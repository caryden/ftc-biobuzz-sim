//! Runs `scripts/bench-server.ts` in Node and keeps the MATCH history. A worker thread owns the process: it sends
//! one command at a time, reads the reply, and paces the MATCH by the wall clock while it plays.

use crate::model::{FieldInfo, History, State};
use anyhow::{anyhow, bail, Context as _};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Physics steps per second in the sim (`DT = 1 / 240`).
pub const STEPS_PER_SEC: f32 = 240.0;
/// The history keeps about this many snapshots per second of MATCH time at 1x.
const SNAPSHOTS_PER_SEC: f32 = 60.0;

pub enum Cmd {
    Reset { seed: u32, mode: String },
    Start,
    Drive(Value),
}

/// The handle the UI holds. Reading the history takes its lock briefly.
pub struct Sim {
    tx: Sender<Cmd>,
    pub history: Arc<Mutex<History>>,
    pub playing: Arc<AtomicBool>,
    /// MATCH seconds per wall second, as f32 bits. Zero means as fast as the sim runs.
    speed: Arc<AtomicU64>,
    pub error: Arc<Mutex<Option<String>>>,
}

impl Sim {
    pub fn spawn(sim_dir: PathBuf) -> Self {
        let (tx, rx) = channel();
        let history = Arc::new(Mutex::new(History::default()));
        let playing = Arc::new(AtomicBool::new(false));
        let speed = Arc::new(AtomicU64::new(1f32.to_bits() as u64));
        let error = Arc::new(Mutex::new(None));
        let w = Worker { rx, history: history.clone(), playing: playing.clone(), speed: speed.clone(), error: error.clone() };
        std::thread::Builder::new().name("sim".into()).spawn(move || w.run(&sim_dir)).expect("sim thread");
        Self { tx, history, playing, speed, error }
    }

    pub fn send(&self, c: Cmd) {
        let _ = self.tx.send(c);
    }

    pub fn speed(&self) -> f32 {
        f32::from_bits(self.speed.load(Ordering::Relaxed) as u32)
    }

    pub fn set_speed(&self, s: f32) {
        self.speed.store(s.to_bits() as u64, Ordering::Relaxed);
    }
}

/// A Node process speaking the sidecar protocol.
pub struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Server {
    /// Starts the sidecar from the simulator's checkout, and waits for its `ready` line.
    pub fn start(sim_dir: &Path) -> anyhow::Result<Self> {
        let script = sim_dir.join("scripts/bench-server.ts");
        if !script.exists() {
            bail!("no {} (pass --sim-dir, the ftc-biobuzz-sim checkout)", script.display());
        }
        let mut child = Command::new("npx")
            .args(["--no-install", "tsx", "scripts/bench-server.ts"])
            .current_dir(sim_dir)
            .env("PATH", path_with_node())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("starting the sim sidecar with npx tsx (is Node installed, and did you run npm install?)")?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut s = Self { child, stdin, stdout };
        let ready = s.read()?;
        if ready["type"] != "ready" {
            bail!("unexpected first line from the sidecar: {ready}");
        }
        Ok(s)
    }

    pub fn read(&mut self) -> anyhow::Result<Value> {
        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            bail!("the sim sidecar exited");
        }
        let v: Value = serde_json::from_str(&line)?;
        if v["type"] == "error" {
            bail!("sidecar: {}", v["message"].as_str().unwrap_or("error"));
        }
        Ok(v)
    }

    pub fn write(&mut self, cmd: &Value) -> anyhow::Result<()> {
        writeln!(self.stdin, "{cmd}")?;
        self.stdin.flush()?;
        Ok(())
    }

    /// Resets the MATCH, and returns the field and the first snapshot.
    pub fn reset(&mut self, seed: u32, mode: &str) -> anyhow::Result<(FieldInfo, State)> {
        self.write(&json!({ "op": "reset", "seed": seed, "mode": mode }))?;
        let field = serde_json::from_value(self.read()?)?;
        Ok((field, self.state()?))
    }

    pub fn start_match(&mut self) -> anyhow::Result<State> {
        self.write(&json!({ "op": "start" }))?;
        self.state()
    }

    pub fn step(&mut self, n: u32) -> anyhow::Result<State> {
        self.write(&json!({ "op": "step", "n": n }))?;
        self.state()
    }

    pub fn drive(&mut self, cmd: &Value) -> anyhow::Result<()> {
        self.write(cmd)?;
        self.read().map(|_| ())
    }

    fn state(&mut self) -> anyhow::Result<State> {
        let v = self.read()?;
        if v["type"] != "state" {
            return Err(anyhow!("expected a state, got {}", v["type"]));
        }
        Ok(serde_json::from_value(v)?)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// A Mac app started from Finder or over SSH may not have Homebrew's bin on its PATH.
fn path_with_node() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/run/current-system/sw/bin"];
    let mut parts: Vec<&str> = base.split(':').filter(|p| !p.is_empty()).collect();
    for e in extra {
        if !parts.contains(&e) {
            parts.push(e);
        }
    }
    parts.join(":")
}

struct Worker {
    rx: Receiver<Cmd>,
    history: Arc<Mutex<History>>,
    playing: Arc<AtomicBool>,
    speed: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
}

impl Worker {
    fn run(self, sim_dir: &Path) {
        if let Err(e) = self.serve(sim_dir) {
            *self.error.lock().unwrap() = Some(format!("{e:#}"));
            self.playing.store(false, Ordering::Relaxed);
        }
    }

    fn serve(&self, sim_dir: &Path) -> anyhow::Result<()> {
        let mut s = Server::start(sim_dir)?;
        let mut owed = 0.0f32;
        let mut last = Instant::now();
        loop {
            let playing = self.playing.load(Ordering::Relaxed);
            let cmd = if playing {
                match self.rx.try_recv() {
                    Ok(c) => Some(c),
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    Err(_) => return Ok(()),
                }
            } else {
                match self.rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(c) => Some(c),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(_) => return Ok(()),
                }
            };
            if let Some(c) = cmd {
                match c {
                    Cmd::Reset { seed, mode } => {
                        self.playing.store(false, Ordering::Relaxed);
                        let (field, state) = s.reset(seed, &mode)?;
                        let mut h = self.history.lock().unwrap();
                        h.reset(field);
                        h.push(state);
                    }
                    Cmd::Start => {
                        let state = s.start_match()?;
                        self.history.lock().unwrap().push(state);
                        self.playing.store(true, Ordering::Relaxed);
                    }
                    Cmd::Drive(v) => s.drive(&v)?,
                }
                last = Instant::now();
                owed = 0.0;
                continue;
            }
            if !playing {
                last = Instant::now();
                continue;
            }
            let speed = f32::from_bits(self.speed.load(Ordering::Relaxed) as u32);
            let now = Instant::now();
            owed += (now - last).as_secs_f32() * if speed > 0.0 { speed } else { 8.0 };
            last = now;
            let per = STEPS_PER_SEC / SNAPSHOTS_PER_SEC * speed.max(1.0);
            let due = (owed * STEPS_PER_SEC).floor();
            if speed > 0.0 && due < per {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            let n = if speed > 0.0 { due.min(per * 4.0) as u32 } else { (per * 2.0) as u32 };
            owed = (owed - n as f32 / STEPS_PER_SEC).max(0.0);
            let state = s.step(n.max(1))?;
            let done = state.phase == "post";
            self.history.lock().unwrap().push(state);
            if done {
                self.playing.store(false, Ordering::Relaxed);
            }
        }
    }
}
