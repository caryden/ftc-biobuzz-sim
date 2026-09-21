import { Defender } from './defend';
import { Executor } from './executor';
import { scriptedTeleop } from './policy';
import { ScriptRunner, autoFor, buildScripts, type ScriptTuning } from './script';
import { NO_INPUT, type Inputs, type Sim } from '../sim/world';

/**
 * Drives one robot for a program: a named AUTO script (see `ScriptRunner`) in AUTO, and the scripted policy
 * (`scriptedTeleop`) in TELEOP. The policy picks a tactic when the running tactic finishes and at least once per second.
 */
export class Coach {
  executor = new Executor();
  autoRoutine = 'cycle_and_park';
  /**
   * The defense policy in TELEOP. `full`: the robot defends for the whole period (see `Defender`). `opportunistic`: the
   * robot plays its normal cycle and bumps an opponent that is lined up to launch next to it. Default: none.
   */
  defense: 'none' | 'full' | 'opportunistic' = 'none'; defender = new Defender();
  /** FLOWER work starts when this many seconds remain in TELEOP. Default: 0, which means TIPS only. */
  flowerStartSec = 0;
  private nextReview = 0; private t = 0;
  script: ScriptRunner | null = null; private scriptName = '';
  /** For experiments: a script name that bypasses the partner mapping, and the choreography tuning. */
  autoOverride: string | null = null; scriptTuning: ScriptTuning = {};

  /** Gets the inputs for one physics step. Call it once per step while a program drives. */
  update(sim: Sim, dt: number): Inputs {
    this.t += dt; const ex = this.executor;
    // AUTO runs a pure script: fixed poses and open-loop shots, with no view of the balls, the HIVE, or other robots.
    if (sim.phase === 'auto') {
      const name = this.autoOverride ?? autoFor(sim, this.autoRoutine);
      if (!this.script || this.scriptName !== name) { const all = buildScripts({ ...this.scriptTuning, length: sim.cfg.length, facing: sim.cfg.shooter.facing }); this.scriptName = name; this.script = new ScriptRunner(all[name] ?? all.cycle_and_park); }
      return this.script.update(sim, dt);
    }
    // The planner runs only in TELEOP. In the transition the sim ignores every command, so a running executor would
    // see no progress, report a stall, and start TELEOP with its first goals on the skip list.
    if (sim.phase !== 'teleop') return NO_INPUT;
    if (this.defense === 'full') return this.defender.update(sim, dt);
    ex.opportunistic = this.defense === 'opportunistic';
    ex.nectarReserve = sim.timer < 75 ? 1 : 0; // Near the endgame, always keep a NECTAR for a FLOWER cap.
    if (ex.status !== 'in_progress' || this.t >= this.nextReview) { const d = scriptedTeleop(sim, this.flowerStartSec, ex.avoidedFlowers()); ex.setTactic(d.tactic, d.flower); this.nextReview = this.t + 1; }
    return ex.update(sim, dt);
  }
}
