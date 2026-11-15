use bench_render::{
    Alliance, Ball, BallKind, BallLabel, Camera, Intrinsics, Owner, Pose, Rendered, RenderOptions, Robot, Scene, Vec3,
    World, POLLEN_RADIUS,
};
use std::f32::consts::FRAC_PI_2;
use std::sync::OnceLock;

fn field() -> &'static Scene {
    static SCENE: OnceLock<Scene> = OnceLock::new();
    SCENE.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../public/field.glb");
        Scene::load(path).expect("field.glb loads")
    })
}

fn render(scene: &Scene, cam: &Camera, balls: &[Ball], robots: &[Robot], hive_angles: [f32; 2]) -> Rendered {
    let world = World { balls, robots, hive_angles };
    scene.render(cam, &world, &RenderOptions::default())
}

fn label(r: &Rendered, id: u32) -> &BallLabel {
    r.labels.iter().find(|l| l.id == id).expect("ball is labeled")
}

#[test]
fn ball_on_axis_projects_to_principal_point() {
    let k = Intrinsics::default();
    let cam = Camera::new(k, Vec3::new(0.0, 0.5, 0.0), 0.0, 0.0);
    let d = 1.2;
    let ball = Ball::new(7, BallKind::Pollen, Vec3::new(d, 0.5, 0.0));
    let r = render(&Scene::empty(), &cam, &[ball], &[], [0.0; 2]);
    let l = label(&r, 7);
    assert!((l.center[0] - k.cx).abs() < 1e-3 && (l.center[1] - k.cy).abs() < 1e-3, "center {:?}", l.center);
    let expected = k.fx * POLLEN_RADIUS / d;
    assert!((l.radius - expected).abs() / expected < 0.01, "radius {} vs {}", l.radius, expected);
    assert!((l.range - d).abs() < 1e-5);
    assert_eq!((l.visible, l.in_image), (1.0, 1.0));
    let area = std::f32::consts::PI * l.radius * l.radius;
    assert!((l.pixels as f32 - area).abs() / area < 0.03, "{} pixels vs area {}", l.pixels, area);
    let mid = (k.cy as u32 * k.width + k.cx as u32) as usize;
    assert!((r.frame.depth[mid] - (d - POLLEN_RADIUS)).abs() < 1e-4, "depth {}", r.frame.depth[mid]);
}

#[test]
fn yaw_and_pitch_follow_the_documented_conventions() {
    // Yaw pi/2 looks along (0, 0, -1), toward the rear wall. Looking that way, +X is to the right.
    let cam = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.3, 1.0), FRAC_PI_2, 0.0);
    assert!(cam.forward().abs_diff_eq(Vec3::new(0.0, 0.0, -1.0), 1e-6));
    let ball = Ball::new(1, BallKind::NectarBlue, Vec3::new(0.3, 0.3, 0.0));
    let r = render(&Scene::empty(), &cam, &[ball], &[], [0.0; 2]);
    let l = label(&r, 1);
    // x_cam = 0.3, z_cam = 1.0, so u = cx + fx * 0.3.
    assert!((l.center[0] - (320.0 + 620.0 * 0.3)).abs() < 1e-3, "u {}", l.center[0]);
    assert!((l.center[1] - 240.0).abs() < 1e-3, "v {}", l.center[1]);

    // Positive pitch tilts down: a point at lens height ahead then sits above the image center.
    let down = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.3, 1.0), FRAC_PI_2, 0.3);
    let [_, v] = down.project(Vec3::new(0.0, 0.3, 0.0)).unwrap();
    assert!(v < 240.0, "v {v}");
    assert!(down.forward().y < 0.0);
}

#[test]
fn camera_on_robot_uses_the_mount() {
    let mount = bench_render::Mount { forward: 0.1, left: 0.05, up: 0.3, yaw: std::f32::consts::PI, pitch: 0.2 };
    let cam = Camera::on_robot(Pose::new(1.0, -0.5, FRAC_PI_2), &mount, Intrinsics::default());
    // Heading pi/2 faces -Z, so forward 0.1 moves to z = -0.6 and left 0.05 moves to x = 0.95.
    assert!(cam.position.abs_diff_eq(Vec3::new(0.95, 0.3, -0.6), 1e-6), "{:?}", cam.position);
    assert!(cam.forward().z > 0.0, "a rear mount looks back along +Z");
}

#[test]
fn robot_hides_the_ball_behind_it() {
    let cam = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.15, 0.0), 0.0, 0.0);
    let robot = Robot::new(Pose::new(1.0, 0.0, 0.3), Alliance::Red);
    let hidden = Ball::new(1, BallKind::Pollen, Vec3::new(1.6, 0.12, 0.0));
    let r = render(&Scene::empty(), &cam, &[hidden], &[robot], [0.0; 2]);
    let l = label(&r, 1);
    assert!(l.visible < 0.02, "visible {}", l.visible);
    assert_eq!(l.in_image, 1.0);
    assert_eq!(r.frame.owner(320, 240), Owner::Robot(0));
}

#[test]
fn ball_partly_behind_another_ball() {
    let cam = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.2, 0.0), 0.0, 0.0);
    let front = Ball::new(1, BallKind::NectarRed, Vec3::new(1.0, 0.2, 0.0));
    let back = Ball::new(2, BallKind::Pollen, Vec3::new(1.5, 0.2, 0.05));
    let r = render(&Scene::empty(), &cam, &[front, back], &[], [0.0; 2]);
    // The back ball shows through a few pixels where the front ball's holes line up.
    assert!(label(&r, 1).visible > 0.99);
    let v = label(&r, 2).visible;
    assert!(v > 0.05 && v < 0.95, "visible {v}");
}

#[test]
fn cropped_ball_reports_in_image_fraction() {
    // The ball center projects exactly onto the left image edge (u = -0.5 between pixels), so about half is inside.
    let cam = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.2, 0.0), 0.0, 0.0);
    let x = 1.0;
    let z = (320.5 / 620.0) * x;
    let r = render(&Scene::empty(), &cam, &[Ball::new(3, BallKind::Pollen, Vec3::new(x, 0.2, z))], &[], [0.0; 2]);
    let l = label(&r, 3);
    assert!((l.in_image - 0.5).abs() < 0.08, "in_image {}", l.in_image);
    assert_eq!(l.visible, 1.0);
}

#[test]
fn field_loads_with_both_hives() {
    let s = field();
    let n = s.triangle_count();
    assert!((215_000..=225_000).contains(&n), "{n} triangles");
    assert!(s.hive_pivot(Alliance::Red).abs_diff_eq(Vec3::new(-0.3236, 1.1165, 0.0), 1e-4));
    assert!(s.hive_pivot(Alliance::Blue).abs_diff_eq(Vec3::new(0.3241, 1.1165, 0.0), 1e-4));
    assert!(s.node_names().iter().any(|n| n == "perimeter"));
}

#[test]
fn hive_rotation_moves_hive_pixels() {
    let s = field();
    let cam = Camera::new(Intrinsics::default(), Vec3::new(-1.6, 0.5, 0.0), 0.0, -0.35);
    let a = render(s, &cam, &[], &[], [0.0, 0.0]);
    let b = render(s, &cam, &[], &[], [0.35, 0.0]);
    let red = Owner::Hive(Alliance::Red);
    let hive_pixels = |r: &Rendered| (0..r.frame.ids.len()).filter(|&i| Owner::from_raw(r.frame.ids[i]) == red).count();
    assert!(hive_pixels(&a) > 2000, "the red HIVE is in view: {}", hive_pixels(&a));
    let changed = (0..a.frame.ids.len())
        .filter(|&i| {
            let either = Owner::from_raw(a.frame.ids[i]) == red || Owner::from_raw(b.frame.ids[i]) == red;
            either && a.frame.rgb[3 * i..3 * i + 3] != b.frame.rgb[3 * i..3 * i + 3]
        })
        .count();
    assert!(changed > 1000, "{changed} HIVE pixels changed");
}

/// OpenCV's 8-bit HSV: H in 0..180, S and V in 0..255.
fn hsv(rgb: &[u8]) -> [f32; 3] {
    let [r, g, b] = [rgb[0] as f32, rgb[1] as f32, rgb[2] as f32];
    let v = r.max(g).max(b);
    let d = v - r.min(g).min(b);
    let s = if v > 0.0 { 255.0 * d / v } else { 0.0 };
    let h = if d == 0.0 {
        0.0
    } else if v == r {
        60.0 * (g - b) / d
    } else if v == g {
        120.0 + 60.0 * (b - r) / d
    } else {
        240.0 + 60.0 * (r - g) / d
    };
    [(if h < 0.0 { h + 360.0 } else { h }) / 2.0, s, v]
}

#[test]
fn lit_pollen_lands_in_the_detector_hsv_band() {
    // The camera sits on the sun's side of the ball, so it sees the lit hemisphere.
    let ball = Ball::on_floor(5, BallKind::Pollen, 0.0, 0.0);
    let pos = Vec3::new(-0.5, 0.3, 0.25);
    let yaw = 0.25f32.atan2(0.5);
    let pitch = (pos.y - ball.radius).atan2(pos.x.hypot(pos.z));
    let cam = Camera::new(Intrinsics::default(), pos, yaw, pitch);
    let r = render(field(), &cam, &[ball], &[], [0.0; 2]);
    let l = label(&r, 5);
    assert!((l.center[0] - 320.0).abs() < 2.0 && (l.center[1] - 240.0).abs() < 2.0, "aimed at the ball: {:?}", l.center);
    let (mut inside, mut total) = (0, 0);
    for (i, &id) in r.frame.ids.iter().enumerate() {
        if Owner::from_raw(id) != Owner::Ball(0) {
            continue;
        }
        total += 1;
        let [h, s, v] = hsv(&r.frame.rgb[3 * i..3 * i + 3]);
        if (15.0..=38.0).contains(&h) && (110.0..=255.0).contains(&s) && (70.0..=255.0).contains(&v) {
            inside += 1;
        }
    }
    let frac = inside as f32 / total as f32;
    assert!(total > 1000 && frac > 0.9, "{inside} of {total} pollen pixels in the band");
}

#[test]
fn scene_is_shareable_across_threads() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<Scene>();
}

#[test]
fn holes_turn_with_the_ball() {
    // A plain sphere looks the same however it is turned, so any change comes from the holes.
    let cam = Camera::new(Intrinsics::default(), Vec3::new(0.0, 0.2, 0.0), 0.0, 0.0);
    let ball = Ball::new(1, BallKind::Pollen, Vec3::new(0.5, 0.2, 0.0));
    let a = render(&Scene::empty(), &cam, &[ball], &[], [0.0; 2]);
    let b = render(&Scene::empty(), &cam, &[ball.turned(bench_render::Quat::from_rotation_y(0.3))], &[], [0.0; 2]);
    let owned = (0..640 * 480).filter(|&i| a.frame.ids[i] == b.frame.ids[i] && a.frame.owner((i % 640) as u32, (i / 640) as u32) == Owner::Ball(0));
    let (n, changed) = owned.fold((0, 0), |(n, c), i| (n + 1, c + (a.frame.rgb[3 * i..3 * i + 3] != b.frame.rgb[3 * i..3 * i + 3]) as u32));
    let frac = changed as f32 / n as f32;
    assert!(frac > 0.1 && frac < 0.6, "{frac:.3} of the ball changed");
    assert!(label(&a, 1).visible > 0.99, "a hole isn't occlusion");
}
