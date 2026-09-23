/**
 * AUTO as behavior trees: the onboard environment, the AUTO leaves, and `AutoProgram`, which runs one robot's AUTO
 * tree. See docs/behavior-trees.md.
 *
 * The onboard environment is what an FTC OpMode can know: the robot's own odometry, its hopper count, its size, the
 * clock, and the camera's AprilTag sightings of the CELLS. It has no balls and no other robots. Positions are in the
 * alliance frame, which is red's FIELD coordinates in x and y: a blue robot runs the same poses rotated 180° about the
 * FIELD center. `simPoint` converts a pose to the simulator's axes.
 *
 * Each AUTO leaf is one step of the kind that `ScriptRunner` ran, with the same timing: it ends on its condition or
 * on its `timeoutSec`, whichever comes first, and then the robot does nothing for one physics step before the next
 * step starts, as a state machine that advances on its next loop does.
 */
import { defineLeaf, loadTree, t, TreeRunner, type Behavior, type CNode, type FnSpec, type Recorder, type Registry, type TreeDef } from '../bt';
import { seesRaisedCell } from '../sim/camera';
import { FIELD } from '../sim/config';
import { NO_INPUT, type Inputs, type IntakeFilter, type Sim } from '../sim/world';
import { pursue } from './follow';
import wallSweepRight from './trees/auto/wall-sweep-pair-right.json';
import wallSweepLeft from './trees/auto/wall-sweep-pair-left.json';
import laneSweepRight from './trees/auto/lane-sweep-pair-right.json';
import laneSweepLeftNoPark from './trees/auto/lane-sweep-pair-left-no-park.json';
import laneSweepLeft from './trees/auto/lane-sweep-pair-left.json';
import soloSweep from './trees/auto/solo-two-tip-sweep.json';
import soloSweepNoPark from './trees/auto/solo-two-tip-sweep-no-park.json';
import leaveAndPark from './trees/auto/leave-and-park.json';
import { fieldObstacles, planPath, type Capsule, type Pt } from './planner';

/**
 * A pose in the alliance frame: red's FIELD coordinates. x runs from the red wall (negative) to the blue wall, y from the
 * audience wall (negative) to the rear wall, in meters, and the heading is in degrees counterclockwise from +x. A blue
 * robot runs the same tree rotated 180° about the FIELD center, so every tree is written for red.
 */
const POSE = t.object({ x: t.number('m'), y: t.number('m'), headingDeg: t.number('deg') });
const CELL = t.enum('rear', 'audience');
const INTAKE = t.enum('all', 'pollen', 'own_nectar', 'none');
export interface Pose { x: number; y: number; headingDeg: number }

/** The fields that expressions in an AUTO tree can read. */
export const ONBOARD_SCHEMA = t.object({
  clock: t.object({
    /** Seconds left in the period. */
    remaining: t.number('s'),
    /** The physics step count, and the step length in seconds. AUTO leaves time their steps with them. */
    step: t.number(), dt: t.number('s'),
  }),
  field: t.object({ half: t.number('m'), flowerHalfSize: t.number('m') }),
  bots: t.object({ me: t.object({
    dimensions: t.object({ length: t.number('m'), width: t.number('m') }),
    shooter: t.object({ facing: t.enum('front', 'rear'), type: t.enum('catapult', 'fifo', 'dual') }),
    hopper: t.object({ count: t.number(), capacity: t.number(), full: t.boolean() }),
    slot: t.number(),
    /** The robot's pose from its odometry, in the alliance frame. */
    pose: POSE,
  }) }),
  sensors: t.object({ camera: t.object({ seesRaised: t.fn([CELL], t.boolean()) }) }),
});

/** Where an AUTO tree's output goes each step: the robot's inputs, and what the page and the tools show. */
export interface AutoOutput {
  inputs: Inputs;
  /** The planned path of the running drive, in FIELD coordinates. */
  path: Pt[];
  note: string;
  /** The kind and tag of the running step. `scripts/plan-sweeps.ts` looks for a wait tagged `sweep`. */
  step: { do: string; tag?: string } | null;
}

/** The onboard environment: the schema's fields, plus the subsystems that only leaves can use. */
export interface OnboardEnv {
  clock: { remaining: number; step: number; dt: number };
  field: { half: number; flowerHalfSize: number };
  bots: { me: {
    dimensions: { length: number; width: number };
    shooter: { facing: 'front' | 'rear'; type: 'catapult' | 'fifo' | 'dual' };
    hopper: { count: number; capacity: number; full: boolean };
    slot: number;
    pose: Pose;
    drive: DriveSubsystem; intake: IntakeSubsystem; launcher: { fireBoth(): void };
  } };
  sensors: { camera: { seesRaised(cell: 'rear' | 'audience'): boolean } };
  out: AutoOutput;
}

interface IntakeSubsystem {
  /** Runs the intake with `filter` for this physics step only. */
  set(filter: IntakeFilter): void;
  /** Runs the intake with `filter` from this physics step on, until the next `hold`. */
  hold(filter: IntakeFilter): void;
}

interface DriveSubsystem {
  /** Plans a path to a pose in the alliance's frame, around the FIELD elements and the AUTO center-line wall. */
  plan(goal: Pose): void;
  /** Sets the path to follow: from where the robot is, straight through `points` in the alliance frame, with no planner. */
  route(points: readonly { x: number; y: number }[]): void;
  /** Computes the command that follows the planned path and turns toward `headingDeg`, without sending it. */
  follow(headingDeg: number): { forward: number; strafeRight: number; turnRight: number; remaining: number; headingError: number };
  send(cmd: { forward: number; strafeRight: number; turnRight: number }): void;
  /** Pushes straight ahead at `power`, as a fraction of full power. */
  push(power: number): void;
  readonly speed: number;
}

/**
 * Converts a point in the alliance frame to the simulator's floor axes, which are three.js's x and z, where z is the
 * negative of FIELD y. `rotate` turns it 180° about the FIELD center, for a blue robot.
 */
export const simPoint = (p: { x: number; y: number }, rotate: boolean): Pt => (rotate ? { x: -p.x, z: p.y } : { x: p.x, z: -p.y });
/** Converts a heading in the alliance frame to the simulator's heading in radians. A blue robot's turns by 180°. */
export const simHeading = (headingDeg: number, rotate: boolean) => ((headingDeg + (rotate ? 180 : 0)) * Math.PI) / 180;
/** Converts a position and heading on the simulator's axes to a pose in the alliance frame. It undoes `simPoint` and `simHeading`. */
export const alliancePose = (p: Pt, heading: number, rotate: boolean): Pose => {
  const deg = (heading * 180) / Math.PI - (rotate ? 180 : 0);
  return { x: rotate ? -p.x : p.x, y: rotate ? p.z : -p.z, headingDeg: ((((deg + 180) % 360) + 360) % 360) - 180 };
};

/** The virtual wall on the FIELD center line. It keeps the robot's circumscribed circle on its own side (G402). */
export const centerWall = (rotate: boolean): Capsule => { const xw = (rotate ? -1 : 1) * 0.08; return { a: { x: xw, z: -2 }, b: { x: xw, z: 2 }, r: 0 }; };

/**
 * Builds the onboard environment over a robot's view of the simulator. `use` builds it for each step: nothing moves
 * while the planners run, so each field is read once per step.
 */
class OnboardAdapter implements OnboardEnv {
  out: AutoOutput = { inputs: { ...NO_INPUT }, path: [], note: '', step: null };
  /** The intake filter that `auto.intake` holds, or undefined before the first. The simulator runs an unset intake as `all`. */
  held: IntakeFilter | undefined;
  clock!: OnboardEnv['clock']; bots!: OnboardEnv['bots']; sensors!: OnboardEnv['sensors'];
  readonly field = { half: FIELD.half, flowerHalfSize: FIELD.flowerHalfSize };

  use(s: Sim, n: number, dt: number) {
    const out = this.out, rotate = s.alliance === 'blue';
    out.inputs = { ...NO_INPUT }; if (this.held) out.inputs.intake = this.held;
    this.clock = { remaining: s.timer, step: n, dt };
    // Rotated 180°, blue's rear CELL is where red's audience CELL is, so a tree's `rear` means red's rear.
    this.sensors = { camera: { seesRaised: cell => seesRaisedCell(s, rotate ? (cell === 'rear' ? 'audience' : 'rear') : cell) } };
    const drive: DriveSubsystem = {
      plan: goal => {
        const p = s.robot.translation(), R = Math.hypot(s.cfg.length, s.cfg.width) / 2;
        out.path = planPath({ x: p.x, z: p.z }, simPoint(goal, rotate), R, [...fieldObstacles(), centerWall(rotate)]);
      },
      route: points => { const p = s.robot.translation(); out.path = [{ x: p.x, z: p.z }, ...points.map(q => simPoint(q, rotate))]; },
      follow: headingDeg => pursue(s, out.path, simHeading(headingDeg, rotate)),
      send: cmd => { out.inputs.forward = cmd.forward; out.inputs.strafeRight = cmd.strafeRight; out.inputs.turnRight = cmd.turnRight; },
      push: power => { out.inputs.forward = power; },
      speed: s.telemetry.speed,
    };
    this.bots = { me: {
      dimensions: { length: s.cfg.length, width: s.cfg.width },
      shooter: { facing: s.cfg.shooter.facing, type: s.cfg.shooter.type },
      hopper: { count: s.carried.length, capacity: s.cfg.capacity, full: s.carried.length >= s.cfg.capacity },
      slot: s.slot,
      pose: alliancePose(s.robot.translation(), s.heading, rotate),
      drive, intake: { set: f => { out.inputs.intake = f; }, hold: f => { this.held = f; out.inputs.intake = f; } }, launcher: { fireBoth: () => { out.inputs.shootPollen = true; out.inputs.shootNectar = true; } },
    } };
  }
}

/** Experiment switches for AUTO, set from a script. */
export const AUTO_TUNING: {
  /** For scripts/plan-sweeps.ts: replace every sweep with a wait of this many seconds, then a wait tagged `sweep`. */
  sweepSnapshotDelay: number | null;
  /**
   * If true, the robot does nothing for one physics step after each AUTO step ends, as `ScriptRunner` did, and the next
   * step starts on the step after. If false, the next step starts in the same physics step. Default: true.
   */
  idleAfterStep: boolean;
  /**
   * The intake filter that AUTO starts with, until an `auto.intake` step sets one. Null leaves the intake input unset,
   * which the simulator runs as `all`, except in a step that sets the intake itself. Default: null.
   */
  intakeDefault: IntakeFilter | null;
} = { sweepSnapshotDelay: null, idleAfterStep: true, intakeDefault: null };

// ---- Step timing ----

/**
 * Times one step. The step started on the step before its first update, as it did in `ScriptRunner`, so its time on
 * its first update is one step length. `over(sec)` is true once the step has run more than `sec` seconds.
 */
function stepTimer(e: OnboardEnv) {
  const start = e.clock.step - 1;
  return { over: (sec: number) => (e.clock.step - start) * e.clock.dt > sec + 1e-9 };
}
/** Ends a step: the robot does nothing for this physics step, and the next step starts on the next one. See `AUTO_TUNING`. */
function* idle(): Behavior<null> { if (AUTO_TUNING.idleAfterStep) yield; return null; }
const stepName = (path: string) => { const id = path.split('/').pop() ?? ''; const m = /^s(\d+)$/.exec(id); return m ? `step ${m[1]}` : id; };
const begin = (e: OnboardEnv, path: string, kind: string, tag?: string) => { e.out.note = `${stepName(path)}: ${kind}`; e.out.step = tag ? { do: kind, tag } : { do: kind }; };

/**
 * Drives to a pose and turns to its heading. It ends on arrival, on a full hopper if `untilFull`, or on its timeout.
 * With an `intake` filter, it runs the intake with that filter on each step. With null, it leaves the intake as it is.
 */
function* driveStep(e: OnboardEnv, pose: Pose, intake: IntakeFilter | null, untilFull: boolean, timeoutSec: number): Behavior<null> {
  const timer = stepTimer(e), me = () => e.bots.me; let plannedAt = -1; // `me` is rebuilt each step.
  for (;;) {
    if (timer.over(timeoutSec)) return yield* idle();
    if (untilFull && me().hopper.full) return yield* idle();
    // The robot replans every 0.15 s, which is 36 steps at 240 steps per second.
    if (plannedAt < 0 || (e.clock.step - plannedAt) * e.clock.dt >= 0.15 - 1e-9) { me().drive.plan(pose); plannedAt = e.clock.step; }
    const cmd = me().drive.follow(pose.headingDeg);
    if (cmd.remaining < 0.05 && Math.abs(cmd.headingError) < 0.05 && me().drive.speed < 0.15) return yield* idle();
    me().drive.send(cmd); if (intake) me().intake.set(intake);
    yield;
  }
}

/** Waits `timeoutSec`, or less if `unlessFull` and the hopper is full. */
function* waitStep(e: OnboardEnv, timeoutSec: number, unlessFull: boolean): Behavior<null> {
  const timer = stepTimer(e);
  for (;;) { if (timer.over(timeoutSec) || (unlessFull && e.bots.me.hopper.full)) return yield* idle(); yield; }
}

const leaf = defineLeaf<OnboardEnv>();
const NEEDS_CAMERA = ['sensors.camera'];

const drive = leaf({
  id: 'auto.drive', version: 1, uses: ['drive', 'intake'],
  doc: 'Drives to a pose and turns to its heading, with the intake set to `intake`. It ends on arrival, on a full hopper if `untilFull`, or after `timeoutSec`.',
  params: {
    pose: { type: POSE, doc: 'The goal, in the alliance frame.' },
    intake: { type: INTAKE, default: 'none' },
    untilFull: { type: t.boolean(), default: false, doc: 'If true, ends the step as soon as the hopper is full.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's' },
    tag: { type: t.string(), default: '', doc: 'A label for tools.' },
  },
  *run(ctx) { const p = ctx.params; begin(ctx.env, ctx.path, 'drive', p.tag || undefined); return yield* driveStep(ctx.env, p.pose, p.intake, p.untilFull, p.timeoutSec); },
});

const sweep = leaf({
  id: 'auto.sweep', version: 1, uses: ['drive', 'intake'],
  doc: 'Drives a list of lanes with the intake leading, each as its own drive step that ends when the hopper is full. A lane with a wall name strafes along that wall with the intake facing it. `scripts/plan-sweeps.ts` writes the lanes.',
  params: {
    from: { type: POSE, doc: 'Where the sweep starts. It sets the first lane\'s heading and timeout.' },
    role: { type: t.enum('solo', 'right', 'left'), doc: 'Which of the planned lane sets `scripts/plan-sweeps.ts` writes into `lanes`.' },
    lanes: { type: t.array(t.object({ x: t.number('m'), y: t.number('m'), wall: t.nullable(t.enum('rear', 'audience', 'red')) })), doc: 'The lane ends, in the alliance frame.' },
  },
  *run(ctx) {
    const e = ctx.env;
    if (AUTO_TUNING.sweepSnapshotDelay !== null) {
      begin(e, ctx.path, 'wait'); yield* waitStep(e, AUTO_TUNING.sweepSnapshotDelay, false);
      begin(e, ctx.path, 'wait', 'sweep'); return yield* waitStep(e, 30, false);
    }
    const facing = { rear: 90, audience: -90, red: 180 } as const;
    let at = { x: ctx.params.from.x, y: ctx.params.from.y };
    for (const [i, lane] of ctx.params.lanes.entries()) {
      const { x, y, wall } = lane, dist = Math.hypot(x - at.x, y - at.y);
      const headingDeg = wall ? facing[wall] : (Math.atan2(y - at.y, x - at.x) * 180) / Math.PI; at = { x, y };
      begin(e, ctx.path, 'drive', i === 0 ? 'sweep' : undefined);
      yield* driveStep(e, { x, y, headingDeg }, 'all', true, dist / 1.1 + 1.2);
    }
    return null;
  },
});

const WAYPOINT = t.object({ x: t.number('m'), y: t.number('m'), headingDeg: t.nullable(t.number('deg')) });
const driveTo = leaf({
  id: 'auto.driveTo', version: 1, uses: ['drive'],
  doc: 'Drives to a pose on a path that the path planner picks around the FIELD elements and the AUTO center-line wall, and turns to the pose\'s heading. It ends on arrival or after `timeoutSec`. It leaves the intake as it is.',
  params: {
    pose: { type: POSE, doc: 'The goal, in the alliance frame.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's' },
    tag: { type: t.string(), default: '', doc: 'A label for tools.' },
  },
  *run(ctx) { const p = ctx.params; begin(ctx.env, ctx.path, 'drive', p.tag || undefined); return yield* driveStep(ctx.env, p.pose, null, false, p.timeoutSec); },
});

/** Where a follower moves on to the next waypoint: within this distance of it, in meters, or past it along the path. */
const WAYPOINT_REACHED = 0.15;
const followPath = leaf({
  id: 'auto.followPath', version: 1, uses: ['drive'],
  doc: 'Follows the path through `waypoints` in order, with no path planner: straight lines from where the robot starts, and through each waypoint without stopping. A waypoint with a heading turns the robot to it; one without faces along the path, so the intake leads. It ends at the last waypoint or after `timeoutSec`. It leaves the intake as it is.',
  params: {
    waypoints: { type: t.array(WAYPOINT), doc: 'The path, in the alliance frame. `scripts/plan-sweeps.ts` writes the waypoints of a path tagged `sweep-ROLE`.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's' },
    tag: { type: t.string(), default: '', doc: 'A label for tools. `scripts/plan-sweeps.ts` finds its sweeps by the tags `sweep-solo`, `sweep-right`, and `sweep-left`.' },
  },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, me = () => e.bots.me; // `me` is rebuilt each step.
    if (AUTO_TUNING.sweepSnapshotDelay !== null && p.tag.startsWith('sweep')) {
      begin(e, ctx.path, 'wait'); yield* waitStep(e, AUTO_TUNING.sweepSnapshotDelay, false);
      begin(e, ctx.path, 'wait', 'sweep'); return yield* waitStep(e, 30, false);
    }
    const wps = p.waypoints; if (!wps.length) return null;
    begin(e, ctx.path, 'follow', p.tag || undefined);
    const timer = stepTimer(e), start = { x: me().pose.x, y: me().pose.y };
    const prev = (i: number) => (i === 0 ? start : wps[i - 1]);
    const headings = wps.map((w, i) => w.headingDeg ?? (Math.atan2(w.y - prev(i).y, w.x - prev(i).x) * 180) / Math.PI);
    let k = 0; me().drive.route(wps);
    for (;;) {
      if (timer.over(p.timeoutSec)) return yield* idle();
      for (;;) {
        if (k >= wps.length - 1) break;
        const here = me().pose, a = prev(k), b = wps[k], ux = b.x - a.x, uy = b.y - a.y, l2 = ux * ux + uy * uy;
        const passed = l2 > 0 && ((here.x - a.x) * ux + (here.y - a.y) * uy) / l2 >= 1;
        if (!passed && Math.hypot(here.x - b.x, here.y - b.y) >= WAYPOINT_REACHED) break;
        k++; me().drive.route(wps.slice(k));
      }
      const cmd = me().drive.follow(headings[k]);
      if (k === wps.length - 1 && cmd.remaining < 0.05 && Math.abs(cmd.headingError) < 0.05 && me().drive.speed < 0.15) return yield* idle();
      me().drive.send(cmd); yield;
    }
  },
});

const intake = leaf({
  id: 'auto.intake', version: 1, uses: ['intake'],
  doc: 'Sets the intake filter, which holds until the next `auto.intake`. It ends at once, in the same physics step. To turn the intake off however a part of the tree ends, put this leaf with `none` in the cleanup of an `ensure` node.',
  params: { filter: { type: INTAKE } },
  *run(ctx) { ctx.env.bots.me.intake.hold(ctx.params.filter); return null; },
});

const waitHopperFull = leaf({
  id: 'auto.waitHopperFull', version: 1,
  doc: 'Waits until the hopper is full. Race it against a drive or a path with a `parallel` node of policy `any`, before the drive, so that the race ends in the step that the hopper fills.',
  params: {},
  *run(ctx) { for (;;) { if (ctx.env.bots.me.hopper.full) return null; yield; } },
});

const push = leaf({
  id: 'auto.push', version: 1, uses: ['drive', 'intake'],
  doc: 'Pushes straight ahead with the intake on, for example against the bottom of a FLOWER. It ends when the hopper is full or after `timeoutSec`.',
  params: { power: { type: t.number(), min: -1, max: 1 }, intake: { type: INTAKE }, timeoutSec: { type: t.number('s'), min: 0, unit: 's' } },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, timer = stepTimer(e); begin(e, ctx.path, 'push');
    for (;;) {
      if (timer.over(p.timeoutSec) || e.bots.me.hopper.full) return yield* idle();
      e.bots.me.drive.push(p.power); e.bots.me.intake.set(p.intake); yield;
    }
  },
});

const shoot = leaf({
  id: 'auto.shoot', version: 1, uses: ['launcher'],
  doc: 'Launches open loop from where the robot stands until `count` elements are gone or the hopper is empty. With `cell`, it holds its fire until the camera sees that CELL raised.',
  params: { count: { type: t.number(), min: 1 }, timeoutSec: { type: t.number('s'), min: 0, unit: 's' }, cell: { type: t.nullable(CELL), default: null } },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, timer = stepTimer(e); let startCount = -1; begin(e, ctx.path, 'shoot');
    for (;;) {
      if (timer.over(p.timeoutSec)) return yield* idle();
      if (p.cell && !e.sensors.camera.seesRaised(p.cell)) { yield; continue; }
      if (startCount < 0) startCount = e.bots.me.hopper.count;
      if (e.bots.me.hopper.count === 0 || startCount - e.bots.me.hopper.count >= p.count) return yield* idle();
      e.bots.me.launcher.fireBoth(); yield;
    }
  },
});

const waitCell = leaf({
  id: 'auto.waitCell', version: 1, needs: NEEDS_CAMERA,
  doc: 'Waits until the camera sees the AprilTags of `cell` in the raised position. The robot must be near its launch spot, with the shooter side toward the HIVE.',
  params: { cell: { type: CELL }, timeoutSec: { type: t.number('s'), min: 0, unit: 's' } },
  *run(ctx) {
    const e = ctx.env, timer = stepTimer(e); begin(e, ctx.path, 'waitCell');
    for (;;) { if (timer.over(ctx.params.timeoutSec) || e.sensors.camera.seesRaised(ctx.params.cell)) return yield* idle(); yield; }
  },
});

const waitTip = leaf({
  id: 'auto.waitTip', version: 1, needs: NEEDS_CAMERA,
  doc: 'Waits until `cell` tips: the camera saw it raised, and then no longer sees it raised. A CELL that isn\'t seen raised after 1 s counts as already tipping.',
  params: { cell: { type: CELL }, timeoutSec: { type: t.number('s'), min: 0, unit: 's' } },
  *run(ctx) {
    const e = ctx.env, timer = stepTimer(e), cell = ctx.params.cell; let sawRaised = false; begin(e, ctx.path, 'waitTip');
    for (;;) {
      if (timer.over(ctx.params.timeoutSec)) return yield* idle();
      if (e.sensors.camera.seesRaised(cell)) sawRaised = true;
      if ((sawRaised || timer.over(1)) && !e.sensors.camera.seesRaised(cell)) return yield* idle();
      yield;
    }
  },
});

const wait = leaf({
  id: 'auto.wait', version: 1,
  doc: 'Waits `timeoutSec`. With `unlessFull`, a full hopper ends the wait, for a wait whose only purpose is a pickup that follows.',
  params: { timeoutSec: { type: t.number('s'), min: 0, unit: 's' }, unlessFull: { type: t.boolean(), default: false }, tag: { type: t.string(), default: '' } },
  *run(ctx) { begin(ctx.env, ctx.path, 'wait', ctx.params.tag || undefined); return yield* waitStep(ctx.env, ctx.params.timeoutSec, ctx.params.unlessFull); },
});

const waitClock = leaf({
  id: 'auto.waitClock', version: 1,
  doc: 'Waits until the period clock shows `clockSec` or less. Partners use it to take turns.',
  params: { clockSec: { type: t.number('s'), unit: 's' }, timeoutSec: { type: t.number('s'), min: 0, unit: 's' } },
  *run(ctx) {
    const e = ctx.env, timer = stepTimer(e); begin(e, ctx.path, 'waitUntil');
    for (;;) { if (timer.over(ctx.params.timeoutSec) || e.clock.remaining <= ctx.params.clockSec) return yield* idle(); yield; }
  },
});

const clockAtMost = leaf({
  id: 'auto.clockAtMost', version: 1,
  doc: 'Succeeds as soon as the period clock shows `sec` or less. It isn\'t a step: it has no timeout and no idle step. An AUTO tree races it against its steps, so that the last step starts in time.',
  params: { sec: { type: t.number('s'), unit: 's' } },
  *run(ctx) { while (ctx.env.clock.remaining > ctx.params.sec) yield; return null; },
});

const FNS: Record<string, FnSpec> = {
  pose: { args: [t.number(), t.number(), t.number()], returns: POSE, impl: (x: number, y: number, headingDeg: number) => ({ x, y, headingDeg }) },
  // offset(p, dx, dy) moves a pose, and a fourth value turns it by that many degrees. The field editor writes it.
  offset: { args: [POSE, t.number(), t.number(), t.number()], required: 3, returns: POSE, impl: (p: Pose, dx: number, dy: number, dh?: number) => ({ x: p.x + dx, y: p.y + dy, headingDeg: dh === undefined ? p.headingDeg : p.headingDeg + dh }) },
};

export const AUTO_REGISTRY: Registry = {
  envs: { onboard: ONBOARD_SCHEMA },
  leaves: Object.fromEntries([drive, sweep, driveTo, followPath, intake, waitHopperFull, push, shoot, waitCell, waitTip, wait, waitClock, clockAtMost].map(l => [l.id, l])),
  fns: FNS,
};

// ---- Trees ----

/** The AUTO tree files in the order of the page's AUTO list. The catalog in D1 is seeded from them. */
export const AUTO_FILES: readonly unknown[] = [wallSweepRight, wallSweepLeft, laneSweepRight, laneSweepLeftNoPark, laneSweepLeft, soloSweep, soloSweepNoPark, leaveAndPark];
const trees: Record<string, TreeDef> = {}, sources: Record<string, Record<string, unknown>> = {}, builtIn = new Set<string>();
/** The AUTO trees by id: the tree files, then the trees that `addAutoTree` adds. A tree file that doesn't load throws with all of its problems. */
export const AUTO_TREES: Readonly<Record<string, TreeDef>> = trees;
/** The JSON source of each AUTO tree, by id, for the field editor, which edits a copy. */
export const AUTO_SOURCES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = sources;
/** The ids of the tree files. `removeAutoTree` can't remove them. */
export const BUILT_IN_AUTO: ReadonlySet<string> = builtIn;
for (const src of AUTO_FILES) builtIn.add(addAutoTree(src).id);

/**
 * Loads an AUTO tree and adds it to `AUTO_TREES`, or replaces the tree that has its id. The page adds the trees that
 * the field editor saves. A tree with a tree file's id can't replace that file.
 * @throws TreeLoadError If the tree doesn't load, with all of its problems.
 */
export function addAutoTree(src: unknown): TreeDef {
  const def = loadTree(src, AUTO_REGISTRY);
  if (builtIn.has(def.id)) throw new Error(`the tree '${def.id}' is built in and can't be replaced`);
  trees[def.id] = def; sources[def.id] = structuredClone(src as Record<string, unknown>);
  return def;
}

/** Removes an AUTO tree that `addAutoTree` added. Returns false for a built-in tree or an unknown id. */
export function removeAutoTree(id: string): boolean {
  if (builtIn.has(id) || !(id in trees)) return false;
  delete trees[id]; delete sources[id]; return true;
}

/** The default AUTO for a robot with no partner, and for a name that no tree has. */
export const SOLO_AUTO = 'solo-two-tip-sweep';

/** Gets where an AUTO tree starts: `right`, `left`, or `any`. The page lists only the trees for a robot's start position. */
export const autoStart = (def: TreeDef): 'right' | 'left' | 'any' => (def.meta.start === 'right' || def.meta.start === 'left' ? def.meta.start : 'any');

/**
 * Gets the AUTO tree for a robot. With a partner, the default is the wall-sweep pair: the right robot (slot 0) runs its
 * right half and the left robot (slot 1) its left half. Over 24 seeds, the right half scores 177 combined AUTO points
 * with its partner, where the lane-sweep pair's right robot scores 151.
 * @param selected The robot's AUTO setting. `SOLO_AUTO` means the default.
 */
export function autoFor(sim: Sim, selected: string): string {
  if (!sim.partner()) return selected;
  return sim.slot === 1 ? 'wall-sweep-pair-left' : selected === SOLO_AUTO ? 'wall-sweep-pair-right' : selected;
}

/** Runs one robot's AUTO tree. Call `update` once per physics step in AUTO. */
export class AutoProgram {
  private readonly env = new OnboardAdapter();
  private readonly runner: TreeRunner<OnboardEnv>;
  private n = 0;

  /** @param recorder If given, records a span each time a node runs, for the tree view and the match trace. */
  constructor(readonly def: TreeDef, readonly recorder?: Recorder) {
    this.env.held = AUTO_TUNING.intakeDefault ?? undefined;
    this.runner = new TreeRunner(def, { env: this.env, now: () => this.n * this.dt, recorder });
  }
  private dt = 0;

  get path(): Pt[] { return this.env.out.path; }
  get note(): string { return this.env.out.note; }
  get step(): AutoOutput['step'] { return this.env.out.step; }

  update(sim: Sim, dt: number): Inputs {
    this.n++; this.dt = dt; this.env.use(sim, this.n, dt);
    const s = this.runner.step();
    if (s.state === 'running') return this.env.out.inputs;
    this.env.out.path = []; this.env.out.step = null;
    this.env.out.note = s.state === 'error' ? `AUTO error: ${String((s.error as Error)?.message ?? s.error)}` : 'script finished';
    return NO_INPUT;
  }
}

/**
 * Gets a tree's leaves in step order, each with its parameters as they are before the match for the robot that `sim`
 * views. A parameter that reads the clock, the hopper, or the camera gets its pre-match value.
 */
export function leafParams(def: TreeDef, sim: Sim): { node: CNode; params: Record<string, unknown> }[] {
  const env = new OnboardAdapter(); env.use(sim, 0, 0);
  const runner = new TreeRunner(def, { env, now: () => 0 }), out: { node: CNode; params: Record<string, unknown> }[] = [];
  const walk = (n: CNode) => { if (n.leaf) out.push({ node: n, params: runner.paramsOf(n)! }); n.children.forEach(walk); }; walk(def.root);
  return out;
}

/**
 * Gets an AUTO tree's whole trajectory before the match: the planned path through every drive pose, and the poses.
 * It follows the tree's steps in order and skips the race against the clock, so it shows the path of a full AUTO.
 * The plan uses only fixed FIELD geometry, so it is known before the MATCH, like a real AUTO path.
 */
export function previewAuto(def: TreeDef, sim: Sim, start: Pt): { path: Pt[]; poses: (Pt & { heading: number; shoots: boolean })[] } {
  const rotate = sim.alliance === 'blue', R = Math.hypot(sim.cfg.length, sim.cfg.width) / 2;
  const leaves = leafParams(def, sim);
  const goals: { pose: Pose; next: CNode | undefined }[] = [];
  leaves.forEach(({ node: n, params: p }, i) => {
    if (n.label === 'auto.drive') goals.push({ pose: p.pose as Pose, next: leaves[i + 1]?.node });
    if (n.label === 'auto.sweep') {
      const facing = { rear: 90, audience: -90, red: 180 } as const, from = p.from as Pose; let at = { x: from.x, y: from.y };
      for (const l of p.lanes as { x: number; y: number; wall: keyof typeof facing | null }[]) {
        goals.push({ pose: { x: l.x, y: l.y, headingDeg: l.wall ? facing[l.wall] : (Math.atan2(l.y - at.y, l.x - at.x) * 180) / Math.PI }, next: undefined }); at = { x: l.x, y: l.y };
      }
    }
  });
  const path: Pt[] = [start], poses: (Pt & { heading: number; shoots: boolean })[] = []; let at = start;
  for (const { pose, next } of goals) {
    const goal = simPoint(pose, rotate);
    path.push(...planPath(at, goal, R, [...fieldObstacles(), centerWall(rotate)]).slice(1)); at = goal;
    poses.push({ ...goal, heading: simHeading(pose.headingDeg, rotate), shoots: next?.label === 'auto.shoot' });
  }
  return { path, poses };
}
