use crate::{Alliance, BallLabel};
use anyhow::Result;
use std::path::Path;

/// One rendered image with its depth and the object that owns each pixel.
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// RGB8, row-major, top row first.
    pub rgb: Vec<u8>,
    /// Meters along the optical axis (camera z, not ray length). `f32::INFINITY` where nothing was hit.
    pub depth: Vec<f32>,
    /// The front-most object at each pixel, as raw [`Owner`] codes. Decode with [`Owner::from_raw`].
    pub ids: Vec<u32>,
}

impl Frame {
    /// The image as BGR8, the channel order OpenCV expects.
    pub fn to_bgr(&self) -> Vec<u8> {
        let mut out = self.rgb.clone();
        rgb_to_bgr_in_place(&mut out);
        out
    }

    /// The object that owns pixel (u, v).
    pub fn owner(&self, u: u32, v: u32) -> Owner {
        Owner::from_raw(self.ids[(v * self.width + u) as usize])
    }

    /// Writes the image as a PNG.
    pub fn save_png(&self, path: impl AsRef<Path>) -> Result<()> {
        image::save_buffer(path, &self.rgb, self.width, self.height, image::ExtendedColorType::Rgb8)?;
        Ok(())
    }
}

/// Swaps R and B in an RGB8 (or BGR8) buffer in place, for OpenCV consumers that reuse a buffer.
pub fn rgb_to_bgr_in_place(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(3) {
        px.swap(0, 2);
    }
}

/// What a frame call returns: the image and one label per ball that projects at least partly into the image.
#[derive(Clone, Debug)]
pub struct Rendered {
    pub frame: Frame,
    pub labels: Vec<BallLabel>,
}

/// The object that wins a pixel. `Field` holds an index into [`crate::Scene::node_names`]; `Robot` and `Ball` hold an
/// index into the slices passed in [`crate::World`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Owner {
    Empty,
    Tiles,
    VenueFloor,
    Field(u32),
    Hive(Alliance),
    Robot(u32),
    Ball(u32),
}

const KIND_SHIFT: u32 = 24;
const INDEX_MASK: u32 = (1 << KIND_SHIFT) - 1;

impl Owner {
    /// Decodes a value from [`Frame::ids`].
    pub fn from_raw(raw: u32) -> Owner {
        let i = raw & INDEX_MASK;
        match raw >> KIND_SHIFT {
            0 => match raw {
                1 => Owner::Tiles,
                2 => Owner::VenueFloor,
                _ => Owner::Empty,
            },
            1 => Owner::Field(i),
            2 => Owner::Hive(if i == 0 { Alliance::Red } else { Alliance::Blue }),
            3 => Owner::Robot(i),
            _ => Owner::Ball(i),
        }
    }

    /// Encodes the owner for [`Frame::ids`].
    pub fn raw(self) -> u32 {
        match self {
            Owner::Empty => 0,
            Owner::Tiles => 1,
            Owner::VenueFloor => 2,
            Owner::Field(i) => (1 << KIND_SHIFT) | (i & INDEX_MASK),
            Owner::Hive(a) => (2 << KIND_SHIFT) | (a == Alliance::Blue) as u32,
            Owner::Robot(i) => (3 << KIND_SHIFT) | (i & INDEX_MASK),
            Owner::Ball(i) => (4 << KIND_SHIFT) | (i & INDEX_MASK),
        }
    }
}
