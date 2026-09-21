import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { BALL, FIELD, HIVE, HIVE_DYN } from '../src/sim/config';
import { GROUP, Hive, groups } from '../src/sim/hive';

const DT = 1 / 240;
type Kind = 'pollen' | 'nectar';

/** Runs one row of Event Field Setup Guide section 12.3 and reports whether the hive tipped. */
export function runRow(placed: Kind[], last: Kind, toss: boolean, comHeight = HIVE_DYN.comHeight): boolean {
  const dyn = { ...HIVE_DYN, comHeight };
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT; world.numSolverIterations = 8;
  const hive = new Hive(RAPIER, world, 'red', 'audience', dyn);
  const step = (sec: number) => { for (let i = 0; i < sec / DT; i++) { hive.applyTorques(dyn); world.step(); if (hive.pollTip()) return true; } return false; };
  const ball = (k: Kind, lx: number, along: number, up: number, vel?: [number, number, number]) => {
    const r = k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius;
    // Local cell coordinates -> world, for the audience CELL raised 30 degrees.
    const phi = hive.phi, c = Math.cos(phi), s = Math.sin(phi), ly = HIVE.cellFloorY + r + up, lz = along;
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true)
      .setTranslation(HIVE.pivotX.red + lx, HIVE.pivotY + ly * c - lz * s, ly * s + lz * c)
      .setLinearDamping(BALL.linearDamping).setAngularDamping(BALL.angularDamping));
    if (vel) b.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    world.createCollider(RAPIER.ColliderDesc.ball(r).setMass(k === 'pollen' ? BALL.pollenMass : BALL.nectarMass)
      .setFriction(BALL.friction).setRestitution(BALL.restitution).setCollisionGroups(groups(GROUP.ball, 0xffff)), b);
  };
  // "Gently placed in the back of the Cell contacting the Hive Back Skin."
  let x = -HIVE.cellHalfWidth + 0.003; let tipped = false;
  const gentle = (k: Kind) => {
    const r = k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius;
    const fits = x + 2 * r <= HIVE.cellHalfWidth - 0.002;
    // A full back row sends the next ball to the second row, as on the real CELL.
    ball(k, fits ? x + r : 0, HIVE.cellBack + (fits ? r + 0.002 : 2 * FIELD.pollenRadius + r + 0.004), 0.004);
    if (fits) x += 2 * r + 0.001;
    tipped = step(0.6) || tipped;
  };
  for (const k of placed) gentle(k);
  tipped = step(1.0) || tipped;
  if (tipped) return true;
  if (!toss) gentle(last);
  // A toss: the ball enters through the opening at about 1.5 m/s toward the back skin.
  else { const phi = hive.phi; ball(last, 0.05, HIVE.cellMouth - 0.06, 0.12, [0, -1.5 * Math.sin(phi) * -1 - 0.3, -1.5 * Math.cos(phi)]); }
  return step(3.0) || tipped;
}

const N: Kind = 'nectar', P: Kind = 'pollen';
const rep = (k: Kind, n: number) => Array<Kind>(n).fill(k);

describe('hive calibration (Event Field Setup Guide 12.3)', () => {
  beforeAll(async () => { await RAPIER.init(); });
  it('3 NECTAR + 1 POLLEN, second POLLEN tossed in: no tip', () => expect(runRow([N, N, N, P], P, true)).toBe(false));
  it('3 NECTAR + 2 POLLEN, third POLLEN gently placed: tip', () => expect(runRow([N, N, N, P, P], P, false)).toBe(true));
  it('3 NECTAR + 2 POLLEN, third POLLEN tossed in: tip', () => expect(runRow([N, N, N, P, P], P, true)).toBe(true));
  it('6 POLLEN, seventh POLLEN tossed in: no tip', () => expect(runRow(rep(P, 6), P, true)).toBe(false));
  it('7 POLLEN, eighth POLLEN gently placed: tip', () => expect(runRow(rep(P, 7), P, false)).toBe(true));
  it('7 POLLEN, eighth POLLEN tossed in: tip', () => expect(runRow(rep(P, 7), P, true)).toBe(true));
});
