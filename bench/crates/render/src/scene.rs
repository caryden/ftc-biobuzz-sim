use crate::frame::{Owner, Rendered};
use crate::shade::hex;
use crate::{glb, raster, Alliance, Camera, RenderOptions, Robot, World};
use anyhow::{Context, Result};
use glam::{Mat4, Vec3};
use std::path::Path;

/// A triangle with its face normal and linear albedo. The normal's sign is arbitrary because the CAD's winding is
/// not consistent; the rasterizer flips it toward the camera.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tri {
    pub v: [Vec3; 3],
    pub n: Vec3,
    pub albedo: Vec3,
    pub owner: u32,
}

impl Tri {
    /// None for a degenerate triangle, which has no normal and covers no pixels.
    fn new(v: [Vec3; 3], albedo: Vec3, owner: u32) -> Option<Tri> {
        let n = (v[1] - v[0]).cross(v[2] - v[0]);
        let len = n.length();
        (len > 1e-12).then(|| Tri { v, n: n / len, albedo, owner })
    }
}

/// A HIVE mesh in pivot-local coordinates, plus the pivot's node transform from the CAD.
pub(crate) struct Hive {
    pub tris: Vec<Tri>,
    /// The CELL skins, which are clear polycarbonate on the real HIVE.
    pub glass: Vec<Tri>,
    pub pivot: Mat4,
}

/// The static field, loaded once: the CAD triangles, the clear perimeter panels, and the two HIVEs, which move.
pub struct Scene {
    pub(crate) field: Vec<Tri>,
    pub(crate) glass: Vec<Tri>,
    pub(crate) hives: [Hive; 2],
    node_names: Vec<String>,
}

impl Scene {
    /// Loads the field CAD (`public/field.glb`). Every node is drawn as static geometry except `hive_red` and
    /// `hive_blue`, which rotate about their node origin. Light perimeter panels become see-through glass, as in the
    /// web view, because the real panels are clear polycarbonate.
    pub fn load(path: impl AsRef<Path>) -> Result<Scene> {
        let nodes = glb::load(path.as_ref())?;
        let mut field = Vec::new();
        let mut glass = Vec::new();
        let mut hives: [Option<Hive>; 2] = [None, None];
        for (index, node) in nodes.iter().enumerate() {
            let hive = match node.name.as_str() {
                "hive_red" => Some(0),
                "hive_blue" => Some(1),
                _ => None,
            };
            if let Some(a) = hive {
                let owner = Owner::Hive(if a == 0 { Alliance::Red } else { Alliance::Blue }).raw();
                // The CELL skins are the light gray material, 0.791 in linear RGB; the trim, frame and tags stay solid.
                let skin = |c: [f32; 4]| (c[0] - 0.791).abs() < 0.02 && (c[1] - 0.791).abs() < 0.02 && (c[2] - 0.791).abs() < 0.02;
                let (tris, glass) = triangles(node, Mat4::IDENTITY, owner, skin);
                hives[a] = Some(Hive { tris, glass, pivot: node.transform });
                continue;
            }
            let see_through = |c: [f32; 4]| node.name == "perimeter" && c[0] > 0.4 && c[1] > 0.4;
            let (solid, clear) = triangles(node, node.transform, Owner::Field(index as u32).raw(), see_through);
            field.extend(solid);
            glass.extend(clear);
        }
        let [red, blue] = hives;
        Ok(Scene {
            field,
            glass,
            hives: [red.context("no hive_red node in the field CAD")?, blue.context("no hive_blue node in the field CAD")?],
            node_names: nodes.into_iter().map(|n| n.name).collect(),
        })
    }

    /// A scene with only the floor: no CAD and no HIVE geometry. Useful for tests and for isolating balls.
    pub fn empty() -> Scene {
        let pivot = |x: f32| Hive { tris: Vec::new(), glass: Vec::new(), pivot: Mat4::from_translation(Vec3::new(x, 1.1165, 0.0)) };
        Scene { field: Vec::new(), glass: Vec::new(), hives: [pivot(-0.3236), pivot(0.3241)], node_names: Vec::new() }
    }

    /// Renders one frame and its ball labels. See [`World`] for the inputs and [`crate::BallLabel`] for the outputs.
    pub fn render(&self, camera: &Camera, world: &World, options: &RenderOptions) -> Rendered {
        raster::render(self, camera, world, options)
    }

    /// The number of triangles loaded: solid field, glass and both HIVEs.
    pub fn triangle_count(&self) -> usize {
        self.field.len() + self.glass.len() + self.hives.iter().map(|h| h.tris.len() + h.glass.len()).sum::<usize>()
    }

    /// The world position of a HIVE's pivot.
    pub fn hive_pivot(&self, alliance: Alliance) -> Vec3 {
        self.hives[alliance as usize].pivot.w_axis.truncate()
    }

    /// The CAD node names, indexed by the value in [`Owner::Field`].
    pub fn node_names(&self) -> &[String] {
        &self.node_names
    }
}

/// A node's triangles under `transform`, split into solid ones and the ones `clear` picks out by material color.
fn triangles(node: &glb::Node, transform: Mat4, owner: u32, clear: impl Fn([f32; 4]) -> bool) -> (Vec<Tri>, Vec<Tri>) {
    let mut solid = Vec::new();
    let mut glass = Vec::new();
    for prim in &node.primitives {
        let albedo = Vec3::new(prim.color[0], prim.color[1], prim.color[2]);
        let out = if clear(prim.color) { &mut glass } else { &mut solid };
        for f in prim.indices.chunks_exact(3) {
            let v = [0, 1, 2].map(|k| transform.transform_point3(prim.positions[f[k] as usize]));
            out.extend(Tri::new(v, albedo, owner));
        }
    }
    (solid, glass)
}

const BUMPER_LOW: f32 = 0.06;
const BUMPER_HIGH: f32 = 0.13;
const BUMPER_THICK: f32 = 0.05;
/// How far the bumpers stand out past the chassis outline.
const BUMPER_PROUD: f32 = 0.02;
const CHASSIS_LOW: f32 = 0.012;

/// A robot's own CAD, from a GLB in the robot's frame: +X forward, Y up, +Z to the robot's right, standing on the
/// floor centered at the origin. `bench/tools/parts-to-glb.mjs` writes one from an Onshape STEP export.
#[derive(Debug)]
pub struct RobotModel {
    tris: Vec<Tri>,
    /// Length (X), height (Y) and width (Z), in meters.
    pub size: Vec3,
}

impl RobotModel {
    pub fn load(path: impl AsRef<Path>) -> Result<RobotModel> {
        let nodes = glb::load(path.as_ref())?;
        let tris: Vec<Tri> = nodes.iter().flat_map(|n| triangles(n, n.transform, 0, |_| false).0).collect();
        let (mut lo, mut hi) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
        for t in &tris {
            for v in t.v {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        anyhow::ensure!(!tris.is_empty(), "no triangles in {}", path.as_ref().display());
        Ok(RobotModel { tris, size: hi - lo })
    }
}

/// A robot as triangles in world coordinates: the team's CAD inside its bumpers when `model` is given, or else a
/// stand-in.
pub(crate) fn robot_tris(robot: &Robot, index: u32, model: Option<&RobotModel>) -> Vec<Tri> {
    match model.filter(|_| robot.model) {
        Some(m) => {
            let owner = Owner::Robot(index).raw();
            let (f, l) = (robot.pose.forward(), robot.pose.left());
            let origin = Vec3::new(robot.pose.x, 0.0, robot.pose.z);
            let place = |v: Vec3| origin + f * v.x + Vec3::Y * v.y - l * v.z;
            let mut out: Vec<Tri> = m.tris.iter().filter_map(|t| Tri::new(t.v.map(place), t.albedo, owner)).collect();
            out.extend(bumper_tris(robot, owner));
            out
        }
        None => stand_in_tris(robot, index),
    }
}

/// The four alliance bumper bars around a robot's footprint.
fn bumper_tris(robot: &Robot, owner: u32) -> Vec<Tri> {
    let bumper = match robot.alliance {
        Alliance::Red => hex(0xd8261c),
        Alliance::Blue => hex(0x1f4fd8),
    };
    let (ol, ow) = (robot.length / 2.0 + BUMPER_PROUD, robot.width / 2.0 + BUMPER_PROUD);
    let (mid, hb, t) = ((BUMPER_LOW + BUMPER_HIGH) / 2.0, (BUMPER_HIGH - BUMPER_LOW) / 2.0, BUMPER_THICK / 2.0);
    let boxes = [([ol - t, 0.0], [t, ow]), ([-ol + t, 0.0], [t, ow]), ([0.0, ow - t], [ol - 2.0 * t, t]), ([0.0, -ow + t], [ol - 2.0 * t, t])];
    let (f, l) = (robot.pose.forward(), robot.pose.left());
    let origin = Vec3::new(robot.pose.x, 0.0, robot.pose.z);
    let mut out = Vec::new();
    for (c, h) in boxes {
        push_box(&mut out, origin + f * c[0] + l * c[1] + Vec3::Y * mid, [f * h[0], l * h[1], Vec3::Y * hb], bumper, owner);
    }
    out
}

/// A stand-in for a typical BIOBUZZ build: a low chassis, four wheels, alliance bumpers, an intake roller across the
/// front, two uprights and a shooter housing at the rear.
fn stand_in_tris(robot: &Robot, index: u32) -> Vec<Tri> {
    let owner = Owner::Robot(index).raw();
    let frame = hex(0x3d4147);
    let plate = hex(0x5c6168);
    let tread = hex(0x1b1c1e);
    let roller = hex(0x2e7d32);
    let flywheel = hex(0x8a8f96);
    let bumper = match robot.alliance {
        Alliance::Red => hex(0xd8261c),
        Alliance::Blue => hex(0x1f4fd8),
    };
    let (hl, hw, top) = (robot.length / 2.0, robot.width / 2.0, robot.height);
    let (ol, ow) = (hl + BUMPER_PROUD, hw + BUMPER_PROUD);
    let mid = (BUMPER_LOW + BUMPER_HIGH) / 2.0;
    let hb = (BUMPER_HIGH - BUMPER_LOW) / 2.0;
    let t = BUMPER_THICK / 2.0;
    let wr = 0.048;
    // Boxes as (forward, left, up) center and half sizes in the robot frame. The front is the intake.
    let mut boxes = vec![
        // The drive base: a low tray and a top plate.
        ([0.0, 0.0, (CHASSIS_LOW + 0.07) / 2.0], [hl - 0.01, hw - 0.05, (0.07 - CHASSIS_LOW) / 2.0], frame),
        ([0.0, 0.0, 0.075], [hl - 0.04, hw - 0.06, 0.006], plate),
        // Side rails and a rear crossmember, as on a channel drive base. The front stays open for the intake.
        ([0.0, hw - 0.02, 0.095], [hl - 0.01, 0.008, 0.085], frame),
        ([0.0, -hw + 0.02, 0.095], [hl - 0.01, 0.008, 0.085], frame),
        ([-hl + 0.02, 0.0, 0.095], [0.008, hw - 0.02, 0.085], frame),
        // The intake roller across the front, low enough to sweep balls in.
        ([hl - 0.03, 0.0, 0.065], [0.025, hw - 0.03, 0.025], roller),
        // Two uprights, and the shooter housing between them at the rear.
        ([-hl * 0.35, hw - 0.07, (0.08 + top) / 2.0], [0.015, 0.015, (top - 0.08) / 2.0], frame),
        ([-hl * 0.35, -hw + 0.07, (0.08 + top) / 2.0], [0.015, 0.015, (top - 0.08) / 2.0], frame),
        ([-hl * 0.55, 0.0, top - 0.07], [hl * 0.3, hw * 0.45, 0.07], plate),
        ([-hl * 0.55, 0.0, top + 0.003], [0.05, 0.05, 0.004], flywheel),
        // Bumpers.
        ([ol - t, 0.0, mid], [t, ow, hb], bumper),
        ([-ol + t, 0.0, mid], [t, ow, hb], bumper),
        ([0.0, ow - t, mid], [ol - 2.0 * t, t, hb], bumper),
        ([0.0, -ow + t, mid], [ol - 2.0 * t, t, hb], bumper),
    ];
    // Four wheels just inside the bumpers.
    for (f, l) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
        boxes.push(([f * (hl - 0.09), l * (hw - 0.035), wr], [wr, 0.02, wr], tread));
    }
    let (f, l) = (robot.pose.forward(), robot.pose.left());
    let origin = Vec3::new(robot.pose.x, 0.0, robot.pose.z);
    let mut out = Vec::with_capacity(boxes.len() * 12);
    for (c, h, albedo) in boxes {
        let center = origin + f * c[0] + l * c[1] + Vec3::Y * c[2];
        push_box(&mut out, center, [f * h[0], l * h[1], Vec3::Y * h[2]], albedo, owner);
    }
    out
}

/// Twelve triangles of a box with these half-axis vectors.
fn push_box(out: &mut Vec<Tri>, center: Vec3, axes: [Vec3; 3], albedo: Vec3, owner: u32) {
    for k in 0..3 {
        let (a, b, c) = (axes[k], axes[(k + 1) % 3], axes[(k + 2) % 3]);
        for s in [1.0, -1.0] {
            let face = center + a * s;
            let q = [face - b - c, face + b - c, face + b + c, face - b + c];
            out.extend(Tri::new([q[0], q[1], q[2]], albedo, owner));
            out.extend(Tri::new([q[0], q[2], q[3]], albedo, owner));
        }
    }
}

/// Linear albedo for a ball kind, from the web view's sRGB colors.
pub(crate) fn ball_albedo(kind: crate::BallKind) -> Vec3 {
    match kind {
        crate::BallKind::Pollen => hex(0xf2c81e),
        crate::BallKind::NectarRed => hex(0xd8261c),
        crate::BallKind::NectarBlue => hex(0x1f4fd8),
    }
}

