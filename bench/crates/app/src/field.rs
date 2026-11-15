//! The FIELD panel. A worker thread renders the field CAD with the MATCH's balls, robots and HIVES from above (plan)
//! or from an orbiting camera, and the annotations are drawn on top through the same camera, at constant pixel
//! widths.

use crate::camera::{world_of, Fleet};
use crate::model::{FieldInfo, State, POLLEN};
use crate::theme::*;
use bench_render::{Camera, Intrinsics, RenderOptions, Scene, Vec3, World};
use gpui::{point, px, Bounds, Hsla, PathBuilder, Pixels, RenderImage, Window};
use std::f32::consts::{FRAC_PI_2, PI, TAU};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

/// How the detector's call on one true ball came out, in the camera's view.
#[derive(Clone, Copy, PartialEq)]
pub enum Call {
    /// A floor POLLEN in range that the detector found.
    Found,
    /// A floor POLLEN in range that the detector missed.
    Missed,
}

/// The decision layer's view, in world meters.
#[derive(Clone, Default)]
pub struct Decision {
    pub tracks: Vec<[f32; 2]>,
    pub target: Option<Target>,
    pub locked: bool,
}

#[derive(Clone)]
pub struct Target {
    pub members: Vec<[f32; 2]>,
    pub centroid: [f32; 2],
    pub intake: [f32; 3],
    pub sweep: [f32; 2],
}

/// Where the FIELD is seen from.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ViewMode {
    /// Straight down, with the audience at the bottom.
    Plan,
    /// An orbiting camera: `yaw` is the direction it looks (0 toward blue, pi/2 toward the rear wall), `pitch` is the
    /// angle down from level, and `dist` the distance to the FIELD center.
    Orbit { yaw: f32, pitch: f32, dist: f32 },
}

impl ViewMode {
    pub fn orbit() -> Self {
        ViewMode::Orbit { yaw: FRAC_PI_2, pitch: 0.62, dist: 5.6 }
    }

    /// The camera for an image of `w` by `h` pixels.
    pub fn camera(self, w: u32, h: u32, half: f32) -> Camera {
        let (wf, hf) = (w as f32, h as f32);
        match self {
            ViewMode::Plan => {
                // High up with a long lens, so the walls and the HIVE lean out only a little.
                let height = 40.0;
                let f = wf.min(hf) * 0.96 / (2.0 * half + 0.1) * height;
                let k = Intrinsics { fx: f, fy: f, cx: wf / 2.0, cy: hf / 2.0, width: w, height: h };
                Camera::new(k, Vec3::new(0.0, height, 0.0), FRAC_PI_2, FRAC_PI_2)
            }
            ViewMode::Orbit { yaw, pitch, dist } => {
                let target = Vec3::new(0.0, 0.25, 0.0);
                let look = Vec3::new(yaw.cos() * pitch.cos(), -pitch.sin(), -yaw.sin() * pitch.cos());
                let f = hf * 1.05;
                let k = Intrinsics { fx: f, fy: f, cx: wf / 2.0, cy: hf / 2.0, width: w, height: h };
                Camera::new(k, target - look * dist, yaw, pitch)
            }
        }
    }
}

pub struct FieldRequest {
    pub frame: usize,
    pub state: Arc<State>,
    pub field: Arc<FieldInfo>,
    pub mode: ViewMode,
    pub w: u32,
    pub h: u32,
}

pub struct FieldImage {
    pub image: Arc<RenderImage>,
    pub camera: Camera,
    /// The snapshot the image shows, so the annotations line up with it exactly.
    pub state: Arc<State>,
    pub plan: bool,
}

/// Renders the FIELD panel's image on its own thread. Only the newest request is rendered.
pub struct FieldWorker {
    tx: Sender<FieldRequest>,
    out: Arc<Mutex<Option<FieldImage>>>,
    last: Option<(usize, u32, u32, [u32; 3])>,
}

fn mode_key(m: ViewMode) -> [u32; 3] {
    match m {
        ViewMode::Plan => [0; 3],
        ViewMode::Orbit { yaw, pitch, dist } => [yaw.to_bits(), pitch.to_bits(), dist.to_bits()],
    }
}

impl FieldWorker {
    pub fn spawn(sim_dir: PathBuf, fleet: Fleet) -> Self {
        let (tx, rx) = channel::<FieldRequest>();
        let out = Arc::new(Mutex::new(None));
        let o = out.clone();
        std::thread::Builder::new()
            .name("field".into())
            .spawn(move || {
                if let Ok(scene) = Scene::load(sim_dir.join("public/field.glb")) {
                    run(&scene, &fleet, rx, &o);
                }
            })
            .expect("field thread");
        Self { tx, out, last: None }
    }

    pub fn request(&mut self, r: FieldRequest) {
        let key = (r.frame, r.w, r.h, mode_key(r.mode));
        if self.last == Some(key) || r.w < 8 || r.h < 8 {
            return;
        }
        self.last = Some(key);
        let _ = self.tx.send(r);
    }

    pub fn take(&self) -> Option<FieldImage> {
        self.out.lock().unwrap().take()
    }
}

fn run(scene: &Scene, fleet: &Fleet, rx: Receiver<FieldRequest>, out: &Mutex<Option<FieldImage>>) {
    while let Ok(first) = rx.recv() {
        let r = rx.try_iter().last().unwrap_or(first);
        let camera = r.mode.camera(r.w, r.h, r.field.half);
        let (balls, robots, hive_angles) = world_of(&r.state, &r.field, None, fleet);
        let glass_alpha = if matches!(r.mode, ViewMode::Plan) { 0.0 } else { 0.08 };
        let o = scene.render(&camera, &World { balls: &balls, robots: &robots, hive_angles, robot_model: fleet.model.as_deref() }, &RenderOptions { glass_alpha, ..RenderOptions::default() });
        let image = crate::camera::to_render_image(&o.frame.rgb, o.frame.width, o.frame.height);
        *out.lock().unwrap() = Some(FieldImage { image, camera, state: r.state, plan: r.mode == ViewMode::Plan });
    }
}

/// Maps between world points and the panel's screen pixels, through the camera of the image on screen.
#[derive(Clone, Copy)]
pub struct Proj {
    pub camera: Camera,
    pub ox: f32,
    pub oy: f32,
    /// Screen pixels per image pixel.
    pub s: f32,
}

impl Proj {
    pub fn new(camera: Camera, bounds: Bounds<Pixels>) -> Self {
        let s = f32::from(bounds.size.width) / camera.intrinsics.width as f32;
        Self { camera, ox: f32::from(bounds.origin.x), oy: f32::from(bounds.origin.y), s }
    }

    pub fn screen(&self, p: Vec3) -> Option<(f32, f32)> {
        let [u, v] = self.camera.project(p)?;
        Some((self.ox + u * self.s, self.oy + v * self.s))
    }

    pub fn floor(&self, x: f32, z: f32) -> Option<(f32, f32)> {
        self.screen(Vec3::new(x, 0.003, z))
    }

    /// The floor point under a screen pixel, if the ray hits the floor.
    pub fn to_floor(self, sx: f32, sy: f32) -> Option<(f32, f32)> {
        let k = self.camera.intrinsics;
        let (u, v) = ((sx - self.ox) / self.s, (sy - self.oy) / self.s);
        let d = self.camera.forward() + self.camera.right() * ((u - k.cx) / k.fx) + self.camera.down() * ((v - k.cy) / k.fy);
        if d.y >= -1e-4 {
            return None;
        }
        let t = -self.camera.position.y / d.y;
        let p = self.camera.position + d * t;
        Some((p.x, p.z))
    }

    /// Screen pixels per meter at a world point, for sizing marks.
    pub fn scale_at(&self, p: Vec3) -> f32 {
        let c = self.camera.world_to_camera(p);
        if c.z <= 0.0 { 0.0 } else { self.camera.intrinsics.fx / c.z * self.s }
    }
}

pub struct Annotations {
    pub field: Arc<FieldInfo>,
    pub state: Arc<State>,
    pub selected: usize,
    /// The ground the selected robot's camera sees, as a world polygon.
    pub footprint: Vec<[f32; 2]>,
    pub calls: Vec<(u32, Call)>,
    /// Detections that matched no floor POLLEN, at their ground position.
    pub false_pos: Vec<[f32; 2]>,
    pub decision: Option<Decision>,
    pub goto: Option<[f32; 3]>,
    pub hover_robot: Option<usize>,
    pub hover_ball: Option<u32>,
    /// From straight above, robots are drawn over the HIVE, so one driving under it stays in sight.
    pub plan: bool,
    /// The selected robot's camera, drawn as a frustum in the orbit view.
    pub camera: Option<Camera>,
}

pub fn path(window: &mut Window, pts: &[(f32, f32)], col: Hsla, width: Option<f32>, close: bool) {
    if pts.len() < 2 {
        return;
    }
    let mut b = match width {
        Some(w) => PathBuilder::stroke(px(w)),
        None => PathBuilder::fill(),
    };
    b.move_to(point(px(pts[0].0), px(pts[0].1)));
    for p in &pts[1..] {
        b.line_to(point(px(p.0), px(p.1)));
    }
    if close {
        b.close();
    }
    if let Ok(p) = b.build() {
        window.paint_path(p, col);
    }
}

pub fn circle_pts(cx: f32, cy: f32, r: f32) -> Vec<(f32, f32)> {
    let n = (r * 1.6).clamp(12.0, 48.0) as usize;
    (0..=n)
        .map(|i| {
            let a = i as f32 / n as f32 * TAU;
            (cx + r * a.cos(), cy + r * a.sin())
        })
        .collect()
}

pub fn dashed(window: &mut Window, pts: &[(f32, f32)], col: Hsla, w: f32, dash: f32) {
    for seg in pts.windows(2) {
        let (a, b) = (seg[0], seg[1]);
        let len = (b.0 - a.0).hypot(b.1 - a.1);
        let n = (len / dash).ceil().max(1.0) as usize;
        for k in (0..n).step_by(2) {
            let t0 = k as f32 / n as f32;
            let t1 = ((k + 1) as f32 / n as f32).min(1.0);
            let p = |t: f32| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            path(window, &[p(t0), p(t1)], col, Some(w), false);
        }
    }
}

/// The four corners of a robot's footprint, front left first.
pub fn robot_corners(x: f32, z: f32, heading: f32, length: f32, width: f32) -> [(f32, f32); 4] {
    let (f, l) = ((heading.cos(), -heading.sin()), (-heading.sin(), -heading.cos()));
    let (hl, hw) = (length / 2.0, width / 2.0);
    let p = |a: f32, b: f32| (x + f.0 * a + l.0 * b, z + f.1 * a + l.1 * b);
    [p(hl, hw), p(hl, -hw), p(-hl, -hw), p(-hl, hw)]
}

/// A polygon on the floor, on screen. Corners behind the camera are dropped.
fn floor_poly(p: &Proj, pts: &[(f32, f32)], close: bool) -> Vec<(f32, f32)> {
    let mut out: Vec<_> = pts.iter().filter_map(|q| p.floor(q.0, q.1)).collect();
    if close && !out.is_empty() {
        out.push(out[0]);
    }
    out
}

pub fn paint(p: &Proj, a: &Annotations, window: &mut Window) {
    let s = &a.state;
    let sel_red = a.field.robots.get(a.selected).is_some_and(|r| r.red());

    // The selected robot's camera: the floor it sees, out to the detector's range, tinted with its alliance.
    if a.footprint.len() >= 3 {
        let pts: Vec<(f32, f32)> = a.footprint.iter().map(|q| (q[0], q[1])).collect();
        path(window, &floor_poly(p, &pts, false), ca(alliance(sel_red), 0.08), None, true);
        path(window, &floor_poly(p, &pts, true), ca(alliance(sel_red), 0.45), Some(1.0), false);
    }

    // Planned paths: the selected robot's bright, the others quiet.
    for (i, (r, info)) in s.robots.iter().zip(a.field.robots.iter()).enumerate() {
        if r.path.len() < 2 {
            continue;
        }
        let mut pts = vec![(r.x, r.z)];
        pts.extend(r.path.iter().skip(1).map(|q| (q[0], q[1])));
        let col = ca(alliance(info.red()), if i == a.selected { 0.95 } else { 0.35 });
        dashed(window, &floor_poly(p, &pts, false), col, if i == a.selected { 1.5 } else { 1.0 }, 5.0);
    }

    // Meter ticks along the near and left walls, for reading positions off the plan.
    if a.plan {
        let h = a.field.half;
        for k in -3..=3 {
            let m = k as f32 * 0.5;
            let len = if k % 2 == 0 { 8.0 } else { 4.0 };
            if let Some((x, y)) = p.floor(m, h) {
                path(window, &[(x, y + 3.0), (x, y + 3.0 + len)], ca(HI, 0.45), Some(1.0), false);
            }
            if let Some((x, y)) = p.floor(-h, m) {
                path(window, &[(x - 3.0, y), (x - 3.0 - len, y)], ca(HI, 0.45), Some(1.0), false);
            }
        }
        for (r, info) in s.robots.iter().zip(a.field.robots.iter()) {
            let corners = robot_corners(r.x, r.z, r.heading, info.length, info.width);
            let pts: Vec<_> = corners.iter().filter_map(|q| p.screen(Vec3::new(q.0, info.height, q.1))).collect();
            if pts.len() == 4 {
                path(window, &pts, ca(0x2a2d31, 0.45), None, true);
                let mut o = pts.clone();
                o.push(o[0]);
                path(window, &o, c(alliance(info.red())), Some(2.5), false);
            }
        }
    }

    // Selection and hover outlines turn with the robot, 4 cm outside its bumpers. Every robot gets a heading tick
    // on its top, and what it carries.
    for (i, (r, info)) in s.robots.iter().zip(a.field.robots.iter()).enumerate() {
        let lift = |q: (f32, f32), y: f32| p.screen(Vec3::new(q.0, y, q.1));
        if i == a.selected || a.hover_robot == Some(i) {
            let grow = robot_corners(r.x, r.z, r.heading, info.length + 0.08, info.width + 0.08);
            let mut o: Vec<_> = grow.iter().filter_map(|q| lift(*q, 0.02)).collect();
            if !o.is_empty() {
                o.push(o[0]);
            }
            let col = if i == a.selected { ca(HI, 0.95) } else { ca(HI, 0.4) };
            path(window, &o, col, Some(2.0), false);
        }
        let top = info.height + 0.005;
        let (fx, fz) = (r.heading.cos(), -r.heading.sin());
        if let (Some(c0), Some(c1)) = (lift((r.x, r.z), top), lift((r.x + fx * info.length * 0.46, r.z + fz * info.length * 0.46), top)) {
            path(window, &[c0, c1], ca(HI, 0.9), Some(2.0), false);
        }
        let n = r.carried.len() as f32;
        let (lx, lz) = (-r.heading.sin(), -r.heading.cos());
        for (k, kind) in r.carried.iter().enumerate() {
            let off = (k as f32 - (n - 1.0) / 2.0) * 0.07;
            let at = Vec3::new(r.x - fx * 0.1 + lx * off, top, r.z - fz * 0.1 + lz * off);
            if let Some((bx, by)) = p.screen(at) {
                let rr = (0.027 * p.scale_at(at)).max(2.5);
                path(window, &circle_pts(bx, by, rr), c(ball(*kind)), None, true);
                path(window, &circle_pts(bx, by, rr), ca(0x000000, 0.55), Some(1.0), false);
            }
        }
    }

    // The detector's calls on the balls the selected camera can see, and the hovered ball.
    for &(id, kind, x, y, z, _) in &s.balls {
        let call = a.calls.iter().find(|(i, _)| *i == id).map(|(_, c)| *c);
        let hovered = a.hover_ball == Some(id);
        if call.is_none() && !hovered {
            continue;
        }
        let r = if kind == POLLEN { a.field.pollen_radius } else { a.field.nectar_radius };
        let at = Vec3::new(x, y, z);
        let Some((sx, sy)) = p.screen(at) else { continue };
        let ring = circle_pts(sx, sy, r * p.scale_at(at) + 4.0);
        match call {
            Some(Call::Found) => path(window, &ring, c(GREEN), Some(1.5), false),
            Some(Call::Missed) => dashed(window, &ring, c(RED), 1.5, 3.0),
            None => {}
        }
        if hovered {
            path(window, &circle_pts(sx, sy, r * p.scale_at(at) + 7.0), ca(HI, 0.8), Some(1.0), false);
        }
    }
    for q in &a.false_pos {
        let Some((sx, sy)) = p.floor(q[0], q[1]) else { continue };
        let d = 4.5;
        path(window, &[(sx - d, sy - d), (sx + d, sy + d)], c(RED), Some(1.5), false);
        path(window, &[(sx - d, sy + d), (sx + d, sy - d)], c(RED), Some(1.5), false);
    }

    if let (false, Some(cam)) = (a.plan, a.camera) {
        paint_frustum(p, &cam, window);
    }
    paint_decision(p, a, window);

    if let Some([x, z, hd]) = a.goto {
        if let Some((sx, sy)) = p.floor(x, z) {
            path(window, &circle_pts(sx, sy, 7.0), c(HI), Some(1.5), false);
            if hd.is_finite() {
                if let Some(tip) = p.floor(x + hd.cos() * 0.25, z - hd.sin() * 0.25) {
                    path(window, &[(sx, sy), tip], c(HI), Some(1.5), false);
                }
            }
        }
    }
}

/// The camera as a pyramid out to 0.6 m, so the orbit view shows where it looks from and how much it takes in.
fn paint_frustum(p: &Proj, cam: &Camera, window: &mut Window) {
    let k = cam.intrinsics;
    let (w, h) = (k.width as f32, k.height as f32);
    let corner = |u: f32, v: f32| {
        let d = (cam.forward() + cam.right() * ((u - k.cx) / k.fx) + cam.down() * ((v - k.cy) / k.fy)).normalize();
        p.screen(cam.position + d * 0.6)
    };
    let (Some(o), Some(a), Some(b), Some(c2), Some(d)) = (p.screen(cam.position), corner(0.0, 0.0), corner(w, 0.0), corner(w, h), corner(0.0, h)) else {
        return;
    };
    let col = ca(HI, 0.75);
    for q in [a, b, c2, d] {
        path(window, &[o, q], col, Some(1.0), false);
    }
    path(window, &[a, b, c2, d, a], col, Some(1.5), false);
    path(window, &[a, b, c2, d], ca(HI, 0.08), None, true);
}

fn paint_decision(p: &Proj, a: &Annotations, window: &mut Window) {
    let Some(d) = &a.decision else { return };
    // Tracks are where the decision layer believes POLLEN is: small diamonds, so they don't read as balls.
    for t in &d.tracks {
        let Some((sx, sy)) = p.floor(t[0], t[1]) else { continue };
        let r = 5.0;
        path(window, &[(sx, sy - r), (sx + r, sy), (sx, sy + r), (sx - r, sy), (sx, sy - r)], ca(HI, 0.85), Some(1.0), false);
    }
    let Some(t) = &d.target else { return };
    let col = if d.locked { c(GREEN) } else { ca(HI, 0.8) };
    let reach = t.members.iter().map(|m| (m[0] - t.centroid[0]).hypot(m[1] - t.centroid[1])).fold(0.0f32, f32::max) + 0.09;
    let ring: Vec<(f32, f32)> = (0..=40)
        .map(|i| {
            let ang = i as f32 / 40.0 * TAU;
            (t.centroid[0] + reach * ang.cos(), t.centroid[1] + reach * ang.sin())
        })
        .collect();
    path(window, &floor_poly(p, &ring, false), col, Some(1.5), false);
    if let (Some(i), Some(e)) = (p.floor(t.intake[0], t.intake[1]), p.floor(t.sweep[0], t.sweep[1])) {
        dashed(window, &[i, e], col, 1.5, 4.0);
    }
    // The intake pose, as an arrowhead on the floor.
    let h = t.intake[2];
    let tri = [0.0f32, 0.8 * PI, -0.8 * PI].map(|da| {
        let len = if da == 0.0 { 0.12 } else { 0.08 };
        (t.intake[0] + (h + da).cos() * len, t.intake[1] - (h + da).sin() * len)
    });
    path(window, &floor_poly(p, &tri, false), col, None, true);
}
