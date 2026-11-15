//! The messages of the sim sidecar (`scripts/bench-server.ts`), and the match history the UI scrubs through.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Deserialize, Clone, Copy, Debug, Default)]
pub struct PerAlliance<T> {
    pub red: T,
    pub blue: T,
}

impl<T> PerAlliance<T> {
    pub fn get(&self, red: bool) -> &T {
        if red { &self.red } else { &self.blue }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HiveInfo {
    pub tilt_limit: f32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct FlowerInfo {
    pub x: f32,
    pub z: f32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShooterInfo {
    pub facing: String,
}

/// The robot's AprilTag camera from its config: forward, left, up offset in meters, and the pitch upward.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CameraCfg {
    pub offset: [f32; 3],
    pub pitch_deg: f32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RobotInfo {
    pub alliance: String,
    pub plate: String,
    pub length: f32,
    pub width: f32,
    pub height: f32,
    pub shooter: ShooterInfo,
    pub camera: CameraCfg,
}

impl RobotInfo {
    pub fn red(&self) -> bool {
        self.alliance == "red"
    }
}

/// What doesn't change during a MATCH. Sent once per reset.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub half: f32,
    pub pollen_radius: f32,
    pub nectar_radius: f32,
    pub flower_half_size: f32,
    pub flowers: Vec<FlowerInfo>,
    pub hive: HiveInfo,
    pub robots: Vec<RobotInfo>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Rp {
    pub swarm: bool,
    pub pollinator1: bool,
    pub pollinator2: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    pub leave: i32,
    pub auto_park: i32,
    pub auto_tips: i32,
    pub teleop_tips: i32,
    pub cell: i32,
    pub flower: i32,
    pub bottom_nectar: i32,
    pub garden: i32,
    pub park: i32,
    pub fouls: i32,
    pub total: i32,
    pub rp: Rp,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct HiveState {
    pub phi: f32,
    pub tips: u32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct TreeNode {
    pub idx: u32,
    pub depth: u32,
    pub kind: String,
    pub label: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct TreeDef {
    pub name: String,
    pub nodes: Vec<TreeNode>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct TreeSnap {
    pub def: Option<Arc<TreeDef>>,
    pub running: Vec<u32>,
    /// Nodes that ended since the last snapshot, with `s`, `f:TAG`, `h` or `e`.
    pub ended: Vec<(u32, String)>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RobotSnap {
    pub x: f32,
    pub z: f32,
    pub heading: f32,
    pub w: f32,
    pub carried: Vec<u8>,
    pub driver: String,
    pub tactic: String,
    pub note: String,
    pub path: Vec<[f32; 2]>,
    pub bus: f32,
    pub speed: f32,
    pub sightings: Vec<String>,
    pub tree: Option<TreeSnap>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Message {
    pub t: f32,
    pub text: String,
}

pub const POLLEN: u8 = 0;
pub const NECTAR_RED: u8 = 1;
pub const NECTAR_BLUE: u8 = 2;

/// One snapshot of the MATCH, after a batch of physics steps.
#[derive(Deserialize, Clone, Debug)]
pub struct State {
    pub t: f32,
    pub phase: String,
    pub clock: f32,
    pub unlocked: bool,
    pub score: PerAlliance<Score>,
    pub hives: PerAlliance<HiveState>,
    pub flowers: Vec<Vec<u8>>,
    /// id, kind (`POLLEN`, `NECTAR_RED`, `NECTAR_BLUE`), x, y, z, and the orientation as a quaternion.
    pub balls: Vec<(u32, u8, f32, f32, f32, [f32; 4])>,
    pub robots: Vec<RobotSnap>,
    pub messages: Vec<Message>,
    pub fouls: usize,
}

impl State {
    pub fn period_label(&self) -> &'static str {
        match self.phase.as_str() {
            "pre" => "PRE",
            "auto" => "AUTO",
            "transition" => "TRANSITION",
            "teleop" => "TELEOP",
            _ => "POST",
        }
    }
}

/// A notable moment on the timeline.
#[derive(Clone, Debug)]
pub struct Mark {
    pub frame: usize,
    pub kind: MarkKind,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MarkKind {
    Tip { red: bool },
    Phase,
    Foul,
}

/// A robot's tree at one frame: the running nodes, and each other node's last result.
pub struct TreeView {
    pub def: Arc<TreeDef>,
    pub running: Vec<u32>,
    pub last: HashMap<u32, String>,
}

/// Every snapshot of the MATCH so far, so that the UI can scrub back through it.
#[derive(Default)]
pub struct History {
    pub field: Option<Arc<FieldInfo>>,
    pub frames: Vec<Arc<State>>,
    /// The MATCH time of each frame, for the timeline.
    pub times: Vec<f32>,
    /// Red and blue totals at each frame, for the timeline's score plot.
    pub scores: Vec<(i32, i32)>,
    pub marks: Vec<Mark>,
    /// Where each phase starts, in frames.
    pub phases: Vec<(usize, String)>,
    /// The log, with the frame each line arrived in.
    pub log: Vec<(usize, Message)>,
    /// Per robot, the frames where a tree started, with that tree.
    trees: Vec<Vec<(usize, Arc<TreeDef>)>>,
}

impl History {
    pub fn reset(&mut self, field: FieldInfo) {
        self.trees = vec![Vec::new(); field.robots.len()];
        self.field = Some(Arc::new(field));
        self.frames.clear();
        self.times.clear();
        self.scores.clear();
        self.marks.clear();
        self.phases.clear();
        self.log.clear();
    }

    pub fn push(&mut self, s: State) {
        let i = self.frames.len();
        if let Some(prev) = self.frames.last() {
            for red in [true, false] {
                if s.hives.get(red).tips > prev.hives.get(red).tips {
                    self.marks.push(Mark { frame: i, kind: MarkKind::Tip { red } });
                }
            }
            if s.phase != prev.phase {
                self.marks.push(Mark { frame: i, kind: MarkKind::Phase });
            }
            if s.fouls > prev.fouls {
                self.marks.push(Mark { frame: i, kind: MarkKind::Foul });
            }
        }
        if self.phases.last().is_none_or(|(_, p)| *p != s.phase) {
            self.phases.push((i, s.phase.clone()));
        }
        for (r, robot) in s.robots.iter().enumerate() {
            if let Some(def) = robot.tree.as_ref().and_then(|t| t.def.clone()) {
                if let Some(list) = self.trees.get_mut(r) {
                    list.push((i, def));
                }
            }
        }
        self.times.push(if s.phase == "pre" { 0.0 } else { s.t });
        self.scores.push((s.score.red.total, s.score.blue.total));
        for m in &s.messages {
            self.log.push((i, m.clone()));
        }
        self.frames.push(Arc::new(s));
    }

    /// The first frame at or after MATCH time `t`.
    pub fn frame_at(&self, t: f32) -> usize {
        self.times.partition_point(|x| *x < t).min(self.frames.len().saturating_sub(1))
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// The tree of robot `r` at frame `i`: its definition, the running nodes, and every other node's last result
    /// since that tree started.
    pub fn tree_at(&self, r: usize, i: usize) -> Option<TreeView> {
        let (start, def) = self.trees.get(r)?.iter().rev().find(|(f, _)| *f <= i)?.clone();
        let mut last = HashMap::new();
        for f in &self.frames[start..=i.min(self.frames.len() - 1)] {
            if let Some(t) = f.robots.get(r).and_then(|x| x.tree.as_ref()) {
                for (n, code) in &t.ended {
                    last.insert(*n, code.clone());
                }
            }
        }
        let running = self.frames.get(i)?.robots.get(r)?.tree.as_ref().map(|t| t.running.clone()).unwrap_or_default();
        Some(TreeView { def, running, last })
    }
}
