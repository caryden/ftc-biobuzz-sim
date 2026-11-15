//! The top bar, the right column (camera, robot, tree, robot code, log), the timeline and the score breakdown.

use crate::camera::MountKind;
use crate::field::path;
use crate::model::{History, MarkKind, Score, State};
use crate::theme::*;
use crate::ui::*;
use crate::{model, Bench, Tab, SPEEDS};
use gpui::{canvas, div, img, prelude::*, px, Bounds, ClipboardItem, Context, Div, FontWeight, ObjectFit, Pixels, Window};
use std::sync::atomic::Ordering;

/// Seconds in a MATCH of this mode, or the time so far for practice.
pub fn match_length(mode: &str, so_far: f32) -> f32 {
    match mode {
        "full" => 158.0,
        "teleop" => 120.0,
        "auto" => 30.0,
        _ => so_far.max(60.0),
    }
}

/// Where the timeline names the parts of a MATCH, in MATCH seconds.
fn timeline_labels(mode: &str) -> Vec<(f32, &'static str)> {
    match mode {
        "full" => vec![(0.0, "AUTO"), (38.0, "TELEOP"), (98.0, "FLOWERS open"), (138.0, "endgame")],
        "teleop" => vec![(0.0, "TELEOP"), (60.0, "FLOWERS open"), (100.0, "endgame")],
        "auto" => vec![(0.0, "AUTO")],
        _ => vec![],
    }
}

fn clock(t: f32) -> String {
    let t = t.max(0.0);
    format!("{}:{:02}", (t / 60.0) as u32, (t % 60.0) as u32)
}

fn speed_label(s: f32) -> String {
    if s == 0.0 { "max".into() } else if s < 1.0 { format!("{s}×") } else { format!("{}×", s as u32) }
}

fn mode_label(m: &str) -> &'static str {
    match m {
        "full" => "full MATCH",
        "teleop" => "TELEOP only",
        "auto" => "AUTO only",
        _ => "practice",
    }
}

#[derive(Clone, Copy)]
enum Icon {
    Play,
    Pause,
    Back,
    Forward,
    Restart,
}

/// A transport icon drawn as paths, 14 px square.
fn icon(kind: Icon, col: u32) -> impl IntoElement {
    canvas(|_, _, _| {}, move |b: Bounds<Pixels>, _, window: &mut Window, _| {
        let (x, y) = (f32::from(b.origin.x), f32::from(b.origin.y));
        let p = |u: f32, v: f32| (x + u, y + v);
        let k = c(col);
        match kind {
            Icon::Play => path(window, &[p(3.0, 2.0), p(12.0, 7.0), p(3.0, 12.0)], k, None, true),
            Icon::Pause => {
                path(window, &[p(3.0, 2.0), p(6.0, 2.0), p(6.0, 12.0), p(3.0, 12.0)], k, None, true);
                path(window, &[p(8.5, 2.0), p(11.5, 2.0), p(11.5, 12.0), p(8.5, 12.0)], k, None, true);
            }
            Icon::Back => {
                path(window, &[p(11.0, 2.5), p(4.0, 7.0), p(11.0, 11.5)], k, None, true);
                path(window, &[p(2.5, 2.5), p(4.0, 2.5), p(4.0, 11.5), p(2.5, 11.5)], k, None, true);
            }
            Icon::Forward => {
                path(window, &[p(3.0, 2.5), p(10.0, 7.0), p(3.0, 11.5)], k, None, true);
                path(window, &[p(10.0, 2.5), p(11.5, 2.5), p(11.5, 11.5), p(10.0, 11.5)], k, None, true);
            }
            Icon::Restart => {
                let pts: Vec<(f32, f32)> = (0..=24).map(|i| {
                    let a = 0.6 + i as f32 / 24.0 * 5.2;
                    p(7.0 + 4.5 * a.cos(), 7.0 + 4.5 * a.sin())
                }).collect();
                path(window, &pts, k, Some(1.6), false);
                path(window, &[p(9.5, 1.0), p(12.8, 3.4), p(9.2, 5.2)], k, None, true);
            }
        }
    })
    .size(px(14.0))
}

pub fn top_bar(b: &Bench, state: Option<&State>, cx: &mut Context<Bench>) -> impl IntoElement {
    let playing = b.sim.playing.load(Ordering::Relaxed);
    let phase = state.map(|s| s.phase.as_str()).unwrap_or("pre");
    let (period, clk) = state.map_or(("", 0.0), |s| (s.period_label(), s.clock));
    let (rs, bs) = state.map_or((0, 0), |s| (s.score.red.total, s.score.blue.total));
    let (badge_text, badge_col) = match (phase, b.cursor.is_some()) {
        ("pre", _) => ("READY", TEXT),
        ("post", false) => ("FINAL", TEXT),
        (_, true) => ("REVIEW", TEXT),
        (_, false) if playing => ("LIVE", GREEN),
        _ => ("PAUSED", TEXT),
    };
    let play_icon = if playing && b.cursor.is_none() { Icon::Pause } else { Icon::Play };
    let transport = div()
        .flex()
        .items_center()
        .gap(px(2.0))
        .child(button(false).id("restart").child(icon(Icon::Restart, TEXT)).on_click(cx.listener(|b, _, _, cx| {
            b.reset(b.seed);
            cx.notify();
        })))
        .child(button(false).id("back").child(icon(Icon::Back, TEXT)).on_click(cx.listener(|b, _, _, cx| {
            b.seek(-60);
            cx.notify();
        })))
        .child(button(true).id("play").child(icon(play_icon, HI)).on_click(cx.listener(|b, _, _, cx| {
            b.play_pause();
            cx.notify();
        })))
        .child(button(false).id("fwd").child(icon(Icon::Forward, TEXT)).on_click(cx.listener(|b, _, _, cx| {
            b.seek(60);
            cx.notify();
        })))
        .child(button(false).id("speed").font_family(MONO).child(speed_label(b.sim.speed())).on_click(cx.listener(|b, _, _, cx| {
            let i = SPEEDS.iter().position(|x| *x == b.sim.speed()).unwrap_or(2);
            b.sim.set_speed(SPEEDS[(i + 1) % SPEEDS.len()]);
            cx.notify();
        })));
    let seed = div()
        .flex()
        .items_center()
        .gap_1()
        .child(text("seed", DIM))
        .child(button(false).id("seed-").child("‹").on_click(cx.listener(|b, _, _, cx| {
            b.reset(b.seed.saturating_sub(1).max(1));
            cx.notify();
        })))
        .child(mono(b.seed.to_string(), HI))
        .child(button(false).id("seed+").child("›").on_click(cx.listener(|b, _, _, cx| {
            b.reset(b.seed + 1);
            cx.notify();
        })));
    let score = div()
        .id("score")
        .flex()
        .items_center()
        .gap_3()
        .px_3()
        .py_1()
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(|s| s.bg(c(0x1a1a1a)))
        .when(b.score_open, |d| d.bg(c(0x1a1a1a)))
        .child(div().font_family(MONO).text_size(px(22.0)).text_color(c(ALLIANCE_RED)).child(rs.to_string()))
        .child(div().text_color(c(DIM)).child("–"))
        .child(div().font_family(MONO).text_size(px(22.0)).text_color(c(ALLIANCE_BLUE)).child(bs.to_string()))
        .on_click(cx.listener(|b, _, _, cx| {
            b.score_open = !b.score_open;
            cx.notify();
        }));
    div()
        .flex()
        .flex_none()
        .items_center()
        .h(px(52.0))
        .px_4()
        .gap_5()
        .border_b_1()
        .border_color(c(LINE))
        .child(div().text_size(px(14.0)).font_weight(FontWeight::SEMIBOLD).text_color(c(HI)).child("bench"))
        .child(transport)
        .child(badge(badge_text, badge_col))
        .child(seed)
        .child(text(mode_label(&b.mode), DIM))
        .child(div().flex_1())
        .when(state.is_some_and(|s| s.unlocked && s.phase == "teleop"), |d| d.child(badge("FLOWERS open", TEXT)))
        .child(
            div()
                .flex()
                .items_baseline()
                .gap_2()
                .child(div().text_size(px(11.0)).font_weight(FontWeight::SEMIBOLD).text_color(c(DIM)).child(period))
                .child(div().font_family(MONO).text_size(px(22.0)).text_color(c(HI)).child(clock(clk))),
        )
        .child(score)
}

/// Both alliances' score lines side by side, opened from the score in the top bar.
pub fn score_popover(state: Option<&State>) -> Option<Div> {
    let s = state?;
    type Line = (&'static str, fn(&Score) -> i32);
    let rows: [Line; 10] = [
        ("LEAVE", |x| x.leave),
        ("AUTO PARK", |x| x.auto_park),
        ("AUTO TIPS", |x| x.auto_tips),
        ("TELEOP TIPS", |x| x.teleop_tips),
        ("in CELL", |x| x.cell),
        ("FLOWERS", |x| x.flower),
        ("bottom NECTAR", |x| x.bottom_nectar),
        ("GARDEN", |x| x.garden),
        ("PARK", |x| x.park),
        ("opponent FOULS", |x| x.fouls),
    ];
    let line = |k: &str, r: String, bl: String, col: u32| {
        div()
            .flex()
            .py(px(2.0))
            .child(div().flex_1().text_color(c(DIM)).child(k.to_string()))
            .child(div().w(px(56.0)).flex().justify_end().font_family(MONO).text_color(c(col)).child(r))
            .child(div().w(px(56.0)).flex().justify_end().font_family(MONO).text_color(c(col)).child(bl))
    };
    let mut d = div()
        .absolute()
        .top(px(56.0))
        .right(px(12.0))
        .w(px(330.0))
        .p_3()
        .rounded(px(8.0))
        .bg(c(0x141414))
        .border_1()
        .border_color(c(LINE))
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .pb_1()
                .child(div().flex_1().child(header("score")))
                .child(div().w(px(56.0)).flex().justify_end().text_color(c(ALLIANCE_RED)).child("RED"))
                .child(div().w(px(56.0)).flex().justify_end().text_color(c(ALLIANCE_BLUE)).child("BLUE")),
        );
    for (k, f) in rows {
        let (r, bl) = (f(&s.score.red), f(&s.score.blue));
        d = d.child(line(k, r.to_string(), bl.to_string(), if r == 0 && bl == 0 { DIM } else { TEXT }));
    }
    let rp = |x: &Score| [(x.rp.swarm, "S"), (x.rp.pollinator1, "P1"), (x.rp.pollinator2, "P2")].iter().filter(|(on, _)| *on).map(|(_, n)| *n).collect::<Vec<_>>().join(" ");
    let (rr, br) = (rp(&s.score.red), rp(&s.score.blue));
    d = d.child(div().h(px(1.0)).my_2().bg(c(LINE)));
    d = d.child(line("total", s.score.red.total.to_string(), s.score.blue.total.to_string(), HI));
    d = d.child(line("ranking points", if rr.is_empty() { "-".into() } else { rr }, if br.is_empty() { "-".into() } else { br }, TEXT));
    Some(d.child(div().pt_2().text_size(px(11.0)).text_color(c(DIM)).child("S is SWARM, P1 and P2 are POLLINATOR 1 and 2")))
}

pub fn right_column(b: &Bench, h: &History, i: usize, state: Option<&State>, width: f32, cx: &mut Context<Bench>) -> impl IntoElement {
    let body = match b.tab {
        Tab::Robot => state.map(|s| robot_tab(b, h, s, cx)).unwrap_or_else(div),
        Tab::Tree => tree_tab(b, h, i),
        Tab::Code => code_tab(b, cx),
        Tab::Log => log_tab(h, i),
    };
    let mut tabs = div().flex().gap_1().mt_3().pb_2().border_b_1().border_color(c(LINE));
    for (t, name) in [(Tab::Robot, "Robot"), (Tab::Tree, "Behavior tree"), (Tab::Code, "Robot code"), (Tab::Log, "Log")] {
        tabs = tabs.child(button(b.tab == t).id(name).child(name).on_click(cx.listener(move |b, _, _, cx| {
            b.tab = t;
            cx.notify();
        })));
    }
    div()
        .id("right")
        .relative()
        .w(px(width))
        .flex_none()
        .h_full()
        .flex()
        .flex_col()
        .child(div().absolute().top_0().bottom_0().left(px(-3.0)).w(px(6.0)).cursor_col_resize())
        .px_4()
        .pt_2()
        .border_l_1()
        .border_color(c(LINE))
        .bg(c(PANEL))
        .child(camera_block(b, width - 32.0, cx))
        .child(tabs)
        .child(div().id("tab-body").flex_1().min_h_0().overflow_y_scroll().pt_1().pb_4().child(body))
}

fn camera_block(b: &Bench, iw: f32, cx: &mut Context<Bench>) -> impl IntoElement {
    let ih = iw * 0.75;
    let r = b.shown.clone();
    let mut stage = div().relative().w(px(iw)).h(px(ih)).rounded(px(4.0)).bg(c(0x080808)).overflow_hidden();
    if let Some(r) = &r {
        let scale = iw / r.width as f32;
        let prims = r.overlay.clone();
        stage = stage
            .child(img(r.image.clone()).absolute().top_0().left_0().w(px(iw)).h(px(ih)).object_fit(ObjectFit::Fill))
            .child(canvas(|_, _, _| {}, move |bb, _, window, _| crate::camera::paint_overlay(bb, scale, &prims, window)).absolute().top_0().left_0().size_full());
        for ([x, y], t, col) in &r.tags {
            stage = stage.child(
                div()
                    .absolute()
                    .left(px((x * scale).min(iw - 60.0)))
                    .top(px((y * scale).max(0.0)))
                    .px(px(3.0))
                    .rounded(px(2.0))
                    .bg(ca(0x000000, 0.65))
                    .font_family(MONO)
                    .text_size(px(10.0))
                    .text_color(c(*col))
                    .child(t.clone()),
            );
        }
    } else {
        stage = stage.flex().items_center().justify_center().child(text("rendering", DIM));
    }
    let pollen = b.mount == MountKind::Pollen;
    let mounts = div()
        .flex()
        .gap_1()
        .child(button(pollen).id("m-pollen").child("Pollen").on_click(cx.listener(|b, _, _, cx| {
            b.mount = MountKind::Pollen;
            b.cam.reset();
            cx.notify();
        })))
        .child(button(!pollen).id("m-tags").child("AprilTag").on_click(cx.listener(|b, _, _, cx| {
            b.mount = MountKind::Tags;
            b.cam.reset();
            cx.notify();
        })));
    let timing = r.as_ref().map(|r| {
        let det = r.det.as_ref().filter(|d| d.real).map(|d| format!("  detect {:.1}", d.ms)).unwrap_or_default();
        format!("render {:.1}{det} ms", r.render_ms)
    });
    let plate = r.as_ref().map(|r| r.plate.clone()).unwrap_or_default();
    let head = div()
        .flex()
        .items_center()
        .justify_between()
        .child(div().flex().items_center().gap_2().child(header("camera")).child(mono(plate, TEXT)).child(mounts))
        .when_some(timing, |d, t| d.child(mono(t, DIM).text_size(px(11.0))));

    let mut stats = div().flex().items_end().gap_5().pt_2();
    if let Some(r) = &r {
        let k = &r.counts;
        stats = stats
            .child(stat("in view", k.targets.to_string(), HI))
            .child(stat("found", k.found.to_string(), if k.found > 0 { GREEN } else { DIM }))
            .child(stat("missed", k.missed.to_string(), if k.missed > 0 { RED } else { DIM }))
            .child(stat("false", k.false_pos.to_string(), if k.false_pos > 0 { RED } else { DIM }))
            .when(k.cropped > 0, |d| d.child(stat("cropped", k.cropped.to_string(), DIM)))
            .child(div().flex_1());
        stats = match (r.real(), b.cam.totals()) {
            (true, Some((n, recall, fp))) => stats.child(
                div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .child(mono(format!("{:.1}% recall", recall * 100.0), TEXT))
                    .child(div().text_size(px(10.5)).text_color(c(DIM)).child(format!("{fp:.2} false per frame, {n} frames"))),
            ),
            (false, _) => stats.child(div().max_w(px(170.0)).text_size(px(10.5)).text_color(c(DIM)).child("perfect camera from the labels: pass --detector to test a real one")),
            _ => stats,
        };
    }
    div().flex().flex_col().gap_1().child(head).child(stage).child(stats)
}

fn robot_tab(b: &Bench, h: &History, s: &State, cx: &mut Context<Bench>) -> Div {
    let Some(field) = h.field.as_ref() else { return div() };
    let mut cards = div().flex().gap_2().pt_2();
    for (k, (r, info)) in s.robots.iter().zip(field.robots.iter()).enumerate() {
        let sel = k == b.selected;
        let mut dots = div().flex().gap(px(3.0));
        for kind in &r.carried {
            dots = dots.child(dot(ball(*kind), 6.0));
        }
        for _ in r.carried.len()..crate::CAPACITY {
            dots = dots.child(div().size(px(6.0)).rounded_full().border_1().border_color(c(LINE)));
        }
        cards = cards.child(
            div()
                .id(("robot", k))
                .flex_1()
                .flex()
                .flex_col()
                .gap_1()
                .p_2()
                .rounded(px(6.0))
                .border_1()
                .border_color(c(if sel { 0x5a5a5a } else { LINE }))
                .when(sel, |d| d.bg(c(0x1a1a1a)))
                .cursor_pointer()
                .hover(|d| d.bg(c(0x1d1d1d)))
                .child(div().flex().items_center().gap_1().child(dot(alliance(info.red()), 7.0)).child(mono(format!("{} {}", k + 1, info.plate), if sel { HI } else { TEXT })))
                .child(dots)
                .on_click(cx.listener(move |b, _, _, cx| {
                    b.select(k);
                    cx.notify();
                })),
        );
    }
    let Some(r) = s.robots.get(b.selected) else { return cards };
    let info = &field.robots[b.selected];
    let carried: Vec<&str> = r.carried.iter().map(|k| match *k {
        model::NECTAR_RED => "red NECTAR",
        model::NECTAR_BLUE => "blue NECTAR",
        _ => "POLLEN",
    }).collect();
    let driver = match (r.driver.as_str(), b.autopilot) {
        ("planner", true) => "planner launches, then the autopilot".to_string(),
        (_, true) => "autopilot (decision layer)".to_string(),
        ("goto", _) => "drive to a spot (esc releases)".to_string(),
        (d, _) => d.to_string(),
    };
    div()
        .flex()
        .flex_col()
        .child(cards)
        .child(header(&format!("{} {}, {} alliance", b.selected + 1, info.plate, info.alliance)))
        .child(kv("driver", driver))
        .when(r.driver == "planner", |d| {
            d.child(kv("tactic", if r.tactic.is_empty() { "-".to_string() } else { r.tactic.clone() }))
                .child(kv("doing", if r.note.is_empty() { "-".to_string() } else { r.note.clone() }))
        })
        .child(kv("pose", format!("{:+.2} {:+.2} m  {:+.0}°", r.x, r.z, r.heading.sin().atan2(r.heading.cos()).to_degrees())))
        .child(kv("speed", format!("{:.2} m/s  {:+.1} rad/s", r.speed, r.w)))
        .child(kv("battery", format!("{:.2} V", r.bus)))
        .child(kv("carries", if carried.is_empty() { "nothing".into() } else { carried.join(", ") }))
        .child(kv("AprilTags", if r.sightings.is_empty() { "none in view".into() } else { r.sightings.join("  ") }))
}

fn tree_tab(b: &Bench, h: &History, i: usize) -> Div {
    let Some(model::TreeView { def, running, last }) = h.tree_at(b.selected, i) else { return div().pt_2().child(text("no tree yet", DIM)) };
    let mut d = div().flex().flex_col().child(header(&def.name));
    for n in &def.nodes {
        let run = running.contains(&n.idx);
        let res = last.get(&n.idx).map(String::as_str);
        let (mark, col) = match (run, res) {
            (true, _) => ("●", HI),
            (_, Some("s")) => ("✓", DIM),
            (_, Some(r)) if r.starts_with("f:") => ("✗", RED),
            (_, Some("h")) => ("–", DIM),
            (_, Some(_)) => ("!", RED),
            _ => ("", DIM),
        };
        let tag = res.and_then(|r| r.strip_prefix("f:")).filter(|t| !t.is_empty());
        let leaf = n.kind == "ref";
        let label = if leaf || n.label == n.kind { n.label.clone() } else { format!("{} {}", n.kind, n.label) };
        d = d.child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .py(px(1.5))
                .pl(px(6.0 + n.depth as f32 * 14.0))
                .rounded(px(3.0))
                .when(run, |d| d.bg(c(0x1c1c1c)))
                .child(div().w(px(12.0)).font_family(MONO).text_color(c(col)).child(mark))
                .child(div().font_family(if leaf { MONO } else { UI }).text_color(c(if run { HI } else if leaf { TEXT } else { DIM })).child(label))
                .when_some(tag, |d, t| d.child(div().font_family(MONO).text_size(px(11.0)).text_color(c(RED)).child(t.to_string()))),
        );
    }
    d
}

/// A short name for a plug-in command: the script or class it runs.
fn short_name(cmd: &str) -> String {
    let words: Vec<&str> = cmd.split_whitespace().collect();
    let pick = words.iter().rev().find(|w| w.ends_with(".py") || w.ends_with(".jar")).or(words.last()).copied().unwrap_or("");
    pick.rsplit('/').next().unwrap_or(pick).to_string()
}

fn code_tab(b: &Bench, cx: &mut Context<Bench>) -> Div {
    let err = b.cam.error();
    let mut d = div().flex().flex_col();

    d = d.child(header("detector"));
    match &b.args.detector {
        None => d = d.child(text("None. Pass --detector to run a camera pipeline on these frames. Until then, a perfect camera built from the labels feeds the decision layer.", DIM)),
        Some(cmd) => {
            let failed = err.as_deref().is_some_and(|e| e.starts_with("detector"));
            let health = if failed { RED } else if b.detector_on { GREEN } else { DIM };
            let cmd = cmd.clone();
            d = d.child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(dot(health, 8.0))
                    .child(mono(short_name(&cmd), HI))
                    .child(div().flex_1())
                    .child(button(b.detector_on).id("det-toggle").child(if b.detector_on { "On" } else { "Off" }).on_click(cx.listener(|b, _, _, cx| {
                        b.detector_on = !b.detector_on;
                        b.cam.reset();
                        cx.notify();
                    })))
                    .child(button(false).id("det-copy").child("Copy command").on_click(cx.listener(move |b, _, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                        b.say("copied the detector command");
                        cx.notify();
                    }))),
            );
            if let Some(det) = b.shown.as_ref().and_then(|r| r.det.as_ref()).filter(|d| d.real) {
                let names = ["hsv", "ccl", "verify", "geom", "track"];
                let total: f32 = det.timings.iter().sum::<f32>().max(0.01);
                let worst = det.timings.iter().cloned().fold(0.0f32, f32::max);
                let shades = [0x5a5a5a, 0x4a4a4a, 0x6b6b6b, 0x3e3e3e, 0x777777];
                let mut bar = div().flex().h(px(8.0)).w_full().mt_2().rounded(px(2.0)).overflow_hidden();
                let mut legend = div().flex().flex_wrap().gap_x_3().pt_1();
                for (k, t) in det.timings.iter().enumerate() {
                    let top = *t == worst && worst > 0.0;
                    bar = bar.child(div().h_full().w(gpui::relative(t / total)).bg(c(if top { HI } else { shades[k] })));
                    legend = legend.child(mono(format!("{} {:.1}", names[k], t), if top { HI } else { DIM }).text_size(px(11.0)));
                }
                d = d.child(kv("round trip", format!("{:.1} ms", det.ms))).child(kv("pipeline", format!("{total:.1} ms"))).child(bar).child(legend);
            }
        }
    }

    d = d.child(header("decision layer"));
    match &b.args.harness {
        None => d = d.child(text("None. Pass --harness to run the robot's pollen decisions here.", DIM)),
        Some(cmd) => {
            let failed = err.as_deref().is_some_and(|e| e.starts_with("decision"));
            let dec = b.shown.as_ref().and_then(|r| r.decision.clone());
            let health = if failed { RED } else if dec.is_some() { GREEN } else { DIM };
            let cmd = cmd.clone();
            d = d.child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(dot(health, 8.0))
                    .child(mono(short_name(&cmd), HI))
                    .child(div().flex_1())
                    .child(button(b.autopilot).id("autopilot").child(if b.autopilot { "Autopilot on" } else { "Autopilot" }).on_click(cx.listener(|b, _, _, cx| {
                        b.toggle_autopilot();
                        cx.notify();
                    })))
                    .child(button(false).id("dec-copy").child("Copy command").on_click(cx.listener(move |b, _, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                        b.say("copied the decision layer command");
                        cx.notify();
                    }))),
            );
            match dec {
                Some(dec) => {
                    let col = match dec.state.as_str() {
                        "LOCKED" => GREEN,
                        "LOST" => RED,
                        _ => TEXT,
                    };
                    d = d
                        .child(div().flex().items_center().gap_2().pt_2().child(badge(dec.state.clone(), col)).when_some(dec.target.as_ref(), |d, t| {
                            d.child(text(format!("{} POLLEN, score {:.2}, confidence {:.2}", t.members.len(), dec.score, dec.conf), TEXT))
                        }))
                        .child(kv("tracks", dec.tracks.len().to_string()))
                        .child(kv("pending", dec.pending.to_string()))
                        .child(kv("target switches", dec.switches.to_string()));
                }
                None => d = d.child(div().pt_1().text_color(c(DIM)).child("Runs on live frames. Play the MATCH to see its calls.")),
            }
        }
    }
    if let Some(e) = err {
        d = d.child(div().mt_3().p_2().rounded(px(4.0)).bg(c(0x1a0d0d)).border_1().border_color(ca(RED, 0.6)).font_family(MONO).text_size(px(11.0)).text_color(c(RED)).child(e));
    }
    d
}

fn log_tab(h: &History, i: usize) -> Div {
    let mut d = div().flex().flex_col().pt_2();
    for (_, m) in h.log.iter().rev().filter(|(f, _)| *f <= i).take(80) {
        d = d.child(div().flex().gap_3().py(px(1.0)).child(mono(format!("{:>6.1}", m.t), DIM)).child(text(m.text.clone(), TEXT)));
    }
    d
}

pub fn timeline(b: &Bench, h: &History, i: usize) -> impl IntoElement {
    let total = match_length(&b.mode, h.times.last().copied().unwrap_or(0.0));
    let x = |f: usize| h.times.get(f).copied().unwrap_or(0.0) / total;
    let phases: Vec<(f32, f32, String)> = h
        .phases
        .iter()
        .enumerate()
        .map(|(k, (start, p))| (x(*start), h.phases.get(k + 1).map_or(x(h.len().saturating_sub(1)), |(f, _)| x(*f)), p.clone()))
        .collect();
    let marks: Vec<(f32, MarkKind)> = h.marks.iter().map(|m| (x(m.frame), m.kind)).collect();
    let misses: Vec<(f32, u32)> = b.cam.miss_history().into_iter().map(|(f, n)| (x(f), n)).collect();
    // The score plot: one point per 20 frames is plenty at this width.
    let scores: Vec<(f32, i32, i32)> = h.scores.iter().enumerate().step_by(20).map(|(f, s)| (x(f), s.0, s.1)).chain(h.scores.last().map(|s| (x(h.len() - 1), s.0, s.1))).collect();
    let head = x(i);
    let tb = b.timeline_bounds.clone();
    let mut labels = div().absolute().top_0().left_0().size_full();
    for (t, name) in timeline_labels(&b.mode) {
        labels = labels.child(div().absolute().top_0().left(gpui::relative(t / total)).pl_1().text_size(px(10.5)).text_color(c(DIM)).child(name));
    }
    let st = h.frames.get(i);
    let (period, clk) = st.map_or(("", 0.0), |s| (s.period_label(), s.clock));
    // What the pointer is over: the time, the score then, and any TIPS within a second and a half.
    let hover = b.timeline_hover;
    let tip = hover.and_then(|fr| {
        let t = fr * total;
        let f = h.frame_at(t);
        let s = h.frames.get(f)?;
        if h.times.get(f).copied().unwrap_or(0.0) + 0.5 < t {
            return None;
        }
        let (r, bl) = h.scores.get(f).copied().unwrap_or((0, 0));
        let events: Vec<(String, u32)> = h
            .marks
            .iter()
            .filter(|m| (h.times.get(m.frame).copied().unwrap_or(0.0) - t).abs() < 1.5)
            .filter_map(|m| match m.kind {
                MarkKind::Tip { red } => Some((format!("{} HIVE TIP", if red { "RED" } else { "BLUE" }), alliance(red))),
                MarkKind::Foul => Some(("FOUL".to_string(), HI)),
                MarkKind::Phase => None,
            })
            .collect();
        let mut d = div()
            .absolute()
            .bottom(px(70.0))
            .left(gpui::relative(fr))
            .flex()
            .flex_col()
            .gap(px(1.0))
            .px_2()
            .py_1()
            .rounded(px(5.0))
            .bg(c(0x161616))
            .border_1()
            .border_color(c(LINE))
            .text_size(px(11.5))
            .child(div().flex().gap_2().child(text(s.period_label(), DIM)).child(mono(clock(s.clock), HI)))
            .child(div().flex().gap_2().child(mono(r.to_string(), ALLIANCE_RED)).child(text("–", DIM)).child(mono(bl.to_string(), ALLIANCE_BLUE)));
        for (e, col) in events {
            d = d.child(text(e, col));
        }
        Some(d)
    });
    div()
        .flex()
        .flex_none()
        .h(px(84.0))
        .px_4()
        .gap_4()
        .items_center()
        .border_t_1()
        .border_color(c(LINE))
        .child(
            div()
                .w(px(96.0))
                .flex()
                .flex_col()
                .child(div().text_size(px(10.5)).font_weight(FontWeight::SEMIBOLD).text_color(c(DIM)).child(period))
                .child(mono(clock(clk), HI).text_size(px(18.0))),
        )
        .child(
            div()
                .relative()
                .flex_1()
                .h_full()
                .py_2()
                .child(labels)
                .child(canvas(move |bb, _, _| tb.set(bb), move |bb, _, window, _| paint_timeline(bb, &phases, &marks, &misses, &scores, head, hover, window)).size_full())
                .when_some(tip, |d, t| d.child(t)),
        )
}

#[allow(clippy::too_many_arguments)]
fn paint_timeline(b: Bounds<Pixels>, phases: &[(f32, f32, String)], marks: &[(f32, MarkKind)], misses: &[(f32, u32)], scores: &[(f32, i32, i32)], head: f32, hover: Option<f32>, window: &mut Window) {
    let (x0, y0, w, h) = (f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height));
    let xf = |t: f32| x0 + w * t.clamp(0.0, 1.0);
    let rect = |window: &mut Window, xa: f32, xb: f32, ya: f32, yb: f32, col: gpui::Hsla| path(window, &[(xa, ya), (xb, ya), (xb, yb), (xa, yb)], col, None, true);
    let (plot_top, plot_bot) = (y0 + 14.0, y0 + h - 12.0);
    let base = plot_bot;
    // Phase bands under the plot: AUTO brighter than TELEOP, the transition left out.
    for (a, bb, phase) in phases {
        let col = match phase.as_str() {
            "auto" => ca(TEXT, 0.10),
            "teleop" => ca(TEXT, 0.05),
            _ => continue,
        };
        rect(window, xf(*a), xf(*bb).max(xf(*a) + 1.0), plot_top, plot_bot, col);
    }
    path(window, &[(x0, base), (x0 + w, base)], c(LINE), Some(1.0), false);
    // Both alliances' totals as step lines.
    let top = scores.iter().map(|s| s.1.max(s.2)).max().unwrap_or(0).max(60) as f32;
    let y = |v: i32| base - (v as f32 / top) * (plot_bot - plot_top - 2.0);
    for (red, col) in [(true, ALLIANCE_RED), (false, ALLIANCE_BLUE)] {
        let mut pts = Vec::with_capacity(scores.len() * 2);
        for (k, s) in scores.iter().enumerate() {
            let v = if red { s.1 } else { s.2 };
            if k > 0 {
                pts.push((xf(s.0), pts.last().map_or(y(v), |p: &(f32, f32)| p.1)));
            }
            pts.push((xf(s.0), y(v)));
        }
        path(window, &pts, ca(col, 0.9), Some(1.5), false);
    }
    for &(t, kind) in marks {
        match kind {
            MarkKind::Tip { red } => {
                let xx = xf(t);
                path(window, &[(xx - 3.5, y0 + 4.0), (xx + 3.5, y0 + 4.0), (xx, y0 + 10.0)], c(alliance(red)), None, true);
            }
            MarkKind::Foul => path(window, &[(xf(t), y0 + 2.0), (xf(t), y0 + 10.0)], c(HI), Some(2.0), false),
            MarkKind::Phase => {}
        }
    }
    for &(t, k) in misses {
        let hgt = (k as f32 * 2.5).min(9.0);
        path(window, &[(xf(t), base + 2.0), (xf(t), base + 2.0 + hgt)], ca(RED, 0.75), Some(1.0), false);
    }
    if let Some(fr) = hover {
        path(window, &[(xf(fr), y0), (xf(fr), y0 + h)], ca(HI, 0.3), Some(1.0), false);
    }
    // The playhead is a 2 px line with a knob.
    let hx = xf(head);
    path(window, &[(hx, y0), (hx, y0 + h)], c(HI), Some(2.0), false);
    path(window, &crate::field::circle_pts(hx, base, 4.0), c(HI), None, true);
}
