/**
 * TELEOP as a behavior tree: the driver environment, the TELEOP leaves, and `TeleopProgram`, which runs one robot's
 * TELEOP tree. See docs/behavior-trees.md.
 *
 * The driver environment models a drive team that watches the whole FIELD. This version holds what the default tree
 * reads: the clock, the robot's config, hopper, tactic, and launch state, which tactics can make progress now, the
 * values that the endgame decision weighs, whether the partner lines up first, and an opponent that is lined up to
 * launch nearby.
 *
 * The tactic leaves drive one shared `Executor`, which keeps its state across tactics, as it did under the coach. A
 * tactic leaf ends when the executor reports that the tactic is done or blocked, on the step after it reports it.
 * Either way the leaf succeeds, so the tree decides again from the top, as the coach did.
 */
import { defineLeaf, loadTree, t, TreeRunner, type Registry, type TreeDef } from '../bt';
import { NO_INPUT, type Inputs, type Sim } from '../sim/world';
import { Defender } from './defend';
import { POINTS } from '../sim/config';
import { TACTICS, linedUpOpponent, parkLeadSec, type Executor, type FlowerId, type Tactic } from './executor';
import { available, flowerStep } from './policy';
import teleopDefault from './trees/teleop-default.json';

/** The fields that expressions in a TELEOP tree can read. */
export const DRIVER_SCHEMA = t.object({
  clock: t.object({ remaining: t.number('s') }),
  config: t.object({
    /** FLOWER work starts when this many seconds remain in TELEOP. 0 means TIPS only. */
    flowerStartSec: t.number('s'),
    defense: t.enum('none', 'full', 'opportunistic'),
  }),
  bots: t.object({ me: t.object({
    hopper: t.object({ count: t.number(), capacity: t.number() }),
    /** The executor's tactic now, which the tree chose last. */
    tactic: t.enum(...TACTICS),
    /** True in a TIP's launch phase with something to launch. A bump replaces launching then. */
    launching: t.boolean(),
    /** True once the endgame chose a last launch. */
    lastLaunchStarted: t.boolean(),
  }) }),
  partner: t.object({
    /** True when this robot should hold still so that its partner lines up first. See `Executor.partnerLinesUpFirst`. */
    linesUpFirst: t.boolean(),
  }),
  opponents: t.object({
    /** The first opponent that stands on its launch spot within 1 m of this robot with a load: about to launch. */
    linedUpNear: t.nullable(t.object({ slot: t.number(), distance: t.number('m') })),
  }),
  /** The values that the endgame decision weighs. Each is computed when a tree reads it. */
  endgame: t.object({
    /** The seconds that the PARK needs: the drive to the LOADING ZONE plus a margin. The endgame starts then. */
    parkLeadSec: t.number('s'),
    /** The points from launching what the robot carries: 20 for a TIP that finishes in time, or 2 per element that stays in the CELL. */
    launchValue: t.number(),
    parkPoints: t.number(),
    /** Whether the alliance still needs this robot's PARK for the SWARM ranking point. A playoff MATCH has none. */
    parkNeededForSwarm: t.boolean(),
  }),
  /** Whether a tactic can make progress now. Each is computed when a tree reads it. */
  available: t.object({
    /** A FLOWER action, or the pickup that the next one needs. See `flowerStep`. */
    flowerWork: t.boolean(),
    /** A TIP: the robot carries POLLEN, or can collect POLLEN or own NECTAR. See `available`. */
    tipHive: t.boolean(),
  }),
});

/** What a TELEOP tree's leaves can use, beyond the schema's fields. */
export interface DriverEnv {
  clock: { remaining: number };
  config: { flowerStartSec: number; defense: 'none' | 'full' | 'opportunistic' };
  bots: { me: { hopper: { count: number; capacity: number }; tactic: Tactic; readonly launching: boolean; lastLaunchStarted: boolean } };
  partner: { readonly linesUpFirst: boolean };
  opponents: { readonly linedUpNear: { slot: number; distance: number } | null };
  available: { readonly flowerWork: boolean; readonly tipHive: boolean };
  endgame: { readonly parkLeadSec: number; readonly launchValue: number; readonly parkPoints: number; readonly parkNeededForSwarm: boolean };
  executor: Executor;
  sim: Sim;
  /** Runs the executor for this physics step, and records its inputs. Call it once per step. See `Executor.update` for `mode`. */
  runExecutor(mode?: 'normal' | 'park' | 'lastLaunch' | 'bump' | 'yield', bumpSlot?: number): void;
  /** Runs the full-time defender for this physics step, and records its inputs. */
  runDefender(): void;
  inputs: Inputs;
}

/** The robot settings that a TELEOP tree reads, and the executor and defender that its leaves drive. */
export interface DriverHost { executor: Executor; defender: Defender; flowerStartSec: number; defense: 'none' | 'full' | 'opportunistic' }

class DriverAdapter implements DriverEnv {
  sim!: Sim; inputs: Inputs = NO_INPUT; private dt = 0;
  clock!: DriverEnv['clock']; config!: DriverEnv['config']; bots!: DriverEnv['bots']; available!: DriverEnv['available']; endgame!: DriverEnv['endgame'];
  opponents!: DriverEnv['opponents']; partner!: DriverEnv['partner'];
  constructor(private readonly host: DriverHost) {}
  get executor() { return this.host.executor; }

  use(sim: Sim, dt: number) {
    const host = this.host, ex = host.executor;
    this.sim = sim; this.dt = dt; this.inputs = NO_INPUT;
    this.clock = { remaining: sim.timer };
    this.config = { flowerStartSec: host.flowerStartSec, defense: host.defense };
    this.bots = { me: { hopper: { count: sim.carried.length, capacity: sim.cfg.capacity }, tactic: ex.tactic, get launching() { return ex.launchingNow(sim); }, lastLaunchStarted: ex.lastLaunchStarted } };
    this.partner = { get linesUpFirst() { return ex.partnerLinesUpFirst(sim); } };
    this.opponents = {
      get linedUpNear() {
        const o = linedUpOpponent(sim); if (!o) return null;
        const p = sim.robot.translation(); return { slot: o.slot, distance: Math.hypot(o.x - p.x, o.z - p.z) };
      },
    };
    this.available = {
      get flowerWork() { return flowerStep(sim, null, ex.avoidedFlowers()) !== null; },
      get tipHive() { return available(sim, 'tip_hive'); },
    };
    this.endgame = {
      get parkLeadSec() { return parkLeadSec(sim); },
      get launchValue() { return ex.launchValue(sim); },
      parkPoints: POINTS.park,
      get parkNeededForSwarm() { return ex.parkNeededForSwarm(sim); },
    };
  }

  runExecutor(mode: 'normal' | 'park' | 'lastLaunch' | 'bump' | 'yield' = 'normal', bumpSlot = -1) {
    const ex = this.host.executor;
    ex.nectarReserve = this.sim.timer < 75 ? 1 : 0; // Near the endgame, always keep a NECTAR for a FLOWER cap.
    this.inputs = ex.update(this.sim, this.dt, mode, bumpSlot);
  }

  runDefender() { this.inputs = this.host.defender.update(this.sim, this.dt); }
}

const leaf = defineLeaf<DriverEnv>();
const ALL = ['drive', 'intake', 'launcher', 'placer'];

const defend = leaf({
  id: 'teleop.defend', version: 1, uses: ALL,
  doc: 'Plays full-time defense for the rest of the period. See `Defender` in src/auto/defend.ts.',
  params: {},
  *run(ctx) { for (;;) { ctx.env.runDefender(); yield; } },
});

const tactic = leaf({
  id: 'teleop.tactic', version: 1, uses: ALL,
  doc: 'Runs one executor tactic until the executor reports it done or blocked. It succeeds with that status.',
  params: { tactic: { type: t.enum(...TACTICS) }, flower: { type: t.nullable(t.enum('rear', 'audience', 'red', 'blue')), default: null } },
  *run(ctx) {
    const e = ctx.env, ex = e.executor;
    ex.setTactic(ctx.params.tactic, ctx.params.flower as FlowerId | null); e.runExecutor();
    for (;;) { yield; if (ex.status !== 'in_progress') return ex.status; e.runExecutor(); }
  },
});

const flowerWork = leaf({
  id: 'teleop.flowerWork', version: 1, uses: ALL,
  doc: 'Works FLOWERS: it runs the tactic that `flowerStep` picks, and picks again once per second, on the same schedule as a fallback that rechecks once per second. It succeeds when the tactic is done or blocked.',
  params: {},
  *run(ctx) {
    const e = ctx.env, ex = e.executor;
    const decide = () => { const d = flowerStep(e.sim, null, ex.avoidedFlowers()); if (d) ex.setTactic(d.tactic, d.flower); };
    decide(); e.runExecutor(); let decidedAt = ctx.now();
    for (;;) {
      yield;
      if (ex.status !== 'in_progress') return ex.status;
      if (ctx.now() - decidedAt >= 1 - 1e-9) { decide(); decidedAt = ctx.now(); }
      e.runExecutor();
    }
  },
});

const lastLaunch = leaf({
  id: 'teleop.lastLaunch', version: 1, uses: ALL,
  doc: 'The endgame\'s launch: the robot launches everything that it carries, keeps no NECTAR in reserve, and doesn\'t go back to collecting, for the rest of the MATCH. It runs until a parent halts it.',
  params: {},
  *run(ctx) { for (;;) { ctx.env.runExecutor('lastLaunch'); yield; } },
});

const parkNow = leaf({
  id: 'teleop.parkNow', version: 1, uses: ALL,
  doc: 'The endgame\'s PARK: the robot drives to its end of the LOADING ZONE and stops there. It doesn\'t change the tactic, so that a later step can still choose a last launch. It runs until a parent halts it.',
  params: {},
  *run(ctx) { for (;;) { ctx.env.runExecutor('park'); yield; } },
});

const bump = leaf({
  id: 'teleop.bump', version: 1, uses: ALL,
  doc: 'Opportunistic defense: in a TIP\'s launch phase, the robot drives straight into the opponent that is lined up to launch next to it, which knocks it off its aim, and holds its own fire. It runs until a parent halts it.',
  params: {},
  *run(ctx) { for (;;) { ctx.env.runExecutor('bump', ctx.env.opponents.linedUpNear?.slot ?? -1); yield; } },
});

const yieldLeaf = leaf({
  id: 'teleop.yield', version: 1, uses: ALL,
  doc: 'Holds still in a TIP\'s launch phase, so that the partner lines up on its launch spot first. It runs until a parent halts it.',
  params: {},
  *run(ctx) { for (;;) { ctx.env.runExecutor('yield'); yield; } },
});

export const DRIVER_REGISTRY: Registry = { envs: { driver: DRIVER_SCHEMA }, leaves: Object.fromEntries([defend, tactic, flowerWork, lastLaunch, parkNow, bump, yieldLeaf].map(l => [l.id, l])) };

/** The TELEOP tree files. The catalog in D1 is seeded from them. */
export const TELEOP_FILES: readonly unknown[] = [teleopDefault];
/** The TELEOP trees by id, loaded and checked once. */
export const TELEOP_TREES: Readonly<Record<string, TreeDef>> = Object.fromEntries(TELEOP_FILES.map(src => { const def = loadTree(src, DRIVER_REGISTRY); return [def.id, def]; }));

/** Runs one robot's TELEOP tree. Call `update` once per physics step in TELEOP. */
export class TeleopProgram {
  private readonly env: DriverAdapter;
  private readonly runner: TreeRunner<DriverEnv>;
  private n = 0; private dt = 0;

  constructor(readonly def: TreeDef, host: DriverHost) {
    this.env = new DriverAdapter(host);
    this.runner = new TreeRunner(def, { env: this.env, now: () => this.n * this.dt });
  }

  /** The error that stopped the tree, if a leaf or the host threw one. The robot then gets no input. */
  error: unknown = null;

  update(sim: Sim, dt: number): Inputs {
    this.n++; this.dt = dt; this.env.use(sim, dt);
    const s = this.runner.step();
    if (s.state === 'error' && this.error === null) { this.error = s.error; console.error('TELEOP tree stopped:', s.error); }
    return s.state === 'running' ? this.env.inputs : NO_INPUT;
  }
}
