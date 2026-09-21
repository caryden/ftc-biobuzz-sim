import type { Inputs } from './sim/world';

const pressed = new Set<string>();
addEventListener('keydown', e => { if (!e.repeat) pressed.add(e.code); });

const shape = (v: number) => { const d = 0.08, a = Math.abs(v); return a < d ? 0 : Math.sign(v) * ((a - d) / (1 - d)) ** 2; };
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const startWas: boolean[] = [], viewWas: boolean[] = [];

/** One controller's state. `id` is the name that the browser reports for it. */
export interface PadState { inputs: Inputs; id: string }
export interface Frame {
  /** Controller 1 and controller 2: the first two connected gamepads in the browser's order. Null means not connected. */
  pads: [PadState | null, PadState | null];
  start: boolean; reset: boolean; camera: boolean; mark: boolean; review: boolean;
}

/**
 * Reads the first two connected gamepads (standard mapping) and the app keys. Robots are driven only with controllers.
 * Left stick: forward/back and strafe. Right stick X: turn. LB: shoot NECTAR. RB: shoot POLLEN. LT: place POLLEN in a
 * FLOWER. RT: place NECTAR in a FLOWER. Start on either controller starts the MATCH, and View cycles the camera.
 * Keys: Enter starts, R resets, C cycles the camera, M marks a moment, and V opens the review.
 */
export function readInput(): Frame {
  let start = pressed.has('Enter'), camera = pressed.has('KeyC');
  const reset = pressed.has('KeyR'), mark = pressed.has('KeyM'), review = pressed.has('KeyV'); pressed.clear();
  const connected = [...navigator.getGamepads()].filter((g): g is Gamepad => !!g && g.connected).slice(0, 2);
  const pads = [0, 1].map(i => {
    const pad = connected[i]; if (!pad) return null; const b = (n: number) => (pad.buttons[n]?.value ?? 0) > 0.4;
    if (b(9) && !startWas[i]) start = true; startWas[i] = b(9);
    if (b(8) && !viewWas[i]) camera = true; viewWas[i] = b(8);
    return { id: pad.id, inputs: { forward: clamp(shape(-pad.axes[1])), strafeRight: clamp(shape(pad.axes[0])), turnRight: clamp(shape(pad.axes[2]) * 0.85), shootNectar: b(4), shootPollen: b(5), placePollen: b(6), placeNectar: b(7) } };
  }) as [PadState | null, PadState | null];
  return { pads, start, reset, camera, mark, review };
}
