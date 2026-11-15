//! Lighting: one directional sun from above plus a sky/ground ambient term, computed in linear light and stored as
//! sRGB. The floor gets exactly its nominal color under this light, so the CAD and the tiles agree.

use glam::Vec3;
use std::sync::OnceLock;

/// Unit vector toward the sun: the web view's (-2, 6, 3), which has length 7.
pub(crate) const LIGHT: Vec3 = Vec3::new(-2.0 / 7.0, 6.0 / 7.0, 3.0 / 7.0);
pub(crate) const SUN: f32 = 0.70;
const SPECULAR: f32 = 0.18;

/// Ambient light for a surface whose unit normal has this world Y: brighter facing up, darker facing down.
pub(crate) fn ambient(normal_y: f32) -> f32 {
    0.22 + 0.09 * (1.0 + normal_y)
}

pub(crate) fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// A 0xRRGGBB sRGB color as linear RGB.
pub(crate) fn hex(rgb: u32) -> Vec3 {
    let c = |shift: u32| srgb_to_linear(((rgb >> shift) & 0xff) as f32 / 255.0);
    Vec3::new(c(16), c(8), c(0))
}

const LUT_SIZE: usize = 4096;

fn lut() -> &'static [u8; LUT_SIZE + 1] {
    static LUT: OnceLock<Box<[u8; LUT_SIZE + 1]>> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = Box::new([0u8; LUT_SIZE + 1]);
        for (i, v) in t.iter_mut().enumerate() {
            let x = i as f32 / LUT_SIZE as f32;
            let s = if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
            *v = (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        }
        t
    })
}

/// Linear RGB to sRGB bytes, clipping at white like a camera does.
pub(crate) fn encode(lin: Vec3) -> [u8; 3] {
    let t = lut();
    let q = |x: f32| t[(x * LUT_SIZE as f32).clamp(0.0, LUT_SIZE as f32) as usize];
    [q(lin.x), q(lin.y), q(lin.z)]
}

/// Flat Lambert shading for a face whose world normal already points toward the camera.
pub(crate) fn flat(albedo: Vec3, normal: Vec3) -> [u8; 3] {
    encode(albedo * (ambient(normal.y) + SUN * normal.dot(LIGHT).max(0.0)))
}

/// Lambert plus a soft Blinn-Phong highlight. All vectors are unit length and in one frame: `up` is world up and
/// `view` points from the surface toward the camera.
pub(crate) fn glossy(albedo: Vec3, n: Vec3, light: Vec3, up: Vec3, view: Vec3) -> [u8; 3] {
    let diffuse = ambient(n.dot(up)) + SUN * n.dot(light).max(0.0);
    let h = (light + view).normalize_or_zero();
    let s = n.dot(h).max(0.0);
    let s4 = s * s * s * s;
    let spec = SPECULAR * SUN * s4 * s4 * s4 * s4 * s4 * s4;
    encode(albedo * diffuse + Vec3::splat(spec))
}
