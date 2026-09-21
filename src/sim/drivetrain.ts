import type { RobotConfig } from './config';

/** Driver command. Each axis is in [-1, 1]. */
export interface DriveCommand { forward: number; strafeRight: number; turnRight: number }
/** Chassis velocity in the robot frame: forward m/s, left m/s, counterclockwise rad/s. */
export interface BodyVel { vf: number; vl: number; w: number }
export interface DriveOutput { forceF: number; forceL: number; torque: number; busVoltage: number; currents: number[] }

/**
 * Computes the net wheel force on a mecanum chassis for one instant.
 *
 * Each wheel has a linear DC motor model (torque falls linearly with speed),
 * a shared battery with internal resistance, and a traction limit. Wheel speed
 * is tied to chassis speed (no-slip inverse kinematics), so back-EMF limits the
 * top speed and brakes the robot when the command is zero (BRAKE mode).
 */
export function mecanumForces(cfg: RobotConfig, cmd: DriveCommand, vel: BodyVel): DriveOutput {
  const k = cfg.halfWheelbase + cfg.halfTrack, r = cfg.wheelRadius;
  const d = cmd.forward, l = -cmd.strafeRight, w = -cmd.turnRight;
  // Wheel order: front-left, front-right, rear-left, rear-right.
  let p = [d - l - w, d + l + w, d + l - w, d - l + w];
  const max = Math.max(1, ...p.map(Math.abs));
  p = p.map(v => v / max);
  const wheelW = [
    (vel.vf - vel.vl - k * vel.w) / r, (vel.vf + vel.vl + k * vel.w) / r,
    (vel.vf + vel.vl - k * vel.w) / r, (vel.vf - vel.vl + k * vel.w) / r,
  ];
  const m = cfg.motor;
  const R = 12 / m.stallCurrent;
  const kt = m.stallTorque / m.stallCurrent;
  const ke = (12 - m.freeCurrent * R) / (m.freeRpm * 2 * Math.PI / 60);
  // Bus voltage sags with the current drawn from the battery. Two fixed-point passes.
  let v = cfg.battery.openCircuitV; let cur = [0, 0, 0, 0];
  for (let it = 0; it < 3; it++) {
    cur = p.map((pi, i) => (v * pi - ke * wheelW[i]) / R);
    // A motor draws battery current in proportion to its duty cycle.
    const draw = cur.reduce((a, c, i) => a + Math.max(0, c * p[i]), 0);
    v = cfg.battery.openCircuitV - cfg.battery.resistance * draw;
  }
  const normal = cfg.mass * 9.81 / 4;
  const f = cur.map(c => {
    const force = kt * c * cfg.gearEfficiency / r;
    return Math.max(-cfg.wheelMu * normal, Math.min(cfg.wheelMu * normal, force));
  });
  return {
    forceF: f[0] + f[1] + f[2] + f[3],
    forceL: (-f[0] + f[1] + f[2] - f[3]) * cfg.strafeEfficiency,
    torque: k * (-f[0] + f[1] - f[2] + f[3]),
    busVoltage: v, currents: cur,
  };
}
