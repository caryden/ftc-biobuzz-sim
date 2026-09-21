import type { Sim } from '../sim/world';
import { pathLength, pointAlong, type Pt } from './planner';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
/** Follower tuning: the planned deceleration in m/s², the pure-pursuit lookahead in meters, and the velocity-error gain. `vMax` is unused. */
export const FOLLOW = { vMax: 1.85, decel: 3.0, lookahead: 0.22, kv: 1.2 };

/**
 * Follows a path by pure pursuit with a trapezoid speed profile, and turns to the goal heading while it travels.
 * It reads only the robot's own pose and velocity, which a real robot gets from odometry.
 */
export function pursue(sim: Sim, path: Pt[], heading: number | null) {
  const p = sim.robot.translation(), th = sim.heading, here = { x: p.x, z: p.z }, live = [here, ...path.slice(1)];
  const remaining = pathLength(live), v = sim.robot.linvel(), speed = Math.hypot(v.x, v.z);
  const aim = pointAlong(live, clamp(FOLLOW.lookahead + 0.22 * speed, FOLLOW.lookahead, 0.6)), dx = aim.x - p.x, dz = aim.z - p.z, d = Math.hypot(dx, dz) || 1e-6;
  // Velocity tracking with active braking. The profile speed is what lets the robot stop at the goal at `decel`.
  // The command is that speed as a fraction of the robot's own top speed, plus a correction on the velocity error,
  // so a robot that is too fast gets reverse power instead of coasting on motor drag alone.
  const vTop = ((sim.cfg.motor.freeRpm * 2 * Math.PI) / 60) * sim.cfg.wheelRadius * 0.81;
  let vDes = Math.min(vTop, Math.sqrt(2 * FOLLOW.decel * Math.max(0, remaining - 0.01))); if (remaining < 0.35) vDes = Math.max(vDes, Math.min(0.4, 2.5 * remaining));
  const ex = (dx / d) * vDes - v.x, ez = (dz / d) * vDes - v.z;
  const cx = ((dx / d) * vDes + FOLLOW.kv * ex) / vTop, cz = ((dz / d) * vDes + FOLLOW.kv * ez) / vTop, cm = Math.max(1, Math.hypot(cx, cz));
  const err = wrap((heading ?? th) - th);
  const f = (cx * Math.cos(th) - cz * Math.sin(th)) / cm, l = (-cx * Math.sin(th) - cz * Math.cos(th)) / cm;
  return { forward: f, strafeRight: -l, turnRight: clamp(-2.0 * err + 0.12 * sim.robot.angvel().y), remaining, headingError: err };
}
