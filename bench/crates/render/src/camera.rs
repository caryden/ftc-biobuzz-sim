use glam::{Mat3, Vec3};

/// Pinhole intrinsics in pixels, as in OpenCV: u = fx * x / z + cx, v = fy * y / z + cy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Intrinsics {
    pub fx: f32,
    pub fy: f32,
    pub cx: f32,
    pub cy: f32,
    pub width: u32,
    pub height: u32,
}

impl Intrinsics {
    /// The Limelight 3A at 640x480, with a 620 px focal length (about 54.5 degrees wide).
    pub const LIMELIGHT_3A: Intrinsics =
        Intrinsics { fx: 620.0, fy: 620.0, cx: 320.0, cy: 240.0, width: 640, height: 480 };
}

impl Default for Intrinsics {
    fn default() -> Self {
        Intrinsics::LIMELIGHT_3A
    }
}

/// A robot's place on the floor. The robot faces along (cos heading, 0, -sin heading), so heading 0 faces +X
/// (toward blue) and heading pi/2 faces -Z (toward the rear wall). This matches the sim and three.js `rotation.y`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub x: f32,
    pub z: f32,
    pub heading: f32,
}

impl Pose {
    /// Builds a pose from floor coordinates and a heading in radians.
    pub fn new(x: f32, z: f32, heading: f32) -> Pose {
        Pose { x, z, heading }
    }

    /// The unit vector the robot faces.
    pub fn forward(&self) -> Vec3 {
        Vec3::new(self.heading.cos(), 0.0, -self.heading.sin())
    }

    /// The unit vector to the robot's left: up x forward.
    pub fn left(&self) -> Vec3 {
        Vec3::new(-self.heading.sin(), 0.0, -self.heading.cos())
    }
}

/// Where a camera sits on a robot. Offsets are in the robot frame from the robot's center on the floor, so `up` is
/// the lens height above the floor. `yaw` is relative to the robot heading (0 looks forward, pi looks out the rear)
/// and `pitch` is in radians with positive tilting the camera DOWN toward the floor.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mount {
    pub forward: f32,
    pub left: f32,
    pub up: f32,
    pub yaw: f32,
    pub pitch: f32,
}

impl Mount {
    /// A pollen camera: centered, 0.30 m up, looking forward, pitched 20 degrees down.
    pub fn pollen_default() -> Mount {
        Mount { forward: 0.0, left: 0.0, up: 0.30, yaw: 0.0, pitch: 20f32.to_radians() }
    }
}

/// A pinhole camera in the world. Before pitch, the optical axis is level along (cos yaw, 0, -sin yaw), the same
/// convention as a robot heading. `pitch` is in radians and positive tilts the axis DOWN toward the floor. Roll is 0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub intrinsics: Intrinsics,
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
}

impl Camera {
    /// A camera at `position` looking along `yaw`, tilted down by `pitch`.
    pub fn new(intrinsics: Intrinsics, position: Vec3, yaw: f32, pitch: f32) -> Camera {
        Camera { intrinsics, position, yaw, pitch }
    }

    /// The camera a robot at `pose` carries on `mount`.
    pub fn on_robot(pose: Pose, mount: &Mount, intrinsics: Intrinsics) -> Camera {
        let base = Vec3::new(pose.x, 0.0, pose.z);
        let position = base + pose.forward() * mount.forward + pose.left() * mount.left + Vec3::Y * mount.up;
        Camera { intrinsics, position, yaw: pose.heading + mount.yaw, pitch: mount.pitch }
    }

    /// The optical axis in world coordinates (camera +z).
    pub fn forward(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(cp * cy, -sp, -cp * sy)
    }

    /// The image's rightward direction in world coordinates (camera +x). It stays level because roll is 0.
    pub fn right(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(sy, 0.0, cy)
    }

    /// The image's downward direction in world coordinates (camera +y).
    pub fn down(&self) -> Vec3 {
        self.forward().cross(self.right())
    }

    /// The world-to-camera rotation: its rows are right, down and forward.
    pub fn rotation(&self) -> Mat3 {
        Mat3::from_cols(self.right(), self.down(), self.forward()).transpose()
    }

    /// A world point in camera coordinates: x right, y down, z along the optical axis.
    pub fn world_to_camera(&self, p: Vec3) -> Vec3 {
        self.rotation() * (p - self.position)
    }

    /// The pixel a world point lands on, or None when it is not in front of the camera. The pixel may be outside
    /// the image.
    pub fn project(&self, p: Vec3) -> Option<[f32; 2]> {
        let c = self.world_to_camera(p);
        if c.z <= 0.0 {
            return None;
        }
        let k = &self.intrinsics;
        Some([k.fx * c.x / c.z + k.cx, k.fy * c.y / c.z + k.cy])
    }
}
