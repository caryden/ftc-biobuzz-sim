import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { HIVE, HIVE_DYN } from './config';

type R = typeof RAPIER_NS;
export type Alliance = 'red' | 'blue';
export type CellSide = 'rear' | 'audience';

export const GROUP = { floor: 1, struct: 2, ball: 4, robot: 8, hive: 16 };
export const groups = (member: number, filter: number) => (member << 16) | filter;

/**
 * One bi-stable HIVE: a dynamic body on a revolute joint with hard stops at
 * +/-30 degrees. The center of mass sits above the pivot, so gravity holds the
 * hive against whichever stop it rests on until the load in the raised CELL
 * produces a larger moment. Positive phi means the rear CELL is raised.
 */
export class Hive {
  body: RAPIER_NS.RigidBody;
  tips = 0;
  private lastStable: 1 | -1;

  constructor(private rapier: R, world: RAPIER_NS.World, public alliance: Alliance, initialUp: CellSide, dyn = HIVE_DYN) {
    const phi = (initialUp === 'rear' ? 1 : -1) * HIVE.tiltLimit;
    this.lastStable = initialUp === 'rear' ? 1 : -1;
    const px = HIVE.pivotX[alliance];
    const q = { x: Math.sin(phi / 2), y: 0, z: 0, w: Math.cos(phi / 2) };
    this.body = world.createRigidBody(rapier.RigidBodyDesc.dynamic()
      .setTranslation(px, HIVE.pivotY, 0).setRotation(q).setCanSleep(false)
      .setAdditionalMassProperties(dyn.mass, { x: 0, y: dyn.comHeight, z: 0 },
        { x: dyn.inertia, y: dyn.inertia, z: dyn.inertia }, { x: 0, y: 0, z: 0, w: 1 }));
    const anchor = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(px, HIVE.pivotY, 0));
    const jd = rapier.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const joint = world.createImpulseJoint(jd, anchor, this.body, true) as RAPIER_NS.RevoluteImpulseJoint;
    joint.setLimits(-HIVE.tiltLimit, HIVE.tiltLimit);

    const add = (hx: number, hy: number, hz: number, x: number, y: number, z: number, rotZ = 0) => {
      const c = rapier.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setDensity(0)
        .setFriction(0.5).setRestitution(0.25)
        .setCollisionGroups(groups(GROUP.hive, GROUP.ball));
      if (rotZ) c.setRotation({ x: 0, y: 0, z: Math.sin(rotZ / 2), w: Math.cos(rotZ / 2) });
      world.createCollider(c, this.body);
    };
    const t = HIVE.wall / 2, hw = HIVE.cellHalfWidth, depth = (HIVE.cellMouth - HIVE.cellBack) / 2;
    const roofLen = Math.hypot(hw, HIVE.cellPeakY - HIVE.cellSideTopY) / 2;
    const roofAng = Math.atan2(HIVE.cellPeakY - HIVE.cellSideTopY, hw);
    const roofY = (HIVE.cellPeakY + HIVE.cellSideTopY) / 2, sideY = (HIVE.cellSideTopY + HIVE.cellFloorY) / 2;
    for (const s of [-1, 1]) {
      const zc = s * (HIVE.cellBack + depth);
      add(hw, t, depth, 0, HIVE.cellFloorY - t, zc);                                  // floor
      add(hw, (HIVE.cellPeakY - HIVE.cellFloorY) / 2, t, 0, (HIVE.cellPeakY + HIVE.cellFloorY) / 2, s * (HIVE.cellBack - t)); // back
      for (const sx of [-1, 1]) {
        add(t, (HIVE.cellSideTopY - HIVE.cellFloorY) / 2, depth, sx * (hw + t), sideY, zc); // side
        add(roofLen, t, depth, sx * hw / 2, roofY + t, zc, -sx * roofAng);            // sloped roof
      }
    }
  }

  /**
   * A stamp that the owner changes each time the body can have moved, such as after every world step. While it holds
   * one value, `phi`, `omega`, and the pivot position are read from Rapier once and then served from a cache. While it
   * is null, which is the default, every read goes to Rapier. Each Rapier read allocates a wrapper object, and
   * `containsInUpCell` runs once per ball on the FIELD each time `Sim.cellLoad` counts a CELL.
   */
  epoch: number | null = null;
  private pose = { epoch: NaN, x: 0, y: 0, z: 0, phi: 0, omega: 0 };
  private read() {
    const p = this.pose;
    if (this.epoch === null || p.epoch !== this.epoch) {
      const t = this.body.translation(), q = this.body.rotation();
      p.x = t.x; p.y = t.y; p.z = t.z; p.phi = 2 * Math.atan2(q.x, q.w); p.omega = this.body.angvel().x; p.epoch = this.epoch ?? NaN;
    }
    return p;
  }
  /** Gets the tilt angle in radians. Positive means the rear CELL is raised. */
  get phi(): number { return this.read().phi; }
  /** Gets the angular velocity about the pivot axis (world X) in radians per second. */
  get omega(): number { return this.read().omega; }
  get upCell(): CellSide { return this.lastStable > 0 ? 'rear' : 'audience'; }

  /** Applies pivot friction and the end-stop damper. Call before each world step. */
  applyTorques(dyn = HIVE_DYN): void {
    const w = this.omega, phi = this.phi;
    let tq = 0;
    if (Math.abs(w) > 1e-3) tq -= Math.sign(w) * dyn.pivotFriction;
    const closing = Math.sign(w) === Math.sign(phi) && HIVE.tiltLimit - Math.abs(phi) < dyn.damperZone;
    if (closing) tq -= dyn.damperCoeff * w;
    this.body.resetTorques(true);
    this.body.addTorque({ x: tq, y: 0, z: 0 }, true);
  }

  /** Checks whether the hive settled on the opposite stop since the last call. */
  pollTip(): boolean {
    const phi = this.phi;
    if (Math.abs(phi) > HIVE.tiltLimit - 0.05 && Math.sign(phi) !== this.lastStable && Math.abs(this.omega) < 0.5) {
      this.lastStable = phi > 0 ? 1 : -1; this.tips++; return true;
    }
    return false;
  }

  /** Checks whether a world-space point is inside the raised CELL. */
  containsInUpCell(p: { x: number; y: number; z: number }, radius: number): boolean {
    const t = this.read(), phi = t.phi, c = Math.cos(-phi), s = Math.sin(-phi);
    const y0 = p.y - t.y, z0 = p.z - t.z;
    const lx = p.x - t.x, ly = y0 * c - z0 * s, lz = y0 * s + z0 * c;
    const along = this.lastStable > 0 ? -lz : lz;
    return Math.abs(lx) < HIVE.cellHalfWidth && ly > HIVE.cellFloorY && ly < HIVE.cellPeakY &&
      along > HIVE.cellBack && along < HIVE.cellMouth + radius;
  }

  /** Checks whether the segment p0 -> p1 passes inward through the opening of the raised CELL. */
  entersMouth(p0: { x: number; y: number; z: number }, p1: { x: number; y: number; z: number }, radius: number): boolean {
    const t = this.read(), phi = t.phi, c = Math.cos(-phi), s = Math.sin(-phi), sign = this.lastStable > 0 ? -1 : 1;
    const loc = (p: { x: number; y: number; z: number }) => { const y = p.y - t.y, z = p.z - t.z; return { x: p.x - t.x, y: y * c - z * s, a: sign * (y * s + z * c) }; };
    const a = loc(p0), b = loc(p1);
    if (!(a.a > HIVE.cellMouth && b.a <= HIVE.cellMouth)) return false;
    const u = (a.a - HIVE.cellMouth) / (a.a - b.a), x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u;
    // The opening is a pentagon: vertical sides up to cellSideTopY, then a roof that rises to the peak.
    const roof = HIVE.cellPeakY - (Math.abs(x) / HIVE.cellHalfWidth) * (HIVE.cellPeakY - HIVE.cellSideTopY);
    return Math.abs(x) < HIVE.cellHalfWidth - radius && y > HIVE.cellFloorY + radius && y < roof - radius;
  }

  /**
   * Gets the four AprilTags under one CELL: world position and outward normal. The cluster is on the bottom face of
   * the CELL (section 9.9). ASSUMPTION: the four tags are spread evenly across the 20 in. width, centered front to back.
   */
  tags(side: CellSide): { p: { x: number; y: number; z: number }; n: { x: number; y: number; z: number } }[] {
    const t = this.read(), phi = t.phi, c = Math.cos(phi), s = Math.sin(phi);
    const ly = HIVE.cellFloorY - HIVE.wall, lz = (side === 'rear' ? -1 : 1) * (HIVE.cellBack + HIVE.cellMouth) / 2;
    return [-0.19, -0.063, 0.063, 0.19].map(lx => ({ p: { x: t.x + lx, y: t.y + ly * c - lz * s, z: t.z + ly * s + lz * c }, n: { x: 0, y: -c, z: -s } }));
  }

  /**
   * Converts a point in the raised CELL's frame to world space. `lx` runs across the CELL, `ly` is the height above the
   * pivot in the HIVE frame, and `along` is the distance from the pivot toward the opening, as in `containsInUpCell`.
   */
  raisedCellPoint(lx: number, ly: number, along: number): { x: number; y: number; z: number } {
    const t = this.read(), c = Math.cos(t.phi), s = Math.sin(t.phi), lz = (this.lastStable > 0 ? -1 : 1) * along;
    return { x: t.x + lx, y: t.y + ly * c - lz * s, z: t.z + ly * s + lz * c };
  }

  /** Gets the world-space center of the raised CELL opening. */
  mouthCenter(): { x: number; y: number; z: number } {
    const t = this.read(), phi = t.phi, c = Math.cos(phi), s = Math.sin(phi);
    const ly = (HIVE.cellFloorY + HIVE.cellPeakY) / 2 - 0.03, lz = (this.lastStable > 0 ? -1 : 1) * HIVE.cellMouth;
    return { x: t.x, y: t.y + ly * c - lz * s, z: t.z + ly * s + lz * c };
  }
}
