import { FIELD, HIVE } from '../sim/config';
import { seesRaisedCell } from '../sim/camera';
import { NO_INPUT, type Inputs, type IntakeFilter, type Sim } from '../sim/world';
import { pursue } from './follow';
import { fieldObstacles, planPath, type Capsule, type Pt } from './planner';
import lanes from './sweep-lanes.json';

/**
 * One step of an AUTO script. Poses are for the red alliance, in field meters and degrees; a blue robot mirrors
 * them through the FIELD center. Every step ends on its condition or on its timeout, whichever comes first.
 */
export type Step =
  /** `untilFull` ends the step as soon as the hopper is full, which the robot senses without vision. */
  | { do: 'drive'; x: number; z: number; headingDeg: number; intake?: IntakeFilter; untilFull?: boolean; timeoutSec: number; /** A label for tools, for example `sweep` on the first lane of a sweep. */ tag?: string }
  /** Pushes forward with the intake on, for example against the bottom of a FLOWER. Ends when the robot is full. */
  | { do: 'push'; power: number; intake: IntakeFilter; timeoutSec: number }
  /** Launches open loop from the current pose until `count` elements are gone. There is no aiming feedback. */
  /** `cell` makes the robot hold its fire until its camera sees that CELL raised. See `waitCell`. */
  | { do: 'shoot'; count: number; timeoutSec: number; cell?: 'rear' | 'audience' }
  /**
   * Waits until the robot's camera reads the AprilTags of the named CELL in the raised position. Each CELL carries an
   * AprilTag cluster on its underside (section 9.9). The camera has a real field of view (see `cameraSightings`), so
   * the robot must be near its launch spot, with the shooter side toward the HIVE, for this step to pass. It is the
   * only vision that AUTO uses: it reads the HIVE, not the balls.
   */
  | { do: 'waitCell'; cell: 'rear' | 'audience'; timeoutSec: number }
  /**
   * Waits until the named CELL tips: the camera saw it raised, and then no longer sees it raised. A sweep that follows
   * a TIP starts after this step, because the spill needs about 2 s to reach the wall. A CELL that isn't seen raised
   * after 1 s counts as already tipping, which happens when the robot arrives while the HIVE swings.
   */
  | { do: 'waitTip'; cell: 'rear' | 'audience'; timeoutSec: number }
  /** `unlessFull` skips the wait when the hopper is full, for a wait whose only purpose is a pickup that follows. */
  | { do: 'wait'; timeoutSec: number; tag?: string; unlessFull?: boolean }
  /** Waits until the period clock shows `clockSec` or less. Partners use it to take turns, like a choreographed AUTO. */
  | { do: 'waitUntil'; clockSec: number; timeoutSec: number };

export interface AutoScript { description: string; steps: Step[]; /** The script jumps to its last step when this many seconds remain. */ finishAtSec?: number }

// Tuned constants, like a team's own AUTO: the launch standoff that scores with the default shooter, FLOWER stand
// distances, and the PARK pose. The rear-facing shooter means the robot backs up to the HIVE.
const Z_LAUNCH = 1.32, X_HIVE = HIVE.pivotX.red;

export interface ScriptTuning { /** The robot's length in meters. Default: 0.43. */ length?: number; /** The side of the robot that the shooter faces. Default: rear. */ facing?: 'front' | 'rear'; /** For scripts/plan-sweeps.ts: replace every sweep with a wait of this many seconds, so that the tool can record where the spill comes to rest without the robot disturbing it. */ sweepSnapshotDelay?: number; /** The clock at which the lead robot loads the audience CELL. Default: 15.5. */ leadWait?: number; /** The clock at which the partner first launches. Default: 24.5. */ partnerWait?: number }

/** Builds every AUTO script for a robot length and a partner choreography. */
export function buildScripts(tuning: ScriptTuning = {}): Record<string, AutoScript> {
const len = tuning.length ?? 0.43, STAND = len / 2 + FIELD.flowerHalfSize + 0.02;
const flip = tuning.facing === 'front' ? 180 : 0; // A front-facing shooter turns every launch pose around.
const launchAudience = { x: X_HIVE, z: Z_LAUNCH, headingDeg: -90 + flip }, launchRear = { x: X_HIVE, z: -Z_LAUNCH, headingDeg: 90 + flip };
const redFlower = { x: -1.7282 + STAND, z: 0.5942, headingDeg: 180 }, rearFlower = { x: -0.5942, z: -1.7282 + STAND, headingDeg: 90 };
// LEAVE needs the robot clear of the wall by its half size plus 2 cm. 9 cm off the wall leaves margin for a 5 cm drive tolerance.
const park = { x: -(FIELD.half - len / 2 - 0.09), z: -0.8954, headingDeg: 180 };

const cycle: Step[] = [
  { do: 'drive', ...launchAudience, timeoutSec: 4 },
  // The raised CELL starts with 3 NECTAR, so the third POLLEN tips the HIVE. The fourth stays for the next CELL.
  { do: 'shoot', count: 3, timeoutSec: 2.5 },
  { do: 'drive', ...redFlower, x: redFlower.x + 0.2, timeoutSec: 3.5 }, { do: 'drive', ...redFlower, intake: 'pollen', timeoutSec: 1.5 },
  { do: 'push', power: 0.35, intake: 'pollen', timeoutSec: 2.2 },
  { do: 'drive', ...launchRear, timeoutSec: 5 }, { do: 'shoot', count: 4, timeoutSec: 4, cell: 'rear' },
  { do: 'drive', ...rearFlower, z: rearFlower.z + 0.2, timeoutSec: 3 }, { do: 'drive', ...rearFlower, intake: 'pollen', timeoutSec: 1.5 },
  { do: 'push', power: 0.35, intake: 'pollen', timeoutSec: 2.2 },
  { do: 'drive', ...launchRear, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 3 },
];

// Blind sweeps: a TIP spills the CELL's contents at positions that the robot can't see. scripts/plan-sweeps.ts
// records where those balls rest over many simulated matches and plans the waypoints in sweep-lanes.json that
// collect the most of them. The robot drives every lane with its intake leading, and a lane ends early once the
// hopper is full.
const sweep = (role: 'solo' | 'right' | 'left', from: Pt): Step[] => {
  if (tuning.sweepSnapshotDelay !== undefined) return [{ do: 'wait', timeoutSec: tuning.sweepSnapshotDelay }, { do: 'wait', timeoutSec: 30, tag: 'sweep' }];
  // A lane normally leads with the intake. A lane marked with a wall name strafes along that wall with the intake
  // facing it, because a ball against a wall is out of reach for a robot that drives along the wall.
  const facing = { rear: 90, audience: -90, red: 180 } as const;
  let at = from; return (lanes[role] as (number | string)[][]).map(([xv, zv, wall], i) => {
    const x = xv as number, z = zv as number, dist = Math.hypot(x - at.x, z - at.z);
    const headingDeg = wall ? facing[wall as keyof typeof facing] : (Math.atan2(-(z - at.z), x - at.x) * 180) / Math.PI; at = { x, z };
    return { do: 'drive' as const, x, z, headingDeg, intake: 'all' as const, untilFull: true, timeoutSec: dist / 1.1 + 1.2, tag: i === 0 ? 'sweep' : undefined };
  });
};
// From the rear launch spot the camera can't see the audience CELL, so the robot can't watch the TIP finish.
// It waits 1.5 s for the spill to land instead.
const sweepSolo: Step[] = [{ do: 'wait', timeoutSec: 1.5 }, ...sweep('solo', launchRear)];

// Pair choreography, named by start position as the red drivers see it. Blue mirrors it. The right robot starts on the
// alliance wall, takes the first TIP, and then works the audience side. The left robot starts on the rear wall, fills
// the rear CELL from the angled launch spot for the second TIP, and sweeps the rear spill. The vision waits keep a
// robot from launching at a CELL before the other robot's TIP has raised it.
const angledRear = { x: X_HIVE - 0.62, z: -1.17, headingDeg: 129.4 + flip };
// The right robot parks at the right end of the LOADING ZONE, and the left robot at the left end.
// Every drive to PARK runs the intake: the robot faces the alliance wall, where NECTAR from the LOADING ZONE collects,
// and a full hopper at the end of AUTO is a head start in TELEOP.
const parkRight = { ...park, z: -0.8954 + 0.33 }, parkLeft = { ...park, z: -0.8954 - 0.33 };
const rightCycle: Step[] = [
  { do: 'drive', ...launchAudience, timeoutSec: 4 }, { do: 'shoot', count: 3, timeoutSec: 2.5 },
  { do: 'drive', ...redFlower, x: redFlower.x + 0.2, timeoutSec: 3.5 }, { do: 'drive', ...redFlower, intake: 'pollen', timeoutSec: 1.5 },
  { do: 'push', power: 0.35, intake: 'pollen', timeoutSec: 2.2 },
  { do: 'drive', ...launchAudience, timeoutSec: 4 }, { do: 'waitCell', cell: 'audience', timeoutSec: 14 }, { do: 'shoot', count: 4, timeoutSec: 2.5, cell: 'audience' },
  ...sweep('right', launchAudience), { do: 'drive', ...launchAudience, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 2.5, cell: 'audience' },
  // That volley is the third TIP. The right robot stays on its own side: it sweeps the fresh audience-side spill so
  // that TELEOP starts with a full hopper, and crosses to the rear only to PARK.
  { do: 'waitTip', cell: 'audience', timeoutSec: 4 }, { do: 'wait', timeoutSec: 1.2 }, ...sweep('right', launchAudience),
  { do: 'drive', ...parkRight, intake: 'all', timeoutSec: 6 },
];
const leftCycle: Step[] = [
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'waitCell', cell: 'rear', timeoutSec: 8 }, { do: 'shoot', count: 4, timeoutSec: 2.5, cell: 'rear' },
  { do: 'drive', ...rearFlower, z: rearFlower.z + 0.2, timeoutSec: 3 }, { do: 'drive', ...rearFlower, intake: 'pollen', timeoutSec: 1.5 },
  { do: 'push', power: 0.35, intake: 'pollen', timeoutSec: 2.2 },
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 2.5 },
  // That volley tips the rear CELL. The left robot watches the TIP and lets the spill reach the rear wall before it sweeps.
  { do: 'waitTip', cell: 'rear', timeoutSec: 4 }, { do: 'wait', timeoutSec: 1.2 }, ...sweep('left', angledRear),
  // The right robot's third TIP raises the rear CELL again: launch what the sweep found, then sweep once more so that
  // TELEOP starts with a full hopper.
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 4, cell: 'rear' },
  ...sweep('left', angledRear), { do: 'drive', ...parkLeft, intake: 'all', timeoutSec: 6 },
];

// Harvest choreography. A TIP spills the CELL along the wall right behind the straight launch spot, and the rear-facing
// shooter means that the intake already faces that wall. After its volley, the robot steps aside to the angled spot so
// that the spill passes, watches the TIP, and then drives straight into the wall with the intake on.
const angledAudience = { x: X_HIVE - 0.62, z: 1.17, headingDeg: -129.4 + flip }, wallStand = FIELD.half - len / 2 - 0.035;
// `waitTip` ends when the CELL starts to swing. The TIP completes about 1.2 s later, and the spill reaches the wall about
// 2 s after that, so the robot waits `settleSec` before it drives in.
const harvest = (side: 1 | -1, cell: 'rear' | 'audience', settleSec = 3.0): Step[] => [
  { do: 'drive', ...(side > 0 ? angledAudience : angledRear), timeoutSec: 2.5 }, { do: 'waitTip', cell, timeoutSec: 4 }, { do: 'wait', timeoutSec: settleSec },
  { do: 'drive', x: X_HIVE + 0.03, z: side * 1.28, headingDeg: -90 * side + flip, intake: 'all', untilFull: true, timeoutSec: 2.5 },
  { do: 'drive', x: X_HIVE + 0.03, z: side * wallStand, headingDeg: -90 * side + flip, intake: 'all', untilFull: true, timeoutSec: 2 },
  { do: 'push', power: 0.3, intake: 'all', timeoutSec: 0.8 },
];
// Wall sweep: the robot yaws 30 degrees toward the wall, puts its wall-side front corner 1.5 cm from the wall, and
// drives along the wall toward the drivers' corner. The intake is 4.5 cm narrower than the chassis on each side, so a
// robot that is square to its path never reaches a ball on the wall. At 30 degrees the wall line crosses the front of
// the intake box, so every ball on the wall passes through it. `untilFull` ends the sweep at four elements.
const YAW = 30, yaw = (YAW * Math.PI) / 180, wallZ = FIELD.half - (len / 2) * Math.sin(yaw) - (len / 2) * Math.cos(yaw) - 0.015;
// The sweep starts as near the FIELD center line as G402 allows: at 30 degrees, the rear corner on the wall side is
// 0.29 m behind the robot's center, so a center at x = -0.31 keeps the whole robot 2 cm inside its own half.
const SWEEP_FROM = -(len / 2) * Math.cos(yaw) - (len / 2) * Math.sin(yaw) - 0.02;
const wallSweep = (side: 1 | -1, fromX: number): Step[] => [
  { do: 'drive', x: fromX, z: side * wallZ, headingDeg: side > 0 ? -180 + YAW : 180 - YAW, intake: 'all', untilFull: true, timeoutSec: 2.5 },
  { do: 'drive', x: -(FIELD.half - 0.31), z: side * wallZ, headingDeg: side > 0 ? -180 + YAW : 180 - YAW, intake: 'all', untilFull: true, timeoutSec: 3 },
];
// The same sweep along the alliance wall, from near the rear corner toward the LOADING ZONE, where NECTAR collects.
// The intake leads at 30 degrees toward the wall. It starts 0.39 m from the rear wall, so that the robot can turn there.
const allianceWallSweep: Step[] = [
  { do: 'drive', x: -wallZ, z: -(FIELD.half - 0.39), headingDeg: -90 - YAW, intake: 'all', untilFull: true, timeoutSec: 2 },
  { do: 'drive', x: -wallZ, z: -0.45, headingDeg: -90 - YAW, intake: 'all', untilFull: true, timeoutSec: 3 },
];
const rightHarvest: Step[] = [
  { do: 'drive', ...launchAudience, timeoutSec: 4 }, { do: 'shoot', count: 3, timeoutSec: 2.5 },
  // The red FLOWER's POLLEN fills the wait for the left robot's TIP, which raises the audience CELL again.
  { do: 'drive', ...redFlower, x: redFlower.x + 0.2, timeoutSec: 3.5 }, { do: 'drive', ...redFlower, intake: 'pollen', timeoutSec: 1.5 }, { do: 'push', power: 0.35, intake: 'pollen', timeoutSec: 2.2 },
  { do: 'drive', ...launchAudience, timeoutSec: 4 }, { do: 'waitCell', cell: 'audience', timeoutSec: 14 }, { do: 'shoot', count: 4, timeoutSec: 2.5, cell: 'audience' },
  // The first TIP's spill rests along the audience wall, and the corner holds staged POLLEN.
  ...wallSweep(1, SWEEP_FROM),
  { do: 'drive', ...launchAudience, timeoutSec: 3.5 }, { do: 'shoot', count: 4, timeoutSec: 2.5, cell: 'audience' },
  // That volley is the third TIP, which raises the rear CELL. The robot sweeps the fresh spill and launches it into the
  // rear CELL from the straight rear spot for a fourth TIP.
  // The robot backs under the HIVE, so that the spill passes over it to the wall, and sweeps after the spill has landed.
  // The camera can't read either CELL from under the HIVE, so the wait is timed: the HIVE tips about 2 s after the
  // volley ends, and the spill needs about 1.6 s more to reach the wall. A full hopper skips the wait and the sweep.
  { do: 'drive', x: X_HIVE, z: 0.62, headingDeg: -90 + flip, untilFull: true, timeoutSec: 2 }, { do: 'wait', timeoutSec: 2.6, unlessFull: true }, ...wallSweep(1, SWEEP_FROM),
  { do: 'drive', ...launchRear, timeoutSec: 5 }, { do: 'shoot', count: 4, timeoutSec: 3, cell: 'rear' },
  // Spill collects on the rear wall between the rear FLOWER and the center line, 0.25 m behind this launch spot, and the
  // intake already faces it: drive in, come back, and launch again. The pose is 3 cm toward the center line, so that a
  // 0.43 m robot clears the FLOWER. In trace 20260920-155206, three POLLEN rested there and the robot parked with 6 s left.
  { do: 'drive', x: X_HIVE + 0.03, z: -wallStand, headingDeg: 90 + flip, intake: 'all', untilFull: true, timeoutSec: 1.5 }, { do: 'push', power: 0.3, intake: 'all', timeoutSec: 0.6 },
  { do: 'drive', ...launchRear, timeoutSec: 2 }, { do: 'shoot', count: 4, timeoutSec: 1.5, cell: 'rear' },
  { do: 'drive', ...parkRight, intake: 'all', timeoutSec: 6 },
];
const leftHarvest: Step[] = [
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'waitCell', cell: 'rear', timeoutSec: 8 }, { do: 'shoot', count: 4, timeoutSec: 2.5, cell: 'rear' },
  { do: 'drive', ...rearFlower, z: rearFlower.z + 0.2, timeoutSec: 3 }, { do: 'drive', ...rearFlower, intake: 'pollen', timeoutSec: 1.5 }, { do: 'push', power: 0.35, intake: 'pollen', timeoutSec: 2.2 },
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 2.5 },
  // That volley tips the rear CELL, and its spill lands in the pocket between the rear FLOWER and the center line.
  ...harvest(-1, 'rear'),
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 12, cell: 'rear' },
  // An angled sweep of the rear wall from the FLOWER to the corner, and then the PARK approach with the intake on.
  ...wallSweep(-1, -(FIELD.flowerHalfSize + 0.5942 + (len / 2) * Math.cos(yaw) + (len / 2) * Math.sin(yaw) + 0.03)), ...allianceWallSweep,
  // The third TIP raised the rear CELL: launch what the sweeps found, and PARK with the intake on.
  // With a full hopper and the rear CELL down, the robot waits here for the right robot's TIP to raise it. A 2 s wait
  // sent it to PARK with 10 s left and a full hopper (trace 20260920-170726).
  { do: 'drive', ...angledRear, timeoutSec: 3 }, { do: 'shoot', count: 4, timeoutSec: 8, cell: 'rear' },
  // Fill the hopper for TELEOP with the time that is left. `finishAtSec` starts the PARK when the clock requires it.
  ...allianceWallSweep,
  { do: 'drive', ...parkLeft, intake: 'all', timeoutSec: 6 },
];

return {
  right_harvest: { description: 'For the right start position, on the alliance wall: the first TIP from the pre-loads, the red FLOWER during the wait for the left robot\'s TIP, then an angled sweep of the audience wall from the center line to the corner, a third TIP, a second sweep after the spill lands, and a launch into the rear CELL for a fourth TIP.', steps: rightHarvest, finishAtSec: 2.5 },
  left_harvest: { description: 'For the left start position: left_cycle, but after its own TIP the robot waits 3 s for the spill and drives into the rear wall pocket between the rear FLOWER and the center line. Over 24 seeds it scores the same as left_cycle.', steps: leftHarvest, finishAtSec: 3.0 },
  right_cycle: { description: 'The earlier default for the right start position, with lane sweeps: the first TIP from the pre-loads, then load the audience CELL after the left robot\'s TIP, sweep, launch for a third TIP, and PARK.', steps: rightCycle, finishAtSec: 4.5 },
  left_cycle_no_park: { description: 'left_cycle without the PARK: the robot keeps sweeping the rear spill.', steps: leftCycle.slice(0, -1) },
  left_cycle: { description: 'For the left start position, on the rear wall: fill the rear CELL for the second TIP, sweep the rear spill, and PARK.', steps: leftCycle, finishAtSec: 3.0 },
  cycle_and_park: { description: 'Two TIPS from the pre-loads and the two own-side FLOWERS, then blind sweeps of the spill to fill the hopper, and a PARK.', steps: [...cycle, ...sweepSolo, { do: 'drive', ...park, intake: 'all', timeoutSec: 6 }], finishAtSec: 3.5 },
  cycle_no_park: { description: 'Two TIPS and the sweeps, without the PARK. It leaves the LOADING ZONE to a partner.', steps: [...cycle, ...sweepSolo] },
  leave_only: { description: 'Drive to the LOADING ZONE and stay: LEAVE plus AUTO PARK, with no launching.', steps: [{ do: 'drive', ...park, timeoutSec: 8 }] },
};
}

/** The scripts for the default robot, for the page's AUTO list and its path preview. */
export const AUTO_SCRIPTS = buildScripts();

/**
 * Gets the default script name for a robot: the right robot (slot 0) runs `right_harvest`, and the left robot (slot 1)
 * runs `left_harvest`. Over 24 seeds, `right_harvest` scores 177 combined AUTO points, where `right_cycle` scores 151.
 */
export function autoFor(sim: Sim, selected: string): string {
  if (!sim.partner()) return selected;
  return sim.slot === 1 ? 'left_harvest' : selected === 'cycle_and_park' ? 'right_harvest' : selected;
}



const centerWall = (mirror: boolean): Capsule => { const xw = (mirror ? -1 : 1) * 0.08; return { a: { x: xw, z: -2 }, b: { x: xw, z: 2 }, r: 0 }; };

/**
 * Gets the whole trajectory of a script before it runs: the planned path through every drive pose, plus the
 * poses. The plan uses only fixed FIELD geometry, so it is known before the MATCH, like a real AUTO path.
 */
export function previewScript(script: AutoScript, alliance: 'red' | 'blue', start: Pt, robotRadius: number): { path: Pt[]; poses: (Pt & { heading: number; shoots: boolean })[] } {
  const mirror = alliance === 'blue', path: Pt[] = [start], poses: (Pt & { heading: number; shoots: boolean })[] = []; let at = start;
  script.steps.forEach((st, i) => {
    if (st.do !== 'drive') return;
    const goal = { x: mirror ? -st.x : st.x, z: mirror ? -st.z : st.z };
    path.push(...planPath(at, goal, robotRadius, [...fieldObstacles(), centerWall(mirror)]).slice(1)); at = goal;
    poses.push({ ...goal, heading: ((st.headingDeg + (mirror ? 180 : 0)) * Math.PI) / 180, shoots: script.steps[i + 1]?.do === 'shoot' });
  });
  return { path, poses };
}

/**
 * Runs an AUTO script the way an FTC OpMode does: no driver and no knowledge of where balls, the HIVE,
 * or other robots are. It reads only the robot's pose (odometry), its carried count (a sensor), and the clock.
 * Paths avoid the fixed FIELD elements and a virtual wall on the FIELD center line, so the robot stays on its
 * own side during AUTO (G402).
 */
export class ScriptRunner {
  index = 0; path: Pt[] = []; note = '';
  private stepTime = 0; private startCount = -1; private replanAt = 0; private t = 0; private sawRaised = false;
  constructor(public script: AutoScript) {}

  update(sim: Sim, dt: number): Inputs {
    this.t += dt; this.stepTime += dt; const steps = this.script.steps, last = steps.length - 1;
    if (this.script.finishAtSec !== undefined && sim.phase === 'auto' && sim.timer <= this.script.finishAtSec && this.index < last) this.goto(last);
    const step = steps[this.index]; if (!step) { this.path = []; this.note = 'script finished'; return NO_INPUT; }
    this.note = `step ${this.index + 1}/${steps.length}: ${step.do}`;
    const mirror = sim.alliance === 'blue', next = () => { this.goto(this.index + 1); return NO_INPUT; };
    if (this.stepTime > step.timeoutSec) return next();
    if (step.do === 'wait') return step.unlessFull && sim.carried.length >= sim.cfg.capacity ? next() : NO_INPUT;
    if (step.do === 'waitUntil') return sim.timer <= step.clockSec ? next() : NO_INPUT;
    // Blue mirrors the FIELD, so its rear is red's audience side.
    const raised = (cell: 'rear' | 'audience') => seesRaisedCell(sim, mirror ? (cell === 'rear' ? 'audience' : 'rear') : cell);
    if (step.do === 'waitCell') return raised(step.cell) ? next() : NO_INPUT;
    if (step.do === 'waitTip') { if (raised(step.cell)) this.sawRaised = true; return (this.sawRaised || this.stepTime > 1) && !raised(step.cell) ? next() : NO_INPUT; }
    if (step.do === 'push') return sim.carried.length >= sim.cfg.capacity ? next() : { ...NO_INPUT, forward: step.power, intake: step.intake };
    if (step.do === 'shoot') {
      if (step.cell && !raised(step.cell)) return NO_INPUT;
      if (this.startCount < 0) this.startCount = sim.carried.length;
      if (sim.carried.length === 0 || this.startCount - sim.carried.length >= step.count) return next();
      return { ...NO_INPUT, shootPollen: true, shootNectar: true };
    }
    if (step.untilFull && sim.carried.length >= sim.cfg.capacity) return next();
    const goal = { x: mirror ? -step.x : step.x, z: mirror ? -step.z : step.z }, heading = ((step.headingDeg + (mirror ? 180 : 0)) * Math.PI) / 180;
    const p = sim.robot.translation(), R = Math.hypot(sim.cfg.length, sim.cfg.width) / 2;
    if (this.t >= this.replanAt) {
      // The center-line wall sits so that the robot's circumscribed circle stays on its own side of the FIELD.
      this.path = planPath({ x: p.x, z: p.z }, goal, R, [...fieldObstacles(), centerWall(mirror)]); this.replanAt = this.t + 0.15;
    }
    const cmd = pursue(sim, this.path, heading);
    if (cmd.remaining < 0.05 && Math.abs(cmd.headingError) < 0.05 && sim.telemetry.speed < 0.15) return next();
    return { ...NO_INPUT, forward: cmd.forward, strafeRight: cmd.strafeRight, turnRight: cmd.turnRight, intake: step.intake ?? 'none' };
  }

  private goto(i: number) { this.index = i; this.stepTime = 0; this.startCount = -1; this.replanAt = 0; this.sawRaised = false; }
}
