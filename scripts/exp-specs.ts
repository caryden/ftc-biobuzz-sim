import type { ScriptTuning } from '../src/auto/script';
import { setDriveRpm, setMass, setSquareSize, type RobotConfig } from '../src/sim/config';

/** One side of an experiment: how both robots of an alliance are built and what they do. */
export interface Side {
  /** Changes a robot's configuration. `slot` is 0 for the first robot and 1 for its partner. */
  cfg?: (c: RobotConfig, slot: 0 | 1) => void;
  /** TELEOP: the clock at which each robot starts FLOWER work. 0 means TIPS only. Default: [0, 0]. */
  flowerStart?: [number, number];
  /** AUTO script names for the two robots. Default: the choreographed pair. */
  auto?: [string, string]; tuning?: ScriptTuning;
}
export interface Spec { group: string; label: string; red?: Side; blue?: Side; global?: { margin?: number; vMax?: number; decel?: number; lookahead?: number; standoff?: number; kv?: number } }

const rpm = (n: number) => (c: RobotConfig) => setDriveRpm(c, n);
// A size change keeps the mass: `setSquareSize` resets the yaw inertia, and `setMass` with the same mass rescales it.
const size = (m: number) => (c: RobotConfig) => { const kg = c.mass; setSquareSize(c, m); c.mass = 13; setMass(c, kg); };
const mass = (kg: number) => (c: RobotConfig) => setMass(c, kg);
const spread = (k: number) => (c: RobotConfig) => { for (const lp of [c.shooter.pollen, c.shooter.nectar]) { lp.speed.std *= k; lp.elevationDeg.std *= k; lp.yawStdDeg *= k; } };
const both = (...fs: ((c: RobotConfig) => void)[]) => (c: RobotConfig) => fs.forEach(f => f(c));

// The base robot is the default setup in src/setup.ts: 15 in. (0.381 m), 22 lb (10 kg), 600 rpm, a dual shooter, and a
// front intake. The opponent in every experiment is two base robots that keep tipping, with the default AUTO pair.
export const SPECS: Record<string, Spec> = {
  // Strategy: when each red robot starts FLOWER work. 0 means never.
  'strat-tips-tips': { group: 'strategy', label: 'Both robots: TIPS only', red: { flowerStart: [0, 0] } },
  'strat-tips-f30': { group: 'strategy', label: 'Robot 1 TIPS only, partner FLOWERS from 30 s', red: { flowerStart: [0, 30] } },
  'strat-tips-f45': { group: 'strategy', label: 'Robot 1 TIPS only, partner FLOWERS from 45 s', red: { flowerStart: [0, 45] } },
  'strat-tips-f66': { group: 'strategy', label: 'Robot 1 TIPS only, partner FLOWERS from 66 s', red: { flowerStart: [0, 66] } },
  'strat-f30-f30': { group: 'strategy', label: 'Both robots: FLOWERS from 30 s', red: { flowerStart: [30, 30] } },
  'strat-f45-f45': { group: 'strategy', label: 'Both robots: FLOWERS from 45 s', red: { flowerStart: [45, 45] } },
  'strat-f66-f66': { group: 'strategy', label: 'Both robots: FLOWERS from 66 s', red: { flowerStart: [66, 66] } },
  'strat-f20-f20': { group: 'strategy', label: 'Both robots: FLOWERS from 20 s', red: { flowerStart: [20, 20] } },
  'strat-tips-f20': { group: 'strategy', label: 'Robot 1 TIPS only, partner FLOWERS from 20 s', red: { flowerStart: [0, 20] } },

  // Shooter type, both red robots.
  'shoot-dual': { group: 'shooter', label: 'Dual shooter (baseline)' },
  'shoot-fifo': { group: 'shooter', label: 'Single shooter, FIFO', red: { cfg: c => { c.shooter.type = 'fifo'; } } },
  'shoot-catapult': { group: 'shooter', label: 'Catapult, all at once', red: { cfg: c => { c.shooter.type = 'catapult'; } } },
  'shoot-fast': { group: 'shooter', label: 'Dual, 0.15 s between shots', red: { cfg: c => { c.shooter.cycleSec = 0.15; } } },
  'shoot-slow': { group: 'shooter', label: 'Dual, 0.6 s between shots', red: { cfg: c => { c.shooter.cycleSec = 0.6; } } },
  'shoot-front': { group: 'shooter', label: 'Dual, shooter on the intake side', red: { cfg: c => { c.shooter.facing = 'front'; } } },

  // Drivetrain gearing. Torque falls as speed rises: the same motor with a different gearbox.
  'drive-312': { group: 'drivetrain', label: '312 rpm', red: { cfg: rpm(312) } },
  'drive-435': { group: 'drivetrain', label: '435 rpm', red: { cfg: rpm(435) } },
  'drive-500': { group: 'drivetrain', label: '500 rpm', red: { cfg: rpm(500) } },
  'drive-600': { group: 'drivetrain', label: '600 rpm (baseline)' },
  'drive-700': { group: 'drivetrain', label: '700 rpm', red: { cfg: rpm(700) } },
  'drive-850': { group: 'drivetrain', label: '850 rpm', red: { cfg: rpm(850) } },
  'mass-7': { group: 'drivetrain', label: '600 rpm, 7 kg (15.4 lb) robot', red: { cfg: mass(7) } },
  'mass-13': { group: 'drivetrain', label: '600 rpm, 13 kg (28.7 lb) robot', red: { cfg: mass(13) } },
  'mass-17': { group: 'drivetrain', label: '600 rpm, 17 kg (37.5 lb) robot', red: { cfg: mass(17) } },
  'mass-17-435': { group: 'drivetrain', label: '435 rpm, 17 kg robot', red: { cfg: both(rpm(435), mass(17)) } },

  // Footprint: a square chassis of this side length. The intake is 9 cm narrower than the chassis.
  'size-46': { group: 'size', label: '18.0 in. (0.457 m), the legal maximum', red: { cfg: size(0.457) } },
  'size-43': { group: 'size', label: '16.9 in. (0.43 m)', red: { cfg: size(0.43) } },
  'size-38': { group: 'size', label: '15.0 in. (0.381 m, baseline)' },
  'size-34': { group: 'size', label: '13.4 in. (0.34 m)', red: { cfg: size(0.34) } },
  'size-30': { group: 'size', label: '11.8 in. (0.30 m)', red: { cfg: size(0.3) } },
  'size-38-wide-intake': { group: 'size', label: '15 in. chassis with a full-width intake', red: { cfg: c => { c.intake.width = c.width; } } },
  'size-46-wide-intake': { group: 'size', label: '18 in. chassis with a full-width intake', red: { cfg: both(size(0.457), c => { c.intake.width = c.width; }) } },

  // Intake layout.
  'intake-front': { group: 'intake', label: 'Front intake (baseline)' },
  'intake-dual': { group: 'intake', label: 'Intakes on the front and the rear', red: { cfg: c => { c.intake.dualSided = true; } } },
  'intake-dual-front-shooter': { group: 'intake', label: 'Front and rear intakes, shooter at the front', red: { cfg: c => { c.intake.dualSided = true; c.shooter.facing = 'front'; } } },
  'shooter-both-ends': { group: 'intake', label: 'Front intake, launches from both ends', red: { cfg: c => { c.shooter.dualSided = true; } } },
  'intake-dual-shooter-both-ends': { group: 'intake', label: 'Front and rear intakes, launches from both ends', red: { cfg: c => { c.intake.dualSided = true; c.shooter.dualSided = true; } } },
  'intake-dual-wide': { group: 'intake', label: 'Front and rear intakes, full width', red: { cfg: c => { c.intake.dualSided = true; c.intake.width = c.width; } } },

  // Launch accuracy and intake reliability.
  'acc-x1': { group: 'accuracy', label: 'Launch spread x1 (baseline)' },
  'acc-x3': { group: 'accuracy', label: 'Launch spread x3', red: { cfg: spread(3) } },
  'acc-x5': { group: 'accuracy', label: 'Launch spread x5', red: { cfg: spread(5) } },
  'acc-x8': { group: 'accuracy', label: 'Launch spread x8', red: { cfg: spread(8) } },
  'acc-x5-flowers': { group: 'accuracy', label: 'Launch spread x5, FLOWERS from 45 s', red: { cfg: spread(5), flowerStart: [45, 45] } },
  'acc-x8-flowers': { group: 'accuracy', label: 'Launch spread x8, FLOWERS from 45 s', red: { cfg: spread(8), flowerStart: [45, 45] } },
  'intake-80': { group: 'accuracy', label: 'Intake succeeds 80% of the time', red: { cfg: c => { c.intake.successP = 0.8; } } },
  'intake-60': { group: 'accuracy', label: 'Intake succeeds 60% of the time', red: { cfg: c => { c.intake.successP = 0.6; } } },

  // AUTO choreography between the right robot and the left robot.
  'auto-harvest': { group: 'auto', label: 'right_harvest and left_harvest (baseline)' },
  'auto-cycle': { group: 'auto', label: 'right_cycle and left_cycle: lane sweeps, no wall sweeps', red: { auto: ['right_cycle', 'left_cycle'] } },
  'auto-harvest-right-only': { group: 'auto', label: 'right_harvest with left_cycle', red: { auto: ['right_harvest', 'left_cycle'] } },
  'auto-naive': { group: 'auto', label: 'Both robots run the solo script', red: { auto: ['cycle_and_park', 'cycle_and_park'] } },
  'auto-solo-leave': { group: 'auto', label: 'Right robot solo script, left robot only parks', red: { auto: ['cycle_and_park', 'leave_only'] } },
  'auto-leave-leave': { group: 'auto', label: 'Both robots only LEAVE and PARK', red: { auto: ['leave_only', 'leave_only'] } },
  'auto-none': { group: 'auto', label: 'No AUTO at all', red: { auto: ['none', 'none'] } },

  // Follower tuning with active braking. These apply to all four robots, so read red plus blue.
  'follow-30-12': { group: 'follow', label: 'Brake 3.0 m/s², gain 1.2 (new default)', global: { decel: 3.0, kv: 1.2 } },
  'follow-22-12': { group: 'follow', label: 'Brake 2.2 m/s², gain 1.2', global: { decel: 2.2, kv: 1.2 } },
  'follow-40-12': { group: 'follow', label: 'Brake 4.0 m/s², gain 1.2', global: { decel: 4.0, kv: 1.2 } },
  'follow-50-12': { group: 'follow', label: 'Brake 5.0 m/s², gain 1.2', global: { decel: 5.0, kv: 1.2 } },
  'follow-40-06': { group: 'follow', label: 'Brake 4.0 m/s², gain 0.6', global: { decel: 4.0, kv: 0.6 } },
  'follow-40-25': { group: 'follow', label: 'Brake 4.0 m/s², gain 2.5', global: { decel: 4.0, kv: 2.5 } },

  // Path settings. These apply to all four robots, so read the combined score.
  'path-base': { group: 'path', label: 'Baseline: 8 cm buffer, 3.0 m/s² planned braking' },
  'path-margin-4': { group: 'path', label: '4 cm obstacle buffer', global: { margin: 0.04 } },
  'path-margin-12': { group: 'path', label: '12 cm obstacle buffer', global: { margin: 0.12 } },
  'path-look-far': { group: 'path', label: 'Longer pure-pursuit lookahead (0.35 m)', global: { lookahead: 0.35 } },
  'path-standoff-near': { group: 'path', label: 'Launch from the closest scoring spot', global: { standoff: 0.05 } },
  'path-standoff-far': { group: 'path', label: 'Launch from the farthest scoring spot', global: { standoff: 0.9 } },
};
