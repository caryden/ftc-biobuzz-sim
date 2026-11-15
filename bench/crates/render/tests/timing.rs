use bench_render::{Alliance, Ball, BallKind, Camera, Intrinsics, Mount, Pose, RenderOptions, Robot, Scene, World};
use std::time::Instant;

/// Prints the median frame time over 20 frames from a robot near the red wall looking across the field.
/// Run with: cargo test --release -p bench-render --test timing -- --ignored --nocapture
#[test]
#[ignore]
fn median_frame_time() {
    let scene = Scene::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../public/field.glb")).unwrap();
    let mut balls = Vec::new();
    for i in 0..30 {
        let kind = [BallKind::Pollen, BallKind::Pollen, BallKind::NectarRed, BallKind::NectarBlue][i % 4];
        let (x, z) = (-1.2 + 0.09 * i as f32, -0.9 + 0.061 * ((i * 7) % 30) as f32);
        balls.push(Ball::on_floor(i as u32, kind, x, z));
    }
    let robots = [
        Robot::new(Pose::new(0.1, -0.15, 2.6), Alliance::Blue),
        Robot::new(Pose::new(0.9, 0.8, 1.0), Alliance::Blue),
        Robot::new(Pose::new(-0.6, 1.1, 0.4), Alliance::Red),
    ];
    let world = World { balls: &balls, robots: &robots, hive_angles: [0.2, -0.1] };
    let cam = Camera::on_robot(Pose::new(-1.5, 0.1, 0.05), &Mount::pollen_default(), Intrinsics::default());
    let opts = RenderOptions::default();
    scene.render(&cam, &world, &opts);
    let mut times: Vec<f64> = (0..20)
        .map(|_| {
            let t = Instant::now();
            std::hint::black_box(scene.render(&cam, &world, &opts));
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    times.sort_by(f64::total_cmp);
    println!("median frame time {:.2} ms (min {:.2}, max {:.2}) over 20 frames", times[10], times[0], times[19]);
}
