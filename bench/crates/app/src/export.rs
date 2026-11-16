//! Labeled camera frames on disk: one PNG per frame, and one JSON line per frame in `labels.jsonl` with the camera,
//! the robot's pose and every ball that projects into the image. `bench export` plays MATCHES headless and writes
//! frames from every robot's camera, so the training set sees the clumps, spills and occlusions of real play.

use crate::camera::{camera_of, is_target, world_of, CamResult, Fleet, MountKind, Optics};
use crate::model::{FieldInfo, State};
use crate::sidecar::{Server, STEPS_PER_SEC};
use crate::Args;
use anyhow::Context as _;
use bench_render::{BallLabel, Camera, RenderOptions, Scene, World};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(clap::Args, Debug, Clone)]
pub struct ExportArgs {
    /// Seeds to play, as `1-20` or `3,7,9`.
    #[arg(long, default_value = "1-4")]
    seeds: String,
    /// Seconds of MATCH time between frames.
    #[arg(long, default_value_t = 0.5)]
    every: f32,
    /// pollen, tags, or both.
    #[arg(long, default_value = "pollen")]
    mount: String,
    /// Skip frames with fewer floor POLLEN in view than this.
    #[arg(long, default_value_t = 0)]
    min_targets: usize,
    /// The folder each export makes a new run-N folder in. Default: ~/bench-datasets.
    #[arg(long)]
    out: Option<PathBuf>,
}

pub fn default_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("bench-datasets")
}

fn parse_seeds(s: &str) -> anyhow::Result<Vec<u32>> {
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('-') {
            Some((a, b)) => out.extend(a.parse::<u32>()?..=b.parse::<u32>()?),
            None => out.push(part.parse()?),
        }
    }
    Ok(out)
}

/// Rounds to 0.1 mm or 0.0001 rad, so the JSON doesn't carry f32 noise.
fn r4(v: f32) -> f64 {
    (v as f64 * 1e4).round() / 1e4
}

fn camera_json(cam: &Camera) -> Value {
    let k = cam.intrinsics;
    json!({
        "position": [r4(cam.position.x), r4(cam.position.y), r4(cam.position.z)],
        "yaw": r4(cam.yaw), "pitch_down": r4(cam.pitch),
        "intrinsics": { "fx": k.fx, "fy": k.fy, "cx": k.cx, "cy": k.cy, "width": k.width, "height": k.height },
    })
}

fn labels_json(labels: &[BallLabel], field: &FieldInfo) -> Value {
    Value::Array(
        labels
            .iter()
            .map(|l| {
                let mut v = serde_json::to_value(l).unwrap_or(Value::Null);
                v["target"] = json!(is_target(l, field));
                v
            })
            .collect(),
    )
}

/// Which camera a frame came from.
struct Shot {
    seed: u32,
    robot: usize,
    mount: MountKind,
}

/// One row of `labels.jsonl`.
fn row(file: &str, shot: &Shot, state: &State, field: &FieldInfo, cam: &Camera, labels: &[BallLabel]) -> Value {
    let &Shot { seed, robot, mount } = shot;
    let r = &state.robots[robot];
    json!({
        "file": file, "seed": seed, "t": r4(state.t), "phase": state.phase,
        "robot": robot, "plate": field.robots[robot].plate, "alliance": field.robots[robot].alliance,
        "mount": match mount { MountKind::Pollen => "pollen", MountKind::Tags => "tags" },
        "pose": { "x": r4(r.x), "z": r4(r.z), "heading": r4(r.heading) },
        "camera": camera_json(cam),
        "balls": labels_json(labels, field),
    })
}

/// Makes the next free run-N folder in `base`, with `manifest` as manifest.json and an empty labels.jsonl, so a run's
/// labels and images always come from the same settings.
fn new_run(base: &Path, manifest: &Value) -> anyhow::Result<(PathBuf, std::fs::File)> {
    std::fs::create_dir_all(base)?;
    let mut n = 1;
    loop {
        let dir = base.join(format!("run-{n}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                std::fs::create_dir(dir.join("frames"))?;
                std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(manifest)?)?;
                let labels = std::fs::File::create(dir.join("labels.jsonl"))?;
                return Ok((dir, labels));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e.into()),
        }
    }
}

/// Saves the frame on screen, with its labels, to `dir`.
pub fn write_frame(dir: &Path, r: &CamResult) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stem = format!("{}_t{:06}", r.plate, (r.t * 1000.0) as u64);
    let png = dir.join(format!("{stem}.png"));
    image::RgbImage::from_raw(r.width, r.height, r.rgb.clone()).context("frame size")?.save(&png)?;
    let labels: Vec<Value> = r.labels.iter().map(|l| serde_json::to_value(l).unwrap_or(Value::Null)).collect();
    let meta = json!({ "file": png.file_name().unwrap().to_string_lossy(), "t": r4(r.t), "camera": camera_json(&r.camera), "balls": labels });
    std::fs::write(dir.join(format!("{stem}.json")), serde_json::to_string_pretty(&meta)?)?;
    Ok(png)
}

pub fn run(args: &Args, e: &ExportArgs) -> anyhow::Result<()> {
    let seeds = parse_seeds(&e.seeds)?;
    let mounts: Vec<MountKind> = match e.mount.as_str() {
        "pollen" => vec![MountKind::Pollen],
        "tags" => vec![MountKind::Tags],
        "both" => vec![MountKind::Pollen, MountKind::Tags],
        m => anyhow::bail!("--mount is pollen, tags or both, not {m}"),
    };
    let scene = Scene::load(args.sim_dir().join("public/field.glb"))?;
    let fleet = Fleet::load(args)?;
    let optics = Optics::load(args.camera_json.as_deref())?;
    let k = optics.intrinsics;
    let manifest = json!({
        "seeds": seeds, "every": e.every, "mount": e.mount, "min_targets": e.min_targets, "mode": args.mode,
        "intrinsics": { "fx": k.fx, "fy": k.fy, "cx": k.cx, "cy": k.cy, "width": k.width, "height": k.height },
        "pollen_mount": { "height_m": optics.height, "pitch_deg": optics.pitch.to_degrees() },
        "robot_model": args.robot_model, "model_robots": args.model_robots, "turret": args.turret,
    });
    let (out, mut index) = new_run(&e.out.clone().unwrap_or_else(default_dir), &manifest)?;
    let mut server = Server::start(&args.sim_dir())?;
    let steps = ((e.every * STEPS_PER_SEC).round() as u32).max(1);
    let mut written = 0usize;
    for &seed in &seeds {
        let (field, _) = server.reset(seed, &args.mode, &fleet.bots(4))?;
        let mut state = server.start_match()?;
        while state.phase != "post" {
            state = server.step(steps)?;
            let jobs: Vec<(usize, MountKind)> = (0..field.robots.len()).flat_map(|r| mounts.iter().map(move |m| (r, *m))).collect();
            let rows: Vec<Option<Value>> = jobs
                .par_iter()
                .map(|&(r, m)| -> anyhow::Result<Option<Value>> {
                    let cam = camera_of(&state, &field, &optics, m, r);
                    let (balls, robots, hive_angles) = world_of(&state, &field, Some(r), &fleet);
                    let o = scene.render(&cam, &World { balls: &balls, robots: &robots, hive_angles, robot_model: fleet.model.as_deref() }, &RenderOptions::default());
                    if o.labels.iter().filter(|l| is_target(l, &field)).count() < e.min_targets {
                        return Ok(None);
                    }
                    let name = format!("s{seed:03}_t{:06}_r{r}_{}.png", (state.t * 1000.0) as u64, if m == MountKind::Pollen { "pollen" } else { "tags" });
                    o.frame.save_png(out.join("frames").join(&name))?;
                    Ok(Some(row(&format!("frames/{name}"), &Shot { seed, robot: r, mount: m }, &state, &field, &cam, &o.labels)))
                })
                .collect::<anyhow::Result<_>>()?;
            for v in rows.into_iter().flatten() {
                writeln!(index, "{v}")?;
                written += 1;
            }
        }
        eprintln!("seed {seed}: {written} frames so far");
    }
    eprintln!("wrote {written} frames to {}", out.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_export_gets_its_own_run() {
        let base = std::env::temp_dir().join(format!("bench-export-test-{}", std::process::id()));
        let (a, mut labels) = new_run(&base, &json!({ "intrinsics": { "fx": 620.0 } })).unwrap();
        writeln!(labels, r#"{{"file":"frames/s001_t000500_r0_pollen.png"}}"#).unwrap();
        let (b, _) = new_run(&base, &json!({ "intrinsics": { "fx": 500.0 } })).unwrap();
        let read = |p: PathBuf| std::fs::read_to_string(p).unwrap();
        assert_eq!((a.clone(), b.clone()), (base.join("run-1"), base.join("run-2")));
        assert_eq!(read(a.join("labels.jsonl")), "{\"file\":\"frames/s001_t000500_r0_pollen.png\"}\n");
        assert_eq!(read(b.join("labels.jsonl")), "");
        let fx = |dir: &Path| serde_json::from_str::<Value>(&read(dir.join("manifest.json"))).unwrap()["intrinsics"]["fx"].clone();
        assert_eq!((fx(&a), fx(&b)), (json!(620.0), json!(500.0)));
        std::fs::remove_dir_all(base).unwrap();
    }
}
