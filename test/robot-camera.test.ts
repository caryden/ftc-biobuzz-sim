import { describe, expect, it } from 'vitest';
import { frameFiles, shotOf } from '../src/render/robot-camera';
import { DEFAULT_ROBOT } from '../src/sim/config';
import { assignDriver, defaultBot, focusRobot } from '../src/setup';
import type { Sim } from '../src/sim/world';
import { frameAsSim, type Frame, type Trace } from '../src/trace';

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
