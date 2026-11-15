//! A close look at POLLEN and NECTAR shells, to check the holes. cargo run --release -p bench-render --example ball_closeup -- OUT.png
use bench_render::{Ball, BallKind, Camera, Intrinsics, Quat, RenderOptions, Scene, Vec3, World};

fn main() -> anyhow::Result<()> {
    let out = std::env::args().nth(1).unwrap_or_else(|| "closeup.png".into());
    let cam = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.25, 0.0), 0.0, 0.35);
    let balls = [
        Ball::on_floor(1, BallKind::Pollen, 0.42, -0.06),
        Ball::on_floor(2, BallKind::NectarRed, 0.47, 0.07).turned(Quat::from_rotation_y(0.7)),
        Ball::on_floor(3, BallKind::Pollen, 0.62, 0.16).turned(Quat::from_rotation_x(1.1)),
        Ball::on_floor(4, BallKind::NectarBlue, 0.6, -0.18),
    ];
    let o = Scene::empty().render(&cam, &World { balls: &balls, robots: &[], hive_angles: [0.0; 2] }, &RenderOptions::default());
    o.frame.save_png(out)
}
