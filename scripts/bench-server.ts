// Runs the simulator headless for the native bench app (bench/). It reads one JSON command per line on stdin and writes
// one JSON message per line on stdout. Each robot has a driver: the planner (its Coach, as on the web page), fixed
// inputs, or a go-to-pose that plans around the FIELD elements and follows the path with the planner's own follower.
// Run: npx tsx scripts/bench-server.ts. The protocol is in bench/PROTOCOL.md.
import RAPIER from '@dimforge/rapier3d-compat';
import readline from 'node:readline';
import { Coach } from '../src/auto/coach';
import { pursue } from '../src/auto/follow';
import { planPath, type Pt } from '../src/auto/planner';
import type { CNode, TreeDef } from '../src/bt';
import { Referee } from '../src/ref/referee';
import { defaultBot, robotConfig, sanitize, type BotSetup } from '../src/setup';
import { FIELD, HIVE } from '../src/sim/config';
import { cameraSightings } from '../src/sim/camera';
import { DT, NO_INPUT, Sim, type Inputs, type IntakeFilter, type MatchMode } from '../src/sim/world';

await RAPIER.init();

type Driver =
  | { kind: 'planner' }
  | { kind: 'inputs'; inputs: Inputs }
  | { kind: 'goto'; goal: { x: number; z: number; heading: number | null }; intake: IntakeFilter; path: Pt[] };

const KIND = { pollen: 0, nectar_red: 1, nectar_blue: 2 } as const;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

let currentSeed = 1, sim: Sim, coaches: Coach[], drivers: Driver[], referee: Referee | null, seen: WeakSet<object>, treeSeen: number[], treeRef: unknown[];

function reset(seed: number, mode: MatchMode, given: Partial<BotSetup>[], ref: boolean) {
  currentSeed = seed;
  const bots = [0, 1, 2, 3].map(i => sanitize({ ...defaultBot(i), ...(given[i] ?? {}) }, i));
  sim = new Sim(RAPIER, undefined, mode, seed, { opponent: true, partners: true, configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) });
  coaches = sim.robots.map((_, i) => { const c = new Coach(); c.flowerStartSec = bots[i].flowerStartSec; c.defense = bots[i].defense; c.traceTrees = true; return c; });
  drivers = sim.robots.map(() => ({ kind: 'planner' }));
  referee = ref ? new Referee() : null; seen = new WeakSet(); treeSeen = sim.robots.map(() => 0); treeRef = sim.robots.map(() => null);
  send({ type: 'field', ...field(bots) });
}

/** The parts of the setup that don't change during a MATCH. */
function field(bots: BotSetup[]) {
  return {
    half: FIELD.half, wallHeight: FIELD.wallHeight, pollenRadius: FIELD.pollenRadius, nectarRadius: FIELD.nectarRadius,
    loadingZone: FIELD.loadingZone, garden: FIELD.garden, flowerHalfSize: FIELD.flowerHalfSize,
    flowers: sim.flowers.map(f => ({ id: f.id, x: f.x, z: f.z })),
    hive: { pivotY: HIVE.pivotY, pivotX: HIVE.pivotX, tiltLimit: HIVE.tiltLimit, cellBack: HIVE.cellBack, cellMouth: HIVE.cellMouth, cellHalfWidth: HIVE.cellHalfWidth, footBar: HIVE.footBar },
    robots: sim.robots.map((r, i) => ({
      alliance: r.alliance, slot: r.slot, plate: bots[i].plate, length: r.cfg.length, width: r.cfg.width, height: r.cfg.height,
      shooter: { type: r.cfg.shooter.type, facing: r.cfg.shooter.facing, turret: !!r.cfg.shooter.turret, dualSided: !!r.cfg.shooter.dualSided },
      intake: { width: r.cfg.intake.width, dualSided: !!r.cfg.intake.dualSided }, camera: r.cfg.camera,
    })),
    mode: sim.mode, seed: currentSeed,
  };
}

/** The flattened tree of a robot's current period, for the tree panel. Sent when the tree changes. */
function tree(def: TreeDef) {
  const nodes: { idx: number; parent: number; depth: number; kind: string; label: string; note?: string }[] = [];
  const walk = (n: CNode, parent: number, depth: number) => { nodes.push({ idx: n.idx, parent, depth, kind: n.kind, label: n.label, note: n.note }); n.children.forEach(c => walk(c, n.idx, depth + 1)); };
  walk(def.root, -1, 0);
  return { id: def.id, name: def.name, nodes };
}

function inputsFor(i: number): { inputs: Inputs; program: boolean } {
  const d = drivers[i], v = sim.view(i);
  if (d.kind === 'inputs') return { inputs: d.inputs, program: true };
  if (d.kind === 'goto') {
    const c = pursue(v, d.path, d.goal.heading);
    const done = c.remaining < 0.03 && Math.abs(c.headingError) < 0.03;
    return { inputs: { ...NO_INPUT, ...(done ? {} : { forward: c.forward, strafeRight: c.strafeRight, turnRight: c.turnRight }), intake: d.intake }, program: true };
  }
  if (sim.phase === 'auto' || sim.phase === 'teleop') return { inputs: coaches[i].update(v, DT), program: true };
  return { inputs: NO_INPUT, program: true };
}

function step(n: number) {
  for (let k = 0; k < n && sim.phase !== 'post'; k++) {
    const per = sim.robots.map((_, i) => inputsFor(i));
    sim.step(per.map(p => p.inputs), per.map(p => p.program)); referee?.update(sim, DT);
  }
}

function state() {
  const robots = sim.robots.map((r, i) => {
    const v = sim.view(i), p = r.body.translation(), lv = r.body.linvel(), d = drivers[i], c = coaches[i];
    const path = d.kind === 'goto' ? d.path : sim.phase === 'auto' ? c.auto?.path ?? [] : c.executor.path;
    const ct = c.currentTree(); let tree: unknown = null;
    if (ct) {
      if (treeRef[i] !== ct.recorder) { treeRef[i] = ct.recorder; treeSeen[i] = 0; tree = { def: treeDefOf(ct.def) }; }
      const ended: [number, string][] = [];
      for (; treeSeen[i] < ct.recorder.closed.length; treeSeen[i]++) {
        const s = ct.recorder.closed[treeSeen[i]];
        ended.push([s.node, s.result === 'success' ? 's' : s.result === 'failure' ? `f:${s.tag ?? ''}` : s.result === 'halted' ? 'h' : 'e']);
      }
      tree = { ...(tree as object ?? {}), period: ct.period, running: ct.recorder.running().map(s => s.node), ended };
    }
    return {
      x: r4(p.x), z: r4(p.z), heading: r4(v.heading), vx: r4(lv.x), vz: r4(lv.z), w: r4(r.body.angvel().y),
      carried: r.carried.map(k => KIND[k]), intent: r.intent, plan: r.plan.phase, side: r.plan.side, goal: r.plan.goal,
      driver: d.kind, tactic: c.executor.tactic, note: sim.phase === 'auto' ? c.auto?.note ?? '' : c.executor.note,
      path: path.map(q => [r4(q.x), r4(q.z)]), turret: Number.isFinite(r.turretAngle) ? r4(r.turretAngle) : null,
      leave: r.autoLeave, autoPark: r.autoPark, bus: r4(r.telemetry.busVoltage), speed: r4(r.telemetry.speed),
      placing: !!r.placing, sightings: cameraSightings(v).map(s => `${s.alliance}:${s.cell}:${s.tags}${s.raised ? ':raised' : ''}`), tree,
    };
  });
  const messages: { t: number; text: string }[] = [];
  for (const m of sim.messages) if (!seen.has(m)) { seen.add(m); messages.push(m); }
  return {
    type: 'state', t: r4((sim as unknown as { time: number }).time), phase: sim.phase, clock: r4(sim.timer), unlocked: sim.flowersUnlocked,
    score: { red: sim.score('red'), blue: sim.score('blue') },
    hives: Object.fromEntries((['red', 'blue'] as const).map(a => [a, { phi: r4(sim.hives[a].phi), up: sim.hives[a].upCell, tips: sim.hives[a].tips }])),
    stash: sim.stash, flowers: sim.flowers.map(f => f.stack.map(k => KIND[k])),
    balls: [...sim.balls.values()].map(b => {
      const q = b.body.translation(), o = b.body.rotation();
      return [b.id, KIND[b.kind], r4(q.x), r4(q.y), r4(q.z), [r4(o.x), r4(o.y), r4(o.z), r4(o.w)]];
    }),
    robots, messages, events: sim.events.splice(0), fouls: referee?.calls.length ?? 0,
  };
}

const defs = new WeakMap<TreeDef, ReturnType<typeof tree>>();
const treeDefOf = (d: TreeDef) => { let t = defs.get(d); if (!t) { t = tree(d); defs.set(d, t); } return t; };

function send(msg: unknown) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(c: Record<string, any>) {
  switch (c.op) {
    case 'reset': reset(c.seed ?? 1, c.mode ?? 'full', c.bots ?? [], !!c.referee); return send(state());
    case 'start': sim.start(); return send(state());
    case 'step': step(Math.max(0, Math.min(2400, c.n ?? 1))); return send(state());
    case 'drive': {
      const i = c.robot, v = sim.view(i);
      if (c.kind === 'planner') drivers[i] = { kind: 'planner' };
      else if (c.kind === 'inputs') drivers[i] = { kind: 'inputs', inputs: { ...NO_INPUT, ...c.inputs } };
      else if (c.kind === 'goto') {
        const p = v.robot.translation(), r = Math.hypot(v.cfg.length, v.cfg.width) / 2;
        drivers[i] = { kind: 'goto', goal: { x: c.x, z: c.z, heading: c.heading ?? null }, intake: c.intake ?? 'none', path: planPath({ x: p.x, z: p.z }, { x: c.x, z: c.z }, r) };
      }
      return send({ type: 'ok' });
    }
    default: return send({ type: 'error', message: `unknown op '${c.op}'` });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line: string) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch (e) { send({ type: 'error', message: e instanceof Error ? e.message : String(e) }); }
});
send({ type: 'ready' });
