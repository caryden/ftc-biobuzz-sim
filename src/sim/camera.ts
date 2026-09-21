import { HIVE } from './config';
import type { Alliance, CellSide } from './hive';
import type { Sim } from './world';

/** One CELL as the robot's camera sees it: how many of its four AprilTags are readable. */
export interface CellSighting { alliance: Alliance; cell: CellSide; tags: number; raised: boolean }

/**
 * Gets the CELLS whose AprilTags the robot's camera can read right now. A tag is readable if it is inside the
 * camera's field of view, within range, facing the camera, and not seen at a grazing angle. The frame, the other
 * CELL, and other robots don't block the view in this model.
 */
export function cameraSightings(sim: Sim): CellSighting[] {
  const cam = sim.cfg.camera, p = sim.robot.translation(), rear = sim.cfg.shooter.facing === 'rear';
  const yaw = sim.heading + (rear ? Math.PI : 0), pitch = (cam.pitchDeg * Math.PI) / 180;
  // The camera sits toward the shooter side. Its optical axis points along that side and up by the pitch.
  const hx = Math.cos(yaw), hz = -Math.sin(yaw), lx = -Math.sin(yaw), lz = -Math.cos(yaw);
  const pos = { x: p.x + hx * cam.offset[0] + lx * cam.offset[1], y: 0.02 + cam.offset[2], z: p.z + hz * cam.offset[0] + lz * cam.offset[1] };
  const f = { x: hx * Math.cos(pitch), y: Math.sin(pitch), z: hz * Math.cos(pitch) };
  const r = { x: -f.z, y: 0, z: f.x }, rm = Math.hypot(r.x, r.z) || 1e-6; r.x /= rm; r.z /= rm;           // right = up x forward, leveled
  const u = { x: f.y * r.z, y: f.z * r.x - f.x * r.z, z: -f.y * r.x };                                   // camera up = forward x right
  const out: CellSighting[] = [];
  for (const a of ['red', 'blue'] as Alliance[]) for (const cell of ['rear', 'audience'] as CellSide[]) {
    const hive = sim.hives[a]; let tags = 0;
    for (const t of hive.tags(cell)) {
      const v = { x: t.p.x - pos.x, y: t.p.y - pos.y, z: t.p.z - pos.z }, d = Math.hypot(v.x, v.y, v.z); if (d > cam.maxRange) continue;
      const zc = v.x * f.x + v.y * f.y + v.z * f.z, xc = v.x * r.x + v.z * r.z, yc = v.x * u.x + v.y * u.y + v.z * u.z; if (zc <= 0) continue;
      if (Math.abs(Math.atan2(xc, zc)) > (cam.hFovDeg * Math.PI) / 360 || Math.abs(Math.atan2(yc, zc)) > (cam.vFovDeg * Math.PI) / 360) continue;
      const facing = -(v.x * t.n.x + v.y * t.n.y + v.z * t.n.z) / d; // Cosine between the tag's normal and the line to the camera.
      if (facing > Math.cos((cam.maxIncidenceDeg * Math.PI) / 180)) tags++;
    }
    // The tag poses give the CELL's tilt, so a sighting also says whether the CELL is raised and at rest.
    if (tags > 0) out.push({ alliance: a, cell, tags, raised: hive.upCell === cell && Math.abs(Math.abs(hive.phi) - HIVE.tiltLimit) < 0.03 });
  }
  return out;
}

/** Checks whether the camera currently reads the named CELL of the robot's own HIVE as raised: the "ok to shoot" signal. */
export function seesRaisedCell(sim: Sim, cell: CellSide): boolean {
  return cameraSightings(sim).some(s => s.alliance === sim.alliance && s.cell === cell && s.raised);
}
