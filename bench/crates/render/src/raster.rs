//! The frame pipeline: transform, cull and near-clip every triangle once, bin them by row band, then fill each band
//! in parallel. A band draws the floor, the triangles, the balls (exact per-pixel ray-sphere hits), ball shadows and
//! the clear perimeter panels, all against one inverse-depth buffer.
//!
//! Pixel coordinates follow OpenCV: pixel (i, j) is centered at u = i, v = j.

use crate::frame::{Frame, Rendered};
use crate::labels::{self, BallView};
use crate::scene::{robot_tris, Scene, Tri};
use crate::shade::{self, LIGHT};
use crate::{floor, post, Ball, Camera, RenderOptions, World};
use glam::{Mat3, Mat4, Vec3};
use rayon::prelude::*;

/// The near clip plane, meters along the optical axis.
pub(crate) const NEAR: f32 = 0.02;
const BAND: usize = 8;

/// Per-frame camera data shared by every stage.
pub(crate) struct View {
    pub w: usize,
    pub h: usize,
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
    /// World to camera rotation.
    pub rot: Mat3,
    pub pos: Vec3,
    pub right: Vec3,
    pub down: Vec3,
    pub fwd: Vec3,
    /// The sun direction and world up, in camera coordinates.
    pub light: Vec3,
    pub up: Vec3,
}

impl View {
    fn new(cam: &Camera) -> View {
        let k = cam.intrinsics;
        let rot = cam.rotation();
        View {
            w: k.width as usize,
            h: k.height as usize,
            fx: k.fx as f64,
            fy: k.fy as f64,
            cx: k.cx as f64,
            cy: k.cy as f64,
            rot,
            pos: cam.position,
            right: cam.right(),
            down: cam.down(),
            fwd: cam.forward(),
            light: rot * LIGHT,
            up: rot * Vec3::Y,
        }
    }

    /// The world ray through pixel (u, v), scaled so its camera-z component is 1.
    pub fn ray(&self, u: f32, v: f32) -> Vec3 {
        let xn = (u - self.cx as f32) / self.fx as f32;
        let yn = (v - self.cy as f32) / self.fy as f32;
        self.fwd + self.right * xn + self.down * yn
    }

    /// Bit flags for the frustum planes a camera-space point is outside of, with a pixel of margin.
    fn outcode(&self, p: Vec3) -> u8 {
        let (fx, fy, cx, cy) = (self.fx as f32, self.fy as f32, self.cx as f32, self.cy as f32);
        let (w, h) = (self.w as f32, self.h as f32);
        let mut code = 0;
        if p.z < NEAR {
            code |= 1;
        }
        if fx * p.x + (cx + 1.0) * p.z < 0.0 {
            code |= 2;
        }
        if fx * p.x + (cx - w) * p.z > 0.0 {
            code |= 4;
        }
        if fy * p.y + (cy + 1.0) * p.z < 0.0 {
            code |= 8;
        }
        if fy * p.y + (cy - h) * p.z > 0.0 {
            code |= 16;
        }
        code
    }

    fn screen(&self, c: [Vec3; 3], rgb: [u8; 3], owner: u32) -> ScreenTri {
        let (fx, fy, cx, cy) = (self.fx as f32, self.fy as f32, self.cx as f32, self.cy as f32);
        ScreenTri {
            p: c.map(|p| [fx * p.x / p.z + cx, fy * p.y / p.z + cy]),
            iz: c.map(|p| 1.0 / p.z),
            rgb,
            owner,
        }
    }
}

/// A projected triangle: pixel positions, inverse depth at each vertex, its shaded color and owner.
#[derive(Clone, Copy)]
struct ScreenTri {
    p: [[f32; 2]; 3],
    iz: [f32; 3],
    rgb: [u8; 3],
    owner: u32,
}

/// A set of triangles under one rigid transform: `m` and `t` take them to camera space, `nm` takes normals to world.
struct Instance<'a> {
    tris: &'a [Tri],
    m: Mat3,
    t: Vec3,
    nm: Mat3,
}

fn project_all(view: &View, instances: &[Instance]) -> Vec<ScreenTri> {
    let mut out = Vec::new();
    for inst in instances {
        out.par_extend(inst.tris.par_chunks(1024).flat_map_iter(|chunk| {
            let mut v = Vec::with_capacity(chunk.len() / 2);
            for tri in chunk {
                emit(view, inst, tri, &mut v);
            }
            v
        }));
    }
    out
}

/// Culls, shades, near-clips and projects one triangle. Faces are two-sided: the normal is flipped toward the camera.
fn emit(view: &View, inst: &Instance, tri: &Tri, out: &mut Vec<ScreenTri>) {
    let c = tri.v.map(|p| inst.m * p + inst.t);
    let codes = c.map(|p| view.outcode(p));
    if codes[0] & codes[1] & codes[2] != 0 {
        return;
    }
    let mut n = inst.nm * tri.n;
    if (view.rot * n).dot(c[0]) > 0.0 {
        n = -n;
    }
    let rgb = shade::flat(tri.albedo, n);
    if (codes[0] | codes[1] | codes[2]) & 1 == 0 {
        out.push(view.screen(c, rgb, tri.owner));
        return;
    }
    let mut poly = [Vec3::ZERO; 4];
    let mut len = 0;
    for i in 0..3 {
        let (a, b) = (c[i], c[(i + 1) % 3]);
        if a.z >= NEAR {
            poly[len] = a;
            len += 1;
        }
        if (a.z >= NEAR) != (b.z >= NEAR) {
            poly[len] = a + (b - a) * ((NEAR - a.z) / (b.z - a.z));
            len += 1;
        }
    }
    for k in 1..len.saturating_sub(1) {
        out.push(view.screen([poly[0], poly[k], poly[k + 1]], rgb, tri.owner));
    }
}

/// Triangle indices grouped by the row bands they touch.
struct Bins {
    start: Vec<u32>,
    items: Vec<u32>,
}

impl Bins {
    fn new(tris: &[ScreenTri], h: usize) -> Bins {
        let bands = h.div_ceil(BAND);
        let ranges: Vec<Option<(usize, usize)>> = tris.par_iter().map(|t| band_range(t, h)).collect();
        let mut start = vec![0u32; bands + 1];
        for &(b0, b1) in ranges.iter().flatten() {
            for b in b0..=b1 {
                start[b + 1] += 1;
            }
        }
        for b in 0..bands {
            start[b + 1] += start[b];
        }
        let mut fill = start.clone();
        let mut items = vec![0u32; start[bands] as usize];
        for (i, r) in ranges.iter().enumerate() {
            if let Some((b0, b1)) = *r {
                for b in b0..=b1 {
                    items[fill[b] as usize] = i as u32;
                    fill[b] += 1;
                }
            }
        }
        Bins { start, items }
    }

    fn band(&self, b: usize) -> &[u32] {
        &self.items[self.start[b] as usize..self.start[b + 1] as usize]
    }
}

fn band_range(t: &ScreenTri, h: usize) -> Option<(usize, usize)> {
    let ys = [t.p[0][1], t.p[1][1], t.p[2][1]];
    let lo = ys[0].min(ys[1]).min(ys[2]).ceil().max(0.0);
    let hi = ys[0].max(ys[1]).max(ys[2]).floor().min(h as f32 - 1.0);
    (lo <= hi).then_some((lo as usize / BAND, hi as usize / BAND))
}

/// One row of a triangle's coverage: pixels `x0..=x1` of `row`, with inverse depth `iz` at x0 rising by `gx` per
/// pixel and clamped to `[lo, hi]`.
struct Span {
    row: usize,
    x0: usize,
    x1: usize,
    iz: f64,
    gx: f64,
    lo: f64,
    hi: f64,
}

/// Calls `f` for each covered row of `t` within rows `y0..y1`. Coverage is inclusive on edges, so shared edges never
/// crack; a pixel both neighbors cover is resolved by the depth test.
fn spans(t: &ScreenTri, y0: usize, y1: usize, w: usize, mut f: impl FnMut(Span)) {
    let mut p = t.p.map(|q| [q[0] as f64, q[1] as f64]);
    let mut iz = t.iz.map(|z| z as f64);
    let area = (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]) - (p[2][1] - p[0][1]) * (p[1][0] - p[0][0]);
    if area == 0.0 || !area.is_finite() {
        return;
    }
    if area < 0.0 {
        p.swap(1, 2);
        iz.swap(1, 2);
    }
    let [a, b, c] = p;
    let (e1, e2) = ([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]);
    let det = e1[0] * e2[1] - e1[1] * e2[0];
    let (d1, d2) = (iz[1] - iz[0], iz[2] - iz[0]);
    let gx = (d1 * e2[1] - e1[1] * d2) / det;
    let gy = (e1[0] * d2 - d1 * e2[0]) / det;
    let lo_z = iz[0].min(iz[1]).min(iz[2]);
    let hi_z = iz[0].max(iz[1]).max(iz[2]);
    let ymin = a[1].min(b[1]).min(c[1]).ceil().max(y0 as f64);
    let ymax = a[1].max(b[1]).max(c[1]).floor().min(y1 as f64 - 1.0);
    if ymin > ymax {
        return;
    }
    let xmin = a[0].min(b[0]).min(c[0]).max(0.0);
    let xmax = a[0].max(b[0]).max(c[0]).min(w as f64 - 1.0);
    const EPS: f64 = 1e-6;
    for row in ymin as usize..=ymax as usize {
        let py = row as f64;
        let (mut lo, mut hi) = (xmin, xmax);
        for (q0, q1) in [(a, b), (b, c), (c, a)] {
            // Inside means (x - q0.x) * s + k >= 0.
            let s = q1[1] - q0[1];
            let k = -(py - q0[1]) * (q1[0] - q0[0]);
            if s > 0.0 {
                lo = lo.max(q0[0] - k / s);
            } else if s < 0.0 {
                hi = hi.min(q0[0] - k / s);
            } else if k < 0.0 {
                hi = -1.0;
            }
        }
        let x0 = (lo - EPS).ceil().max(0.0);
        let x1 = (hi + EPS).floor();
        if x1 < x0 {
            continue;
        }
        let iz0 = iz[0] + gx * (x0 - a[0]) + gy * (py - a[1]);
        f(Span { row, x0: x0 as usize, x1: x1 as usize, iz: iz0, gx, lo: lo_z, hi: hi_z });
    }
}

/// A soft contact shadow under one ball, as a disc on the floor and the pixel rectangle it can touch.
struct Shadow {
    x: f32,
    z: f32,
    radius: f32,
    strength: f32,
    rect: [usize; 4],
}

fn shadows(view: &View, balls: &[Ball]) -> Vec<Shadow> {
    balls
        .iter()
        .filter_map(|b| {
            let height = (b.center.y - b.radius).max(0.0);
            if height > 0.6 {
                return None;
            }
            let x = b.center.x - LIGHT.x / LIGHT.y * b.center.y;
            let z = b.center.z - LIGHT.z / LIGHT.y * b.center.y;
            let radius = b.radius * (1.1 + 2.0 * height);
            let strength = 0.5 / (1.0 + 12.0 * height);
            let rect = floor_rect(view, x, z, radius)?;
            Some(Shadow { x, z, radius, strength, rect })
        })
        .collect()
}

/// The pixel rectangle (x0, x1, y0, y1, inclusive) covering a disc on the floor, or None when it is out of view.
fn floor_rect(view: &View, x: f32, z: f32, r: f32) -> Option<[usize; 4]> {
    let (mut u0, mut u1, mut v0, mut v1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for k in 0..8 {
        let a = k as f32 * std::f32::consts::FRAC_PI_4;
        let c = view.rot * (Vec3::new(x + r * 1.1 * a.cos(), 0.0, z + r * 1.1 * a.sin()) - view.pos);
        if c.z < NEAR {
            return Some([0, view.w - 1, 0, view.h - 1]);
        }
        let (u, v) = (view.fx as f32 * c.x / c.z + view.cx as f32, view.fy as f32 * c.y / c.z + view.cy as f32);
        (u0, u1, v0, v1) = (u0.min(u), u1.max(u), v0.min(v), v1.max(v));
    }
    clamp_rect(view, [u0 as f64, u1 as f64, v0 as f64, v1 as f64])
}

/// A float pixel rectangle (u0, u1, v0, v1) as inclusive pixel indices inside the image, or None if it misses.
pub(crate) fn clamp_rect(view: &View, r: [f64; 4]) -> Option<[usize; 4]> {
    let x0 = r[0].floor().max(0.0);
    let x1 = r[1].ceil().min(view.w as f64 - 1.0);
    let y0 = r[2].floor().max(0.0);
    let y1 = r[3].ceil().min(view.h as f64 - 1.0);
    (x0 <= x1 && y0 <= y1).then_some([x0 as usize, x1 as usize, y0 as usize, y1 as usize])
}

struct Ctx<'a> {
    view: &'a View,
    tris: &'a [ScreenTri],
    bins: &'a Bins,
    glass: &'a [ScreenTri],
    glass_bins: &'a Bins,
    glass_alpha: f32,
    cells: &'a [ScreenTri],
    cell_bins: &'a Bins,
    cell_alpha: f32,
    balls: &'a [BallView],
    shadows: &'a [Shadow],
}

/// The buffers for one band of rows, starting at row `y0`.
struct Band<'a> {
    y0: usize,
    y1: usize,
    rgb: &'a mut [u8],
    iz: &'a mut [f32],
    ids: &'a mut [u32],
}

pub(crate) fn render(scene: &Scene, cam: &Camera, world: &World, opts: &RenderOptions) -> Rendered {
    let view = View::new(cam);
    let (w, h) = (view.w, view.h);
    let robots: Vec<Tri> = world.robots.iter().enumerate().flat_map(|(i, r)| robot_tris(r, i as u32, world.robot_model)).collect();
    let fixed = |tris| Instance { tris, m: view.rot, t: -(view.rot * view.pos), nm: Mat3::IDENTITY };
    let mut instances = vec![fixed(&scene.field), fixed(&robots)];
    let mut cell_instances = Vec::new();
    for (hive, angle) in scene.hives.iter().zip(world.hive_angles) {
        let xf = hive.pivot * Mat4::from_rotation_x(angle);
        let r = Mat3::from_mat4(xf);
        let (m, t) = (view.rot * r, view.rot * (xf.w_axis.truncate() - view.pos));
        instances.push(Instance { tris: &hive.tris, m, t, nm: r });
        cell_instances.push(Instance { tris: &hive.glass, m, t, nm: r });
    }
    let tris = project_all(&view, &instances);
    let bins = Bins::new(&tris, h);
    let glass = if opts.glass_alpha > 0.0 { project_all(&view, &[fixed(&scene.glass)]) } else { Vec::new() };
    let glass_bins = Bins::new(&glass, h);
    let cells = if opts.cell_alpha > 0.0 { project_all(&view, &cell_instances) } else { Vec::new() };
    let cell_bins = Bins::new(&cells, h);
    let balls = labels::prepare(&view, world.balls);
    let shadows = if opts.ball_shadows { shadows(&view, world.balls) } else { Vec::new() };
    let ctx = Ctx {
        view: &view,
        tris: &tris,
        bins: &bins,
        glass: &glass,
        glass_bins: &glass_bins,
        glass_alpha: opts.glass_alpha,
        cells: &cells,
        cell_bins: &cell_bins,
        cell_alpha: opts.cell_alpha,
        balls: &balls,
        shadows: &shadows,
    };

    let mut rgb = vec![0u8; w * h * 3];
    let mut depth = vec![0f32; w * h];
    let mut ids = vec![0u32; w * h];
    rgb.par_chunks_mut(w * BAND * 3)
        .zip(depth.par_chunks_mut(w * BAND))
        .zip(ids.par_chunks_mut(w * BAND))
        .enumerate()
        .for_each(|(b, ((rgb, iz), ids))| {
            let y0 = b * BAND;
            let mut band = Band { y0, y1: y0 + iz.len() / w, rgb, iz, ids };
            draw_band(&ctx, b, &mut band);
        });

    let labels = labels::compute(&view, world.balls, &balls, &ids);
    post::apply(&opts.post, &mut rgb, w, h);
    Rendered { frame: Frame { width: w as u32, height: h as u32, rgb, depth, ids }, labels }
}

fn draw_band(ctx: &Ctx, b: usize, band: &mut Band) {
    draw_floor(ctx.view, band);
    for &i in ctx.bins.band(b) {
        draw_tri(&ctx.tris[i as usize], ctx.view.w, band);
    }
    for ball in ctx.balls {
        draw_ball(ctx.view, ball, band);
    }
    for s in ctx.shadows {
        draw_shadow(ctx.view, s, band);
    }
    for &i in ctx.glass_bins.band(b) {
        draw_glass(&ctx.glass[i as usize], ctx.view.w, ctx.glass_alpha, band);
    }
    for &i in ctx.cell_bins.band(b) {
        draw_glass(&ctx.cells[i as usize], ctx.view.w, ctx.cell_alpha, band);
    }
    for z in band.iz.iter_mut() {
        *z = if *z > 0.0 { 1.0 / *z } else { f32::INFINITY };
    }
}

fn draw_floor(view: &View, band: &mut Band) {
    for row in band.y0..band.y1 {
        let base = (row - band.y0) * view.w;
        for x in 0..view.w {
            let s = floor::sample(view, view.ray(x as f32, row as f32));
            let i = base + x;
            band.iz[i] = s.iz;
            band.ids[i] = s.owner;
            band.rgb[3 * i..3 * i + 3].copy_from_slice(&s.rgb);
        }
    }
}

fn draw_tri(t: &ScreenTri, w: usize, band: &mut Band) {
    let y0 = band.y0;
    spans(t, band.y0, band.y1, w, |s| {
        let base = (s.row - y0) * w;
        let mut z = s.iz;
        for x in s.x0..=s.x1 {
            let zz = z.clamp(s.lo, s.hi) as f32;
            let i = base + x;
            if zz > band.iz[i] {
                band.iz[i] = zz;
                band.ids[i] = t.owner;
                band.rgb[3 * i..3 * i + 3].copy_from_slice(&t.rgb);
            }
            z += s.gx;
        }
    });
}

fn draw_glass(t: &ScreenTri, w: usize, alpha: f32, band: &mut Band) {
    let y0 = band.y0;
    let tint = t.rgb.map(|c| c as f32 * alpha);
    spans(t, band.y0, band.y1, w, |s| {
        let base = (s.row - y0) * w;
        let mut z = s.iz;
        for x in s.x0..=s.x1 {
            let i = base + x;
            if z.clamp(s.lo, s.hi) as f32 > band.iz[i] {
                for (c, t) in band.rgb[3 * i..3 * i + 3].iter_mut().zip(tint) {
                    *c = (*c as f32 * (1.0 - alpha) + t + 0.5) as u8;
                }
            }
            z += s.gx;
        }
    });
}

fn draw_ball(view: &View, ball: &BallView, band: &mut Band) {
    let Some([x0, x1, r0, r1]) = ball.rect else { return };
    let (r0, r1) = (r0.max(band.y0), r1.min(band.y1 - 1));
    if r0 > r1 {
        return;
    }
    for row in r0..=r1 {
        let base = (row - band.y0) * view.w;
        for x in x0..=x1 {
            let Some(t) = ball.hit(view, x as f64, row as f64) else { continue };
            let i = base + x;
            let iz = (1.0 / t) as f32;
            if iz <= band.iz[i] {
                continue;
            }
            // A hole pixel still belongs to the ball, so occlusion and labels see the whole silhouette.
            band.ids[i] = ball.owner;
            let d = Vec3::new(((x as f64 - view.cx) / view.fx) as f32, ((row as f64 - view.cy) / view.fy) as f32, 1.0);
            let p = d * t as f32;
            let n = ((p - ball.center()) / ball.r as f32).normalize_or_zero();
            if !ball.in_hole(n) {
                band.iz[i] = iz;
                let rgb = shade::glossy(ball.albedo, n, view.light, view.up, -p.normalize_or_zero());
                band.rgb[3 * i..3 * i + 3].copy_from_slice(&rgb);
                continue;
            }
            // Through a hole: the inside of the far wall, in its own shade, unless that is a hole too.
            let t2 = ball.exit(view, x as f64, row as f64);
            let p2 = d * t2 as f32;
            let n2 = ((p2 - ball.center()) / ball.r as f32).normalize_or_zero();
            if ball.in_hole(n2) {
                continue;
            }
            let iz2 = (1.0 / t2) as f32;
            if iz2 > band.iz[i] {
                band.iz[i] = iz2;
                let rgb = shade::flat(ball.albedo * INSIDE, view.rot.transpose() * -n2);
                band.rgb[3 * i..3 * i + 3].copy_from_slice(&rgb);
            }
        }
    }
}

/// How much light reaches the inside of a ball's shell, as a fraction of the outside.
const INSIDE: f32 = 0.45;

fn draw_shadow(view: &View, s: &Shadow, band: &mut Band) {
    let [x0, x1, r0, r1] = s.rect;
    let (r0, r1) = (r0.max(band.y0), r1.min(band.y1 - 1));
    if r0 > r1 {
        return;
    }
    for row in r0..=r1 {
        let base = (row - band.y0) * view.w;
        for x in x0..=x1 {
            let i = base + x;
            if band.iz[i] <= 0.0 {
                continue;
            }
            let p = view.pos + view.ray(x as f32, row as f32) / band.iz[i];
            if p.y.abs() > 0.006 {
                continue;
            }
            let q2 = ((p.x - s.x).powi(2) + (p.z - s.z).powi(2)) / (s.radius * s.radius);
            if q2 >= 1.0 {
                continue;
            }
            let k = 1.0 - s.strength * (1.0 - q2) * (1.0 - q2);
            for c in &mut band.rgb[3 * i..3 * i + 3] {
                *c = (*c as f32 * k + 0.5) as u8;
            }
        }
    }
}
