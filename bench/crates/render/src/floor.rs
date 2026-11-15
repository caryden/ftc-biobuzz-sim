//! The floor, which is not in the CAD: gray foam tiles inside the perimeter and a dark venue floor outside it.
//! Each pixel intersects its ray with the floor planes directly, so the floor is exact and needs no triangles.

use crate::frame::Owner;
use crate::raster::View;
use crate::FIELD_HALF;
use glam::Vec3;

/// The tile surface sits a hair below y = 0 (as in the web view) so tape lying on it wins the depth test.
pub(crate) const TILE_Y: f32 = -0.0005;
const VENUE_Y: f32 = -0.016;
const VENUE_HALF: f32 = 7.0;
const TILE: f32 = 2.0 * FIELD_HALF / 6.0;
const SEAM: f32 = 0.003;
const TILE_RGB: [f32; 3] = [74.0, 78.0, 85.0];
const SEAM_RGB: [f32; 3] = [52.0, 56.0, 63.0];
const VENUE_RGB: [f32; 3] = [35.0, 39.0, 46.0];
pub(crate) const BACKGROUND: [u8; 3] = [0x14, 0x17, 0x1c];

pub(crate) struct Sample {
    pub rgb: [u8; 3],
    pub iz: f32,
    pub owner: u32,
}

const EMPTY: Sample = Sample { rgb: BACKGROUND, iz: 0.0, owner: 0 };

/// The floor seen along world ray `d`, scaled so its camera-z component is 1 (so the ray parameter is depth).
pub(crate) fn sample(view: &View, d: Vec3) -> Sample {
    let h = view.pos.y - TILE_Y;
    if d.y >= 0.0 || h <= 0.0 {
        return EMPTY;
    }
    let t = h / -d.y;
    let p = view.pos + d * t;
    if p.x.abs() <= FIELD_HALF && p.z.abs() <= FIELD_HALF {
        let (wx, wz) = footprint(view, d, t);
        return Sample { rgb: tile_color(p, wx, wz), iz: 1.0 / t, owner: Owner::Tiles.raw() };
    }
    let t = (view.pos.y - VENUE_Y) / -d.y;
    let p = view.pos + d * t;
    if p.x.abs() > VENUE_HALF || p.z.abs() > VENUE_HALF {
        return EMPTY;
    }
    let (wx, wz) = footprint(view, d, t);
    let n = value_noise(p.x / 0.02, p.z / 0.02, 7) * 1.5 * fade(0.02, wx + wz);
    Sample { rgb: to_bytes(VENUE_RGB.map(|c| c + n)), iz: 1.0 / t, owner: Owner::VenueFloor.raw() }
}

/// How far one pixel reaches across the floor in world X and Z at this ray, for filtering seams and texture.
fn footprint(view: &View, d: Vec3, t: f32) -> (f32, f32) {
    let du = (view.right - d * (view.right.y / d.y)) * (t / view.fx as f32);
    let dv = (view.down - d * (view.down.y / d.y)) * (t / view.fy as f32);
    (du.x.abs() + dv.x.abs(), du.z.abs() + dv.z.abs())
}

fn tile_color(p: Vec3, wx: f32, wz: f32) -> [u8; 3] {
    let (sx, sz) = ((p.x + FIELD_HALF) / TILE, (p.z + FIELD_HALF) / TILE);
    let per_tile = hash(sx.floor() as i32, sz.floor() as i32, 1) * 2.0;
    let fine = value_noise(p.x / 0.008, p.z / 0.008, 2) * 3.0 * fade(0.008, wx + wz);
    let coarse = value_noise(p.x / 0.03, p.z / 0.03, 3) * 2.0 * fade(0.03, wx + wz);
    let seam = 1.0 - (1.0 - seam_cover(sx, wx)) * (1.0 - seam_cover(sz, wz));
    let shade = per_tile + fine + coarse;
    let mut rgb = [0.0; 3];
    for k in 0..3 {
        rgb[k] = (TILE_RGB[k] + shade) * (1.0 - seam) + SEAM_RGB[k] * seam;
    }
    to_bytes(rgb)
}

/// The fraction of a pixel of world width `w` covered by the nearest inner seam, `s` being the position in tiles.
fn seam_cover(s: f32, w: f32) -> f32 {
    let k = s.round();
    if !(1.0..=5.0).contains(&k) {
        return 0.0;
    }
    let delta = (s - k).abs() * TILE;
    let w = w.max(1e-5);
    let lo = (delta - w / 2.0).max(-SEAM / 2.0);
    let hi = (delta + w / 2.0).min(SEAM / 2.0);
    ((hi - lo) / w).clamp(0.0, 1.0)
}

/// 1 when a texture cell spans several pixels, falling to 0 once a pixel spans two cells, so far texture does not
/// alias into speckle.
fn fade(cell: f32, footprint: f32) -> f32 {
    (cell / footprint.max(1e-6) - 0.5).clamp(0.0, 1.0)
}

fn to_bytes(rgb: [f32; 3]) -> [u8; 3] {
    rgb.map(|c| (c + 0.5).clamp(0.0, 255.0) as u8)
}

/// A deterministic value in [-1, 1] for an integer lattice point.
pub(crate) fn hash(x: i32, z: i32, salt: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (z as u32).wrapping_mul(0xd816_3841) ^ salt.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297a_2d39);
    h ^= h >> 15;
    (h as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// Smooth value noise in [-1, 1] on a unit lattice.
fn value_noise(x: f32, z: f32, salt: u32) -> f32 {
    let (fx, fz) = (x.floor(), z.floor());
    let (ix, iz) = (fx as i32, fz as i32);
    let (tx, tz) = (x - fx, z - fz);
    let (sx, sz) = (tx * tx * (3.0 - 2.0 * tx), tz * tz * (3.0 - 2.0 * tz));
    let a = hash(ix, iz, salt) + (hash(ix + 1, iz, salt) - hash(ix, iz, salt)) * sx;
    let b = hash(ix, iz + 1, salt) + (hash(ix + 1, iz + 1, salt) - hash(ix, iz + 1, salt)) * sx;
    a + (b - a) * sz
}
