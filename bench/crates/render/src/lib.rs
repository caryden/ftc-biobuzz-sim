//! CPU renderer for what a robot-mounted camera sees on the BIOBUZZ field, with exact labels for every ball.
//!
//! World frame: the field CAD frame, in meters. X runs from red to blue (red alliance at x < 0), Y is up, and Z runs
//! from the rear wall to the audience. Camera frame: x right, y down, z along the optical axis (the OpenCV
//! convention), so image u grows to the right and v grows downward.
//!
//! Load the field once with [`Scene::load`], then call [`Scene::render`] per frame with a [`Camera`] and a [`World`]
//! that holds the balls, robots and HIVE angles from the physics sim.

mod camera;
mod floor;
mod frame;
mod glb;
mod labels;
mod post;
mod raster;
mod scene;
mod shade;

pub use camera::{Camera, Intrinsics, Mount, Pose};
pub use frame::{rgb_to_bgr_in_place, Frame, Owner, Rendered};
pub use glam::Vec3;
pub use labels::BallLabel;
pub use post::PostFx;
pub use scene::Scene;

use serde::Serialize;

/// Half the width of the field inside the perimeter wall, in meters (`FIELD.half` in src/sim/config.ts).
pub const FIELD_HALF: f32 = 1.7929;
/// POLLEN radius in meters: a 2.8 in. ball.
pub const POLLEN_RADIUS: f32 = 0.03556;
/// NECTAR radius in meters: a 3.6 in. ball.
pub const NECTAR_RADIUS: f32 = 0.04572;

/// Which alliance a robot, a HIVE or a NECTAR belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Alliance {
    Red,
    Blue,
}

/// The three kinds of scoring element.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BallKind {
    Pollen,
    NectarRed,
    NectarBlue,
}

impl BallKind {
    /// The game's radius for this kind, in meters.
    pub fn radius(self) -> f32 {
        match self {
            BallKind::Pollen => POLLEN_RADIUS,
            BallKind::NectarRed | BallKind::NectarBlue => NECTAR_RADIUS,
        }
    }
}

/// One ball in the sim: a sphere with a caller-chosen id that comes back in its label.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ball {
    pub id: u32,
    pub kind: BallKind,
    pub center: Vec3,
    pub radius: f32,
}

impl Ball {
    /// A ball of the given kind with the game's radius for that kind.
    pub fn new(id: u32, kind: BallKind, center: Vec3) -> Ball {
        Ball { id, kind, center, radius: kind.radius() }
    }

    /// A ball of the given kind resting on the floor at (x, z).
    pub fn on_floor(id: u32, kind: BallKind, x: f32, z: f32) -> Ball {
        let r = kind.radius();
        Ball { id, kind, center: Vec3::new(x, r, z), radius: r }
    }
}

/// A robot drawn as a chassis box with alliance-colored bumpers. Sizes are in meters; `length` runs along the heading.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Robot {
    pub pose: Pose,
    pub length: f32,
    pub width: f32,
    pub height: f32,
    pub alliance: Alliance,
}

impl Robot {
    /// An 18 in. square robot, 0.30 m tall, the sim's default size.
    pub fn new(pose: Pose, alliance: Alliance) -> Robot {
        Robot { pose, length: 0.43, width: 0.43, height: 0.30, alliance }
    }
}

/// The moving parts of one frame, straight from the sim.
#[derive(Clone, Copy, Debug, Default)]
pub struct World<'a> {
    pub balls: &'a [Ball],
    /// Robots to draw. Leave out the robot carrying the camera unless its body should show in the image.
    pub robots: &'a [Robot],
    /// The final rotation of each HIVE about its pivot's local X axis, in radians, `[red, blue]`. The web view uses
    /// `phi + tiltLimit` for red and `phi - tiltLimit` for blue; 0 is the pose stored in the CAD.
    pub hive_angles: [f32; 2],
}

/// Per-frame switches. The default is a clean render with ball shadows and faint perimeter panels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderOptions {
    /// Draws a soft contact shadow on the floor under each ball.
    pub ball_shadows: bool,
    /// Opacity of the clear polycarbonate perimeter panels. 0 skips them.
    pub glass_alpha: f32,
    /// Blur and sensor noise applied after the labels are computed. Off by default.
    pub post: PostFx,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions { ball_shadows: true, glass_alpha: 0.06, post: PostFx::default() }
    }
}
