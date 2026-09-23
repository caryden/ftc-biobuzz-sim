import { FIELD, HIVE, POINTS, RP, TIP_LOAD } from '../sim/config';
import type { RobotState } from '../sim/world';
import type { Alliance } from '../sim/hive';
import { NO_INPUT, retrievable, stackTop, type BallKind, type Flower, type Inputs, type IntakeFilter, type Sim } from '../sim/world';
import { pursue } from './follow';
import { Shooter } from './shooter';
import { ballApproach, fieldObstacles, pathLength, planPath, segmentClear, type Capsule, type Pt } from './planner';

export const TACTICS = ['tip_hive', 'collect_pollen', 'collect_own_nectar', 'launch_into_hive', 'work_flower', 'park'] as const;
export type Tactic = (typeof TACTICS)[number];
export type FlowerId = 'rear' | 'audience' | 'red' | 'blue';
export type FlowerAction = 'place_own_nectar_to_plug' | 'pull_pollen_to_seat_plug' | 'fill_with_pollen' | 'cap_with_own_nectar' | 'none';
export type Status = 'in_progress' | 'done' | 'blocked';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const ownNectar = (a: Alliance): BallKind => (a === 'red' ? 'nectar_red' : 'nectar_blue');
/** POLLEN above the plug in a finished FLOWER. Plug + 4 POLLEN + cap leaves no room for another element. */
export const FILL_TARGET = 4;
/** Executor tuning. `standoff` picks the launch distance within the scoring range: 0 is the closest spot, 1 the farthest. */
/** `tipByMotion`: if true, a TIP counts as under way only when the HIVE is past level or turning away from its stop. See `tipTarget`. */
/**
 * `turretFireEnRoute`: if true, a robot with a turret fires as soon as `Shooter.canShoot` passes in its `moving` mode, on
 * the way to its launch spot. If false, it fires from the spot, still, like a fixed shooter. It lost 58.1 ± 9.3 combined
 * points in e82. `turretIntakeHeading`: if true, a robot with a turret turns its intakes toward the most balls on its
 * way to launch. See `intakeHeading`. It lost 13.0 ± 7.8 more in e83. Default: both false.
 */
export const EXEC = { standoff: 0.4, tipByMotion: true, turretFireEnRoute: false, turretIntakeHeading: false };

/**
 * How alliance partners divide the FIELD. With `sides`, the robot that starts on the left of its drivers (the second
 * robot: rear side for red, audience side for blue) owns the left CELL, the left half of the FIELD, and the left
 * end of the LOADING ZONE, and its partner owns the right. Neither crosses the HIVE's center line except to PARK.
 * The rule holds only while the partner is also tipping: a robot whose partner works FLOWERS or parks takes both CELLS.
 * With `routes`, both robots feed the raised CELL, which keeps the HIVE tipping, and fixed roles keep them apart.
 * After a TIP both robots head for the other end at the same moment, so each has its own way there: the right robot
 * (straight launch spot) goes under the HIVE, and the left robot (angled launch spot) goes around it through the
 * alliance's own corridor. Neither uses the opponent's side. With `none`, both drive the shortest path.
 */
export type Convention = 'sides' | 'routes' | 'none';
/** Gets the robot's own side under the sides convention, or null without a partner. */
export function ownSide(sim: Sim): 'rear' | 'audience' | null {
  if (!sim.partner()) return null; const left = sim.slot === 1; return (sim.alliance === 'red') === left ? 'rear' : 'audience';
}

/** Gets how many own NECTAR the alliance can still get: carried, on the floor, or with the HUMAN PLAYER. */
export function nectarSupply(sim: Sim): number {
  const own = ownNectar(sim.alliance); let n = sim.carried.filter(k => k === own).length + sim.stash[sim.alliance];
  for (const b of sim.balls.values()) if (b.kind === own && b.body.translation().y < 0.13) n++;
  return n;
}

/** Checks whether a FLOWER is locked for the robot's alliance: own NECTAR is the top-most NECTAR and no element fits. */
export function flowerLocked(sim: Sim, f: Flower): boolean {
  const nectars = f.stack.filter(k => k !== 'pollen');
  return nectars[nectars.length - 1] === ownNectar(sim.alliance) && stackTop(f.stack) > FIELD.flowerPlaceLimit;
}

/**
 * Gets the next useful action on a FLOWER, following the plug, fill, cap doctrine. A finished FLOWER is
 * own NECTAR at the middle ring, four POLLEN, and own NECTAR on top. It is full, so the opponent can't cap it.
 * The robot fills only if a cap NECTAR is still obtainable, because a filled FLOWER with room is a gift to the opponent.
 */
export function flowerAction(sim: Sim, f: Flower): FlowerAction {
  const me = ownNectar(sim.alliance), room = stackTop(f.stack) <= FIELD.flowerPlaceLimit, free = sim.cfg.capacity - sim.carried.length;
  const hasN = sim.carried.includes(me), hasP = sim.carried.includes('pollen'), unlocked = sim.flowersUnlocked;
  const nectars = f.stack.filter(k => k !== 'pollen'), top = nectars[nectars.length - 1], firstN = f.stack.findIndex(k => k !== 'pollen');
  if (!room) return 'none';
  if (nectars.length === 0) return hasN && unlocked ? 'place_own_nectar_to_plug' : 'none';
  if (firstN > 0 && free > 0) return 'pull_pollen_to_seat_plug';
  if (top !== me) return hasN && unlocked ? 'cap_with_own_nectar' : 'none';
  const above = f.stack.length - 1 - f.stack.lastIndexOf(me), late = sim.phase === 'teleop' && sim.timer < 14;
  if (above < FILL_TARGET && hasP && !late && nectarSupply(sim) > 0) return 'fill_with_pollen';
  // The plug alone owns the FLOWER, but it has room. The cap fills it so that the opponent can't take it.
  // One cap is enough: a second NECTAR on top of own NECTAR adds 2 points and wastes a cap for another FLOWER.
  if (hasN && unlocked && (above >= FILL_TARGET || (late && above > 0))) return 'cap_with_own_nectar';
  return 'none';
}

/** Gets how many POLLEN a FLOWER with an own plug still needs before the cap. Zero for any other FLOWER. */
export function pollenToFill(sim: Sim, f: Flower): number {
  const me = ownNectar(sim.alliance), nectars = f.stack.filter(k => k !== 'pollen');
  if (f.stack[0] !== me || nectars[nectars.length - 1] !== me || stackTop(f.stack) > FIELD.flowerPlaceLimit) return 0;
  return Math.max(0, FILL_TARGET - (f.stack.length - 1 - f.stack.lastIndexOf(me)));
}

/** Gets the match points that the robot's alliance currently earns from a FLOWER. */
export function flowerPoints(sim: Sim, f: Flower): number { const s = sim.flowerStatus(f); return (s.owner === sim.alliance ? 2 * s.scored : 0) + (s.bottom === sim.alliance ? 5 : 0); }

/** Gets the points that the opponent gains by placing one NECTAR in this FLOWER now. Zero if the FLOWER is full. */
export function opponentCapGain(sim: Sim, f: Flower): number {
  if (stackTop(f.stack) > FIELD.flowerPlaceLimit) return 0;
  const s = sim.flowerStatus(f), hasNectar = f.stack.some(k => k !== 'pollen');
  return s.owner === sim.alliance || s.owner === null ? 2 * (s.scored + 1) + (hasNectar ? 0 : 5) : 0;
}

/**
 * Gets the CELL that the next launch is for, and the POLLEN it still needs to tip. Balls in flight toward the
 * raised CELL count as landed, and so does `mateLoad`, the load that the alliance partner is about to deliver.
 * When that load already reaches the tipping point, or the HIVE is swinging, the TIP is on its way: the target
 * becomes the opposite CELL, which starts empty.
 */
export function tipTarget(sim: Sim, mateLoad = 0, own: 'rear' | 'audience' | null = null): { side: 'rear' | 'audience'; need: number; remaining: number; tipPending: boolean } {
  const hive = sim.hives[sim.alliance], up = hive.upCell, mouth = hive.mouthCenter(); let inflight = 0;
  for (const b of sim.balls.values()) {
    const q = sim.ballPos(b);
    if (b.airborne && q.y > 0.5 && Math.abs(q.x - mouth.x) < 0.35 && !hive.containsInUpCell(q, b.radius)) inflight += b.kind === 'pollen' ? TIP_LOAD.pollen : TIP_LOAD.nectar;
  }
  // A TIP is under way when the HIVE is past level, or when it is off its stop and turning away from it. A HIVE that is
  // only off its stop isn't tipping: a partly loaded CELL sags by up to 0.13 rad and stays there, and balls that land in
  // it rock it. Reading that as a TIP sent both robots to the other end, where they waited with a load that would have
  // tipped the raised CELL. `EXEC.tipByMotion` false restores the old test, for comparisons.
  const off = Math.abs(Math.abs(hive.phi) - HIVE.tiltLimit), w = hive.omega, away = Math.sign(w) !== Math.sign(hive.phi) && Math.abs(w) > 0.25;
  const swinging = EXEC.tipByMotion ? (hive.phi > 0) !== (up === 'rear') || (off > 0.03 && away) : off > 0.03, load = sim.cellLoad(sim.alliance) + inflight + mateLoad;
  const full = Math.ceil(TIP_LOAD.threshold / TIP_LOAD.pollen);
  // Sides convention: the robot launches only into its own CELL. While that CELL is down, or about to go down, the
  // robot loads up for the next time it rises and waits at its own launch spot.
  if (own) {
    const mineUp = up === own && !swinging && load < TIP_LOAD.threshold;
    return mineUp ? { side: own, need: Math.max(1, Math.ceil((TIP_LOAD.threshold - load) / TIP_LOAD.pollen - 1e-9)), remaining: TIP_LOAD.threshold - load, tipPending: false }
      : { side: own, need: full, remaining: TIP_LOAD.threshold, tipPending: up === own };
  }
  // During the swing, `up` still names the CELL that is going down, so the target is the other one in both cases.
  if (swinging || load >= TIP_LOAD.threshold) return { side: up === 'rear' ? 'audience' : 'rear', need: full, remaining: TIP_LOAD.threshold, tipPending: !swinging };
  return { side: up, need: Math.max(1, Math.ceil((TIP_LOAD.threshold - load) / TIP_LOAD.pollen - 1e-9)), remaining: TIP_LOAD.threshold - load, tipPending: false };
}
/** Gets how many more POLLEN the next launch target needs to tip. */
export const pollenNeededToTip = (sim: Sim) => tipTarget(sim).need;

/** Gets the seconds the robot needs to reach the own LOADING ZONE, with a margin. PARK starts no earlier than this. */
const leadCache = new WeakMap<Sim, { at: number; v: number }>();
/**
 * Gets the end of the LOADING ZONE that the robot takes: -1 for the smaller z, 1 for the larger z. The robot with the
 * smaller z takes the smaller-z end. Both partners compare the same two positions on every step, so they always agree,
 * and the assignment follows a partner that arrives by another route. Within 0.15 m of each other in z, the slot decides.
 */
export function parkEnd(sim: Sim): -1 | 1 {
  const mate = sim.partner(); if (!mate) return 1; const dz = sim.robot.translation().z - mate.z;
  return dz < -0.15 ? -1 : dz > 0.15 ? 1 : sim.slot === 0 ? -1 : 1;
}
/** What a robot's drive team tells its partner: its intent, for example `tip_hive`, and its plan. See `RobotState`. */
export type TeamChannel = Pick<RobotState, 'intent' | 'plan'>;

/**
 * Gets the first opponent that stands on its launch spot within 1 m of this robot with a load: about to launch. An
 * opportunistic bump targets it. Null if there is none.
 */
export function linedUpOpponent(sim: Sim): ReturnType<Sim['otherRobots']>[number] | null {
  const p = sim.robot.translation();
  return sim.otherRobots().find(o => o.alliance !== sim.alliance && o.plan.phase === 'launch' && o.plan.goal !== null && o.carried.length > 0 && Math.hypot(o.plan.goal.x - o.x, o.plan.goal.z - o.z) < 0.25 && Math.hypot(o.x - p.x, o.z - p.z) < 1.0) ?? null;
}

export function parkLeadSec(sim: Sim): number {
  // Planning a path on every physics step is wasteful, so the value is reused for 0.4 s of match time.
  const c = leadCache.get(sim); if (c && Math.abs(c.at - sim.timer) < 0.4) return c.v;
  const p = sim.robot.translation(), g = parkGoal(sim);
  const v = pathLength(planPath({ x: p.x, z: p.z }, g, Math.hypot(sim.cfg.length, sim.cfg.width) / 2)) / 1.1 + 2.5 + (sim.partner() ? 1.5 : 0); // With a partner, traffic near the zone costs time.
  leadCache.set(sim, { at: sim.timer, v }); return v;
}
/**
 * Gets the PARK pose. With a partner, the robot with the smaller z takes the end of the LOADING ZONE with the smaller z,
 * so the partners never have to pass each other along the wall. In trace 20260920-131052, ends fixed by slot sent R1
 * past R0, and R1 pushed R0 along the wall until the MATCH ended. See `parkEnd`.
 */
export function parkGoal(sim: Sim): Pt {
  // Partly in the LOADING ZONE counts as PARK. Staying 6 cm off the wall also keeps the LEAVE in AUTO.
  // Partners share the 0.58 m wide zone: each takes one end, and both are partly inside.
  const lz = FIELD.loadingZone[sim.alliance], x = FIELD.half - sim.cfg.length / 2 - 0.06, sgn = sim.alliance === 'red' ? 1 : -1;
  // The right robot takes the right end and the left robot the left end, 0.66 m apart center to center, so there
  // is a 0.23 m gap between them. Each overlaps the zone by 0.17 m, which counts as PARK.
  const mate = sim.partner(); void sgn;
  const offset = mate ? 0.33 * parkEnd(sim) : 0;
  return { x: sim.alliance === 'red' ? -x : x, z: (lz[2] + lz[3]) / 2 + offset };
}

interface Goal {
  x: number; z: number; heading: number | null; key: string; push?: number;
  /** If true, the robot approaches rear-first, so `push` leans backward. Only a robot with a dual-sided intake does this. */ reverse?: boolean;
  /** A pickup that the robot drives through without stopping. `via` is where the route goes next. */ via?: Pt;
  /** If true, the robot drives straight at the goal and skips the planner: the last few centimeters into an obstacle's buffer. */ direct?: boolean;
}
/** A pickup source. `load` is its weight toward a TIP in POLLEN equivalents; `slots` is the robot capacity it uses. */
interface Source { key: string; x: number; z: number; load: number; slots: number; nectar?: boolean; flower?: Flower; approach?: { stage: Pt; touch: Pt; heading: number } }

/** Runs one tactic with path planning. A policy or a script picks the tactic; this class drives and presses buttons. */
export class Executor {
  tactic: Tactic = 'tip_hive'; flowerId: FlowerId | null = null;
  /** How this robot divides the FIELD with its partner. Default: routes. */
  convention: Convention = 'routes';
  /** Own NECTAR that tip_hive keeps in hand instead of launching, so that a FLOWER cap is always possible. Default: 0. */
  nectarReserve = 0;
  status: Status = 'in_progress'; path: Pt[] = []; note = '';
  /** The last stall: the target the robot couldn't reach and why. The coach reads it to try something else. */
  stall: { target: string; reason: string; at: number } | null = null; private justStalled = false;
  private replanAt = 0; private goalKey = ''; private t = 0; private doneFor = 0;
  private recoverUntil = 0; private recoverDir = { f: 0, s: 0 }; private recoverFrom: Pt | null = null;
  private skip = new Map<string, number>(); private spot: Record<string, number> = {};
  private best = Infinity; private bestAt = 0; private progressKey = '';
  /** True once the robot chose a last launch over the PARK. It then launches everything that it carries and doesn't go back to collecting. */
  /** If true, the robot bumps an opponent that is lined up to launch within 1 m of it, and then launches. See `Coach.defense`. */
  /** True once the endgame branch chose a last launch. See `update`. */
  get lastLaunchStarted() { return this.endgame; }
  /**
   * Checks whether this robot should hold still so that its partner lines up first. Both head for the same CELL, and
   * the partner carries the bigger load, or the same load and this robot is the second robot. The partner hasn't lined
   * up yet, this robot is 0.3 m to 1.2 m from its launch spot and within 1.1 m of the partner, and the partner's spot
   * is more than 0.5 m away. A still robot is an obstacle that the planner routes around. Two robots that converge on
   * spots 0.62 m apart block each other: 23 of 65 stalls in eight headless matches before the yield existed.
   * It reads the partner's load as this robot last judged it, without judging it again, so it has no side effects.
   */
  partnerLinesUpFirst(sim: Sim): boolean {
    if (!this.launchingNow(sim)) return false;
    const mate = sim.partner();
    if (!mate || mate.intent !== 'tip_hive' || mate.plan.phase !== 'launch' || !mate.plan.goal) return false;
    if (mate.plan.side !== tipTarget(sim, this.mateLoad, this.own(sim)).side) return false;
    const own = ownNectar(sim.alliance), pollen = sim.carried.filter(k => k === 'pollen').length, nectar = sim.carried.filter(k => k === own).length;
    const keep = sim.cfg.shooter.type === 'dual' ? Math.min(this.nectarReserve, nectar) : 0, load = pollen * TIP_LOAD.pollen + (nectar - keep) * TIP_LOAD.nectar;
    const mateFirst = mate.plan.load > load + 0.01 || (Math.abs(mate.plan.load - load) <= 0.01 && sim.slot === 1);
    const p = sim.robot.translation(), g = this.launchSpot(sim);
    const mateArrived = Math.hypot(mate.plan.goal.x - mate.x, mate.plan.goal.z - mate.z) < 0.2, mine = Math.hypot(g.x - p.x, g.z - p.z), apart = Math.hypot(mate.x - p.x, mate.z - p.z);
    return mateFirst && !mateArrived && mine > 0.3 && mine < 1.2 && apart < 1.1 && Math.hypot(mate.plan.goal.x - p.x, mate.plan.goal.z - p.z) > 0.5;
  }

  /** Checks whether the robot is in a TIP's launch phase with something to launch, where a bump can replace launching. */
  launchingNow(sim: Sim): boolean {
    if (this.tactic !== 'tip_hive' || this.tipPhase !== 'launch') return false;
    const own = ownNectar(sim.alliance), pollen = sim.carried.filter(k => k === 'pollen').length, nectar = sim.carried.filter(k => k === own).length;
    const keep = sim.cfg.shooter.type === 'dual' ? Math.min(this.nectarReserve, nectar) : 0;
    return pollen + nectar - keep > 0;
  }
  private endgame = false; private stagedReverse = { key: '', rev: false };
  private mateLoad = 0; private mateDecidedAt = -9; private launchSide: 'rear' | 'audience' | null = null; private launchCount = 0;
  private readonly shooter = new Shooter(); private intakeAim: { at: number; heading: number | null } = { at: -1, heading: null };
  private pickup: Source[] = []; private pickupAt = -1; private pickupCost = Infinity; private pickupEnd: Pt | null = null; private staged = ''; private tipPhase: 'collect' | 'launch' = 'collect';

  setTactic(t: Tactic, flower: FlowerId | null) {
    if (t === this.tactic && flower === this.flowerId) return;
    this.tactic = t; this.flowerId = flower; this.goalKey = ''; this.replanAt = 0; this.status = 'in_progress'; this.doneFor = 0; this.pickupAt = -1; this.tipPhase = 'collect';
  }

  /** Gets the targets that stalled recently, for example `flower:red`. The robot avoids them until the time runs out. */
  avoided(): string[] { return [...this.skip].filter(([, until]) => until > this.t).map(([k]) => k); }
  /** Gets the FLOWERS that stalled recently. Policies skip them when they pick the next FLOWER. */
  avoidedFlowers(): FlowerId[] { return this.avoided().filter(k => k.startsWith('flower:')).map(k => k.slice(7) as FlowerId); }

  /**
   * Decides how much of the partner's load to count toward the current TIP, the way drive teams split work by
   * watching each other. The first robot of an alliance has priority: it counts its partner's load only when the
   * partner is already lined up to launch. The second robot counts whatever the first carries for a TIP. The
   * decision holds for at least 2 s, because a plan that flips with every change in the partner's plan goes nowhere.
   */
  private partnerLoad(sim: Sim): number {
    if (this.own(sim)) return (this.mateLoad = 0); // Under the sides convention each robot fills its own CELL.
    if (this.t - this.mateDecidedAt < 2) return this.mateLoad;
    const mate = sim.partner(), up = sim.hives[sim.alliance].upCell; let load = 0;
    if (mate?.intent === 'tip_hive' && mate.plan.load > 0 && mate.plan.side === up) {
      // The partner's load counts only if the partner delivers it first: it is in its launch phase and nearer to its
      // launch spot than this robot is to its own. A partner that is still collecting across the FIELD doesn't count.
      // Counting it made a robot leave a CELL that needed one more ball and wait at the other end.
      const p = sim.robot.translation(), spot = this.launchSpot(sim), mine = Math.hypot(spot.x - p.x, spot.z - p.z);
      const theirs = mate.plan.goal ? Math.hypot(mate.plan.goal.x - mate.x, mate.plan.goal.z - mate.z) : Infinity;
      if (mate.plan.phase === 'launch' && (theirs < 0.4 || theirs < mine - (sim.slot === 1 ? 0 : 0.3))) load = mate.plan.load;
    }
    if (load !== this.mateLoad) { this.mateLoad = load; this.mateDecidedAt = this.t; }
    return this.mateLoad;
  }

  private ownHeld: 'rear' | 'audience' | null = null; private ownDecidedAt = -9;
  /** Gets the robot's own side if the sides convention applies now. The answer holds for 2 s, so it can't flicker. */
  private own(sim: Sim) {
    if (this.convention !== 'sides') return null;
    if (this.t - this.ownDecidedAt >= 2) { const mate = sim.partner(), v = mate && mate.intent === 'tip_hive' ? ownSide(sim) : null; if (v !== this.ownHeld) { this.ownHeld = v; this.ownDecidedAt = this.t; } }
    return this.ownHeld;
  }

  /**
   * Gets the points that launching the carried load earns before the MATCH ends, or 0 if the launch can't finish in
   * time. The estimate is the drive to the launch spot at 1.1 m/s, 0.8 s to settle, and 0.3 s per element. A TIP also
   * needs about 1.8 s for the HIVE to swing (measured: 1.2 s to 1.7 s from the threshold to the TIP).
   * The TELEOP tree's endgame branch reads it: see `DriverEnv.endgame`.
   */
  launchValue(sim: Sim): number {
    const own = ownNectar(sim.alliance), keep = 0, pollen = sim.carried.filter(k => k === 'pollen').length, nectar = sim.carried.filter(k => k === own).length - keep, n = pollen + nectar; if (n <= 0) return 0;
    const tgt = tipTarget(sim, 0, this.own(sim)), hive = sim.hives[sim.alliance]; if (tgt.tipPending || tgt.side !== hive.upCell) return 0;
    const p = sim.robot.translation(), spot = this.launchSpot(sim), secs = Math.hypot(spot.x - p.x, spot.z - p.z) / 1.1 + 0.8 + 0.3 * n; if (secs > sim.timer) return 0;
    const load = pollen * TIP_LOAD.pollen + nectar * TIP_LOAD.nectar;
    return load >= tgt.remaining && secs + 1.8 <= sim.timer ? POINTS.tip : n * POINTS.cell;
  }

  /** Checks whether the alliance still needs this robot's PARK for the SWARM ranking point. A playoff MATCH has no ranking points. */
  parkNeededForSwarm(sim: Sim): boolean {
    if (sim.options.playoff) return false;
    const s = sim.score(sim.alliance), mate = sim.partner(), mateParks = mate && mate.plan.phase === 'park' ? POINTS.park : 0;
    // `s.park` counts robots in the LOADING ZONE now, which can include this robot. The partner's PARK counts once.
    const others = Math.max(mateParks, s.park - (sim.robotInLoadingZone() ? POINTS.park : 0));
    return s.leave + s.autoPark + others < RP.swarm;
  }

  private R(sim: Sim) { return Math.hypot(sim.cfg.length, sim.cfg.width) / 2; }

  /**
   * Gets the heading that points the robot's intakes at the most floor elements that the planner collects: POLLEN and
   * own NECTAR, still, and outside the own GARDEN. Each element in an intake's corridor, as wide as the intake and up
   * to 1.2 m ahead of it, counts more the nearer it is. A dual-sided intake counts both ends. The heading is chosen
   * again every 0.25 s, and it changes only for one that scores 25% more, so that the robot doesn't swing between two
   * groups. Null means no element is in reach: the robot keeps its heading.
   */
  private intakeHeading(sim: Sim): number | null {
    if (this.intakeAim.at >= 0 && this.t - this.intakeAim.at < 0.25) return this.intakeAim.heading;
    const p = sim.robot.translation(), c = sim.cfg, own = ownNectar(sim.alliance), g = FIELD.garden[sim.alliance], half = c.length / 2, reach = 1.2;
    const balls: Pt[] = [];
    for (const b of sim.balls.values()) {
      const q = b.body.translation(), v = b.body.linvel();
      if ((b.kind !== 'pollen' && b.kind !== own) || q.y > 0.13 || Math.hypot(v.x, v.z) > 1.2) continue;
      if (q.x > g[0] - 0.05 && q.x < g[1] + 0.05 && q.z > g[2] - 0.05 && q.z < g[3] + 0.05) continue;
      balls.push({ x: q.x - p.x, z: q.z - p.z });
    }
    const score = (h: number) => {
      const fx = Math.cos(h), fz = -Math.sin(h); let sum = 0;
      for (const b of balls) {
        const along = b.x * fx + b.z * fz, lateral = Math.abs(-b.x * Math.sin(h) - b.z * Math.cos(h)); if (lateral > c.intake.width / 2 + 0.05) continue;
        if (along - half >= 0 && along - half <= reach) sum += 1 / (0.25 + along - half);
        else if (c.intake.dualSided && -along - half >= 0 && -along - half <= reach) sum += 1 / (0.25 - along - half);
      }
      return sum;
    };
    let best: number | null = null, bestScore = 0;
    for (let k = 0; k < 24; k++) { const h = wrap((k * Math.PI) / 12), sc = score(h); if (sc > bestScore) { bestScore = sc; best = h; } }
    const prev = this.intakeAim.heading;
    const heading = prev !== null && best !== null && score(prev) * 1.25 >= bestScore ? prev : best;
    this.intakeAim = { at: this.t, heading };
    return heading;
  }

  /**
   * Gets the launch pose for the raised CELL. A fixed shooter aims with the robot's heading. A turret aims itself, so
   * its launch pose has no heading, and the robot doesn't turn to launch.
   * The first robot of an alliance launches from straight in front of the CELL. Its partner launches from 0.62 m
   * to the side, angled at the opening, so both can launch without sharing a spot.
   */
  launchSpot(sim: Sim): Goal {
    const me = sim.alliance, hive = sim.hives[me], cell = tipTarget(sim, this.mateLoad, this.own(sim)).side, side = cell === 'audience' ? 1 : -1, rear = sim.cfg.shooter.facing === 'rear';
    // Under the sides convention the partners launch from opposite sides of the HIVE, so both use the straight spot.
    const angled = this.useAngled(sim, cell), x = HIVE.pivotX[me] + (angled ? (me === 'red' ? -0.62 : 0.62) : 0), mouthZ = side * 0.415, key = `${angled}`;
    const headingAt = (z: number) => { const aim = Math.atan2(-(mouthZ - z), HIVE.pivotX[me] - x); return rear ? wrap(aim + Math.PI) : aim; };
    // The standoff is measured from the shot preview, which needs this CELL raised and at rest. The two alliances' sides are the same, rotated 180°.
    if (this.spot[key] === undefined && hive.upCell === cell && Math.abs(Math.abs(hive.phi) - HIVE.tiltLimit) < 0.02) {
      const ok: number[] = [];
      for (let z = 0.75; z <= 1.58; z += 0.02) if (sim.previewShot('pollen', { x, z: side * z, heading: headingAt(side * z) }).scores) ok.push(z);
      if (ok.length) this.spot[key] = ok[Math.min(ok.length - 1, Math.floor(ok.length * EXEC.standoff))];
    }
    const z = side * (this.spot[key] ?? 1.3);
    // A dual-sided shooter launches out of either end, so the robot takes whichever heading needs the smaller turn.
    const h = headingAt(z), flipIt = !!sim.cfg.shooter.dualSided && Math.abs(wrap(h - sim.heading)) > Math.PI / 2;
    return { x, z, heading: sim.cfg.shooter.turret ? null : flipIt ? wrap(h + Math.PI) : h, key: `launch:${cell}` };
  }

  /**
   * Decides which of the two launch spots the robot uses. The slot decides: the first robot launches from straight in
   * front of the CELL, and the second from the angled spot. The one exception is a swap: when each partner stands
   * within 0.3 m of the other's spot and both are launching into the same CELL, each takes the spot that it stands on.
   * In trace 20260920-165529, the partners arrived at each other's spots and pushed each other for 2 s.
   * A general "nearer robot takes the straight spot" rule lost 59 points over 24 seeds, so the rule stays this narrow.
   */
  private useAngled(sim: Sim, cell: 'rear' | 'audience'): boolean {
    const byDefault = sim.slot === 1 && !this.own(sim), mate = sim.partner();
    if (this.own(sim) || !mate || this.tactic !== 'tip_hive' || this.tipPhase !== 'launch' || mate.intent !== 'tip_hive' || mate.plan.phase !== 'launch' || mate.plan.side !== cell) return byDefault;
    const side = cell === 'audience' ? 1 : -1, me = sim.alliance, p = sim.robot.translation();
    const straight = { x: HIVE.pivotX[me], z: side * (this.spot.false ?? 1.3) }, angled = { x: HIVE.pivotX[me] + (me === 'red' ? -0.62 : 0.62), z: side * (this.spot.true ?? 1.17) };
    const mySpot = byDefault ? angled : straight, theirSpot = byDefault ? straight : angled, near = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z) < 0.3;
    return near(p, theirSpot) && near(mate, mySpot) ? !byDefault : byDefault;
  }

  private flowerStand(sim: Sim, f: Flower, push = 0): Goal {
    const onX = Math.abs(f.x) > Math.abs(f.z), stand = sim.cfg.length / 2 + FIELD.flowerHalfSize + 0.02;
    const p = sim.robot.translation(), lateral = onX ? Math.abs(p.z - f.z) : Math.abs(p.x - f.x);
    // Approach in two stages: line up on the FLOWER's axis 0.2 m back, then drive straight in. Sliding in from
    // the side catches a front corner of the chassis on the FLOWER.
    const back = stand + (lateral > 0.07 ? 0.2 : 0);
    const x = onX ? f.x - Math.sign(f.x) * back : f.x, z = onX ? f.z : f.z - Math.sign(f.z) * back;
    return { x, z, heading: Math.atan2(-(f.z - z), f.x - x), key: `flower:${f.id}`, push: lateral > 0.07 ? 0 : push };
  }

  /**
   * Plans the fastest pickup route: the order of floor balls and FLOWER bottoms that yields `needLoad` (in POLLEN
   * equivalents) within `slots` free slots and ends at `end`, by exhaustive search over the nearest sources.
   * Own NECTAR weighs 1.6 POLLEN toward a TIP, so it gets a small preference. A blocked straight leg costs a detour.
   */
  private planPickup(sim: Sim, kinds: BallKind[], needLoad: number, slots: number, end: Pt | null): { seq: Source[]; cost: number } {
    const p = sim.robot.translation(), here = { x: p.x, z: p.z }, g = FIELD.garden[sim.alliance], R = this.R(sim), srcs: Source[] = [];
    // Partners don't chase the same ball, and they stay away from a partner that is lined up to launch.
    // The first robot's claims win. If both robots honored each other's claims, each replan would evict the other's.
    const others = sim.otherRobots(); const mate = sim.partner(), taken = new Set(mate && sim.slot === 1 ? mate.plan.claims : []), mateBusy = mate && mate.plan.phase === 'launch' && mate.speed < 0.3 ? mate : null;
    for (const b of sim.balls.values()) {
      const q = b.body.translation(), v = b.body.linvel(), key = `ball:${b.id}`;
      if (!kinds.includes(b.kind) || q.y > 0.13 || Math.hypot(v.x, v.z) > 1.2 || (this.skip.get(key) ?? 0) > this.t) continue;
      if (q.x > g[0] - 0.05 && q.x < g[1] + 0.05 && q.z > g[2] - 0.05 && q.z < g[3] + 0.05) continue; // Already scoring in the own GARDEN.
      if (taken.has(key) || (mateBusy && Math.hypot(q.x - mateBusy.x, q.z - mateBusy.z) < 0.6)) continue;
      // The closer robot owns the ball. A ball within 0.25 m of another robot's chassis is that robot's to take, and
      // going for it means pushing that robot. In trace 20260920-131052, R1 chased a ball 0.2 m from R0 and fought it.
      const mineD = Math.hypot(q.x - p.x, q.z - p.z); if (others.some(o => { const d = Math.hypot(q.x - o.x, q.z - o.z); return d < o.r + 0.25 && d < mineD; })) continue;
      // A ball against a HIVE foot bar or leg needs a square approach from a staging pose. No pose means no pickup.
      let ap = ballApproach({ x: q.x, z: q.z }, R, sim.cfg.length / 2); if (!ap) continue;
      // A ball against one perimeter wall gets a square approach: line up 0.22 m back, facing the wall, and then drive
      // straight in. It applies when the robot would come in more than 0.6 rad off square. A diagonal approach puts a front corner on the wall before the intake reaches the ball: 14 of 32
      // stalls in eight headless matches. A ball in a corner keeps the diagonal approach, which is the only one.
      const lim = FIELD.half - sim.cfg.width / 2 - 0.03, byX = Math.abs(q.x) > lim - 0.12, byZ = Math.abs(q.z) > lim - 0.12;
      const square = byZ ? (q.z < 0 ? Math.PI / 2 : -Math.PI / 2) : q.x > 0 ? 0 : Math.PI, shallow = Math.abs(wrap(Math.atan2(-(q.z - p.z), q.x - p.x) - square)) > 0.6;
      if (ap === 'open' && byX !== byZ && shallow) {
        const heading = square, fx = Math.cos(heading), fz = -Math.sin(heading), back = sim.cfg.length / 2 - 0.02;
        const touch = { x: clamp(q.x - fx * back, -lim, lim), z: clamp(q.z - fz * back, -lim, lim) };
        ap = { stage: { x: touch.x - fx * 0.22, z: touch.z - fz * 0.22 }, touch, heading };
      }
      srcs.push({ key, x: ap === 'open' ? q.x : ap.stage.x, z: ap === 'open' ? q.z : ap.stage.z, load: b.kind === 'pollen' ? TIP_LOAD.pollen : TIP_LOAD.nectar, slots: 1, nectar: b.kind !== 'pollen', approach: ap === 'open' ? undefined : ap });
    }
    // Sides convention: pick up in the own half of the FIELD. The other half is the partner's, unless the own half is empty.
    const zone = this.own(sim), inZone = (q: Pt) => !zone || (zone === 'rear' ? q.z < 0.15 : q.z > -0.15), mine = srcs.filter(inZone);
    if (mine.length) srcs.splice(0, srcs.length, ...mine);
    srcs.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)); srcs.length = Math.min(srcs.length, 8);
    if (kinds.includes('pollen')) for (const f of sim.flowers) {
      const key = `flower:${f.id}`, n = f.stack.findIndex(k => k !== 'pollen'), units = n < 0 ? f.stack.length : n;
      // A FLOWER bottom yields several POLLEN in one stop. FLOWERS that the alliance owns keep their POLLEN.
      if (inZone(f) && retrievable(f.stack) && sim.flowerStatus(f).owner !== sim.alliance && (this.skip.get(key) ?? 0) <= this.t && !taken.has(key) && sim.partner()?.intent !== `work_flower:${f.id}`) { const st = this.flowerStand(sim, f); srcs.push({ key, x: st.x, z: st.z, load: units, slots: units, flower: f }); }
    }
    // Pickups on the opponent's half of the FIELD cost extra: crossing over brings collisions and contention.
    const away = (q: Pt) => ((sim.alliance === 'red' ? q.x : -q.x) > 0.1 ? 1.5 : 0);
    // A leg that passes through a slow partner costs a detour, the same as a leg through a FIELD element.
    const crossesMate = (a: Pt, b: Pt) => { if (!mate || mate.speed > 0.5) return false; const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez, u = l2 === 0 ? 0 : clamp(((mate.x - a.x) * ex + (mate.z - a.z) * ez) / l2, 0, 1); return Math.hypot(mate.x - a.x - u * ex, mate.z - a.z - u * ez) < R + mate.r - 0.08; };
    const leg = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z) + (segmentClear(a, b, R) ? 0 : 0.9) + (crossesMate(a, b) ? 0.9 : 0) + away(b);
    let bestCost = Infinity, bestSeq: Source[] = [];
    const dfs = (at: Pt, got: number, used: number, cost: number, seq: Source[]) => {
      if (cost >= bestCost) return;
      if (got >= needLoad - 1e-9 || used >= slots || seq.length === srcs.length || seq.length >= 4) {
        if (seq.length === 0) return; const total = cost + (end ? leg(at, end) : 0) + (got < needLoad ? 3 * (needLoad - got) : 0);
        if (total < bestCost) { bestCost = total; bestSeq = [...seq]; } return;
      }
      for (const src of srcs) if (!seq.includes(src)) {
        const take = Math.min(src.slots, slots - used, Math.ceil(needLoad - got));
        dfs(src, got + (src.flower ? take : src.load), used + take, cost + leg(at, src) + (src.flower ? 0.55 * take + 0.3 : (src.nectar ? -0.15 : 0) + (src.approach ? 0.7 : 0)), [...seq, src]);
      }
    };
    dfs(here, 0, 0, 0, []);
    return { seq: bestSeq, cost: bestCost };
  }

  private collect(sim: Sim, kinds: BallKind[], needLoad: number, slots: number, end: Pt | null): Goal | null {
    const first = this.pickup[0];
    const gone = !first || (this.skip.get(first.key) ?? 0) > this.t || (first.flower ? !retrievable(first.flower.stack) : !this.ballStill(sim, first));
    // Replan when the target is gone, and otherwise look again every 0.5 s but keep the plan unless a new one is
    // clearly better. Switching between near-equal plans is what makes a robot hesitate and reverse.
    if (gone || this.pickupAt < 0 || this.t - this.pickupAt > 0.5) {
      const plan = this.planPickup(sim, kinds, needLoad, slots, end); this.pickupAt = this.t;
      const current = gone || this.pickupAt < 0 ? Infinity : this.routeCost(sim, this.pickup, end);
      if (gone || !plan.seq[0] || plan.seq[0].key === first?.key || plan.cost < current - 0.45) { if (plan.seq[0]?.key !== first?.key) this.staged = ''; this.pickup = plan.seq; }
    }
    this.pickupEnd = end; const s = this.pickup[0]; if (!s) return null;
    if (s.flower) return this.flowerStand(sim, s.flower, 0.35);
    // A dual-sided intake takes a floor ball at either end, so the robot uses whichever end needs the smaller turn.
    const either = (g: Goal): Goal => (sim.cfg.intake.dualSided && g.heading !== null && Math.abs(wrap(g.heading - sim.heading)) > Math.PI / 2 ? { ...g, heading: wrap(g.heading + Math.PI), reverse: true } : g);
    const p = sim.robot.translation(), next = this.pickup[1] ?? end ?? undefined;
    if (s.approach) {
      // A ball against the frame: line up at the staging pose, then drive straight in and lean on it.
      const a = s.approach, at = Math.hypot(a.stage.x - p.x, a.stage.z - p.z) < 0.08 && Math.abs(wrap(a.heading - sim.heading)) < 0.12;
      if (at) this.staged = s.key;
      // The end is chosen once per staged approach, so that the robot doesn't flip ends between the stage and the touch.
      const rev = sim.cfg.intake.dualSided && (this.stagedReverse.key === s.key ? this.stagedReverse.rev : (this.stagedReverse = { key: s.key, rev: Math.abs(wrap(a.heading - sim.heading)) > Math.PI / 2 }).rev), h = rev ? wrap(a.heading + Math.PI) : a.heading;
      const at2 = Math.hypot(a.stage.x - p.x, a.stage.z - p.z) < 0.08 && Math.abs(wrap(h - sim.heading)) < 0.12; if (at2) this.staged = s.key;
      return this.staged === s.key ? { ...a.touch, heading: h, key: s.key, push: 0.3, direct: true, reverse: rev } : { ...a.stage, heading: h, key: s.key };
    }
    // A ball near a wall needs a stop with the intake over it. A ball in the open is driven through at speed, with
    // the intake leading, and the route continues to the next pickup or to the launch spot.
    const lim = FIELD.half - sim.cfg.width / 2 - 0.03, nearWall = Math.abs(s.x) > lim - 0.12 || Math.abs(s.z) > lim - 0.12;
    const dir = Math.atan2(-(s.z - p.z), s.x - p.x);
    if (!nearWall) return either({ x: s.x, z: s.z, heading: Math.hypot(s.x - p.x, s.z - p.z) > 0.12 ? dir : null, key: s.key, via: next ? { x: next.x, z: next.z } : undefined });
    const back = sim.cfg.length / 2 - 0.02, gx = clamp(s.x - Math.cos(dir) * back, -lim, lim), gz = clamp(s.z + Math.sin(dir) * back, -lim, lim);
    return either({ x: gx, z: gz, heading: Math.atan2(-(s.z - gz), s.x - gx), key: s.key, push: 0.3 });
  }

  private routeCost(sim: Sim, seq: Source[], end: Pt | null): number {
    const p = sim.robot.translation(); let at: Pt = { x: p.x, z: p.z }, c = 0;
    for (const q of seq) { c += Math.hypot(q.x - at.x, q.z - at.z) + (q.flower ? 0.55 * q.slots + 0.3 : q.approach ? 0.7 : 0); at = q; }
    return c + (end ? Math.hypot(end.x - at.x, end.z - at.z) : 0);
  }

  private ballStill(sim: Sim, s: Source) { const b = sim.balls.get(Number(s.key.slice(5))); if (!b) return false; const q = b.body.translation(), ref = s.approach ? { x: s.approach.touch.x, z: s.approach.touch.z } : s; return q.y < 0.13 && Math.hypot(q.x - ref.x, q.z - ref.z) < (s.approach ? 0.45 : 0.25); }

  /**
   * Gets the robot inputs for this physics step.
   * @param mode What the TELEOP tree decided for this step. `park` runs the PARK without changing the tactic, so that a
   *   later step can still choose a last launch. `lastLaunch` launches everything that the robot carries and stops
   *   collecting, for the rest of the MATCH. `bump` drives into the opponent in slot `bumpSlot` instead of launching, if
   *   the robot is in a TIP's launch phase. `yield` holds still in a TIP's launch phase, so that the partner lines up
   *   first. Default: `normal`, which runs the tactic.
   * @param bumpSlot The opponent's slot for `bump`.
   * @param team What this robot's drive team tells its partner: its intent and its plan. Partners and opponents read
   *   them from the robot's record. Default: that record. The TELEOP tree passes its partner channel.
   */
  update(sim: Sim, dt: number, mode: 'normal' | 'park' | 'lastLaunch' | 'bump' | 'yield' = 'normal', bumpSlot = -1, team: TeamChannel = sim.robots[sim.me]): Inputs {
    this.t += dt; team.intent = this.tactic === 'work_flower' ? `work_flower:${this.flowerId}` : this.tactic;
    const shared = team.plan; shared.claims = this.tactic === 'tip_hive' || this.tactic.startsWith('collect') ? this.pickup.slice(0, 2).map(q => q.key) : []; shared.phase = 'other'; shared.side = null; shared.load = 0; shared.goal = null; shared.zone = this.own(sim);
    const me = sim.alliance, free = sim.cfg.capacity - sim.carried.length, carriedPollen = sim.carried.filter(k => k === 'pollen').length;
    let goal: Goal | null = null, status: Status = 'in_progress', intake: IntakeFilter = 'none', tactic = this.tactic; this.note = '';
    const buttons = { shootNectar: false, shootPollen: false, placeNectar: false, placePollen: false };
    // The endgame: the TELEOP tree decides between a last launch and PARK, by value, and passes the decision in `mode`.
    if (mode === 'lastLaunch') { this.endgame = true; this.tipPhase = 'launch'; this.note = 'last launch, not PARK'; }
    else if (mode === 'park') { tactic = 'park'; this.note = 'park guard'; }

    const own = ownNectar(me), carriedNectar = sim.carried.filter(k => k === own).length;
    const launch = (keepNectar: number, onlyWhatTips = false) => {
      goal = this.launchSpot(sim); const p = sim.robot.translation();
      // The shot preview is the real gate, so the spot itself has a loose tolerance: a robot that a neighbor keeps
      // 10 cm off its spot still launches if the predicted path enters the CELL.
      const at = Math.hypot(goal.x - p.x, goal.z - p.z) < 0.22 && (goal.heading === null || Math.abs(wrap(goal.heading - sim.heading)) < 0.08);
      const dual = sim.cfg.shooter.type === 'dual', next = dual ? (carriedPollen > 0 ? 'pollen' : 'nectar') : sim.carried[0] === 'pollen' ? 'pollen' : 'nectar';
      // Fire control is the shooter's: see `Shooter.canShoot`. The robot launches from its spot, still. A turret aims
      // itself, so its spot has no heading, and two experiments can change it: see `EXEC`.
      const turret = !!sim.cfg.shooter.turret, enRoute = turret && EXEC.turretFireEnRoute;
      if (turret && EXEC.turretIntakeHeading) goal = { ...goal, heading: this.intakeHeading(sim) };
      if ((enRoute || at) && this.shooter.canShoot(sim, next, EXEC.tipByMotion, enRoute ? 'moving' : 'still')) {
        buttons.shootNectar = !dual || carriedNectar > keepNectar; buttons.shootPollen = true;
        if (onlyWhatTips && dual) {
          // The dual shooter can fire both types at once. Fire only what the TIP still needs, counting balls in
          // flight: one POLLEN if that finishes it, NECTAR (1.6) only while more than one POLLEN of load is missing.
          const left = tipTarget(sim, this.mateLoad, this.own(sim)).remaining, canN = carriedNectar > keepNectar;
          buttons.shootNectar = canN && (left > TIP_LOAD.pollen || carriedPollen === 0);
          buttons.shootPollen = carriedPollen > 0 && !(buttons.shootNectar && left <= TIP_LOAD.nectar);
        }
      }
    };

    if (tactic === 'tip_hive') {
      // Collect only what the raised CELL still needs, by the fastest route that ends at the launch spot, then launch.
      // Own NECTAR counts 1.6 POLLEN toward the TIP. `nectarReserve` NECTAR stay in hand for a FLOWER cap.
      const tgt = tipTarget(sim, this.partnerLoad(sim), this.own(sim)), need = tgt.need, keep = sim.cfg.shooter.type === 'dual' ? Math.min(this.nectarReserve, carriedNectar) : 0;
      const launchable = carriedPollen + carriedNectar - keep, load = carriedPollen * TIP_LOAD.pollen + (carriedNectar - keep) * TIP_LOAD.nectar;
      // Two phases with no way back: collect until the load is in hand, then launch all of it. Without the latch,
      // each shot drops the carried load under the target and sends the robot off to collect again.
      if (this.tipPhase === 'collect' && (load >= need || free === 0) && launchable > 0) { this.tipPhase = 'launch'; this.launchSide = tgt.side; this.launchCount = sim.carried.length; }
      // The latch has one way back: the robot has room, it carries clearly less than the target needs, and either it
      // hasn't fired yet or the target moved to the other CELL. In trace 20260920-141643, R1 latched with one NECTAR,
      // the target moved to the rear CELL, which needed 8, and R1 waited at the rear spot for more than 5 s.
      else if (this.tipPhase === 'launch' && !this.endgame && free > 0 && load < need - 0.5 && (tgt.side !== this.launchSide || sim.carried.length >= this.launchCount)) { this.tipPhase = 'collect'; this.pickupAt = -1; }
      shared.phase = this.tipPhase; shared.side = tgt.side; shared.load = load;
      if (this.tipPhase === 'launch') {
        if (launchable === 0) { this.tipPhase = 'collect'; status = 'done'; } else {
          launch(this.endgame ? 0 : keep, !this.endgame); if (free > 0) intake = 'all';
          // Opportunistic defense: the TELEOP tree's bump branch decides when to shove an opponent that is lined up to launch.
          if (mode === 'bump' && !this.endgame) {
            const foe = sim.otherRobots().find(o => o.alliance !== sim.alliance && o.slot === bumpSlot);
            if (foe) { goal = { x: foe.x, z: foe.z, heading: null, key: `bump:${foe.slot}`, direct: true }; buttons.shootNectar = buttons.shootPollen = false; this.note = 'bump the opponent that is lined up'; this.bestAt = this.t; }
          }
          // Yield: the TELEOP tree's yield branch decides when to hold still for the partner. See `partnerLinesUpFirst`.
          if (mode === 'yield') { goal = null; this.note = 'yield: partner lines up first'; this.bestAt = this.t; }
        }
      } else {
        // The intake stays open while the hopper has room, for every shooter type: a ball on the route is a free ball.
        // In trace 20260920-141643, a FIFO robot with two free slots passed a POLLEN at 0.22 m with the intake closed.
        intake = free > 0 ? 'all' : 'none'; goal = this.collect(sim, ['pollen', own], need - load, free, this.launchSpot(sim));
        if (!goal) { if (launchable > 0) this.tipPhase = 'launch'; else status = 'blocked'; }
      }
      this.note ||= `${this.tipPhase}: ${tgt.side} CELL needs ${need} POLLEN equivalents${tgt.tipPending ? ', TIP pending' : ''}${keep ? `, holding ${keep} NECTAR` : ''}`;
    } else if (tactic === 'collect_pollen' || tactic === 'collect_own_nectar') {
      const kind = tactic === 'collect_pollen' ? 'pollen' : ownNectar(me); intake = tactic === 'collect_pollen' ? 'pollen' : 'own_nectar';
      if (free === 0) status = 'done'; else { goal = this.collect(sim, [kind], free * 2, free, null); if (!goal) status = 'done'; }
    } else if (tactic === 'launch_into_hive') {
      if (sim.carried.length === 0) status = 'done'; else launch(0);
    } else if (tactic === 'work_flower') {
      const f = sim.flowers.find(q => q.id === this.flowerId) ?? null, act = f ? flowerAction(sim, f) : 'none';
      if (!f || (this.skip.get(`flower:${f.id}`) ?? 0) > this.t) status = 'blocked'; else if (act === 'none') status = 'done';
      else {
        goal = this.flowerStand(sim, f, act === 'pull_pollen_to_seat_plug' ? 0.35 : 0.12); intake = act === 'pull_pollen_to_seat_plug' ? 'pollen' : 'none';
        if (sim.reachableFlower() === f && act !== 'pull_pollen_to_seat_plug') { if (act === 'fill_with_pollen') buttons.placePollen = true; else buttons.placeNectar = true; }
        this.note = act;
      }
    } else {
      shared.phase = 'park'; const g = parkGoal(sim); goal = { ...g, heading: null, key: 'park' };
      if (sim.robotInLoadingZone() && Math.hypot(g.x - sim.robot.translation().x, g.z - sim.robot.translation().z) < 0.12) { this.status = 'in_progress'; this.path = []; return NO_INPUT; }
    }
    // A stall ends the tactic at once as blocked, so that the coach picks something else instead of retrying.
    if (this.justStalled) { this.justStalled = false; this.status = 'blocked'; this.doneFor = 1; return { ...NO_INPUT, intake }; }
    // A tactic reports done only after it stays done for 0.2 s, so one frame with no target doesn't end it.
    this.doneFor = status === 'in_progress' ? 0 : this.doneFor + dt;
    this.status = status === 'in_progress' || this.doneFor > 0.2 ? status : 'in_progress';
    if (!goal) { this.path = []; return { ...NO_INPUT, intake }; }
    shared.goal = { x: (goal as Goal).x, z: (goal as Goal).z };
    return { ...this.drive(sim, goal, dt), ...buttons, intake };
  }

  /** Follows the planned path by pure pursuit. The robot turns to the goal heading while it travels. */
  private drive(sim: Sim, goal: Goal, dt: number) {
    const p = sim.robot.translation(), here = { x: p.x, z: p.z };
    // A recovery ends after 0.45 m as well as after its time, because a fast robot covers far more ground in the same
    // time. In trace 20260920-141643, a 600 rpm robot backed off across the FIELD center line.
    if (this.t < this.recoverUntil && this.recoverFrom && Math.hypot(p.x - this.recoverFrom.x, p.z - this.recoverFrom.z) > 0.45) this.recoverUntil = 0;
    if (this.t < this.recoverUntil) return { forward: this.recoverDir.f, strafeRight: this.recoverDir.s, turnRight: 0 };
    if (this.t >= this.replanAt || goal.key !== this.goalKey) {
      // Other robots are obstacles at their current position. Replanning every 0.15 s tracks their motion. A partner
      // that is lined up to launch gets a wider berth, and so does its firing lane to the CELL: don't bump the shooter.
      const robots: Capsule[] = sim.otherRobots().flatMap(o => {
        // Lined up means at its launch spot, not merely slow: a stuck partner must not get a wider berth.
        const lined = o.alliance === sim.alliance && o.plan.phase === 'launch' && o.speed < 0.4 && o.plan.side !== null && o.plan.goal !== null && Math.hypot(o.plan.goal.x - o.x, o.plan.goal.z - o.z) < 0.25;
        const out: Capsule[] = [{ a: o, b: o, r: o.r + (lined ? 0.15 : 0), soft: true }];
        if (lined) out.push({ a: o, b: { x: HIVE.pivotX[sim.alliance], z: (o.plan.side === 'audience' ? 1 : -1) * 0.5 }, r: 0.05, soft: true });
        return out;
      });
      // Routes: on a trip from one end of the FIELD to the other, the right robot goes under the HIVE and the left
      // robot goes around it on the alliance's own side. The opponent's corridor is closed to both.
      const oneWay: Capsule[] = [], sgn = sim.alliance === 'red' ? 1 : -1;
      if (this.convention === 'routes' && sim.partner() && here.z * goal.z < 0 && Math.abs(here.z) > 0.35 && Math.abs(goal.z) > 0.35) {
        oneWay.push({ a: { x: sgn * 0.63, z: 0 }, b: { x: sgn * 2, z: 0 }, r: 0 });
        oneWay.push(sim.slot === 0 ? { a: { x: -sgn * 0.63, z: 0 }, b: { x: -sgn * 2, z: 0 }, r: 0 } : { a: { x: -0.6, z: 0 }, b: { x: 0.6, z: 0 }, r: 0 });
      }
      const fixed = [...fieldObstacles(), ...robots];
      this.path = goal.direct ? [here, goal] : planPath(here, goal, this.R(sim), [...fixed, ...oneWay]);
      // If the assigned route is closed, for example by a robot in the tunnel, any open route will do.
      if (oneWay.length && this.path.length === 2) this.path = planPath(here, goal, this.R(sim), fixed);
      if (goal.via) this.path.push(goal.via); // The route continues past a drive-through pickup, so the robot doesn't brake for it.
      this.replanAt = this.t + 0.15;
      if (goal.key !== this.goalKey) { this.goalKey = goal.key; this.best = Infinity; this.bestAt = this.t; }
    }
    const cmd = pursue(sim, this.path, goal.heading), remaining = cmd.remaining, err = cmd.headingError;
    let forward = cmd.forward;
    // Keep clear of other robots: inside 0.56 m, add a push straight away from them. Both robots do this, so two
    // robots that meet slide apart instead of wedging against each other, which would also be a PIN (G421).
    let strafe = cmd.strafeRight; const th = sim.heading;
    for (const o of sim.otherRobots()) {
      // The push fades out near the robot's own goal: launch spots of partners and opponents are 0.62 m to 0.65 m
      // apart by design, and a push there would keep the robot from ever settling on its spot.
      const ox = p.x - o.x, oz = p.z - o.z, d = Math.hypot(ox, oz) || 1e-6, k = clamp((0.56 - d) / 0.2, 0, 1) * 0.8 * clamp(remaining / 0.5, 0, 1); if (k === 0) continue;
      forward += k * ((ox * Math.cos(th) - oz * Math.sin(th)) / d); strafe -= k * ((-ox * Math.sin(th) - oz * Math.cos(th)) / d);
    }
    const near = remaining < 0.2 && Math.abs(err) < 0.3;
    // Lean on the ball or the FLOWER so that the intake takes it. A rear-first approach leans backward.
    if (goal.push && near) forward = goal.reverse ? Math.min(forward, -goal.push) : Math.max(forward, goal.push);

    // Progress monitor: no progress toward the goal and no change in what the robot carries means it is hung.
    const pk = `${goal.key}|${sim.carried.length}|${sim.flowers.map(q => q.stack.length).join()}`;
    if (pk !== this.progressKey) { this.progressKey = pk; this.best = remaining; this.bestAt = this.t; }
    else if (remaining < this.best - 0.03) { this.best = remaining; this.bestAt = this.t; }
    // Waiting for the interlock at the launch spot isn't a stall. Being held short of the spot is.
    const waitingToShoot = goal.key.startsWith('launch') && remaining < 0.14 && Math.abs(err) < 0.06;
    if (this.t - this.bestAt > (near ? 2.2 : 1.4) && !waitingToShoot && goal.key !== 'park') {
      // Robots that block each other must not retry in step, so the avoid time differs per robot.
      const nearest = sim.otherRobots().map(o => ({ o, d: Math.hypot(o.x - p.x, o.z - p.z) })).sort((a, b) => a.d - b.d)[0];
      const byRobot = !!nearest && nearest.d < 0.75;
      this.stall = { target: goal.key, reason: byRobot ? `another robot is in the way, ${nearest.d.toFixed(1)} m away` : 'no progress toward the target', at: this.t }; this.justStalled = true;
      this.skip.set(goal.key, this.t + (byRobot ? 7 + 5 * sim.me : 8)); this.recoverUntil = this.t + 0.5; this.recoverFrom = { x: p.x, z: p.z }; this.bestAt = this.t; this.best = Infinity; this.replanAt = 0; this.pickupAt = -1; this.goalKey = '';
      // Make way for the partner: the second robot of an alliance clears out of its partner's goal, away from the
      // walls, for longer than a plain back-off. Two partners that both back off and return would block each other again.
      const mate = sim.partner();
      if (byRobot && mate && sim.slot === 1 && Math.hypot(mate.x - p.x, mate.z - p.z) < 0.75) {
        const from = mate.plan.goal ?? mate; let ax = p.x - from.x, az = p.z - from.z; const wall = FIELD.half - 0.45;
        if (Math.abs(p.x) > wall) ax -= Math.sign(p.x) * 1.2; if (Math.abs(p.z) > wall) az -= Math.sign(p.z) * 1.2;
        const m = Math.hypot(ax, az) || 1e-6; this.recoverDir = { f: 0.9 * (ax * Math.cos(th) - az * Math.sin(th)) / m, s: -0.9 * (-ax * Math.sin(th) - az * Math.cos(th)) / m }; this.recoverUntil = this.t + 1.3;
      } else if (byRobot) {
        // Back away from the blocking robot, and off any wall: backing into a wall goes nowhere.
        let ax = p.x - nearest.o.x, az = p.z - nearest.o.z; const wall = FIELD.half - 0.45;
        if (Math.abs(p.x) > wall) ax -= Math.sign(p.x) * 1.5; if (Math.abs(p.z) > wall) az -= Math.sign(p.z) * 1.5;
        const m = Math.hypot(ax, az) || 1e-6; this.recoverDir = { f: 0.8 * (ax * Math.cos(th) - az * Math.sin(th)) / m, s: -0.8 * (-ax * Math.sin(th) - az * Math.cos(th)) / m }; this.recoverUntil = this.t + 0.8;
      }
      else {
        // Hung on a FIELD element, for example a chassis corner on a FLOWER after a nudge: back straight away from
        // the nearest element and off any wall. Backing along the heading can just slide along it.
        let ax = 0, az = 0, bestD = 0.5;
        for (const o of fieldObstacles()) { const ex = o.b.x - o.a.x, ez = o.b.z - o.a.z, l2 = ex * ex + ez * ez, u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - o.a.x) * ex + (p.z - o.a.z) * ez) / l2)), cx = o.a.x + u * ex, cz = o.a.z + u * ez, d = Math.hypot(p.x - cx, p.z - cz) - o.r; if (d < bestD) { bestD = d; ax = p.x - cx; az = p.z - cz; } }
        const wall = FIELD.half - 0.4, n0 = Math.hypot(ax, az) || 1; ax /= n0; az /= n0;
        if (Math.abs(p.x) > wall) ax -= Math.sign(p.x) * 0.8; if (Math.abs(p.z) > wall) az -= Math.sign(p.z) * 0.8;
        const m = Math.hypot(ax, az);
        if (m > 0.2) { this.recoverDir = { f: 0.8 * (ax * Math.cos(th) - az * Math.sin(th)) / m, s: -0.8 * (-ax * Math.sin(th) - az * Math.cos(th)) / m }; this.recoverUntil = this.t + 0.8; }
        else this.recoverDir = { f: -0.6 * Math.sign(forward || 1), s: -0.4 * Math.sign(strafe) };
      }
    }
    return { forward: clamp(forward), strafeRight: clamp(strafe), turnRight: cmd.turnRight };
  }
}
