//! Colors. Grays carry the interface. Color means something on the field: an alliance, an element, or a
//! right or wrong call by the detector.

use gpui::{rgb, rgba, Hsla};

pub const BG: u32 = 0x0c0c0c;
pub const PANEL: u32 = 0x111111;
pub const LINE: u32 = 0x262626;
pub const FAINT: u32 = 0x1a1a1a;
pub const DIM: u32 = 0x6b6b6b;
pub const TEXT: u32 = 0xbdbdbd;
pub const HI: u32 = 0xeeeeee;

pub const GREEN: u32 = 0x3fd46a;
pub const RED: u32 = 0xe5484d;

pub const ALLIANCE_RED: u32 = 0xd8474b;
pub const ALLIANCE_BLUE: u32 = 0x4a86e8;
pub const POLLEN: u32 = 0xe6c547;

pub fn c(hex: u32) -> Hsla {
    rgb(hex).into()
}

/// A color with an alpha from 0 to 1.
pub fn ca(hex: u32, a: f32) -> Hsla {
    rgba((hex << 8) | (a.clamp(0.0, 1.0) * 255.0) as u32).into()
}

pub fn alliance(red: bool) -> u32 {
    if red { ALLIANCE_RED } else { ALLIANCE_BLUE }
}

pub fn ball(kind: u8) -> u32 {
    match kind {
        crate::model::NECTAR_RED => ALLIANCE_RED,
        crate::model::NECTAR_BLUE => ALLIANCE_BLUE,
        _ => POLLEN,
    }
}
