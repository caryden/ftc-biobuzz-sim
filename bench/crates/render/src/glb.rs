//! A minimal reader for binary glTF: node names, node transforms, triangle positions and base colors. That is all
//! the field CAD needs, so nothing else is read.

use anyhow::{bail, ensure, Context, Result};
use glam::{Mat4, Quat, Vec3};
use serde_json::Value;

pub(crate) struct Primitive {
    pub positions: Vec<Vec3>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
}

pub(crate) struct Node {
    pub name: String,
    /// Node to world, including every parent.
    pub transform: Mat4,
    pub primitives: Vec<Primitive>,
}

pub(crate) fn load(path: &std::path::Path) -> Result<Vec<Node>> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    parse(&bytes).with_context(|| format!("parsing {}", path.display()))
}

fn u32_at(b: &[u8], at: usize) -> Result<u32> {
    let s = b.get(at..at + 4).context("truncated file")?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn parse(bytes: &[u8]) -> Result<Vec<Node>> {
    ensure!(u32_at(bytes, 0)? == 0x4654_6C67, "not a binary glTF file");
    ensure!(u32_at(bytes, 4)? == 2, "only glTF 2.0 is supported");
    let mut json = None;
    let mut bin: &[u8] = &[];
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let len = u32_at(bytes, at)? as usize;
        let kind = u32_at(bytes, at + 4)?;
        let body = bytes.get(at + 8..at + 8 + len).context("truncated chunk")?;
        match kind {
            0x4E4F_534A => json = Some(serde_json::from_slice::<Value>(body)?),
            0x004E_4942 => bin = body,
            _ => {}
        }
        at += 8 + len;
    }
    let doc = Doc { json: json.context("no JSON chunk")?, bin };
    let scene = doc.json["scene"].as_u64().unwrap_or(0) as usize;
    let roots = &doc.json["scenes"][scene]["nodes"];
    let mut out = Vec::new();
    for root in roots.as_array().context("scene has no nodes")? {
        doc.walk(root.as_u64().context("bad node index")? as usize, Mat4::IDENTITY, &mut out)?;
    }
    Ok(out)
}

struct Doc<'a> {
    json: Value,
    bin: &'a [u8],
}

impl Doc<'_> {
    fn walk(&self, index: usize, parent: Mat4, out: &mut Vec<Node>) -> Result<()> {
        let node = &self.json["nodes"][index];
        let transform = parent * local_matrix(node);
        let mut primitives = Vec::new();
        if let Some(mesh) = node["mesh"].as_u64() {
            for prim in self.json["meshes"][mesh as usize]["primitives"].as_array().context("mesh has no primitives")? {
                if prim["mode"].as_u64().unwrap_or(4) == 4 {
                    primitives.push(self.primitive(prim)?);
                }
            }
        }
        let name = node["name"].as_str().unwrap_or("").to_string();
        out.push(Node { name, transform, primitives });
        if let Some(children) = node["children"].as_array() {
            for c in children {
                self.walk(c.as_u64().context("bad child index")? as usize, transform, out)?;
            }
        }
        Ok(())
    }

    fn primitive(&self, prim: &Value) -> Result<Primitive> {
        let pos = prim["attributes"]["POSITION"].as_u64().context("primitive has no POSITION")? as usize;
        let positions = self.positions(pos)?;
        let indices = match prim["indices"].as_u64() {
            Some(i) => self.indices(i as usize)?,
            None => (0..positions.len() as u32).collect(),
        };
        ensure!(indices.iter().all(|&i| (i as usize) < positions.len()), "index out of range");
        let mut color = [1.0; 4];
        if let Some(m) = prim["material"].as_u64() {
            if let Some(f) = self.json["materials"][m as usize]["pbrMetallicRoughness"]["baseColorFactor"].as_array() {
                for (c, v) in color.iter_mut().zip(f) {
                    *c = v.as_f64().unwrap_or(1.0) as f32;
                }
            }
        }
        Ok(Primitive { positions, indices, color })
    }

    /// The bytes of an accessor's data plus the stride between elements.
    fn view(&self, accessor: &Value, elem: usize) -> Result<(&[u8], usize, usize)> {
        ensure!(accessor["sparse"].is_null(), "sparse accessors are not supported");
        let count = accessor["count"].as_u64().context("accessor has no count")? as usize;
        let view = &self.json["bufferViews"][accessor["bufferView"].as_u64().context("accessor has no bufferView")? as usize];
        ensure!(view["buffer"].as_u64().unwrap_or(0) == 0, "only the GLB's own buffer is supported");
        let start = view["byteOffset"].as_u64().unwrap_or(0) as usize + accessor["byteOffset"].as_u64().unwrap_or(0) as usize;
        let stride = view["byteStride"].as_u64().map_or(elem, |s| s as usize);
        let end = if count == 0 { start } else { start + stride * (count - 1) + elem };
        let data = self.bin.get(start..end).context("accessor runs past the buffer")?;
        Ok((data, stride, count))
    }

    fn positions(&self, index: usize) -> Result<Vec<Vec3>> {
        let acc = &self.json["accessors"][index];
        ensure!(acc["componentType"].as_u64() == Some(5126) && acc["type"] == "VEC3", "POSITION must be float VEC3");
        let (data, stride, count) = self.view(acc, 12)?;
        let f = |at: usize| f32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]);
        Ok((0..count).map(|i| Vec3::new(f(i * stride), f(i * stride + 4), f(i * stride + 8))).collect())
    }

    fn indices(&self, index: usize) -> Result<Vec<u32>> {
        let acc = &self.json["accessors"][index];
        let size = match acc["componentType"].as_u64() {
            Some(5121) => 1,
            Some(5123) => 2,
            Some(5125) => 4,
            other => bail!("unsupported index type {other:?}"),
        };
        let (data, stride, count) = self.view(acc, size)?;
        Ok((0..count)
            .map(|i| {
                let s = &data[i * stride..i * stride + size];
                match size {
                    1 => s[0] as u32,
                    2 => u16::from_le_bytes([s[0], s[1]]) as u32,
                    _ => u32::from_le_bytes([s[0], s[1], s[2], s[3]]),
                }
            })
            .collect())
    }
}

fn floats<const N: usize>(v: &Value) -> Option<[f32; N]> {
    let a = v.as_array()?;
    if a.len() != N {
        return None;
    }
    let mut out = [0.0; N];
    for (o, x) in out.iter_mut().zip(a) {
        *o = x.as_f64()? as f32;
    }
    Some(out)
}

fn local_matrix(node: &Value) -> Mat4 {
    if let Some(m) = floats::<16>(&node["matrix"]) {
        return Mat4::from_cols_array(&m);
    }
    let t = floats::<3>(&node["translation"]).map_or(Vec3::ZERO, Vec3::from);
    let r = floats::<4>(&node["rotation"]).map_or(Quat::IDENTITY, Quat::from_array);
    let s = floats::<3>(&node["scale"]).map_or(Vec3::ONE, Vec3::from);
    Mat4::from_scale_rotation_translation(s, r, t)
}
