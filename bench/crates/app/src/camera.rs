//! The selected robot's camera. A worker thread renders the frame, runs the detector on it (or a perfect detector
//! built from the labels when there is none), scores each call against the labels, and feeds live frames to the
//! decision layer the way the robot's loop would.

use crate::field::{Call, Decision, Target};
use crate::model::{FieldInfo, State, NECTAR_BLUE, NECTAR_RED};
use crate::plugins::{frames, parse_llpython, Detector, Harness, LlRow, LL_LEN};
use crate::theme::*;
use crate::Args;
use anyhow::Context as _;
use bench_render::{Alliance, Ball, BallKind, BallLabel, Camera, Frame, Intrinsics, Mount, Pose, Quat, RenderOptions, Robot, RobotModel, Scene, Vec3, World};
use gpui::{point, px, Bounds, PathBuilder, Pixels, RenderImage, Window};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// The height NECTAR rests at in a FLOWER: `FIELD.flowerNectarSeat` in src/sim/config.ts.
const FLOWER_NECTAR_SEAT: f32 = 0.09;

/// The pollen detector's range limit, the 3.5 m gate in PROTOCOL.md.
pub const MAX_RANGE: f32 = 3.5;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum MountKind {
    /// The pollen camera: at the intake end, looking down at the floor.
    Pollen,
    /// The robot's AprilTag camera from its config: at the shooter end, looking up at the raised CELL.
    Tags,
}

impl MountKind {
    pub fn next(self) -> Self {
        match self {
            MountKind::Pollen => MountKind::Tags,
            MountKind::Tags => MountKind::Pollen,
        }
    }
}

/// A camera.json: the intrinsics and the pollen camera's mount.
#[derive(Deserialize)]
struct CameraJson {
    intrinsics: JsonIntrinsics,
    mount: JsonMount,
}
#[derive(Deserialize)]
struct JsonIntrinsics {
    fx: f32,
    fy: f32,
    cx: f32,
    cy: f32,
    width: u32,
    height: u32,
}
#[derive(Deserialize)]
struct JsonMount {
    height_m: f32,
    pitch_deg: f32,
}

#[derive(Clone, Copy)]
pub struct Optics {
    pub intrinsics: Intrinsics,
    pub height: f32,
    pub pitch: f32,
}

impl Optics {
    pub fn load(path: Option<&Path>) -> anyhow::Result<Self> {
        let Some(p) = path else {
            return Ok(Self { intrinsics: Intrinsics::LIMELIGHT_3A, height: 0.30, pitch: 20f32.to_radians() });
        };
        let j: CameraJson = serde_json::from_str(&std::fs::read_to_string(p)?)?;
        let i = j.intrinsics;
        Ok(Self {
            intrinsics: Intrinsics { fx: i.fx, fy: i.fy, cx: i.cx, cy: i.cy, width: i.width, height: i.height },
            height: j.mount.height_m,
            pitch: j.mount.pitch_deg.to_radians(),
        })
    }

    /// Where the camera sits on robot `r`.
    pub fn mount(&self, kind: MountKind, field: &FieldInfo, r: usize) -> Mount {
        let info = &field.robots[r];
        match kind {
            MountKind::Pollen => Mount { forward: info.length / 2.0 - 0.03, left: 0.0, up: self.height, yaw: 0.0, pitch: self.pitch },
            MountKind::Tags => {
                let o = info.camera.offset;
                let rear = info.shooter.facing == "rear";
                let s = if rear { -1.0 } else { 1.0 };
                Mount { forward: s * o[0], left: s * o[1], up: o[2], yaw: if rear { std::f32::consts::PI } else { 0.0 }, pitch: -info.camera.pitch_deg.to_radians() }
            }
        }
    }
}

pub struct CamRequest {
    pub frame: usize,
    pub state: Arc<State>,
    pub field: Arc<FieldInfo>,
    pub robot: usize,
    pub mount: MountKind,
    pub detect: bool,
    /// The newest frame of a running MATCH: only these go to the decision layer, in order.
    pub live: bool,
}

/// A shape drawn over the camera image, in image pixels.
#[derive(Clone)]
pub enum Prim {
    Circle { at: [f32; 3], col: u32, alpha: f32, dashed: bool, width: f32 },
    Cross { at: [f32; 2], size: f32, col: u32 },
}

#[derive(Clone, Default, Debug)]
pub struct Counts {
    /// Floor POLLEN in range and in view: what the detector should report.
    pub targets: u32,
    pub found: u32,
    pub missed: u32,
    /// Detections on no floor POLLEN: clutter, or a ball that isn't a target.
    pub false_pos: u32,
    /// Floor POLLEN mostly outside the image: not counted either way.
    pub cropped: u32,
}

#[derive(Debug)]
pub struct DetOut {
    /// The `llpython` array, as the decision layer gets it.
    pub ll: Vec<f64>,
    pub rows: Vec<LlRow>,
    pub timings: [f32; 5],
    pub ms: f32,
    /// False when the rows came from the labels, not a detector.
    pub real: bool,
}

#[derive(Clone)]
pub struct DecisionView {
    pub state: String,
    pub tracks: Vec<[f32; 2]>,
    pub pending: u32,
    pub switches: u32,
    pub target: Option<Target>,
    pub score: f32,
    pub conf: f32,
    pub field: Decision,
}

/// Everything about one camera frame, ready to draw.
pub struct CamResult {
    pub robot: usize,
    pub plate: String,
    pub live: bool,
    pub t: f32,
    pub width: u32,
    pub height: u32,
    pub image: Arc<RenderImage>,
    pub rgb: Vec<u8>,
    pub labels: Vec<BallLabel>,
    pub camera: Camera,
    pub overlay: Vec<Prim>,
    /// A confidence label per detection: where it goes in image pixels, the text, and its color.
    pub tags: Vec<([f32; 2], String, u32)>,
    pub footprint: Vec<[f32; 2]>,
    pub calls: Vec<(u32, Call)>,
    pub false_ground: Vec<[f32; 2]>,
    pub det: Option<DetOut>,
    pub decision: Option<DecisionView>,
    pub counts: Counts,
    pub render_ms: f32,
}

impl CamResult {
    /// True when the calls came from a real detector rather than the labels.
    pub fn real(&self) -> bool {
        self.det.as_ref().is_some_and(|d| d.real)
    }
}

/// Each message carries the MATCH generation it was sent in.
enum Msg {
    Render(u64, CamRequest),
    Intaken(u64),
}

/// What the worker hands the UI during one MATCH.
#[derive(Default)]
struct Results {
    /// Counts MATCHES, so that a frame which finishes after a reset is dropped.
    generation: u64,
    newest: Option<Arc<CamResult>>,
    /// Per (robot, frame), so a frame seen twice while scrubbing counts once.
    frames: BTreeMap<(usize, usize), (Counts, bool)>,
}

impl Results {
    fn publish(&mut self, generation: u64, robot: usize, frame: usize, r: CamResult) {
        if generation == self.generation {
            self.frames.insert((robot, frame), (r.counts.clone(), r.real()));
            self.newest = Some(Arc::new(r));
        }
    }
}

pub struct CameraWorker {
    tx: Sender<Msg>,
    results: Arc<Mutex<Results>>,
    error: Arc<Mutex<Option<String>>>,
    last: Option<(usize, usize, MountKind, bool)>,
    robot: usize,
}

impl CameraWorker {
    pub fn spawn(args: &Args, fleet: Fleet) -> Self {
        let (tx, rx) = channel();
        let results = Arc::new(Mutex::new(Results::default()));
        let error = Arc::new(Mutex::new(None));
        let w = Worker {
            sim_dir: args.sim_dir(),
            detector_cmd: args.detector.clone(),
            harness_cmd: args.harness.clone(),
            camera_json: args.camera_json.clone(),
            fleet,
            results: results.clone(),
            error: error.clone(),
        };
        std::thread::Builder::new().name("camera".into()).spawn(move || w.run(rx)).expect("camera thread");
        Self { tx, results, error, last: None, robot: 0 }
    }

    /// Asks for a frame. A request for the frame already on screen is dropped.
    pub fn request(&mut self, r: CamRequest) {
        let key = (r.frame, r.robot, r.mount, r.detect);
        if self.last == Some(key) {
            return;
        }
        self.last = Some(key);
        self.robot = r.robot;
        let _ = self.tx.send(Msg::Render(self.generation(), r));
    }

    /// Forgets the last request, so that the next one renders even if it is for the same frame.
    pub fn reset(&mut self) {
        self.last = None;
    }

    fn generation(&self) -> u64 {
        self.results.lock().unwrap().generation
    }

    /// Starts a new MATCH: clears the totals, drops frames still in flight, and restarts the robot code.
    pub fn clear(&mut self) {
        self.last = None;
        let mut r = self.results.lock().unwrap();
        *r = Results { generation: r.generation + 1, ..Results::default() };
    }

    pub fn take(&self) -> Option<Arc<CamResult>> {
        self.results.lock().unwrap().newest.take()
    }

    pub fn intaken(&self) {
        let _ = self.tx.send(Msg::Intaken(self.generation()));
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }

    /// Frames of the selected robot with missed floor POLLEN, for the timeline.
    pub fn miss_history(&self) -> Vec<(usize, u32)> {
        let t = self.results.lock().unwrap();
        t.frames.range((self.robot, 0)..(self.robot + 1, 0)).filter(|(_, (k, _))| k.missed > 0).map(|((_, f), (k, _))| (*f, k.missed)).collect()
    }

    /// Over the MATCH so far, for the selected robot and only frames a real detector ran on: the frame count, the
    /// recall, and false detections per frame.
    pub fn totals(&self) -> Option<(usize, f32, f32)> {
        let t = self.results.lock().unwrap();
        let (mut n, mut targets, mut found, mut fp) = (0usize, 0u32, 0u32, 0u32);
        for (_, (k, real)) in t.frames.range((self.robot, 0)..(self.robot + 1, 0)) {
            if *real {
                n += 1;
                targets += k.targets;
                found += k.found;
                fp += k.false_pos;
            }
        }
        (n > 0).then(|| (n, if targets > 0 { found as f32 / targets as f32 } else { 1.0 }, fp as f32 / n as f32))
    }
}

struct Worker {
    sim_dir: PathBuf,
    detector_cmd: Option<String>,
    harness_cmd: Option<String>,
    camera_json: Option<PathBuf>,
    fleet: Fleet,
    results: Arc<Mutex<Results>>,
    error: Arc<Mutex<Option<String>>>,
}

impl Worker {
    fn fail(&self, what: &str, e: anyhow::Error) {
        *self.error.lock().unwrap() = Some(format!("{what}: {e:#}"));
    }

    fn run(self, rx: Receiver<Msg>) {
        let scene = match Scene::load(self.sim_dir.join("public/field.glb")) {
            Ok(s) => s,
            Err(e) => return self.fail("loading public/field.glb", e),
        };
        let optics = match Optics::load(self.camera_json.as_deref()) {
            Ok(o) => o,
            Err(e) => {
                self.fail("reading --camera-json", e);
                Optics::load(None).unwrap()
            }
        };
        let mut detector: Option<Detector> = None;
        let mut harness: Option<Harness> = None;
        let mut harness_robot = usize::MAX;
        let mut generation = 0;
        while let Ok(first) = rx.recv() {
            // Only the newest request matters. Intake notices all go through, in order.
            let mut req = None;
            for m in std::iter::once(first).chain(rx.try_iter()) {
                match m {
                    Msg::Render(g, r) => {
                        // A new MATCH gets new processes, so no track, target lock or timer carries over.
                        if g != generation {
                            generation = g;
                            detector = None;
                            harness = None;
                        }
                        req = Some(r);
                    }
                    Msg::Intaken(g) if g != generation => {}
                    Msg::Intaken(_) => {
                        if let Some(h) = harness.as_mut() {
                            if let Err(e) = h.intaken() {
                                self.fail("decision layer", e);
                                harness = None;
                            }
                        }
                    }
                }
            }
            let Some(req) = req else { continue };
            if req.detect && detector.is_none() {
                if let Some(cmd) = &self.detector_cmd {
                    match Detector::start(cmd, &self.sim_dir) {
                        Ok(d) => detector = Some(d),
                        Err(e) => self.fail("detector", e),
                    }
                }
            }
            if req.live && harness.is_none() {
                if let Some(cmd) = &self.harness_cmd {
                    match Harness::start(cmd, &self.sim_dir) {
                        Ok(h) => harness = Some(h),
                        Err(e) => self.fail("decision layer", e),
                    }
                }
            }
            // The decision layer keeps memory of one robot. A new robot starts it fresh.
            if req.live && harness_robot != req.robot && harness.is_some() {
                harness = self.harness_cmd.as_ref().and_then(|cmd| Harness::start(cmd, &self.sim_dir).ok());
                harness_robot = req.robot;
            }
            let (result, det_err, dec_err) = frame(&scene, &self.fleet, &optics, &req, detector.as_mut(), if req.live { harness.as_mut() } else { None });
            if let Some(e) = det_err {
                self.fail("detector", e);
                detector = None;
            }
            if let Some(e) = dec_err {
                self.fail("decision layer", e);
                harness = None;
            }
            self.results.lock().unwrap().publish(generation, req.robot, req.frame, result);
        }
    }
}

/// The team's robot CAD, and the robots drawn from it.
#[derive(Clone, Default)]
pub struct Fleet {
    pub model: Option<Arc<RobotModel>>,
    pub robots: Vec<usize>,
    pub turret: bool,
}

impl Fleet {
    pub fn load(args: &Args) -> anyhow::Result<Self> {
        let Some(path) = &args.robot_model else { return Ok(Self::default()) };
        let model = RobotModel::load(path).with_context(|| format!("loading --robot-model {}", path.display()))?;
        let robots = args.model_robots.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        Ok(Self { model: Some(Arc::new(model)), robots, turret: args.turret })
    }

    /// Setup overrides for the sim, one per robot: a model robot gets the CAD's footprint as the sim's square size,
    /// and the turret if `--turret` asks for it.
    pub fn bots(&self, n: usize) -> serde_json::Value {
        let size = self.model.as_ref().map(|m| (m.size.x.max(m.size.z) / 0.0254 * 10.0).round() / 10.0);
        serde_json::Value::Array((0..n).map(|i| match size.filter(|_| self.robots.contains(&i)) {
            Some(s) => serde_json::json!({ "sizeIn": s, "turret": self.turret }),
            None => serde_json::json!({}),
        }).collect())
    }
}

/// Ids at or above this are balls stacked in a FLOWER, which the sim keeps as a list rather than as bodies.
pub const FLOWER_BALL_IDS: u32 = 1_000_000;

fn kind_of(k: u8) -> BallKind {
    match k {
        NECTAR_RED => BallKind::NectarRed,
        NECTAR_BLUE => BallKind::NectarBlue,
        _ => BallKind::Pollen,
    }
}

/// The renderer's view of one snapshot. The camera's own robot is left out, since its camera sits at its edge.
pub fn world_of(state: &State, field: &FieldInfo, skip: Option<usize>, fleet: &Fleet) -> (Vec<Ball>, Vec<Robot>, [f32; 2]) {
    let mut balls: Vec<Ball> = state
        .balls
        .iter()
        .map(|&(id, kind, x, y, z, [qx, qy, qz, qw])| Ball::new(id, kind_of(kind), Vec3::new(x, y, z)).turned(Quat::from_xyzw(qx, qy, qz, qw).normalize()))
        .collect();
    // FLOWER stacks, as `flowerHeights` in src/sim/world.ts places them: POLLEN rests on what is below it, and NECTAR
    // sits at least on the middle ring.
    for (i, (fl, stack)) in field.flowers.iter().zip(&state.flowers).enumerate() {
        let mut h = 0.0f32;
        for (k, kind) in stack.iter().enumerate() {
            let b = kind_of(*kind);
            let bottom = if b == BallKind::Pollen { h } else { h.max(FLOWER_NECTAR_SEAT) };
            balls.push(Ball::new(FLOWER_BALL_IDS + 16 * i as u32 + k as u32, b, Vec3::new(fl.x, bottom + b.radius(), fl.z)));
            h = bottom + 2.0 * b.radius();
        }
    }
    let robots = state
        .robots
        .iter()
        .zip(field.robots.iter())
        .enumerate()
        .filter(|(i, _)| Some(*i) != skip)
        .map(|(i, (r, info))| Robot {
            pose: Pose::new(r.x, r.z, r.heading),
            length: info.length,
            width: info.width,
            height: info.height,
            alliance: if info.red() { Alliance::Red } else { Alliance::Blue },
            model: fleet.robots.contains(&i),
        })
        .collect();
    let tilt = field.hive.tilt_limit;
    (balls, robots, [state.hives.red.phi + tilt, state.hives.blue.phi - tilt])
}

/// The camera on robot `r` in snapshot `state`.
pub fn camera_of(state: &State, field: &FieldInfo, optics: &Optics, kind: MountKind, r: usize) -> Camera {
    let s = &state.robots[r];
    Camera::on_robot(Pose::new(s.x, s.z, s.heading), &optics.mount(kind, field, r), optics.intrinsics)
}

/// True for a label the detector is meant to report: floor POLLEN, mostly visible, in range, and not in a FLOWER.
pub fn is_target(l: &BallLabel, field: &FieldInfo) -> bool {
    floor_pollen(l, field) && l.in_image >= 0.5
}

/// Floor POLLEN the detector may report, whether or not most of it is in the image. A detection on one that is mostly
/// cut off by the image edge is neither a hit nor a false detection.
fn floor_pollen(l: &BallLabel, field: &FieldInfo) -> bool {
    let on_floor = l.world.y < field.pollen_radius + 0.03;
    let hs = field.flower_half_size;
    let in_flower = field.flowers.iter().any(|f| (l.world.x - f.x).abs() < hs && (l.world.z - f.z).abs() < hs);
    l.kind == BallKind::Pollen && on_floor && !in_flower && l.visible >= 0.5 && l.range <= MAX_RANGE
}

/// A perfect detector: the `llpython` the PROTOCOL says the camera would send for these labels.
pub fn llpython_from_labels(labels: &[BallLabel], field: &FieldInfo) -> Vec<f64> {
    let mut a = vec![-1.0f64; LL_LEN];
    a[0] = 1.0;
    for t in &mut a[2..7] {
        *t = 0.0;
    }
    let mut t: Vec<&BallLabel> = labels.iter().filter(|l| is_target(l, field)).collect();
    t.sort_by(|a, b| a.range.total_cmp(&b.range));
    t.truncate(8);
    a[1] = t.len() as f64;
    for k in 0..8 {
        let row = &mut a[7 + 8 * k..15 + 8 * k];
        match t.get(k) {
            Some(l) => {
                let g = frames::to_field(l.world.x, l.world.z);
                row.copy_from_slice(&[l.id as f64, 0.0, l.center[0] as f64, l.center[1] as f64, l.radius as f64, 1.0, g[0] as f64, g[1] as f64]);
            }
            None => row[5] = 0.0,
        }
    }
    a
}

/// What the camera reports for one frame. With `detect` off, a perfect camera built from the labels. With it on, the
/// detector's `llpython`, or nothing if the detector isn't running. A detector that fails gives an error, never a
/// perfect frame in its place.
fn detect(detect: bool, detector: Option<&mut Detector>, frame: &Frame, pose: [f32; 3], labels: &[BallLabel], field: &FieldInfo) -> anyhow::Result<Option<DetOut>> {
    if !detect {
        let ll = llpython_from_labels(labels, field);
        let (timings, rows) = parse_llpython(&ll)?;
        return Ok(Some(DetOut { ll, rows, timings, ms: 0.0, real: false }));
    }
    let Some(d) = detector else { return Ok(None) };
    let t = Instant::now();
    let ll = d.run(&frame.to_bgr(), frame.width as usize, frame.height as usize, Some(pose))?;
    let ms = t.elapsed().as_secs_f32() * 1e3;
    let (timings, rows) = parse_llpython(&ll)?;
    Ok(Some(DetOut { ll, rows, timings, ms, real: true }))
}

/// Matches detections to labels by image distance, nearest first.
fn score(labels: &[BallLabel], rows: &[LlRow], field: &FieldInfo) -> (Counts, Vec<(u32, Call)>, Vec<Option<usize>>) {
    let mut pairs = Vec::new();
    for (d, row) in rows.iter().enumerate() {
        for (l, lab) in labels.iter().enumerate() {
            let dist = (row.cx - lab.center[0]).hypot(row.cy - lab.center[1]);
            if dist <= (0.6 * lab.radius).max(4.0) {
                pairs.push((dist, d, l));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut det_to = vec![None; rows.len()];
    let mut lab_taken = vec![false; labels.len()];
    for (_, d, l) in pairs {
        if det_to[d].is_none() && !lab_taken[l] {
            det_to[d] = Some(l);
            lab_taken[l] = true;
        }
    }
    let mut k = Counts::default();
    let mut calls = Vec::new();
    for (l, lab) in labels.iter().enumerate() {
        if is_target(lab, field) {
            k.targets += 1;
            if lab_taken[l] {
                k.found += 1;
                calls.push((lab.id, Call::Found));
            } else {
                k.missed += 1;
                calls.push((lab.id, Call::Missed));
            }
        }
    }
    k.false_pos = det_to.iter().filter(|m| m.is_none_or(|l| !floor_pollen(&labels[l], field))).count() as u32;
    (k, calls, det_to)
}

/// The floor the camera sees, out to `MAX_RANGE`, as a world polygon.
fn footprint(cam: &Camera) -> Vec<[f32; 2]> {
    let k = cam.intrinsics;
    let (w, h) = (k.width as f32, k.height as f32);
    let n = 24;
    let mut border = Vec::new();
    for i in 0..n {
        border.push((w * i as f32 / n as f32, 0.0));
    }
    for i in 0..n {
        border.push((w, h * i as f32 / n as f32));
    }
    for i in 0..n {
        border.push((w - w * i as f32 / n as f32, h));
    }
    for i in 0..n {
        border.push((0.0, h - h * i as f32 / n as f32));
    }
    let (f, r, d) = (cam.forward(), cam.right(), cam.down());
    let o = cam.position;
    border
        .into_iter()
        .map(|(u, v)| {
            let dir = (f + r * ((u - k.cx) / k.fx) + d * ((v - k.cy) / k.fy)).normalize();
            let flat = Vec3::new(dir.x, 0.0, dir.z).normalize_or_zero();
            let t = if dir.y < -1e-4 { -o.y / dir.y } else { f32::INFINITY };
            let hit = o + dir * t;
            let reach = (hit - o).with_y(0.0).length();
            if t.is_finite() && reach <= MAX_RANGE {
                [hit.x, hit.z]
            } else {
                [o.x + flat.x * MAX_RANGE, o.z + flat.z * MAX_RANGE]
            }
        })
        .collect()
}

/// Clips a polygon to the square |x|, |z| <= half (Sutherland-Hodgman), since the camera can't see floor past the walls.
fn clip_square(poly: &[[f32; 2]], half: f32) -> Vec<[f32; 2]> {
    let mut out = poly.to_vec();
    for (axis, sign) in [(0usize, 1.0f32), (0, -1.0), (1, 1.0), (1, -1.0)] {
        let inside = |p: &[f32; 2]| sign * p[axis] <= half;
        let input = std::mem::take(&mut out);
        for (i, cur) in input.iter().enumerate() {
            let prev = input[(i + input.len() - 1) % input.len()];
            let cross = |a: [f32; 2], b: [f32; 2]| {
                let t = (sign * half - a[axis]) / (b[axis] - a[axis]);
                [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
            };
            match (inside(&prev), inside(cur)) {
                (true, true) => out.push(*cur),
                (true, false) => out.push(cross(prev, *cur)),
                (false, true) => {
                    out.push(cross(prev, *cur));
                    out.push(*cur);
                }
                (false, false) => {}
            }
        }
        if out.is_empty() {
            break;
        }
    }
    out
}

fn parse_decision(v: &Value, half: f32) -> DecisionView {
    let map = |x: &Value, y: &Value| frames::from_map([x.as_f64().unwrap_or(f64::NAN) as f32, y.as_f64().unwrap_or(f64::NAN) as f32], half);
    let tracks: Vec<[f32; 2]> = v["tracks"].as_array().map(|a| a.iter().map(|t| map(&t[1], &t[2])).collect()).unwrap_or_default();
    let cl = |c: &Value| -> Option<Target> {
        if c.is_null() {
            return None;
        }
        let intake = map(&c["intake"][0], &c["intake"][1]);
        Some(Target {
            members: c["pts"].as_array().map(|a| a.iter().map(|p| map(&p[0], &p[1])).collect()).unwrap_or_default(),
            centroid: map(&c["c"][0], &c["c"][1]),
            intake: [intake[0], intake[1], c["intake"][2].as_f64().unwrap_or(f64::NAN) as f32],
            sweep: map(&c["sweep"][0], &c["sweep"][1]),
        })
    };
    let target = cl(&v["target"]);
    let state = v["state"].as_str().unwrap_or("?").to_string();
    let locked = state == "LOCKED";
    DecisionView {
        tracks: tracks.clone(),
        pending: v["pending"].as_u64().unwrap_or(0) as u32,
        switches: v["switches"].as_u64().unwrap_or(0) as u32,
        score: v["target"]["score"].as_f64().unwrap_or(0.0) as f32,
        conf: v["target"]["conf"].as_f64().unwrap_or(0.0) as f32,
        field: Decision { tracks, target: target.clone(), locked },
        target,
        state,
    }
}

pub fn to_render_image(rgb: &[u8], w: u32, h: u32) -> Arc<RenderImage> {
    let mut bgra = Vec::with_capacity((w * h * 4) as usize);
    for p in rgb.chunks_exact(3) {
        bgra.extend_from_slice(&[p[2], p[1], p[0], 255]);
    }
    let buf = image::RgbaImage::from_raw(w, h, bgra).expect("frame size");
    Arc::new(RenderImage::new(smallvec::SmallVec::from_elem(image::Frame::new(buf), 1)))
}

/// Renders one request and runs the robot code on it. Returns the result and any plug-in errors.
fn frame(
    scene: &Scene,
    fleet: &Fleet,
    optics: &Optics,
    req: &CamRequest,
    detector: Option<&mut Detector>,
    harness: Option<&mut Harness>,
) -> (CamResult, Option<anyhow::Error>, Option<anyhow::Error>) {
    let (state, field) = (&req.state, &req.field);
    let cam = camera_of(state, field, optics, req.mount, req.robot);
    let (balls, robots, hive_angles) = world_of(state, field, Some(req.robot), fleet);
    let t0 = Instant::now();
    let out = scene.render(&cam, &World { balls: &balls, robots: &robots, hive_angles, robot_model: fleet.model.as_deref() }, &RenderOptions::default());
    let render_ms = t0.elapsed().as_secs_f32() * 1e3;
    let (w, h) = (out.frame.width, out.frame.height);
    let me = &state.robots[req.robot];
    let pose_field = {
        let g = frames::to_field(me.x, me.z);
        [g[0], g[1], me.heading]
    };

    let (det, det_err) = match detect(req.detect, detector, &out.frame, pose_field, &out.labels, field) {
        Ok(d) => (d, None),
        Err(e) => (None, Some(e)),
    };

    // A frame with no detector result is missing data: it is neither scored nor counted.
    let rows = det.as_ref().map(|d| d.rows.clone()).unwrap_or_default();
    let (mut counts, calls, det_to) = if det.is_some() { score(&out.labels, &rows, field) } else { Default::default() };
    let mut overlay = Vec::new();
    let real = det.as_ref().is_some_and(|d| d.real);
    for (lab, call) in calls.iter().filter_map(|(id, c)| out.labels.iter().find(|l| l.id == *id).map(|l| (l, c))) {
        if *call == Call::Missed {
            overlay.push(Prim::Circle { at: [lab.center[0], lab.center[1], lab.radius + 3.0], col: RED, alpha: 1.0, dashed: true, width: 1.5 });
        }
    }
    for lab in &out.labels {
        let cropped = lab.kind == BallKind::Pollen && lab.in_image < 0.5 && lab.in_image > 0.0 && lab.visible >= 0.5 && lab.world.y < field.pollen_radius + 0.03;
        if cropped {
            counts.cropped += 1;
            overlay.push(Prim::Circle { at: [lab.center[0], lab.center[1], lab.radius + 3.0], col: DIM, alpha: 0.9, dashed: true, width: 1.0 });
        }
    }
    let mut false_ground = Vec::new();
    let mut tags = Vec::new();
    for (row, m) in rows.iter().zip(&det_to) {
        let good = m.is_some_and(|l| is_target(&out.labels[l], field));
        let cropped = !good && m.is_some_and(|l| floor_pollen(&out.labels[l], field));
        let held = row.robot_adjacent();
        let (col, alpha) = match (good, cropped || held) {
            (true, _) => (GREEN, 1.0),
            (false, true) => (TEXT, 0.6),
            (false, false) => (RED, 1.0),
        };
        overlay.push(Prim::Circle { at: [row.cx, row.cy, row.r], col, alpha, dashed: false, width: if real { 1.5 } else { 1.0 } });
        if real {
            let what = if held { "held" } else if good { "" } else if cropped { "cropped" } else { "false" };
            tags.push(([row.cx + row.r * 0.7 + 3.0, row.cy - row.r * 0.7 - 14.0], format!("{:.2} {what}", row.conf).trim().to_string(), col));
        }
        overlay.push(Prim::Cross { at: [row.cx, row.cy], size: 3.0, col });
        if !good && !held && !cropped {
            if let Some(g) = row.ground {
                false_ground.push(frames::from_field(g));
            }
        }
    }

    let mut dec_err = None;
    let decision = harness.and_then(|hn| {
        let pose = frames::to_map(me.x, me.z, field.half);
        match hn.frame((state.t * 1000.0) as u64, Some([pose[0], pose[1], me.heading]), det.as_ref().map(|d| d.ll.as_slice())) {
            Ok(v) => Some(parse_decision(&v, field.half)),
            Err(e) => {
                dec_err = Some(e);
                None
            }
        }
    });

    let result = CamResult {
        robot: req.robot,
        plate: field.robots[req.robot].plate.clone(),
        live: req.live,
        t: state.t,
        width: w,
        height: h,
        image: to_render_image(&out.frame.rgb, w, h),
        rgb: out.frame.rgb,
        labels: out.labels,
        camera: cam,
        overlay,
        tags,
        footprint: clip_square(&footprint(&cam), field.half),
        calls,
        false_ground,
        det,
        decision,
        counts,
        render_ms,
    };
    (result, det_err, dec_err)
}

pub fn paint_overlay(b: Bounds<Pixels>, scale: f32, prims: &[Prim], window: &mut Window) {
    let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let tp = |x: f32, y: f32| (ox + x * scale, oy + y * scale);
    let stroke = |window: &mut Window, pts: &[(f32, f32)], col: gpui::Hsla, w: f32| {
        let mut p = PathBuilder::stroke(px(w));
        p.move_to(point(px(pts[0].0), px(pts[0].1)));
        for q in &pts[1..] {
            p.line_to(point(px(q.0), px(q.1)));
        }
        if let Ok(p) = p.build() {
            window.paint_path(p, col);
        }
    };
    for p in prims {
        match p {
            Prim::Circle { at: [cx, cy, r], col, alpha, dashed, width } => {
                let n = 40;
                let pts: Vec<_> = (0..=n).map(|i| {
                    let a = i as f32 / n as f32 * std::f32::consts::TAU;
                    tp(cx + r * a.cos(), cy + r * a.sin())
                }).collect();
                if *dashed {
                    for k in (0..n).step_by(2) {
                        stroke(window, &pts[k..k + 2], ca(*col, *alpha), *width);
                    }
                } else {
                    stroke(window, &pts, ca(*col, *alpha), *width);
                }
            }
            Prim::Cross { at: [x, y], size, col } => {
                stroke(window, &[tp(*x - size, *y), tp(*x + size, *y)], c(*col), 1.0);
                stroke(window, &[tp(*x, *y - size), tp(*x, *y + size)], c(*col), 1.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> FieldInfo {
        serde_json::from_value(serde_json::json!({
            "half": 1.7929, "pollenRadius": 0.03556, "nectarRadius": 0.04572, "flowerHalfSize": 0.0847,
            "flowers": [], "hive": { "tiltLimit": std::f32::consts::FRAC_PI_6 }, "robots": []
        }))
        .unwrap()
    }

    fn pollen(id: u32, center: [f32; 2], in_image: f32) -> BallLabel {
        BallLabel {
            id,
            kind: BallKind::Pollen,
            center,
            radius: 12.0,
            bbox: [center[0] - 12.0, center[1] - 12.0, center[0] + 12.0, center[1] + 12.0],
            range: 1.0,
            visible: 1.0,
            in_image,
            pixels: 400,
            world: Vec3::new(0.0, 0.0356, 0.0),
        }
    }

    fn row(cx: f32, cy: f32) -> LlRow {
        LlRow { cls: 0, cx, cy, r: 12.0, conf: 0.9, ground: None }
    }

    #[test]
    fn a_detection_on_a_cut_off_ball_is_neither_found_nor_false() {
        let f = field();
        let labels = [pollen(1, [100.0, 100.0], 1.0), pollen(2, [630.0, 478.0], 0.3)];
        let (k, calls, _) = score(&labels, &[row(101.0, 100.0), row(629.0, 477.0), row(300.0, 300.0)], &f);
        assert_eq!((k.targets, k.found, k.missed), (1, 1, 0));
        assert_eq!(k.false_pos, 1, "only the detection on nothing is false");
        assert_eq!(calls.len(), 1);
    }

    fn blank(missed: u32) -> CamResult {
        CamResult {
            robot: 0,
            plate: String::new(),
            live: true,
            t: 0.0,
            width: 1,
            height: 1,
            image: to_render_image(&[0; 3], 1, 1),
            rgb: vec![0; 3],
            labels: Vec::new(),
            camera: Camera::new(Intrinsics::default(), Vec3::ZERO, 0.0, 0.0),
            overlay: Vec::new(),
            tags: Vec::new(),
            footprint: Vec::new(),
            calls: Vec::new(),
            false_ground: Vec::new(),
            det: None,
            decision: None,
            counts: Counts { missed, ..Counts::default() },
            render_ms: 0.0,
        }
    }

    #[test]
    fn a_frame_from_the_last_match_is_dropped() {
        let (tx, _rx) = channel();
        let mut cam = CameraWorker { tx, results: Default::default(), error: Default::default(), last: None, robot: 0 };
        cam.clear();
        cam.results.lock().unwrap().publish(0, 0, 7, blank(2));
        assert!(cam.take().is_none());
        assert_eq!(cam.miss_history(), []);
        cam.results.lock().unwrap().publish(1, 0, 8, blank(2));
        assert!(cam.take().is_some());
        assert_eq!(cam.miss_history(), [(8, 2)]);
    }

    fn pixel() -> Frame {
        Frame { width: 1, height: 1, rgb: vec![0; 3], depth: vec![f32::INFINITY], ids: vec![0] }
    }

    fn detector(reply: &str) -> Detector {
        Detector::start(&format!("read header; head -c 3 >/dev/null; echo '{reply}'"), Path::new(".")).unwrap()
    }

    #[test]
    fn a_detector_error_is_no_observation() {
        let mut d = detector(r#"{"error":"no pipeline"}"#);
        let e = detect(true, Some(&mut d), &pixel(), [0.0; 3], &[pollen(1, [100.0, 100.0], 1.0)], &field()).unwrap_err();
        assert_eq!(e.to_string(), "detector: no pipeline");
    }

    #[test]
    fn malformed_detector_output_is_no_observation() {
        let mut d = detector(r#"{"llpython":[1,0]}"#);
        let e = detect(true, Some(&mut d), &pixel(), [0.0; 3], &[pollen(1, [100.0, 100.0], 1.0)], &field()).unwrap_err();
        assert_eq!(e.to_string(), "llpython has 2 values, expected 71");
    }

    #[test]
    fn perfect_detections_only_when_picked() {
        let labels = [pollen(1, [100.0, 100.0], 1.0)];
        let perfect = detect(false, None, &pixel(), [0.0; 3], &labels, &field()).unwrap().unwrap();
        assert!(!perfect.real);
        assert_eq!(perfect.rows.iter().map(|r| [r.cx, r.cy]).collect::<Vec<_>>(), [[100.0, 100.0]]);
        assert!(detect(true, None, &pixel(), [0.0; 3], &labels, &field()).unwrap().is_none());
    }
}
