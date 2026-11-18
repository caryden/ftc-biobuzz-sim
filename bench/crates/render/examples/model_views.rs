//! Renders a robot model GLB from four sides, to check its orientation. cargo run --release -p bench-render --example model_views -- MODEL.glb OUT_PREFIX
use bench_render::{Alliance, Camera, Intrinsics, Pose, RenderOptions, Robot, RobotModel, Scene, Vec3, World};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let model = RobotModel::load(&args[1])?;
    let robot = Robot { pose: Pose::new(0.0, 0.0, 0.0), length: model.size.x, width: model.size.z, height: model.size.y, alliance: Alliance::Red, model: true };
    for (name, yaw) in [("front", std::f32::consts::PI), ("side", std::f32::consts::FRAC_PI_2), ("back", 0.0f32)] {
        // The camera sits 1.2 m out on the side named, looking back at the robot.
        let look = yaw;
        let pos = Vec3::new(-look.cos() * 1.2, 0.55, look.sin() * 1.2);
        let cam = Camera::new(Intrinsics::default(), pos, look, 0.3);
        let o = Scene::empty().render(&cam, &World { balls: &[], robots: &[robot], hive_angles: [0.0; 2], robot_model: Some(&model) }, &RenderOptions::default());
        o.frame.save_png(format!("{}-{name}.png", args[2]))?;
    }
    println!("size {:?}", model.size);
    Ok(())
}
