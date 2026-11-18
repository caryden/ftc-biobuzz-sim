//! Ball geometry shared by the rasterizer and the labels: the exact ray-sphere test and the analytic silhouette.
//! The labels count pixels with the same hit test the rasterizer used, so `visible` can never exceed 1.

use crate::frame::Owner;
use crate::raster::{clamp_rect, View, NEAR};
use crate::scene::ball_albedo;
use crate::{holes, Ball, BallKind};
use glam::{DMat3, DVec3, Mat3, Vec3};
use rayon::prelude::*;
use serde::{Serialize, Serializer};

/// Ground truth for one ball that projects at least partly into the image. Pixel coordinates follow OpenCV: pixel
/// (i, j) is centered at u = i, v = j.
#[derive(Clone, Debug, Serialize)]
pub struct BallLabel {
    /// The id the caller gave the ball.
    pub id: u32,
    pub kind: BallKind,
    /// The projection of the sphere's center, in pixels. It may lie outside the image.
    pub center: [f32; 2],
    /// The radius of the circle with the same area as the sphere's silhouette (an ellipse off-axis), in pixels.
    pub radius: f32,
    /// The silhouette's bounding box (u0, v0, u1, v1) in pixels, not clipped to the image.
    pub bbox: [f32; 4],
    /// Meters from the camera to the ball center.
    pub range: f32,
    /// The fraction of the in-image silhouette pixels where this ball is the front-most surface. 1 is unoccluded.
    pub visible: f32,
    /// The fraction of the silhouette's pixels that fall inside the image. 1 is uncropped.
    pub in_image: f32,
    /// The number of pixels this ball owns in the frame.
    pub pixels: u32,
    /// The ball center in world coordinates.
    #[serde(serialize_with = "vec3")]
    pub world: Vec3,
}

fn vec3<S: Serializer>(v: &Vec3, s: S) -> Result<S::Ok, S::Error> {
    v.to_array().serialize(s)
}

/// A ball in camera space, ready to draw.
pub(crate) struct BallView {
    pub index: usize,
    pub c: DVec3,
    pub r: f64,
    /// |c|^2 - r^2, constant for the ray test.
    k: f64,
    pub silhouette: Option<Silhouette>,
    /// The pixels to test when drawing (x0, x1, y0, y1, inclusive), or None when the ball misses the image.
    pub rect: Option<[usize; 4]>,
    pub albedo: Vec3,
    pub owner: u32,
    /// Turns a camera-space normal into the ball's own frame, where its holes are.
    local: Mat3,
    holes: &'static [[f32; 3]],
    hole_cos: f32,
}

/// The silhouette ellipse of a sphere fully in front of the camera.
pub(crate) struct Silhouette {
    /// (u0, u1, v0, v1) in pixels.
    pub bounds: [f64; 4],
    pub area: f64,
}

impl BallView {
    pub fn center(&self) -> Vec3 {
        self.c.as_vec3()
    }

    /// True when a camera-space surface normal falls in one of the shell's holes.
    pub fn in_hole(&self, n: Vec3) -> bool {
        let l = self.local * n;
        self.holes.iter().any(|h| l.x * h[0] + l.y * h[1] + l.z * h[2] > self.hole_cos)
    }

    /// The camera-z depth where the ray through pixel (u, v) leaves the sphere: the inside of the far wall.
    pub fn exit(&self, view: &View, u: f64, v: f64) -> f64 {
        let xn = (u - view.cx) / view.fx;
        let yn = (v - view.cy) / view.fy;
        let b = xn * self.c.x + yn * self.c.y + self.c.z;
        let a = xn * xn + yn * yn + 1.0;
        (b + (b * b - a * self.k).max(0.0).sqrt()) / a
    }

    /// The camera-z depth where the ray through pixel (u, v) first meets the sphere, if it does in front of the near
    /// plane.
    pub fn hit(&self, view: &View, u: f64, v: f64) -> Option<f64> {
        let xn = (u - view.cx) / view.fx;
        let yn = (v - view.cy) / view.fy;
        let b = xn * self.c.x + yn * self.c.y + self.c.z;
        let a = xn * xn + yn * yn + 1.0;
        let disc = b * b - a * self.k;
        if disc < 0.0 || b <= 0.0 {
            return None;
        }
        let t = (b - disc.sqrt()) / a;
        (t >= NEAR as f64).then_some(t)
    }
}

pub(crate) fn prepare(view: &View, balls: &[Ball]) -> Vec<BallView> {
    balls
        .iter()
        .enumerate()
        .filter_map(|(index, ball)| {
            let c = (view.rot * (ball.center - view.pos)).as_dvec3();
            let r = ball.radius as f64;
            if c.z + r <= NEAR as f64 {
                return None;
            }
            let silhouette = silhouette(view, c, r);
            let rect = match &silhouette {
                Some(s) => clamp_rect(view, [s.bounds[0] - 1.0, s.bounds[1] + 1.0, s.bounds[2] - 1.0, s.bounds[3] + 1.0]),
                None => Some([0, view.w - 1, 0, view.h - 1]),
            };
            Some(BallView {
                index,
                c,
                r,
                k: c.length_squared() - r * r,
                silhouette,
                rect,
                albedo: ball_albedo(ball.kind),
                owner: Owner::Ball(index as u32).raw(),
                local: Mat3::from_quat(ball.rot).transpose() * view.rot.transpose(),
                holes: if ball.kind == BallKind::Pollen { &holes::POLLEN } else { &holes::NECTAR },
                hole_cos: (if ball.kind == BallKind::Pollen { holes::POLLEN_DEG } else { holes::NECTAR_DEG }).to_radians().cos(),
            })
        })
        .collect()
}

/// The sphere's image is the conic of rays tangent to it. In normalized coordinates d = (x, y, 1) the inside is
/// (d.c)^2 >= |d|^2 (|c|^2 - r^2). It is a closed ellipse only when the sphere is entirely in front of the camera.
fn silhouette(view: &View, c: DVec3, r: f64) -> Option<Silhouette> {
    if c.z <= r * 1.000_001 {
        return None;
    }
    let k = c.length_squared() - r * r;
    let q = DMat3::from_cols(c * c.x, c * c.y, c * c.z) - DMat3::from_diagonal(DVec3::splat(k));
    let kinv = DMat3::from_cols(
        DVec3::new(1.0 / view.fx, 0.0, 0.0),
        DVec3::new(0.0, 1.0 / view.fy, 0.0),
        DVec3::new(-view.cx / view.fx, -view.cy / view.fy, 1.0),
    );
    // Negated so the 2x2 part is positive definite and the inside is where the form is <= 0.
    let m = -(kinv.transpose() * q * kinv);
    let det2 = m.x_axis.x * m.y_axis.y - m.x_axis.y * m.y_axis.x;
    let area = std::f64::consts::PI * -m.determinant() / det2.powf(1.5);
    // Tangent lines u = u0 satisfy l^T m* l = 0 for l = (1, 0, -u0), m* being the dual conic.
    let d = m.inverse();
    let roots = |ii: f64, i2: f64| {
        let s = (i2 * i2 - ii * d.z_axis.z).max(0.0).sqrt();
        let (a, b) = ((i2 - s) / d.z_axis.z, (i2 + s) / d.z_axis.z);
        (a.min(b), a.max(b))
    };
    let (u0, u1) = roots(d.x_axis.x, d.z_axis.x);
    let (v0, v1) = roots(d.y_axis.y, d.z_axis.y);
    Some(Silhouette { bounds: [u0, u1, v0, v1], area })
}

pub(crate) fn compute(view: &View, balls: &[Ball], prepared: &[BallView], ids: &[u32]) -> Vec<BallLabel> {
    prepared.par_iter().filter_map(|bv| label(view, &balls[bv.index], bv, ids)).collect()
}

fn label(view: &View, ball: &Ball, bv: &BallView, ids: &[u32]) -> Option<BallLabel> {
    if bv.c.z <= NEAR as f64 {
        return None;
    }
    let (w, h) = (view.w as i64, view.h as i64);
    // Rays are tested over the whole silhouette, off-image too, so `in_image` is a pixel ratio. A sphere crossing the
    // camera plane has an unbounded silhouette; a few image sizes around the image stand in for it.
    let region = match &bv.silhouette {
        Some(s) => [s.bounds[0].floor() as i64 - 1, s.bounds[1].ceil() as i64 + 1, s.bounds[2].floor() as i64 - 1, s.bounds[3].ceil() as i64 + 1],
        None => [-2 * w, 3 * w, -2 * h, 3 * h],
    };
    let [x0, x1, y0, y1] = [region[0].max(-2 * w), region[1].min(3 * w), region[2].max(-2 * h), region[3].min(3 * h)];
    let (mut total, mut inside, mut won) = (0u64, 0u64, 0u32);
    let mut hit_box = [f64::MAX, f64::MIN, f64::MAX, f64::MIN];
    for v in y0..=y1 {
        for u in x0..=x1 {
            if bv.hit(view, u as f64, v as f64).is_none() {
                continue;
            }
            total += 1;
            hit_box = [hit_box[0].min(u as f64), hit_box[1].max(u as f64), hit_box[2].min(v as f64), hit_box[3].max(v as f64)];
            if u >= 0 && u < w && v >= 0 && v < h {
                inside += 1;
                if ids[(v * w + u) as usize] == bv.owner {
                    won += 1;
                }
            }
        }
    }
    let (bounds, area) = match &bv.silhouette {
        Some(s) => (s.bounds, s.area),
        None => (hit_box, total as f64),
    };
    let overlaps = bounds[1] >= -0.5 && bounds[0] <= w as f64 - 0.5 && bounds[3] >= -0.5 && bounds[2] <= h as f64 - 0.5;
    if inside == 0 && !overlaps {
        return None;
    }
    let ratio = |a: u64, b: u64| if b == 0 { 0.0 } else { a as f32 / b as f32 };
    Some(BallLabel {
        id: ball.id,
        kind: ball.kind,
        center: [
            (view.fx * bv.c.x / bv.c.z + view.cx) as f32,
            (view.fy * bv.c.y / bv.c.z + view.cy) as f32,
        ],
        radius: (area / std::f64::consts::PI).sqrt() as f32,
        bbox: [bounds[0] as f32, bounds[2] as f32, bounds[1] as f32, bounds[3] as f32],
        range: bv.c.length() as f32,
        visible: ratio(won as u64, inside),
        in_image: ratio(inside, total),
        pixels: won,
        world: ball.center,
    })
}
