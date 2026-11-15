//! bench: the BIOBUZZ simulator as a native app. It plays the web simulator's MATCH headless, renders the FIELD
//! and what a robot's camera sees from the field CAD, and runs the team's camera pipeline and decision code on it.

mod camera;
mod export;
mod field;
mod model;
mod panels;
mod plugins;
mod sidecar;
mod theme;
mod ui;

use camera::{CamRequest, CamResult, CameraWorker, MountKind};
use clap::{Parser, Subcommand};
use field::{Annotations, FieldRequest, FieldWorker, Proj, ViewMode};
use gpui::{
    canvas, div, img, prelude::*, px, size, App, Bounds, Context, FocusHandle, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ObjectFit, Pixels, Point, RenderImage, ScrollEvent, Window, WindowBounds,
    WindowOptions,
};
use model::{History, State};
use serde_json::json;
use sidecar::{Cmd, Sim};
use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use theme::*;
use ui::*;

#[derive(Parser, Debug, Clone)]
#[command(about = "The BIOBUZZ simulator as a native app, with a camera for the robot code")]
pub struct Args {
    /// The ftc-biobuzz-sim checkout (has scripts/bench-server.ts). Default: the checkout this was built from.
    #[arg(long)]
    sim_dir: Option<PathBuf>,
    #[arg(long, default_value_t = 1)]
    seed: u32,
    /// full, teleop, auto or practice.
    #[arg(long, default_value = "full")]
    mode: String,
    /// A detector command, for example `python3 bench/plugins/snapscript.py path/to/pipeline.py`.
    #[arg(long)]
    detector: Option<String>,
    /// A decision-layer command that speaks the pollen harness protocol, for example
    /// `java -cp path/to/classes PollenHarness`.
    #[arg(long)]
    harness: Option<String>,
    /// A camera.json with the intrinsics and the pollen camera's mount. Default: 620 px focal length, 640x480,
    /// 0.30 m high, 20 degrees down.
    #[arg(long)]
    camera_json: Option<PathBuf>,
    /// The team's robot CAD as a GLB (bench/tools/parts-to-glb.mjs writes one). The robots named by
    /// --model-robots are drawn from it and sized to its footprint.
    #[arg(long)]
    robot_model: Option<PathBuf>,
    /// Which robots use --robot-model, as indices 0 to 3: red's two, then blue's.
    #[arg(long, default_value = "0")]
    model_robots: String,
    /// Gives the --model-robots a turret, as the sim models one: it aims each launch at the raised CELL.
    #[arg(long)]
    turret: bool,
    #[command(subcommand)]
    command: Option<Sub>,
}

#[derive(Subcommand, Debug, Clone)]
enum Sub {
    /// Plays MATCHES headless and writes every robot's camera frames with exact labels, for training and evaluation.
    Export(export::ExportArgs),
}

impl Args {
    pub fn sim_dir(&self) -> PathBuf {
        self.sim_dir.clone().unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    Robot,
    Tree,
    Code,
    Log,
}

/// A drag on the FIELD panel.
enum Drag {
    /// Right button: drive the selected robot to `from`, facing toward `to`.
    Steer { from: (f32, f32), to: (f32, f32) },
    /// Left button in the orbit view: turn the view. `moved` tells a drag from a click.
    Orbit { last: Point<Pixels>, moved: f32 },
}

/// What the pointer is over on the FIELD.
#[derive(Clone, Copy, PartialEq)]
enum Hover {
    Robot(usize),
    Ball(u32),
}

struct Bench {
    args: Args,
    sim: Sim,
    seed: u32,
    mode: String,
    /// The frame on screen. None follows the newest one.
    cursor: Option<usize>,
    selected: usize,
    mount: MountKind,
    view: ViewMode,
    tab: Tab,
    cam: CameraWorker,
    shown: Option<Arc<CamResult>>,
    fieldw: FieldWorker,
    fleet: camera::Fleet,
    field_img: Option<field::FieldImage>,
    retired: Vec<Arc<RenderImage>>,
    detector_on: bool,
    autopilot: bool,
    /// The last goal sent to the sim by the autopilot, so that it doesn't resend a goal that didn't move.
    sent_goal: Option<[f32; 3]>,
    last_carried: usize,
    field_bounds: Rc<Cell<Bounds<Pixels>>>,
    timeline_bounds: Rc<Cell<Bounds<Pixels>>>,
    scrubbing: bool,
    drag: Option<Drag>,
    goto: Option<[f32; 3]>,
    /// The floor point under the pointer, in world meters.
    pointer: Option<(f32, f32)>,
    /// The pointer in window pixels, for the tooltip.
    pointer_screen: (f32, f32),
    hover: Option<Hover>,
    score_open: bool,
    /// The right column's width, once dragged. None is a third of the window.
    right_w: Option<f32>,
    resizing: bool,
    vp_w: f32,
    /// Where the pointer is along the timeline, 0 to 1.
    timeline_hover: Option<f32>,
    focus: FocusHandle,
    note: Option<(String, Instant)>,
}

/// What a robot can hold at once (G407).
const CAPACITY: usize = 4;

/// The speeds [ and ] step through. 0 runs the sim as fast as it goes.
const SPEEDS: [f32; 6] = [0.25, 0.5, 1.0, 2.0, 4.0, 0.0];

fn step_speed(s: f32, by: i32) -> f32 {
    let i = SPEEDS.iter().position(|x| *x == s).unwrap_or(2) as i32;
    SPEEDS[(i + by).clamp(0, SPEEDS.len() as i32 - 1) as usize]
}

impl Bench {
    fn new(args: Args, focus: FocusHandle) -> Self {
        let fleet = camera::Fleet::load(&args).unwrap_or_else(|e| {
            eprintln!("bench: {e:#}");
            camera::Fleet::default()
        });
        let sim = Sim::spawn(args.sim_dir());
        sim.send(Cmd::Reset { seed: args.seed, mode: args.mode.clone(), bots: fleet.bots(4) });
        let cam = CameraWorker::spawn(&args, fleet.clone());
        let fieldw = FieldWorker::spawn(args.sim_dir(), fleet.clone());
        Self {
            seed: args.seed,
            mode: args.mode.clone(),
            detector_on: args.detector.is_some(),
            args,
            sim,
            cursor: None,
            selected: 0,
            mount: MountKind::Pollen,
            view: ViewMode::Plan,
            tab: Tab::Robot,
            cam,
            shown: None,
            fieldw,
            fleet,
            field_img: None,
            retired: Vec::new(),
            autopilot: false,
            sent_goal: None,
            last_carried: 0,
            field_bounds: Rc::new(Cell::new(Bounds::default())),
            timeline_bounds: Rc::new(Cell::new(Bounds::default())),
            scrubbing: false,
            drag: None,
            goto: None,
            pointer: None,
            pointer_screen: (0.0, 0.0),
            hover: None,
            score_open: false,
            right_w: None,
            resizing: false,
            vp_w: 1520.0,
            timeline_hover: None,
            focus,
            note: None,
        }
    }

    fn say(&mut self, s: impl Into<String>) {
        self.note = Some((s.into(), Instant::now()));
    }

    fn reset(&mut self, seed: u32) {
        self.seed = seed;
        self.cursor = None;
        self.autopilot = false;
        self.sent_goal = None;
        self.goto = None;
        self.cam.clear();
        self.sim.send(Cmd::Reset { seed, mode: self.mode.clone(), bots: self.fleet.bots(4) });
    }

    fn frame_index(&self, h: &History) -> usize {
        let last = h.len().saturating_sub(1);
        self.cursor.map_or(last, |c| c.min(last))
    }

    fn play_pause(&mut self) {
        let phase = self.sim.history.lock().unwrap().frames.last().map(|s| s.phase.clone()).unwrap_or_default();
        if phase == "pre" {
            self.sim.send(Cmd::Start);
            self.cursor = None;
        } else if phase == "post" {
            self.reset(self.seed + 1);
        } else {
            let p = !self.sim.playing.load(Ordering::Relaxed);
            self.sim.playing.store(p, Ordering::Relaxed);
            if p {
                self.cursor = None;
            }
        }
    }

    fn seek(&mut self, delta: i64) {
        let h = self.sim.history.lock().unwrap();
        let i = self.frame_index(&h) as i64;
        let last = h.len().saturating_sub(1) as i64;
        drop(h);
        self.sim.playing.store(false, Ordering::Relaxed);
        self.cursor = Some((i + delta).clamp(0, last.max(0)) as usize);
    }

    fn select(&mut self, i: usize) {
        if i != self.selected {
            if self.autopilot {
                self.release();
            }
            self.selected = i;
            self.cam.reset();
        }
    }

    fn drive(&mut self, cmd: serde_json::Value) {
        self.sim.send(Cmd::Drive(cmd));
    }

    fn release(&mut self) {
        self.autopilot = false;
        self.goto = None;
        self.sent_goal = None;
        self.drive(json!({ "op": "drive", "robot": self.selected, "kind": "planner" }));
    }

    fn toggle_autopilot(&mut self) {
        if self.args.harness.is_none() {
            return;
        }
        if self.autopilot {
            self.release();
            self.say("autopilot off: the planner drives");
        } else {
            self.autopilot = true;
            self.last_carried = usize::MAX;
            self.say("autopilot on: the decision layer picks the POLLEN to drive at");
        }
    }

    fn on_key(&mut self, ev: &KeyDownEvent, cx: &mut Context<Self>) {
        let k = ev.keystroke.key.as_str();
        let shift = ev.keystroke.modifiers.shift;
        match k {
            "space" => self.play_pause(),
            "left" => self.seek(if shift { -300 } else { -1 }),
            "right" => self.seek(if shift { 300 } else { 1 }),
            "home" => self.cursor = Some(0),
            "end" | "l" => self.cursor = None,
            "r" => self.reset(self.seed),
            "n" => self.reset(self.seed + 1),
            "1" | "2" | "3" | "4" => self.select(k.parse::<usize>().unwrap() - 1),
            "m" => {
                self.mount = self.mount.next();
                self.cam.reset();
            }
            "v" => self.view = if self.view == ViewMode::Plan { ViewMode::orbit() } else { ViewMode::Plan },
            "d" if self.args.detector.is_some() => {
                self.detector_on = !self.detector_on;
                self.cam.reset();
            }
            "a" => self.toggle_autopilot(),
            "x" => self.export_frame(),
            "escape" => {
                self.score_open = false;
                self.release();
            }
            "[" => self.sim.set_speed(step_speed(self.sim.speed(), -1)),
            "]" => self.sim.set_speed(step_speed(self.sim.speed(), 1)),
            _ => return,
        }
        cx.notify();
    }

    fn export_frame(&mut self) {
        let Some(r) = self.shown.clone() else { return };
        let dir = export::default_dir().join("frames");
        match export::write_frame(&dir, &r) {
            Ok(p) => self.say(format!("saved {}", p.display())),
            Err(e) => self.say(format!("export failed: {e:#}")),
        }
    }

    fn proj(&self) -> Option<Proj> {
        self.field_img.as_ref().map(|f| Proj::new(f.camera, self.field_bounds.get()))
    }

    /// The robot or ball under a screen point, robots first.
    fn hit(&self, at: Point<Pixels>) -> Option<Hover> {
        let p = self.proj()?;
        let h = self.sim.history.lock().unwrap();
        let field = h.field.clone()?;
        let state = match &self.field_img {
            Some(f) => f.state.clone(),
            None => h.frames.get(self.frame_index(&h)).cloned()?,
        };
        drop(h);
        let (sx, sy) = (f32::from(at.x), f32::from(at.y));
        let mut best: Option<(f32, Hover)> = None;
        for (i, (r, info)) in state.robots.iter().zip(field.robots.iter()).enumerate() {
            let c3 = bench_render::Vec3::new(r.x, info.height * 0.5, r.z);
            if let Some((x, y)) = p.screen(c3) {
                let reach = info.length.max(info.width) * 0.6 * p.scale_at(c3);
                let d = (x - sx).hypot(y - sy);
                if d < reach && best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, Hover::Robot(i)));
                }
            }
        }
        if best.is_some() {
            return best.map(|(_, h)| h);
        }
        for &(id, _, x, y, z, _) in &state.balls {
            let at = bench_render::Vec3::new(x, y, z);
            if let Some((bx, by)) = p.screen(at) {
                let d = (bx - sx).hypot(by - sy);
                if d < (0.05 * p.scale_at(at)).max(6.0) && best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, Hover::Ball(id)));
                }
            }
        }
        best.map(|(_, h)| h)
    }

    fn field_mouse_down(&mut self, ev: &MouseDownEvent) {
        if !self.field_bounds.get().contains(&ev.position) {
            return;
        }
        self.score_open = false;
        match ev.button {
            MouseButton::Left => {
                if matches!(self.view, ViewMode::Orbit { .. }) {
                    self.drag = Some(Drag::Orbit { last: ev.position, moved: 0.0 });
                } else if let Some(Hover::Robot(i)) = self.hit(ev.position) {
                    self.select(i);
                }
            }
            MouseButton::Right => {
                if let Some(at) = self.proj().and_then(|p| p.to_floor(f32::from(ev.position.x), f32::from(ev.position.y))) {
                    self.drag = Some(Drag::Steer { from: at, to: at });
                }
            }
            _ => {}
        }
    }

    fn field_mouse_move(&mut self, ev: &MouseMoveEvent) {
        let proj = self.proj();
        let inside = self.field_bounds.get().contains(&ev.position);
        self.pointer = if inside { proj.and_then(|p| p.to_floor(f32::from(ev.position.x), f32::from(ev.position.y))) } else { None };
        match self.drag.as_mut() {
            Some(Drag::Steer { to, .. }) => {
                if let Some(at) = self.pointer {
                    *to = at;
                }
            }
            Some(Drag::Orbit { last, moved }) => {
                let (dx, dy) = (f32::from(ev.position.x - last.x), f32::from(ev.position.y - last.y));
                *moved += dx.abs() + dy.abs();
                *last = ev.position;
                if let ViewMode::Orbit { yaw, pitch, dist } = self.view {
                    self.view = ViewMode::Orbit { yaw: yaw + dx * 0.006, pitch: (pitch + dy * 0.004).clamp(0.12, 1.5), dist };
                }
            }
            None => self.hover = if inside { self.hit(ev.position) } else { None },
        }
    }

    fn field_mouse_up(&mut self, ev: &MouseUpEvent) {
        match self.drag.take() {
            Some(Drag::Steer { from, to }) => {
                let (dx, dz) = (to.0 - from.0, to.1 - from.1);
                let heading = if dx.hypot(dz) > 0.08 { (-dz).atan2(dx) } else { f32::NAN };
                self.autopilot = false;
                self.goto = Some([from.0, from.1, heading]);
                let mut cmd = json!({ "op": "drive", "robot": self.selected, "kind": "goto", "x": from.0, "z": from.1, "intake": "all" });
                if heading.is_finite() {
                    cmd["heading"] = json!(heading);
                }
                self.drive(cmd);
            }
            Some(Drag::Orbit { moved, .. }) if moved < 4.0 => {
                if let Some(Hover::Robot(i)) = self.hit(ev.position) {
                    self.select(i);
                }
            }
            _ => {}
        }
    }

    fn scroll(&mut self, ev: &ScrollEvent) {
        if !self.field_bounds.get().contains(&ev.position) {
            return;
        }
        if let ViewMode::Orbit { yaw, pitch, dist } = self.view {
            let dy = f32::from(ev.delta.pixel_delta(px(16.0)).y);
            self.view = ViewMode::Orbit { yaw, pitch, dist: (dist * (-dy * 0.002).exp()).clamp(1.5, 12.0) };
        }
    }

    fn timeline_seek(&mut self, x: Pixels) {
        let b = self.timeline_bounds.get();
        let h = self.sim.history.lock().unwrap();
        if h.len() == 0 {
            return;
        }
        let total = panels::match_length(&self.mode, h.times.last().copied().unwrap_or(0.0));
        let t = ((f32::from(x) - f32::from(b.origin.x)) / f32::from(b.size.width).max(1.0)).clamp(0.0, 1.0) * total;
        let i = h.frame_at(t);
        let n = h.len();
        drop(h);
        self.sim.playing.store(false, Ordering::Relaxed);
        self.cursor = if i + 1 >= n { None } else { Some(i) };
    }

    /// Picks up finished images, and lets the autopilot act on the decision layer's call.
    fn pull_images(&mut self, window: &mut Window, cx: &mut App, state: &State) {
        for old in self.retired.drain(..) {
            cx.drop_image(old, Some(window));
        }
        if let Some(r) = self.cam.take() {
            if let Some(prev) = self.shown.replace(r) {
                self.retired.push(prev.image.clone());
            }
        }
        if let Some(f) = self.fieldw.take() {
            if let Some(prev) = self.field_img.replace(f) {
                self.retired.push(prev.image);
            }
        }
        if self.autopilot {
            self.autopilot_step(state);
        }
    }

    fn autopilot_step(&mut self, state: &State) {
        let Some(r) = self.shown.clone() else { return };
        if !r.live || r.robot != self.selected {
            return;
        }
        let Some(me) = state.robots.get(self.selected) else { return };
        let carried = me.carried.len();
        if self.last_carried != usize::MAX && carried > self.last_carried {
            self.cam.intaken();
            self.sent_goal = None;
        }
        self.last_carried = carried;
        // A full robot goes back to the planner to launch, and the autopilot takes it again once it is empty.
        if carried >= CAPACITY {
            if me.driver != "planner" {
                self.goto = None;
                self.sent_goal = None;
                self.say("autopilot: full, so the planner launches");
                self.drive(json!({ "op": "drive", "robot": self.selected, "kind": "planner" }));
            }
            return;
        }
        if me.driver == "planner" && carried > 0 {
            return;
        }
        let goal = r.decision.as_ref().and_then(|d| d.target.as_ref().map(|t| t.intake));
        match goal {
            Some(g) => {
                let moved = self.sent_goal.is_none_or(|s| (s[0] - g[0]).hypot(s[1] - g[1]) > 0.05 || (s[2] - g[2]).abs() > 0.1);
                if moved {
                    self.sent_goal = Some(g);
                    self.goto = Some(g);
                    self.drive(json!({ "op": "drive", "robot": self.selected, "kind": "goto", "x": g[0], "z": g[1], "heading": g[2], "intake": "pollen" }));
                }
            }
            None if self.sent_goal.is_some() || self.goto.is_none() => {
                // Nothing to drive at: turn in place, slowly, to look for POLLEN.
                self.sent_goal = None;
                self.goto = Some([me.x, me.z, f32::NAN]);
                self.drive(json!({ "op": "drive", "robot": self.selected, "kind": "inputs", "inputs": { "turnRight": 0.22, "intake": "pollen" } }));
            }
            None => {}
        }
    }

    fn request_images(&mut self, h: &History, i: usize, window: &Window) {
        let (Some(field), Some(state)) = (h.field.clone(), h.frames.get(i).cloned()) else { return };
        let live = self.cursor.is_none() && self.sim.playing.load(Ordering::Relaxed);
        self.cam.request(CamRequest { frame: i, state: state.clone(), field: field.clone(), robot: self.selected, mount: self.mount, detect: self.detector_on, live });
        // The FIELD image at the panel's size in device pixels, held to about 1.4 million pixels to stay fast.
        let b = self.field_bounds.get();
        let (w, hgt) = (f32::from(b.size.width), f32::from(b.size.height));
        let scale = window.scale_factor().min((1.4e6 / (w * hgt).max(1.0)).sqrt());
        self.fieldw.request(FieldRequest { frame: i, state, field, mode: self.view, w: (w * scale) as u32, h: (hgt * scale) as u32 });
    }

    fn field_panel(&self, h: &History, state: Option<&Arc<State>>, cx: &mut Context<Self>) -> impl IntoElement {
        let fb = self.field_bounds.clone();
        let image = self.field_img.as_ref().map(|f| f.image.clone());
        let state = self.field_img.as_ref().map(|f| f.state.clone()).or_else(|| state.cloned());
        let state = state.as_ref();
        let annotations = match (h.field.clone(), state.cloned()) {
            (Some(field), Some(state)) => {
                let shown = self.shown.clone().filter(|r| r.robot == self.selected);
                let steer = match &self.drag {
                    Some(Drag::Steer { from, to }) => {
                        let (dx, dz) = (to.0 - from.0, to.1 - from.1);
                        Some([from.0, from.1, if dx.hypot(dz) > 0.08 { (-dz).atan2(dx) } else { f32::NAN }])
                    }
                    _ => None,
                };
                Some(Annotations {
                    field,
                    state,
                    selected: self.selected,
                    footprint: shown.as_ref().map(|r| r.footprint.clone()).unwrap_or_default(),
                    calls: shown.as_ref().map(|r| r.calls.clone()).unwrap_or_default(),
                    false_pos: shown.as_ref().map(|r| r.false_ground.clone()).unwrap_or_default(),
                    decision: shown.as_ref().and_then(|r| r.decision.as_ref().map(|d| d.field.clone())),
                    goto: steer.or(self.goto),
                    hover_robot: match self.hover {
                        Some(Hover::Robot(i)) => Some(i),
                        _ => None,
                    },
                    hover_ball: match self.hover {
                        Some(Hover::Ball(id)) => Some(id),
                        _ => None,
                    },
                    plan: self.field_img.as_ref().is_some_and(|f| f.plan),
                    camera: shown.as_ref().map(|r| r.camera),
                })
            }
            _ => None,
        };
        let cam = self.field_img.as_ref().map(|f| f.camera);
        let mut stage = div().relative().size_full().overflow_hidden();
        if let Some(image) = image {
            stage = stage.child(img(image).absolute().top_0().left_0().size_full().object_fit(ObjectFit::Fill));
        } else {
            stage = stage.flex().items_center().justify_center().child(text("loading the field CAD", DIM));
        }
        stage = stage.child(
            canvas(
                move |b, _, _| fb.set(b),
                move |b, _, window, _| {
                    if let (Some(a), Some(cam)) = (&annotations, cam) {
                        field::paint(&Proj::new(cam, b), a, window);
                    }
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        );
        stage = stage.child(self.plates(h, state)).child(self.view_switch(cx)).child(self.ticks(h)).child(self.legend(h));
        if let Some(tip) = self.tooltip(h, state) {
            stage = stage.child(tip);
        }
        div().flex_1().h_full().flex().flex_col().min_w_0().child(div().flex_1().min_h_0().child(stage)).child(self.status_bar())
    }

    /// The plan or orbit switch at the panel's top left.
    fn view_switch(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let plan = self.view == ViewMode::Plan;
        div()
            .absolute()
            .top_2()
            .left_2()
            .flex()
            .gap_1()
            .p(px(2.0))
            .rounded(px(6.0))
            .bg(ca(0x0c0c0c, 0.85))
            .border_1()
            .border_color(c(LINE))
            .child(button(plan).id("plan").child("Plan").on_click(cx.listener(|b, _, _, cx| {
                b.view = ViewMode::Plan;
                cx.notify();
            })))
            .child(button(!plan).id("orbit").child("Orbit").on_click(cx.listener(|b, _, _, cx| {
                if b.view == ViewMode::Plan {
                    b.view = ViewMode::orbit();
                }
                cx.notify();
            })))
    }

    /// Whole-meter labels for the plan view's ticks.
    fn ticks(&self, h: &History) -> impl IntoElement {
        let mut layer = div().absolute().top_0().left_0().size_full();
        let (Some(field), Some(p)) = (h.field.as_ref(), self.proj()) else { return layer };
        if !self.field_img.as_ref().is_some_and(|f| f.plan) {
            return layer;
        }
        let b = self.field_bounds.get();
        let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
        let label = |s: String| div().absolute().font_family(MONO).text_size(px(10.0)).text_color(c(DIM)).child(s);
        for k in -1..=1 {
            let m = k as f32;
            if let Some((x, y)) = p.floor(m, field.half) {
                layer = layer.child(label(format!("{k:+}").replace("+0", "0")).left(px(x - ox - 6.0)).top(px(y - oy + 12.0)));
            }
            if let Some((x, y)) = p.floor(-field.half, m) {
                layer = layer.child(label(format!("{k:+}").replace("+0", "0")).left(px(x - ox - 30.0)).top(px(y - oy - 7.0)));
            }
        }
        if let (Some((x, y)), Some((lx, ly))) = (p.floor(field.half, field.half), p.floor(-field.half, 1.55)) {
            layer = layer.child(label("x m".into()).left(px(x - ox - 18.0)).top(px(y - oy + 12.0)));
            layer = layer.child(label("z m".into()).left(px(lx - ox - 30.0)).top(px(ly - oy - 7.0)));
        }
        layer
    }

    /// A key for the marks on the FIELD, listing only the ones on screen now.
    fn legend(&self, h: &History) -> impl IntoElement {
        #[derive(Clone, Copy)]
        enum G {
            Found,
            Missed,
            False,
            Track,
            Target,
            View,
        }
        let shown = self.shown.as_ref().filter(|r| r.robot == self.selected);
        let dec = shown.and_then(|r| r.decision.as_ref());
        let items: Vec<(G, &str)> = [
            (shown.is_some_and(|r| !r.footprint.is_empty()), G::View, "camera view"),
            (shown.is_some_and(|r| r.calls.iter().any(|(_, c)| *c == field::Call::Found)), G::Found, "found"),
            (shown.is_some_and(|r| r.calls.iter().any(|(_, c)| *c == field::Call::Missed)), G::Missed, "missed"),
            (shown.is_some_and(|r| !r.false_ground.is_empty()), G::False, "false detection"),
            (dec.is_some_and(|d| !d.tracks.is_empty()), G::Track, "tracked by the robot"),
            (dec.is_some_and(|d| d.target.is_some()), G::Target, "robot's target"),
        ]
        .into_iter()
        .filter(|(on, _, _)| *on)
        .map(|(_, g, s)| (g, s))
        .collect();
        let red = h.field.as_ref().and_then(|f| f.robots.get(self.selected).map(|r| r.red())).unwrap_or(true);
        let mut row = div().absolute().bottom_2().left_2().flex().gap_3().px_2().py_1().rounded(px(5.0)).bg(ca(0x0c0c0c, 0.85)).text_size(px(11.0));
        if items.is_empty() {
            return row.invisible();
        }
        for (g, s) in items {
            let glyph = canvas(|_, _, _| {}, move |b, _, window, _| {
                let (x, y) = (f32::from(b.origin.x) + 6.0, f32::from(b.origin.y) + 6.0);
                match g {
                    G::Found => field::path(window, &field::circle_pts(x, y, 4.5), c(GREEN), Some(1.5), false),
                    G::Missed => field::dashed(window, &field::circle_pts(x, y, 4.5), c(RED), 1.5, 2.0),
                    G::False => {
                        field::path(window, &[(x - 4.0, y - 4.0), (x + 4.0, y + 4.0)], c(RED), Some(1.5), false);
                        field::path(window, &[(x - 4.0, y + 4.0), (x + 4.0, y - 4.0)], c(RED), Some(1.5), false);
                    }
                    G::Track => field::path(window, &[(x, y - 4.5), (x + 4.5, y), (x, y + 4.5), (x - 4.5, y), (x, y - 4.5)], ca(HI, 0.85), Some(1.0), false),
                    G::Target => field::path(window, &field::circle_pts(x, y, 4.5), c(GREEN), Some(1.0), false),
                    G::View => field::path(window, &[(x - 5.0, y + 4.0), (x + 5.0, y + 4.0), (x + 2.0, y - 4.0), (x - 2.0, y - 4.0)], ca(alliance(red), 0.6), None, true),
                }
            })
            .size(px(12.0));
            row = row.child(div().flex().items_center().gap_1().child(glyph).child(text(s.to_string(), TEXT)));
        }
        row
    }

    /// Each robot's number and plate on a dark backing, just below it on screen.
    fn plates(&self, h: &History, state: Option<&Arc<State>>) -> impl IntoElement {
        let mut layer = div().absolute().top_0().left_0().size_full();
        let (Some(field), Some(state), Some(p)) = (h.field.as_ref(), state, self.proj()) else { return layer };
        let b = self.field_bounds.get();
        for (k, (r, info)) in state.robots.iter().zip(field.robots.iter()).enumerate() {
            let base = bench_render::Vec3::new(r.x, 0.0, r.z);
            let Some((sx, sy)) = p.screen(base) else { continue };
            let below = info.length.hypot(info.width) * 0.5 * p.scale_at(base) + 4.0;
            let sel = k == self.selected;
            layer = layer.child(
                div()
                    .absolute()
                    .left(px(sx - f32::from(b.origin.x) - 22.0))
                    .top(px(sy - f32::from(b.origin.y) + below))
                    .w(px(44.0))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .px(px(4.0))
                            .rounded(px(3.0))
                            .bg(ca(0x0c0c0c, if sel { 0.9 } else { 0.7 }))
                            .font_family(MONO)
                            .text_size(px(10.5))
                            .text_color(c(if sel { HI } else { alliance(info.red()) }))
                            .child(format!("{} {}", k + 1, info.plate)),
                    ),
            );
        }
        layer
    }

    /// What the hovered robot or ball is.
    fn tooltip(&self, h: &History, state: Option<&Arc<State>>) -> Option<impl IntoElement> {
        if self.drag.is_some() {
            return None;
        }
        let (hover, state, field) = (self.hover?, state?, h.field.as_ref()?);
        let b = self.field_bounds.get();
        let lines: Vec<(String, u32)> = match hover {
            Hover::Robot(i) => {
                let (r, info) = (state.robots.get(i)?, field.robots.get(i)?);
                vec![
                    (format!("{} {}", i + 1, info.plate), alliance(info.red())),
                    (format!("{} · {}", r.driver, if r.tactic.is_empty() { "-" } else { r.tactic.as_str() }), TEXT),
                    (format!("carries {} · {:.2} m/s", r.carried.len(), r.speed), DIM),
                ]
            }
            Hover::Ball(id) => {
                let &(_, kind, _, y, _, _) = state.balls.iter().find(|b| b.0 == id)?;
                let name = match kind {
                    model::NECTAR_RED => "red NECTAR",
                    model::NECTAR_BLUE => "blue NECTAR",
                    _ => "POLLEN",
                };
                let r = if kind == model::POLLEN { field.pollen_radius } else { field.nectar_radius };
                let place = if y < r + 0.03 { "on the floor".to_string() } else { format!("{:.2} m up", y - r) };
                let call = self.shown.as_ref().and_then(|s| s.calls.iter().find(|(i, _)| *i == id).map(|(_, c)| *c));
                let mut v = vec![(format!("{name} #{id}"), ball(kind)), (place, TEXT)];
                match call {
                    Some(field::Call::Found) => v.push(("the detector found it".into(), GREEN)),
                    Some(field::Call::Missed) => v.push(("the detector missed it".into(), RED)),
                    None => {}
                }
                v
            }
        };
        let (mx, my) = self.pointer_screen;
        let mut d = div()
            .absolute()
            .left(px(mx - f32::from(b.origin.x) + 14.0))
            .top(px(my - f32::from(b.origin.y) + 14.0))
            .flex()
            .flex_col()
            .gap(px(1.0))
            .px_2()
            .py_1()
            .rounded(px(5.0))
            .bg(c(0x161616))
            .border_1()
            .border_color(c(LINE))
            .text_size(px(11.5));
        for (s, col) in lines {
            d = d.child(text(s, col));
        }
        Some(d)
    }

    fn status_bar(&self) -> impl IntoElement {
        let note = self.note.as_ref().filter(|(_, t)| t.elapsed().as_secs() < 8).map(|(s, _)| s.clone());
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_4()
            .h(px(28.0))
            .px_3()
            .border_t_1()
            .border_color(c(LINE))
            .text_size(px(11.0))
            .child(key_hint("space", "play"))
            .child(key_hint("← →", "scrub"))
            .child(key_hint("1-4", "robot"))
            .child(key_hint("right-drag", "drive"))
            .child(key_hint("v", "view"))
            .child(key_hint("m", "camera"))
            .child(key_hint("x", "save frame"))
            .when(self.args.harness.is_some(), |d| d.child(key_hint("a", "autopilot")))
            .child(div().flex_1())
            .when_some(note, |d, n| d.child(text(n, TEXT)))
            .when_some(self.pointer, |d, (x, z)| d.child(mono(format!("x {x:+.2}  z {z:+.2} m"), DIM)))
    }
}

impl Render for Bench {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        window.request_animation_frame();
        let hist = self.sim.history.clone();
        let h = hist.lock().unwrap();
        let i = self.frame_index(&h);
        let state = h.frames.get(i).cloned();
        self.request_images(&h, i, window);
        if let Some(s) = &state {
            self.pull_images(window, cx, s);
        }
        let m = window.mouse_position();
        self.pointer_screen = (f32::from(m.x), f32::from(m.y));
        let vp = window.viewport_size();
        self.vp_w = f32::from(vp.width);
        let right_w = self.right_w.unwrap_or((self.vp_w * 0.33).clamp(400.0, 540.0)).min(self.vp_w - 480.0);

        let field_panel = self.field_panel(&h, state.as_ref(), cx);
        let right = panels::right_column(self, &h, i, state.as_deref(), right_w, cx);
        let timeline = panels::timeline(self, &h, i);
        let top = panels::top_bar(self, state.as_deref(), cx);
        let popover = if self.score_open { panels::score_popover(state.as_deref()) } else { None };
        let error = self.sim.error.lock().unwrap().clone();
        drop(h);

        div()
            .id("root")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(c(BG))
            .text_color(c(TEXT))
            .text_size(px(12.5))
            .font_family(UI)
            .on_key_down(cx.listener(|b, ev: &KeyDownEvent, _, cx| b.on_key(ev, cx)))
            .on_mouse_down(MouseButton::Left, cx.listener(|b, ev: &MouseDownEvent, _, cx| {
                let edge = b.vp_w - b.right_w.unwrap_or((b.vp_w * 0.33).clamp(400.0, 540.0)).min(b.vp_w - 480.0);
                let fb = b.field_bounds.get();
                let in_body = ev.position.y > fb.origin.y && ev.position.y < fb.origin.y + fb.size.height;
                if in_body && (f32::from(ev.position.x) - edge).abs() < 5.0 {
                    b.resizing = true;
                } else if b.timeline_bounds.get().contains(&ev.position) {
                    b.scrubbing = true;
                    b.timeline_seek(ev.position.x);
                } else {
                    b.field_mouse_down(ev);
                }
                cx.notify();
            }))
            .on_mouse_down(MouseButton::Right, cx.listener(|b, ev: &MouseDownEvent, _, cx| {
                b.field_mouse_down(ev);
                cx.notify();
            }))
            .on_mouse_move(cx.listener(|b, ev: &MouseMoveEvent, _, cx| {
                let tb = b.timeline_bounds.get();
                b.timeline_hover = tb.contains(&ev.position).then(|| f32::from(ev.position.x - tb.origin.x) / f32::from(tb.size.width).max(1.0));
                if b.resizing {
                    b.right_w = Some((b.vp_w - f32::from(ev.position.x)).clamp(360.0, 780.0));
                } else if b.scrubbing {
                    b.timeline_seek(ev.position.x);
                } else {
                    b.field_mouse_move(ev);
                }
                cx.notify();
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|b, ev: &MouseUpEvent, _, cx| {
                b.scrubbing = false;
                b.resizing = false;
                b.field_mouse_up(ev);
                cx.notify();
            }))
            .on_mouse_up(MouseButton::Right, cx.listener(|b, ev: &MouseUpEvent, _, cx| {
                b.field_mouse_up(ev);
                cx.notify();
            }))
            .on_scroll(cx.listener(|b, ev: &ScrollEvent, _, cx| {
                b.scroll(ev);
                cx.notify();
            }))
            .child(top)
            .child(div().flex().flex_1().min_h_0().child(field_panel).child(right))
            .child(timeline)
            .when_some(popover, |d, p| d.child(p))
            .when_some(error, |d, e| {
                d.child(div().absolute().top(px(52.0)).left_3().right_3().p_2().rounded(px(4.0)).bg(c(0x1a0d0d)).border_1().border_color(c(RED)).text_color(c(RED)).child(e))
            })
    }
}

fn main() {
    let args = Args::parse();
    if let Some(Sub::Export(e)) = args.command.clone() {
        if let Err(err) = export::run(&args, &e) {
            eprintln!("bench export: {err:#}");
            std::process::exit(1);
        }
        return;
    }
    gpui_platform::application().run(move |cx: &mut App| {
        let fonts = FONTS.iter().map(|b| std::borrow::Cow::Borrowed(*b)).collect();
        if let Err(e) = cx.text_system().add_fonts(fonts) {
            eprintln!("bench: the bundled fonts didn't load: {e:#}");
        }
        let bounds = Bounds::centered(None, size(px(1520.0), px(940.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                app_id: Some("bench".into()),
                titlebar: Some(gpui::TitlebarOptions { title: Some("bench".into()), ..Default::default() }),
                window_min_size: Some(size(px(1100.0), px(680.0))),
                ..Default::default()
            },
            |window, cx| {
                let focus = cx.focus_handle();
                window.focus(&focus, cx);
                cx.new(|_| Bench::new(args.clone(), focus))
            },
        )
        .unwrap();
        cx.activate(true);
    });
}
