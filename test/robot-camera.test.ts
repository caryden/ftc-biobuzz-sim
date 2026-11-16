import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { aim, frameFiles, labelBalls, shotOf, type BallMesh } from '../src/render/robot-camera';
import { DEFAULT_ROBOT } from '../src/sim/config';
import { assignDriver, defaultBot, focusRobot } from '../src/setup';
import type { Sim } from '../src/sim/world';
import { frameAsSim, type Frame, type Trace } from '../src/trace';
import SCENES from './robot-camera-scenes.json';

const template = { me: 0, robots: [0, 1, 2, 3].map(() => ({ cfg: DEFAULT_ROBOT })) } as unknown as Sim;
const frame = (t: number, robots: [string, number, number, number][]) =>
  ({ t, flowers: [], hives: { red: { phi: 0 }, blue: { phi: 0 } }, robots: robots.map(([id, x, z, h]) => ({ id, x, z, h, carried: [] })) }) as unknown as Frame;
const trace = { flowerSites: [], frames: [
  frame(1.2, [['R0', 0.5, -0.25, 0], ['R1', -1, 1, 0], ['B0', 1.5, 0, 3.14], ['B1', 1.5, 1, 3.14]]),
  frame(3.4, [['R0', 1, 0, 3.14], ['R1', -1, 0.5, 0], ['B0', 1.5, 0, 3.14], ['B1', 1.5, 1, 3.14]]),
] } as unknown as Trace;

describe('robot camera replay', () => {
  it('names and labels each replay frame with its own recorded time and pose', () => {
    const saved = [0, 1].map(i => frameFiles(shotOf(frameAsSim(trace, i, template), 'pollen', []), []));
    expect(saved.map(s => s.stem)).toEqual(['R0_t001200_pollen', 'R0_t003400_pollen']);
    expect(saved.map(s => [s.meta.t, s.meta.camera.position, s.meta.camera.yaw])).toEqual([
      [1.2, [0.685, 0.3, -0.25], 0],
      [3.4, [0.815, 0.3, -0.0003], 3.14],
    ]);
  });

  it("shows and saves R1's camera, plate, and time when a person drives R1", () => {
    const bots = [0, 1, 2, 3].map(defaultBot); bots[1].plate = '23511'; assignDriver(bots, 1, 'pad1');
    const sim = frameAsSim(trace, 0, { ...template, me: focusRobot(bots) } as Sim);
    const { stem, meta } = frameFiles(shotOf(sim, 'pollen', bots.map(b => b.plate)), []);
    expect(stem).toBe('23511_t001200_pollen');
    expect([meta.t, meta.camera.position, meta.camera.yaw]).toEqual([1.2, [-0.815, 0.3, 1], 0]);
  });
});

/** Labels a scene of robot-camera-scenes.json, given each ball's pixels in the visibility pass, in the order of its balls. */
function labelScene(name: keyof typeof SCENES, pixels: number[]) {
  const scene = SCENES[name], camera = new THREE.PerspectiveCamera(); aim(camera, scene.camera as Parameters<typeof aim>[1]);
  const balls = scene.balls.map(b => { const mesh = new THREE.Object3D(); mesh.position.fromArray(b.world); return { ...b, mesh } as BallMesh; });
  return labelBalls(camera, balls, new Map(pixels.map((n, i) => [i, n])));
}

// The pixel counts are what the visibility pass rendered for each scene in headless Chrome, with the CAD POLLEN of
// public/balls.gltf. Unhidden, that POLLEN renders 620 pixels where the circle has 640.
describe('ball labels', () => {
  it('labels a centered POLLEN a little short of fully visible', () => {
    expect(labelScene('centered', [620])).toEqual([
      { id: 1, kind: 'pollen', center: [320, 240.0117], radius: 28.5168, range: 0.7731, visible: 0.9688, inImage: 1, world: [0.7265, 0.0356, 0], target: true },
    ]);
  });
  it('labels a POLLEN cut by the image edge', () => {
    // Off axis, the rendered ball is wider than the circle: 385 pixels in the image against the circle's 362, so `visible` is clamped to 1.
    expect(labelScene('edge-clipped', [385])).toEqual([
      { id: 1, kind: 'pollen', center: [636.7641, 240.0117], radius: 28.5168, range: 0.8682, visible: 1, inImage: 0.5674, world: [0.7265, 0.0356, 0.395], target: true },
    ]);
  });
  it('labels a POLLEN half hidden by a nearer one as hidden', () => {
    // Exactly half of the far ball's 620 rendered pixels show, but against the circle's 640 that is under 0.5.
    expect(labelScene('partly occluded', [310, 785])).toEqual([
      { id: 1, kind: 'pollen', center: [320, 240.0117], radius: 28.5168, range: 0.7731, visible: 0.4844, inImage: 1, world: [0.7265, 0.0356, 0], target: false },
      { id: 2, kind: 'pollen', center: [320, 266.5255], radius: 31.8672, range: 0.6925, visible: 0.9813, inImage: 1, world: [0.64, 0.0356, 0], target: true },
    ]);
  });
});
