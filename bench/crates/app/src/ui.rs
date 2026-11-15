//! Small building blocks for the panels: text in the UI and number fonts, section headers, key-value rows, chips,
//! and buttons. Labels use Inter, and anything that is a number, a name from the code or a key uses JetBrains Mono.

use crate::theme::*;
use gpui::{div, prelude::*, px, Div, FontWeight, SharedString};

pub const UI: &str = "Inter";
pub const MONO: &str = "JetBrains Mono";

/// The bundled fonts, so the app looks the same on a machine without them installed.
pub const FONTS: [&[u8]; 4] = [
    include_bytes!("../fonts/Inter-Regular.ttf"),
    include_bytes!("../fonts/Inter-SemiBold.ttf"),
    include_bytes!("../fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../fonts/JetBrainsMono-Medium.ttf"),
];

pub fn text(s: impl Into<SharedString>, col: u32) -> Div {
    div().text_color(c(col)).child(s.into())
}

pub fn mono(s: impl Into<SharedString>, col: u32) -> Div {
    div().font_family(MONO).text_color(c(col)).child(s.into())
}

/// A section header: small caps-style label with room above it.
pub fn header(s: &str) -> Div {
    div().pt_3().pb_1().text_size(px(10.5)).font_weight(FontWeight::SEMIBOLD).text_color(c(DIM)).child(s.to_uppercase())
}

/// A label and its value on one line, the value in the number font, cut short if it doesn't fit.
pub fn kv(k: &str, v: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .justify_between()
        .gap_4()
        .py(px(2.0))
        .child(div().flex_none().text_color(c(DIM)).child(k.to_string()))
        .child(div().min_w_0().truncate().font_family(MONO).text_color(c(TEXT)).child(v.into()))
}

/// A number with a label under it, colored by what it means.
pub fn stat(label: &str, value: impl Into<SharedString>, col: u32) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(1.0))
        .child(div().font_family(MONO).text_size(px(17.0)).text_color(c(col)).child(value.into()))
        .child(div().text_size(px(10.5)).text_color(c(DIM)).child(label.to_string()))
}

/// A small rounded label, for states like LIVE or LOCKED.
pub fn badge(s: impl Into<SharedString>, col: u32) -> Div {
    div()
        .px(px(6.0))
        .py(px(1.0))
        .rounded(px(3.0))
        .border_1()
        .border_color(ca(col, 0.55))
        .bg(ca(col, 0.12))
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c(col))
        .child(s.into())
}

/// A colored dot, for a process's health or a ball's kind.
pub fn dot(col: u32, size: f32) -> Div {
    div().flex_none().size(px(size)).rounded_full().bg(c(col))
}

/// A key and what it does, for the hint line.
pub fn key_hint(k: &str, what: &str) -> Div {
    div()
        .flex()
        .items_center()
        .gap_1()
        .child(div().px(px(4.0)).rounded(px(3.0)).bg(c(FAINT)).font_family(MONO).text_size(px(10.5)).text_color(c(TEXT)).child(k.to_string()))
        .child(text(what.to_string(), DIM))
}

/// The look of a clickable control: quiet until hovered, brighter when on. Give it an id and a click handler.
pub fn button(on: bool) -> Div {
    div()
        .px(px(8.0))
        .py(px(3.0))
        .rounded(px(4.0))
        .cursor_pointer()
        .text_color(c(if on { HI } else { TEXT }))
        .when(on, |d| d.bg(c(0x1f1f1f)))
        .hover(|s| s.bg(c(0x242424)).text_color(c(HI)))
}
