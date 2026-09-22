import { Defender } from './defend';
import { TELEOP_TREES, TeleopProgram } from './driver';
import { Executor } from './executor';
import { AUTO_TREES, AutoProgram, autoFor } from './onboard';
import { NO_INPUT, type Inputs, type Sim } from '../sim/world';

/**
 * Drives one robot for a program: a named AUTO tree (see `AutoProgram`) in AUTO, and the default TELEOP tree (see
 * `TeleopProgram` and src/auto/trees/teleop_default.json) in TELEOP. The robot's settings here are what the TELEOP
 * tree reads as `config`.
 */
export class Coach {
  /** The executor that the TELEOP tree's tactic leaves drive. It keeps its state across tactics. */
  executor = new Executor();
  autoRoutine = 'cycle_and_park';
  /**
   * The defense policy in TELEOP. `full`: the robot defends for the whole period (see `Defender`). `opportunistic`: the
   * robot plays its normal cycle and bumps an opponent that is lined up to launch next to it. Default: none.
   */
  defense: 'none' | 'full' | 'opportunistic' = 'none'; defender = new Defender();
  /** FLOWER work starts when this many seconds remain in TELEOP. Default: 0, which means TIPS only. */
  flowerStartSec = 0;
  /** The running AUTO tree, or null before AUTO. */
  auto: AutoProgram | null = null; private autoName = '';
  /** For experiments: an AUTO tree name that bypasses the partner mapping. */
  autoOverride: string | null = null;
  /** The running TELEOP tree, or null before TELEOP. */
  teleop: TeleopProgram | null = null;

  /** Gets the inputs for one physics step. Call it once per step while a program drives. */
  update(sim: Sim, dt: number): Inputs {
    // AUTO runs a tree in the onboard environment: poses, open-loop shots, and the camera, with no view of the balls or
    // other robots. An unknown name runs cycle_and_park.
    if (sim.phase === 'auto') {
      const name = this.autoOverride ?? autoFor(sim, this.autoRoutine);
      if (!this.auto || this.autoName !== name) { this.autoName = name; this.auto = new AutoProgram(AUTO_TREES[name] ?? AUTO_TREES.cycle_and_park); }
      return this.auto.update(sim, dt);
    }
    // The planner runs only in TELEOP. In the transition the sim ignores every command, so a running executor would
    // see no progress, report a stall, and start TELEOP with its first goals on the skip list.
    if (sim.phase !== 'teleop') return NO_INPUT;
    return (this.teleop ??= new TeleopProgram(TELEOP_TREES.teleop_default, this)).update(sim, dt);
  }
}
