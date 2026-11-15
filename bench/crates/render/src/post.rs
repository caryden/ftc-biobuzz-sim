//! Optional camera effects applied to the finished image: a slight lens blur and seeded sensor noise. Labels and
//! the id buffer are computed before this runs, so they stay exact.

use rayon::prelude::*;

/// Post-processing settings. The default turns everything off.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PostFx {
    /// Gaussian blur sigma in pixels. 0 skips the blur.
    pub blur_sigma: f32,
    /// Standard deviation of the per-channel noise, in 8-bit levels. 0 skips the noise.
    pub noise_sigma: f32,
    /// Seed for the noise. The same seed gives the same noise, so frames are reproducible.
    pub seed: u64,
}

impl PostFx {
    /// A plausible small-sensor look: sigma 0.6 px blur and noise of 2 levels.
    pub fn camera_like(seed: u64) -> PostFx {
        PostFx { blur_sigma: 0.6, noise_sigma: 2.0, seed }
    }
}

pub(crate) fn apply(fx: &PostFx, rgb: &mut [u8], w: usize, h: usize) {
    if fx.blur_sigma > 0.0 {
        blur(rgb, w, h, fx.blur_sigma);
    }
    if fx.noise_sigma > 0.0 {
        noise(rgb, w, fx.noise_sigma, fx.seed);
    }
}

fn kernel(sigma: f32) -> Vec<f32> {
    let r = (3.0 * sigma).ceil() as i32;
    let k: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.into_iter().map(|x| x / sum).collect()
}

/// A separable Gaussian with clamped edges.
fn blur(rgb: &mut [u8], w: usize, h: usize, sigma: f32) {
    let k = kernel(sigma);
    let r = (k.len() / 2) as isize;
    let mut tmp = vec![0f32; rgb.len()];
    tmp.par_chunks_mut(w * 3).zip(rgb.par_chunks(w * 3)).for_each(|(out, row)| {
        for x in 0..w as isize {
            for c in 0..3 {
                let mut acc = 0.0;
                for (j, kj) in k.iter().enumerate() {
                    let xs = (x + j as isize - r).clamp(0, w as isize - 1) as usize;
                    acc += kj * row[xs * 3 + c] as f32;
                }
                out[x as usize * 3 + c] = acc;
            }
        }
    });
    rgb.par_chunks_mut(w * 3).enumerate().for_each(|(y, out)| {
        for (i, o) in out.iter_mut().enumerate() {
            let mut acc = 0.0;
            for (j, kj) in k.iter().enumerate() {
                let ys = (y as isize + j as isize - r).clamp(0, h as isize - 1) as usize;
                acc += kj * tmp[ys * w * 3 + i];
            }
            *o = (acc + 0.5).clamp(0.0, 255.0) as u8;
        }
    });
}

fn noise(rgb: &mut [u8], w: usize, sigma: f32, seed: u64) {
    rgb.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
        for (i, c) in row.iter_mut().enumerate() {
            let n = gaussian(seed ^ ((y * w * 3 + i) as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
            *c = (*c as f32 + n * sigma + 0.5).clamp(0.0, 255.0) as u8;
        }
    });
}

/// A standard normal sample from a 64-bit key, by Box-Muller on two hashed uniforms.
fn gaussian(key: u64) -> f32 {
    let mut z = key.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^= z >> 31;
    let u1 = ((z >> 40) as f32 + 0.5) / (1u64 << 24) as f32;
    let u2 = ((z & 0xff_ffff) as f32) / (1u64 << 24) as f32;
    (-2.0 * u1.ln()).sqrt() * (std::f32::consts::TAU * u2).cos()
}
