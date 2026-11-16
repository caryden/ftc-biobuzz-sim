/**
 * The robot camera: what a Limelight on the selected robot sees, drawn in a panel, with the ball labels that a ball
 * detector would be scored against. It renders the page's scene from the camera into a 640 x 480 target, and a
 * second, smaller pass with each ball in its own flat color gives how much of each ball is in sight. Save frame
 * downloads the image and its labels, for training and testing a detector.
 */
import * as THREE from 'three';
import { FIELD } from '../sim/config';
import type { BallKind, Sim } from '../sim/world';

/** The Limelight 3A at 640 x 480: a 620 px focal length, about 54.5 degrees wide. */
export const INTRINSICS = { fx: 620, fy: 620, cx: 320, cy: 240, width: 640, height: 480 };
/** The pollen detector's range limit, in meters. */
const MAX_RANGE = 3.5;
/** The size of the visibility pass, a quarter of the image's pixels. */
const ID_W = 320, ID_H = 240;

export type Mount = 'pollen' | 'tags';

/** A ball the camera might see: its mesh, with `userData.kind` and `userData.id`. */
export interface BallMesh { mesh: THREE.Object3D; kind: BallKind; id: number; inFlower: boolean }

export interface BallLabel {
  id: number; kind: BallKind;
  /** The projected center and the equivalent radius, in pixels. */
  center: [number, number]; radius: number;
  /** Meters from the camera to the ball's center. */
  range: number;
  /** The fraction of the ball's silhouette in sight, and the fraction inside the image. */
  visible: number; inImage: number;
  world: [number, number, number];
  /** A floor POLLEN outside the FLOWERS, mostly in sight and in the image, within the detector's range. */
  target: boolean;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** A flat color that is exactly `n` in the visibility pass: linear, so no color management, and not tone mapped. */
function idMaterial(n: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ toneMapped: false });
  m.color.setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, THREE.LinearSRGBColorSpace);
  return m;
}

/** The moment and the camera pose of one image: what the saved labels say about it besides the balls. */
export interface Shot { t: number; plate: string; mount: Mount; position: [number, number, number]; yaw: number; pitch: number }

/** The camera on the robot that `sim` stands for, as `mount` says, at the sim's time. `plates` holds each robot's number plate. */
export function shotOf(sim: Sim, mount: Mount, plates: string[]): Shot {
  const p = sim.robot.translation(), h = sim.heading, cfg = sim.cfg, r = sim.robots[sim.me];
  const fwd = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
  let f: number, l: number, up: number, yaw: number, pitch: number;
  if (mount === 'pollen') {
    // The pollen camera: at the intake end, 0.30 m up, 20 degrees down. ASSUMPTION: the turret team's placeholder mount.
    f = cfg.length / 2 - 0.03; l = 0; up = 0.3; yaw = 0; pitch = (20 * Math.PI) / 180;
  } else {
    // The AprilTag camera from the robot's config: toward the shooter end, looking up at the raised CELL.
    const rear = cfg.shooter.facing === 'rear', s = rear ? -1 : 1, o = cfg.camera.offset;
    f = s * o[0]; l = s * o[1]; up = o[2]; yaw = rear ? Math.PI : 0; pitch = -(cfg.camera.pitchDeg * Math.PI) / 180;
  }
  const pos = new THREE.Vector3(p.x, 0, p.z).addScaledVector(fwd, f).addScaledVector(left, l).setY(up);
  return { t: sim.time, plate: plates[sim.me] ?? `${r.alliance === 'red' ? 'R' : 'B'}${r.slot}`, mount, position: [pos.x, pos.y, pos.z], yaw: h + yaw, pitch };
}

/** Points `camera` as `shot` says: `yaw` counterclockwise from +x seen from above, and `pitch` down. */
export function aim(camera: THREE.Camera, shot: Pick<Shot, 'position' | 'yaw' | 'pitch'>) {
  const { yaw: a, pitch } = shot, pos = new THREE.Vector3(...shot.position);
  camera.position.copy(pos); camera.up.set(0, 1, 0);
  camera.lookAt(pos.clone().add(new THREE.Vector3(Math.cos(a) * Math.cos(pitch), -Math.sin(pitch), -Math.sin(a) * Math.cos(pitch)))); camera.updateMatrixWorld();
}

/** The saved files' name without the extension, and the labels JSON, in the native app's `bench export` format. */
export function frameFiles(shot: Shot, labels: BallLabel[]) {
  const stem = `${shot.plate}_t${String(Math.round(shot.t * 1000)).padStart(6, '0')}_${shot.mount}`;
  const meta = {
    file: `${stem}.png`, t: r4(shot.t), mount: shot.mount,
    camera: { position: shot.position.map(r4), yaw: r4(shot.yaw), pitch_down: r4(shot.pitch), intrinsics: INTRINSICS },
    balls: labels.map(l => ({ id: l.id, kind: l.kind, center: l.center, radius: l.radius, range: l.range, visible: l.visible, in_image: l.inImage, world: l.world, target: l.target })),
  };
  return { stem, meta };
}

/** Labels the balls that `camera` sees. `counts` holds each ball's pixels in the visibility pass, by its index in `balls`. */
export function labelBalls(camera: THREE.Camera, balls: BallMesh[], counts: Map<number, number>): BallLabel[] {
  const k = INTRINSICS, view = camera.matrixWorldInverse, out: BallLabel[] = [], sx = ID_W / k.width;
  balls.forEach((b, i) => {
    const w = new THREE.Vector3(); b.mesh.getWorldPosition(w);
    const c = w.clone().applyMatrix4(view), depth = -c.z, r = b.kind === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius;
    if (depth <= 0.03) return;
    const u = k.cx + (k.fx * c.x) / depth, v = k.cy - (k.fy * c.y) / depth, rp = (k.fx * r) / depth;
    if (u + rp < 0 || u - rp > k.width || v + rp < 0 || v - rp > k.height) return;
    // The silhouette's pixels at the visibility pass's scale, all of them and those inside the image.
    const ru = rp * sx, cu = u * sx, cv = v * sx;
    let all = 0, inside = 0;
    for (let y = Math.floor(cv - ru); y <= Math.ceil(cv + ru); y++) for (let x = Math.floor(cu - ru); x <= Math.ceil(cu + ru); x++) {
      if ((x + 0.5 - cu) ** 2 + (y + 0.5 - cv) ** 2 > ru * ru) continue;
      all++; if (x >= 0 && y >= 0 && x < ID_W && y < ID_H) inside++;
    }
    if (!inside) return;
    const visible = Math.min(1, (counts.get(i) ?? 0) / inside), inImage = inside / Math.max(all, 1), range = w.distanceTo(camera.position);
    const target = b.kind === 'pollen' && !b.inFlower && w.y < r + 0.03 && visible >= 0.5 && inImage >= 0.5 && range <= MAX_RANGE;
    out.push({ id: b.id, kind: b.kind, center: [r4(u), r4(v)], radius: r4(rp), range: r4(range), visible: r4(visible), inImage: r4(inImage), world: [r4(w.x), r4(w.y), r4(w.z)], target });
  });
  return out;
}

export class RobotCamera {
  readonly camera = new THREE.PerspectiveCamera((2 * Math.atan(INTRINSICS.cy / INTRINSICS.fy) * 180) / Math.PI, INTRINSICS.width / INTRINSICS.height, 0.03, 30);
  labels: BallLabel[] = [];
  mount: Mount = 'pollen';
  private target = new THREE.WebGLRenderTarget(INTRINSICS.width, INTRINSICS.height);
  private idTarget = new THREE.WebGLRenderTarget(ID_W, ID_H);
  private pixels = new Uint8Array(INTRINSICS.width * INTRINSICS.height * 4);
  private idPixels = new Uint8Array(ID_W * ID_H * 4);
  private image: ImageData;
  private black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  private idMats: THREE.MeshBasicMaterial[] = [];
  private frame = 0;
  /** The moment and the pose of the image on screen. */
  shot: Shot | null = null;

  constructor(private canvas: HTMLCanvasElement, private overlay: HTMLCanvasElement) {
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    canvas.width = overlay.width = INTRINSICS.width; canvas.height = overlay.height = INTRINSICS.height;
    this.image = new ImageData(INTRINSICS.width, INTRINSICS.height);
  }

  /**
   * Renders the camera's image and, every few frames, the labels. `hide` are the objects the camera must not see: the
   * robot it rides on and the page's overlays. `clear` are the see-through panels, which don't block the view.
   */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sim: Sim, plates: string[], hide: THREE.Object3D[], clear: THREE.Object3D[], balls: BallMesh[], force = false) {
    this.frame++;
    if (!force && this.frame % 2) return;
    const was = hide.map(o => o.visible); hide.forEach(o => { o.visible = false; });
    const shot = shotOf(sim, this.mount, plates); aim(this.camera, shot);
    renderer.setRenderTarget(this.target); renderer.render(scene, this.camera);
    renderer.readRenderTargetPixels(this.target, 0, 0, INTRINSICS.width, INTRINSICS.height, this.pixels);
    const visible = force || this.frame % 4 === 0 ? this.visibility(renderer, scene, clear, balls) : null;
    renderer.setRenderTarget(null);
    hide.forEach((o, i) => { o.visible = was[i]; });
    // The target's rows run bottom to top.
    const w4 = INTRINSICS.width * 4;
    for (let y = 0; y < INTRINSICS.height; y++) this.image.data.set(this.pixels.subarray((INTRINSICS.height - 1 - y) * w4, (INTRINSICS.height - y) * w4), y * w4);
    this.canvas.getContext('2d')!.putImageData(this.image, 0, 0);
    if (visible) this.labels = labelBalls(this.camera, balls, visible);
    this.shot = shot;
    this.drawOverlay();
  }

  /** Counts each ball's pixels in a pass where the field is black and each ball has its own color. */
  private visibility(renderer: THREE.WebGLRenderer, scene: THREE.Scene, clear: THREE.Object3D[], balls: BallMesh[]): Map<number, number> {
    const clearWas = clear.map(o => o.visible); clear.forEach(o => { o.visible = false; });
    renderer.setRenderTarget(this.idTarget);
    scene.overrideMaterial = this.black; const bg = scene.background; scene.background = null;
    const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, this.camera);
    renderer.setClearColor(clearColor, clearAlpha);
    scene.overrideMaterial = null;
    // Second pass: only the balls, each in its own color, depth-tested against the first.
    const saved = balls.map(b => (b.mesh as THREE.Mesh).material);
    balls.forEach((b, i) => { while (this.idMats.length <= i) this.idMats.push(idMaterial(this.idMats.length + 1)); (b.mesh as THREE.Mesh).material = this.idMats[i]; b.mesh.layers.enable(1); });
    const autoClear = renderer.autoClear; renderer.autoClear = false; this.camera.layers.set(1);
    renderer.render(scene, this.camera);
    this.camera.layers.set(0); renderer.autoClear = autoClear;
    balls.forEach((b, i) => { (b.mesh as THREE.Mesh).material = saved[i]; b.mesh.layers.disable(1); });
    scene.background = bg; clear.forEach((o, i) => { o.visible = clearWas[i]; });
    renderer.readRenderTargetPixels(this.idTarget, 0, 0, ID_W, ID_H, this.idPixels);
    const counts = new Map<number, number>();
    for (let k = 0; k < this.idPixels.length; k += 4) {
      const v = (this.idPixels[k] << 16) | (this.idPixels[k + 1] << 8) | this.idPixels[k + 2];
      if (v > 0) counts.set(v - 1, (counts.get(v - 1) ?? 0) + 1);
    }
    return counts;
  }

  /** Rings on the POLLEN a detector should report, and dashed ones on floor POLLEN cut off by the image edge. */
  private drawOverlay() {
    const g = this.overlay.getContext('2d')!; g.clearRect(0, 0, this.overlay.width, this.overlay.height);
    g.lineWidth = 2.5;
    for (const l of this.labels) {
      if (l.kind !== 'pollen' || l.visible < 0.5) continue;
      if (!l.target && l.inImage >= 0.5) continue;
      g.setLineDash(l.target ? [] : [5, 5]); g.strokeStyle = l.target ? '#41e07f' : 'rgba(233,236,241,.55)';
      g.beginPath(); g.arc(l.center[0], l.center[1], l.radius + 4, 0, Math.PI * 2); g.stroke();
    }
    g.setLineDash([]);
  }

  /** The number of POLLEN a detector should report in the image on screen. */
  get targets(): number { return this.labels.filter(l => l.target).length; }

  /** Downloads the image on screen as a PNG and its labels as JSON, in the native app's `bench export` format. */
  save() {
    if (!this.shot) return;
    const { stem, meta } = frameFiles(this.shot, this.labels);
    const download = (href: string, name: string) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
    download(this.canvas.toDataURL('image/png'), `${stem}.png`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }));
    download(url, `${stem}.json`); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
