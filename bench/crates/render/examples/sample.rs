//! Renders one frame from near the red alliance wall and writes `sample.png` and `sample.json` (the labels).
//!
//! cargo run --release -p bench-render --example sample -- OUT_DIR

use bench_render::{Alliance, Ball, BallKind, Camera, Intrinsics, Mount, Pose, RenderOptions, Robot, Scene, World};
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let out = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let glb = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../public/field.glb");
    let scene = Scene::load(glb)?;

    let balls = [
        Ball::on_floor(0, BallKind::Pollen, -0.93, 0.64),
        Ball::on_floor(1, BallKind::Pollen, -0.52, 0.82),
        Ball::on_floor(2, BallKind::Pollen, -0.72, 0.27),
        Ball::on_floor(3, BallKind::Pollen, -1.08, 0.31),
        Ball::on_floor(4, BallKind::NectarRed, -0.26, 0.35),
        Ball::on_floor(5, BallKind::NectarBlue, -0.56, 0.53),
        Ball::on_floor(6, BallKind::Pollen, -0.41, -0.45),
        Ball::on_floor(7, BallKind::NectarRed, 0.07, 0.59),
    ];
    let robots = [Robot::new(Pose::new(0.35, 0.85, 2.3), Alliance::Blue)];
    let world = World { balls: &balls, robots: &robots, hive_angles: [0.0, 0.0], robot_model: None };

    // A robot in the red alliance's audience-side corner facing the field center. The mount is tilted 5 degrees up
    // instead of the default pollen mount's 20 degrees down, so both HIVEs fit in the frame.
    let mount = Mount { pitch: -5f32.to_radians(), ..Mount::pollen_default() };
    let camera = Camera::on_robot(Pose::new(-1.55, 1.3, 0.7), &mount, Intrinsics::default());
    let shot = scene.render(&camera, &world, &RenderOptions::default());
    shot.frame.save_png(out.join("sample.png"))?;
    std::fs::write(out.join("sample.json"), serde_json::to_string_pretty(&shot.labels)?)?;
    for l in &shot.labels {
        println!(
            "ball {} {:?} at ({:.1}, {:.1}) r {:.1} px, range {:.2} m, visible {:.2}, in image {:.2}",
            l.id, l.kind, l.center[0], l.center[1], l.radius, l.range, l.visible, l.in_image
        );
    }
    Ok(())
}
