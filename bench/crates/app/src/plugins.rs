//! Robot code that runs beside the sim, each in its own process:
//!
//! - A detector: gets each rendered camera frame and returns the Limelight `llpython` array. A Limelight SnapScript
//!   runs unchanged through `bench/plugins/snapscript.py`.
//! - A decision layer: gets the robot's pose and each `llpython` array, and returns what it would drive to. It speaks
//!   the pollen harness protocol (one `F` or `N` line per robot loop, one JSON object back).
//!
//! The wire formats are in `bench/PROTOCOL.md`.

use anyhow::{bail, Context as _};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Inches to meters.
pub const IN: f32 = 0.0254;
/// The length of the `llpython` array in protocol version 1.
pub const LL_LEN: usize = 71;

/// A child process with line-based stdout.
struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Proc {
    fn start(cmd: &str, cwd: &Path) -> anyhow::Result<Self> {
        let mut child = Command::new("sh")
            .args(["-c", cmd])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("starting `{cmd}`"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Ok(Self { child, stdin, stdout })
    }

    fn line(&mut self) -> anyhow::Result<Value> {
        let mut s = String::new();
        if self.stdout.read_line(&mut s)? == 0 {
            let status = self.child.try_wait().ok().flatten();
            bail!("the process exited{}", status.map(|s| format!(" ({s})")).unwrap_or_default());
        }
        serde_json::from_str(&s).with_context(|| format!("not JSON: {}", s.trim()))
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One row of `llpython`: a ball the camera reports.
#[derive(Clone, Debug)]
pub struct LlRow {
    pub cls: u32,
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
    /// The verifier's confidence, 0 to 1.
    pub conf: f32,
    /// Ground position: in the PROTOCOL field frame when a pose was sent, else forward and left of the robot.
    pub ground: Option<[f32; 2]>,
}

impl LlRow {
    /// Bit 0 of `cls`: the ball sits against a robot's bumper, so it isn't one to drive at.
    pub fn robot_adjacent(&self) -> bool {
        self.cls & 1 != 0
    }
}

/// Reads an `llpython` array: the stage timings and the ball rows.
pub fn parse_llpython(a: &[f64]) -> anyhow::Result<([f32; 5], Vec<LlRow>)> {
    if a.len() != LL_LEN {
        bail!("llpython has {} values, expected {LL_LEN}", a.len());
    }
    if a[0] != 1.0 {
        bail!("llpython version {} (this build reads version 1)", a[0]);
    }
    let mut t = [0f32; 5];
    for (k, v) in t.iter_mut().enumerate() {
        *v = a[2 + k] as f32;
    }
    let n = (a[1].max(0.0) as usize).min(8);
    let rows = (0..n)
        .map(|k| {
            let r = &a[7 + 8 * k..15 + 8 * k];
            let ground = (r[6].is_finite() && r[7].is_finite()).then(|| [r[6] as f32, r[7] as f32]);
            LlRow { cls: r[1].max(0.0) as u32, cx: r[2] as f32, cy: r[3] as f32, r: r[4] as f32, conf: r[5] as f32, ground }
        })
        .filter(|r| r.r > 0.0)
        .collect();
    Ok((t, rows))
}

/// A detector process. Each frame is one JSON header line followed by the raw BGR pixels.
pub struct Detector {
    p: Proc,
}

impl Detector {
    pub fn start(cmd: &str, cwd: &Path) -> anyhow::Result<Self> {
        Ok(Self { p: Proc::start(cmd, cwd)? })
    }

    /// Runs one frame. `llrobot` is the pose in the PROTOCOL field frame, or None to run without a pose.
    pub fn run(&mut self, bgr: &[u8], w: usize, h: usize, llrobot: Option<[f32; 3]>) -> anyhow::Result<Vec<f64>> {
        let ll = match llrobot {
            Some([x, y, hd]) => [x as f64, y as f64, hd as f64, 1.0],
            None => [0.0; 4],
        };
        let header = serde_json::json!({ "w": w, "h": h, "llrobot": ll });
        writeln!(self.p.stdin, "{header}")?;
        self.p.stdin.write_all(bgr)?;
        self.p.stdin.flush()?;
        let v = self.p.line()?;
        if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
            bail!("detector: {e}");
        }
        let arr = v.get("llpython").and_then(|a| a.as_array()).context("detector reply has no llpython")?;
        Ok(arr.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
    }
}

/// The pollen decision layer, driven the way the robot's loop drives it.
pub struct Harness {
    p: Proc,
}

impl Harness {
    pub fn start(cmd: &str, cwd: &Path) -> anyhow::Result<Self> {
        Ok(Self { p: Proc::start(cmd, cwd)? })
    }

    /// One robot loop. `pose` is in the map frame (inches from the audience-left corner, heading CCW from +x).
    /// `ll` is None for a loop with no fresh camera result.
    pub fn frame(&mut self, t_ms: u64, pose: Option<[f32; 3]>, ll: Option<&[f64]>) -> anyhow::Result<Value> {
        let (pv, [x, y, h]) = match pose {
            Some(p) => (1, p),
            None => (0, [0.0; 3]),
        };
        let mut line = format!("{} {t_ms} {pv} {x} {y} {h}", if ll.is_some() { 'F' } else { 'N' });
        if let Some(a) = ll {
            for v in a {
                if v.is_finite() {
                    line.push_str(&format!(" {v}"));
                } else {
                    line.push_str(" NaN");
                }
            }
        }
        writeln!(self.p.stdin, "{line}")?;
        self.p.stdin.flush()?;
        self.p.line()
    }

    /// Tells the targeter that its target went into the intake.
    pub fn intaken(&mut self) -> anyhow::Result<()> {
        writeln!(self.p.stdin, "R")?;
        self.p.stdin.flush()?;
        self.p.line().map(|_| ())
    }
}

/// Conversions between the sim's world frame (meters, X red to blue, Z rear to audience) and the robot code's frames.
pub mod frames {
    use super::IN;

    /// The PROTOCOL field frame: meters from the field center, x toward the blue wall, y toward the rear wall.
    pub fn to_field(x: f32, z: f32) -> [f32; 2] {
        [x, -z]
    }
    pub fn from_field(p: [f32; 2]) -> [f32; 2] {
        [p[0], -p[1]]
    }

    /// The map frame of the decision layer: inches from the inside audience-left corner, +y toward the rear.
    pub fn to_map(x: f32, z: f32, half: f32) -> [f32; 2] {
        [(x + half) / IN, (half - z) / IN]
    }
    pub fn from_map(p: [f32; 2], half: f32) -> [f32; 2] {
        [p[0] * IN - half, half - p[1] * IN]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llpython_rows() {
        let mut a = vec![-1.0; LL_LEN];
        a[0] = 1.0;
        a[1] = 1.0;
        a[2..7].fill(0.5);
        a[7..15].copy_from_slice(&[3.0, 1.0, 320.0, 240.0, 12.0, 0.9, 1.5, f64::NAN]);
        let (t, rows) = parse_llpython(&a).unwrap();
        assert_eq!(t, [0.5; 5]);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].robot_adjacent());
        assert!(rows[0].ground.is_none());
    }

    #[test]
    fn frames_roundtrip() {
        let half = 1.7929;
        let m = frames::to_map(-half, half, half);
        assert!(m[0].abs() < 1e-4 && m[1].abs() < 1e-4, "the audience-left corner is the map origin");
        let w = frames::from_map(frames::to_map(0.4, -1.1, half), half);
        assert!((w[0] - 0.4).abs() < 1e-4 && (w[1] + 1.1).abs() < 1e-4);
        assert_eq!(frames::from_field(frames::to_field(0.3, 0.7)), [0.3, 0.7]);
    }
}
