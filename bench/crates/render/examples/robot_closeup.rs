//! Two robots and a few balls up close, to check how robots look. cargo run --release -p bench-render --example robot_closeup -- OUT.png
use bench_render::{Alliance, Ball, BallKind, Camera, Intrinsics, Pose, RenderOptions, Robot, Scene, Vec3, World};

fn main() -> anyhow::Result<()> {
    let out = std::env::args().nth(1).unwrap_or_else(|| "robots.png".into());
    let cam = Camera::new(Intrinsics::default(), Vec3::new(-0.2, 0.75, 1.0), 0.6, 0.45);
    let robots = [Robot::new(Pose::new(0.6, 0.35, 2.4), Alliance::Red), Robot::new(Pose::new(0.95, -0.35, -0.9), Alliance::Blue)];
    let balls = [Ball::on_floor(1, BallKind::Pollen, 0.25, 0.1), Ball::on_floor(2, BallKind::Pollen, 0.3, 0.2), Ball::on_floor(3, BallKind::NectarBlue, 0.55, -0.05)];
    let o = Scene::empty().render(&cam, &World { balls: &balls, robots: &robots, hive_angles: [0.0; 2], robot_model: None }, &RenderOptions::default());
    o.frame.save_png(out)
}
