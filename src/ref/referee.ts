import { fieldObstacles } from '../auto/planner';
import { FIELD } from '../sim/config';
import type { Alliance } from '../sim/hive';
import type { Sim } from '../sim/world';

const TWO_FEET = 0.61, CONTACT = 0.64, FOUL_EVERY = 3;

/** What code measures about one robot in a contact. The fixed rule judges these facts. */
interface RobotFacts {
  alliance: Alliance; speed_mps: number; commanded_power: number; moved_in_last_2s_m: number;
  commanded_direction: 'toward the other robot' | 'away from the other robot' | 'sideways' | 'none';
  boxed_in_by: string | null;
}
export interface PinState { pinner: Alliance; victim: Alliance; key: string; count: number; fouls: number; paused: boolean }
/**
 * The PIN referee for G421. Code keeps the facts and the clock: contact, speeds, commands, the 3-count, the pause
 * and end conditions A, B, and C, and the MAJOR FOUL every 3 seconds. The judgment "is this robot PINNING that one"
 * is fuzzy. A fixed rule answers it: see `ruleJudge`.
 */
export class Referee {
  pins: PinState[] = []; lastFacts: unknown = null;
  private contact: Record<string, number> = {}; private askAt: Record<string, number> = {}; private t = 0;
  private judged: Record<string, number> = {}; private origin: Record<string, { a: { x: number; z: number }; b: { x: number; z: number } }> = {};
  private endTimer: Record<string, { apart: number; moved: number }> = {};
  private trail: { t: number; p: { x: number; z: number }[] }[] = [];

  private facts(sim: Sim, i: number, j: number): RobotFacts {
    const r = sim.robots[i], o = sim.robots[j], p = r.body.translation(), q = o.body.translation(), v = r.body.linvel(), th = sim.view(i).heading;
    const c = r.lastCmd, power = Math.hypot(c.forward, c.strafeRight);
    // The commanded direction in field coordinates, compared with the direction to the other robot.
    const cx = c.forward * Math.cos(th) + c.strafeRight * Math.sin(th), cz = -c.forward * Math.sin(th) + c.strafeRight * Math.cos(th);
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 1e-6, cos = power < 0.15 ? 0 : (cx * dx + cz * dz) / (power * d);
    const old = this.trail.find(e => this.t - e.t <= 2)?.p[i] ?? p;
    // Boxed in: a wall or a FIELD element is close on the side away from the other robot, so backing off is impossible.
    const half = Math.max(r.cfg.length, r.cfg.width) / 2 + 0.07, ax = p.x - (dx / d) * half, az = p.z - (dz / d) * half;
    let boxed: string | null = Math.abs(ax) > FIELD.half - 0.02 || Math.abs(az) > FIELD.half - 0.02 ? 'the FIELD perimeter wall' : null;
    if (!boxed) for (const ob of fieldObstacles()) { const ex = ob.b.x - ob.a.x, ez = ob.b.z - ob.a.z, l2 = ex * ex + ez * ez, u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((ax - ob.a.x) * ex + (az - ob.a.z) * ez) / l2)); if (Math.hypot(ob.a.x + u * ex - ax, ob.a.z + u * ez - az) < ob.r + 0.06) { boxed = ob.r > 0.05 ? 'a FLOWER' : 'the HIVE frame'; break; } }
    return { alliance: r.alliance, speed_mps: +Math.hypot(v.x, v.z).toFixed(2), commanded_power: +power.toFixed(2), moved_in_last_2s_m: +Math.hypot(p.x - old.x, p.z - old.z).toFixed(2),
      commanded_direction: power < 0.15 ? 'none' : cos > 0.5 ? 'toward the other robot' : cos < -0.5 ? 'away from the other robot' : 'sideways', boxed_in_by: boxed };
  }

  /** The fixed rule: the victim commands motion and barely moves, while the other robot pushes toward it or boxes it in. */
  private ruleJudge(pinner: RobotFacts, victim: RobotFacts): number {
    const stuck = victim.commanded_power > 0.3 && victim.moved_in_last_2s_m < 0.12 && victim.commanded_direction !== 'toward the other robot';
    const pressing = pinner.commanded_direction === 'toward the other robot' || (victim.boxed_in_by !== null && pinner.speed_mps < 0.1);
    return stuck && pressing ? 0.9 : 0.1;
  }

  /** Advances the referee by one physics step. Call it after `sim.step`. */
  update(sim: Sim, dt: number) {
    this.t += dt;
    if (this.trail.length === 0 || this.t - this.trail[this.trail.length - 1].t >= 0.25) { this.trail.push({ t: this.t, p: sim.robots.map(r => { const p = r.body.translation(); return { x: p.x, z: p.z }; }) }); while (this.trail.length > 12) this.trail.shift(); }
    if (sim.phase !== 'teleop' && sim.phase !== 'auto') return;
    for (let i = 0; i < sim.robots.length; i++) for (let j = i + 1; j < sim.robots.length; j++) {
      if (sim.robots[i].alliance === sim.robots[j].alliance) continue;
      const p = sim.robots[i].body.translation(), q = sim.robots[j].body.translation(), dist = Math.hypot(p.x - q.x, p.z - q.z), touching = dist < CONTACT;
      const pair = `${i}-${j}`; this.contact[pair] = touching ? (this.contact[pair] ?? 0) + dt : 0;
      if (!touching) { this.judged[`${i}>${j}`] = this.judged[`${j}>${i}`] = 0; }
      // Judge once the contact lasts 0.5 s, and again every second while it lasts.
      if (touching && this.contact[pair] > 0.5 && this.t >= (this.askAt[pair] ?? 0)) {
        const fi = this.facts(sim, i, j), fj = this.facts(sim, j, i); this.askAt[pair] = this.t + 1;
        this.lastFacts = { contact: { seconds: +this.contact[pair].toFixed(1), center_distance_m: +dist.toFixed(2) }, robot_a: fi, robot_b: fj };
        this.judged[`${i}>${j}`] = this.ruleJudge(fi, fj); this.judged[`${j}>${i}`] = this.ruleJudge(fj, fi);
      }
      this.count(sim, i, j, dist, dt); this.count(sim, j, i, dist, dt);
    }
  }

  /** Runs the G421 count for one direction: robot `a` pins robot `b`. */
  private count(sim: Sim, a: number, b: number, dist: number, dt: number) {
    const key = `${a}>${b}`, pinning = (this.judged[key] ?? 0) > 0.5, mutual = (this.judged[`${b}>${a}`] ?? 0) > 0.5;
    let pin = this.pins.find(x => x.key === key) ?? null;
    const pa = sim.robots[a].body.translation(), pb = sim.robots[b].body.translation();
    if (!pin) {
      if (!pinning || mutual) return; // G421.C: a robot that is itself pinned isn't the PINNING robot.
      pin = { pinner: sim.robots[a].alliance, victim: sim.robots[b].alliance, key, count: 0, fouls: 0, paused: false }; this.pins.push(pin);
      this.origin[key] = { a: { x: pa.x, z: pa.z }, b: { x: pb.x, z: pb.z } }; this.endTimer[key] = { apart: 0, moved: 0 };
      sim.say(`REFEREE: PIN count started on ${pin.pinner.toUpperCase()}`);
    }
    const o = this.origin[key], e = this.endTimer[key];
    const apart = dist >= TWO_FEET, moved = Math.hypot(pa.x - o.a.x, pa.z - o.a.z) >= TWO_FEET || Math.hypot(pb.x - o.b.x, pb.z - o.b.z) >= TWO_FEET;
    e.apart = apart ? e.apart + dt : 0; e.moved = moved ? e.moved + dt : 0; pin.paused = apart || moved || !pinning;
    // The count ends after 3 s apart (A), 3 s away from where it started (B), or when the pinner gets pinned (C).
    if (e.apart > 3 || e.moved > 3 || mutual) { this.pins = this.pins.filter(x => x !== pin); if (pin.count > 0.5) sim.say(`REFEREE: PIN count on ${pin.pinner.toUpperCase()} ended at ${pin.count.toFixed(1)} s`); return; }
    if (pin.paused) return;
    pin.count += dt;
    if (pin.count > FOUL_EVERY * (pin.fouls + 1)) { pin.fouls++; sim.foul(pin.pinner, 'MAJOR', `G421 PIN, ${Math.round(pin.count)} seconds`); }
  }
}
