import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FIELD, HIVE } from '../sim/config';
import { flowerHeights, type BallKind, type Sim } from '../sim/world';

const COLOR: Record<BallKind, number> = { pollen: 0xf2c81e, nectar_red: 0xd8261c, nectar_blue: 0x1f4fd8 };
export const CAMERAS = ['driver', 'overhead', 'chase', 'audience'] as const;
export type CameraMode = (typeof CAMERAS)[number];
/** The distance from a drive handle to its heading knob, in meters. */
export const KNOB = 0.3;

/** Draws the simulation with three.js. The official field CAD supplies every FIELD element mesh. */
export class View {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(58, 1, 0.05, 40);
  mode: CameraMode = 'driver';
  /** The number plate text of each robot, in `sim.robots` order. A missing entry shows the alliance letter and the slot. */
  plates: string[] = [];
  /** Pixels at the left edge that a panel covers. The overhead camera centers the FIELD in the rest of the window. */
  insetLeft = 0;
  private ballGeo: Record<'pollen' | 'nectar', THREE.BufferGeometry> = { pollen: new THREE.SphereGeometry(FIELD.pollenRadius, 20, 14), nectar: new THREE.SphereGeometry(FIELD.nectarRadius, 20, 14) };
  private ballMat = new Map<BallKind, THREE.Material>();
  private ballMeshes = new Map<number, THREE.Mesh>();
  private staticBalls = new THREE.Group();
  private robotGroups: THREE.Group[] = [];
  private hiveNodes: { red?: THREE.Object3D; blue?: THREE.Object3D } = {};
  private pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x3ab7ff }));
  private autoLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffa726, dashSize: 0.08, gapSize: 0.05 }));
  private autoPoses = new THREE.Group(); private autoKey = '';
  private otherLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffa726, dashSize: 0.05, gapSize: 0.06, transparent: true, opacity: 0.35 })); private otherKey = '';
  private arc: THREE.Line; private arcMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  private staticKey = ''; private chaseAngle: number | null = null;

  constructor(canvas: HTMLCanvasElement, private onProgress: (msg: string | null) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x14171c);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-2, 6, 3); this.scene.add(sun);
    // The balls have holes, so the inside of the far wall shows through: both faces are drawn.
    for (const k of Object.keys(COLOR) as BallKind[]) this.ballMat.set(k, new THREE.MeshStandardMaterial({ color: COLOR[k], roughness: 0.45, side: THREE.DoubleSide }));
    this.buildFloor(); this.buildAxisLabels();
    this.scene.add(this.staticBalls);
    this.arc = new THREE.Line(new THREE.BufferGeometry(), this.arcMat); this.arc.frustumCulled = false; this.pathLine.frustumCulled = false; this.autoLine.frustumCulled = false; this.otherLine.frustumCulled = false; this.scene.add(this.arc, this.pathLine, this.autoLine, this.autoPoses, this.otherLine);
    this.loadField(); this.loadBalls();
    addEventListener('resize', () => this.resize()); this.resize();
  }

  private resize() { const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  private buildFloor() {
    const venue = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 1 }));
    venue.rotation.x = -Math.PI / 2; venue.position.y = -0.016; this.scene.add(venue);
    const s = FIELD.half * 2, tiles = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.95 }));
    tiles.rotation.x = -Math.PI / 2; tiles.position.y = -0.0005; this.scene.add(tiles);
    const pts: number[] = [];
    for (let i = 1; i < 6; i++) { const p = -FIELD.half + (i * s) / 6; pts.push(p, 0.0002, -FIELD.half, p, 0.0002, FIELD.half, -FIELD.half, 0.0002, p, FIELD.half, 0.0002, p); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x34383f })));
  }

  private loadField() {
    this.onProgress('Loading the field CAD…');
    new GLTFLoader().load('/field.glb', gltf => {
      gltf.scene.traverse(o => {
        if (o.name === 'hive_red') this.hiveNodes.red = o; if (o.name === 'hive_blue') this.hiveNodes.blue = o;
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
          // The CAD perimeter panels are opaque. Real panels are clear polycarbonate.
          const mat = m.material as THREE.MeshStandardMaterial;
          if (o.parent?.name === 'perimeter' || o.name === 'perimeter') { const c = mat.color; if (c.r > 0.4 && c.g > 0.4) { mat.transparent = true; mat.opacity = 0.22; mat.depthWrite = false; } }
        }
      });
      this.scene.add(gltf.scene); this.onProgress(null);
    }, e => { if (e.total) this.onProgress(`Loading the field CAD… ${Math.round((100 * e.loaded) / e.total)}%`); },
    () => this.onProgress('The field CAD did not load. Run: node scripts/convert-step.mjs'));
  }

  /**
   * Loads the real POLLEN and NECTAR models from the field CAD (public/balls.gltf, written by scripts/convert-balls.mjs)
   * and swaps them in for the smooth spheres. If the file is missing, the spheres stay.
   */
  private loadBalls() {
    new GLTFLoader().load('/balls.gltf', gltf => {
      for (const kind of ['pollen', 'nectar'] as const) {
        const mesh = gltf.scene.getObjectByName(kind) as THREE.Mesh | undefined; if (!mesh?.isMesh) continue;
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
        const old = this.ballGeo[kind]; this.ballGeo[kind] = mesh.geometry;
        this.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry === old) m.geometry = mesh.geometry; });
      }
    }, undefined, () => { /* The spheres stay. */ });
  }

  private buildRobot(): THREE.Group {
    const group = new THREE.Group();
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.6 })); chassis.name = 'chassis'; group.add(chassis);
    // The intake bar is green while the hopper has room and orange when it is full. A dual-sided intake shows a second bar at the rear.
    const intakeMat = new THREE.MeshStandardMaterial({ color: 0x3ad17a, emissive: 0x0c4022 });
    for (const name of ['intake', 'intakeRear']) { const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), intakeMat); bar.name = name; group.add(bar); }
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 3), new THREE.MeshStandardMaterial({ color: 0xffffff })); arrow.name = 'arrow'; arrow.rotation.z = -Math.PI / 2; group.add(arrow);
    const wheelGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.038, 18), wheelMat = new THREE.MeshStandardMaterial({ color: 0x15171a });
    for (let i = 0; i < 4; i++) { const w = new THREE.Mesh(wheelGeo, wheelMat); w.name = `wheel${i}`; w.rotation.x = Math.PI / 2; group.add(w); }
    const carried = new THREE.Group(); carried.name = 'carried'; group.add(carried);
    // Two number plates on opposite sides of the robot, as the FTC robot rules require. `syncRobot` places them and draws the text.
    const plateMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(document.createElement('canvas')) });
    for (let i = 0; i < 2; i++) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), plateMat); pl.name = `plate${i}`; group.add(pl); }
    this.scene.add(group); return group;
  }

  /** Draws the plate text in white on the alliance color. The texture is redrawn only when the text or the alliance changes. */
  private drawPlate(group: THREE.Group, text: string, alliance: string) {
    const key = `${text}|${alliance}`; if (group.userData.plate === key) return; group.userData.plate = key;
    const mat = (group.getObjectByName('plate0') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material, cv = mat.map!.image as HTMLCanvasElement; cv.width = 256; cv.height = 96;
    const g = cv.getContext('2d')!; g.fillStyle = alliance === 'red' ? '#d8261c' : '#1f4fd8'; g.fillRect(0, 0, 256, 96); g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(3, 3, 250, 90);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; let px = 72; do { g.font = `800 ${px}px ui-sans-serif, system-ui, sans-serif`; px -= 4; } while (g.measureText(text).width > 230 && px > 20);
    g.fillText(text, 128, 52); mat.map!.needsUpdate = true;
  }

  private syncRobot(group: THREE.Group, sim: Sim, plate: string) {
    const c = sim.cfg, p = sim.robot.translation(), th = sim.heading;
    group.position.set(p.x, 0, p.z); group.rotation.y = th;
    const ch = group.getObjectByName('chassis') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    ch.material.color.set(sim.alliance === 'red' ? 0x9c231d : 0x1d3f9c); ch.scale.set(c.length, c.height * 0.55, c.width - 0.09); ch.position.y = 0.03 + c.height * 0.275;
    const it = group.getObjectByName('intake')!; it.scale.set(0.02, 0.05, c.intake.width); it.position.set(c.length / 2 + 0.01, 0.05, 0);
    const rear = group.getObjectByName('intakeRear')!; rear.visible = !!c.intake.dualSided; rear.scale.set(0.02, 0.05, c.intake.width); rear.position.set(-c.length / 2 - 0.01, 0.05, 0);
    (it as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.color.set(sim.carried.length >= c.capacity ? 0xd1833a : 0x3ad17a);
    group.getObjectByName('arrow')!.position.set(c.length / 2 - 0.09, 0.03 + c.height * 0.55 + 0.005, 0);
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b], i) => group.getObjectByName(`wheel${i}`)!.position.set(a * c.halfWheelbase, 0.052, b * c.halfTrack));
    // The plates sit just outside the two side faces. The front has the intake and the rear has the shooter.
    this.drawPlate(group, plate, sim.alliance); const py = 0.03 + c.height * 0.33, hz = (c.width - 0.09) / 2 + 0.002;
    ([[0, hz, 0], [0, -hz, Math.PI]] as const).forEach(([x, z, ry], i) => { const pl = group.getObjectByName(`plate${i}`)!; pl.position.set(x, py, z); pl.rotation.y = ry; });
    const carried = group.getObjectByName('carried') as THREE.Group;
    if (carried.userData.key !== sim.carried.join()) {
      carried.userData.key = sim.carried.join(); carried.clear();
      sim.carried.forEach((k, i) => { const m = new THREE.Mesh(k === 'pollen' ? this.ballGeo.pollen : this.ballGeo.nectar, this.ballMat.get(k)); m.position.set(-0.13 + (i % 2) * 0.1 + 0.02, 0.03 + c.height * 0.55 + (k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius), (i < 2 ? -1 : 1) * 0.06); carried.add(m); });
    }
  }

  /** Projects an AUTO trajectory onto the FIELD: a dashed line, a wedge at each pose, and a ring where the robot shoots. */
  showAutoPlan(plan: { path: { x: number; z: number }[]; poses: { x: number; z: number; heading: number; shoots: boolean }[] } | null, key: string) {
    this.autoLine.visible = this.autoPoses.visible = !!plan; if (!plan || key === this.autoKey) return; this.autoKey = key;
    this.autoLine.geometry.dispose(); this.autoLine.geometry = new THREE.BufferGeometry().setFromPoints(plan.path.map(q => new THREE.Vector3(q.x, 0.008, q.z))); this.autoLine.computeLineDistances();
    this.autoPoses.clear();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa726 }), shootMat = new THREE.MeshBasicMaterial({ color: 0xff5252, side: THREE.DoubleSide });
    for (const q of plan.poses) {
      const w = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.13, 3), mat); w.rotation.set(0, q.heading, -Math.PI / 2, 'YXZ'); w.position.set(q.x, 0.01, q.z); w.scale.y = 1; this.autoPoses.add(w);
      if (q.shoots) { const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.225, 40), shootMat); ring.rotation.x = -Math.PI / 2; ring.position.set(q.x, 0.009, q.z); this.autoPoses.add(ring); }
    }
  }

  private handleGroup = new THREE.Group();
  /**
   * Draws the field editor's handles: a disc at each pose, and for a drive step a line to a knob that sets its heading.
   * A selected handle is white and larger, and an edited one has a green ring. Handles draw over the FIELD elements, so
   * that a pose under a FLOWER stays visible. Handles that can't be dragged, on a plan that isn't being edited, are
   * faint. An empty list clears them.
   */
  showHandles(list: readonly { x: number; z: number; heading?: number; kind: 'drive' | 'waypoint'; selected: boolean; edited: boolean }[], editable = true) {
    if (!this.handleGroup.parent) { this.handleGroup.renderOrder = 10; this.scene.add(this.handleGroup); }
    this.handleGroup.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh || (o as THREE.Line).isLine) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.handleGroup.clear();
    const flat = (geo: THREE.BufferGeometry, color: number, x: number, z: number, y: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: editable ? 1 : 0.6, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.renderOrder = 10; this.handleGroup.add(m); return m;
    };
    for (const h of list) {
      const color = h.selected ? 0xffffff : h.kind === 'drive' ? 0xffa726 : 0x4dd0e1, r = h.selected ? 0.085 : 0.065;
      if (h.edited) flat(new THREE.RingGeometry(r + 0.012, r + 0.03, 32), 0x41e07f, h.x, h.z, 0.021);
      flat(new THREE.CircleGeometry(r, 32), color, h.x, h.z, 0.022);
      if (h.heading === undefined) continue;
      const kx = h.x + KNOB * Math.cos(h.heading), kz = h.z - KNOB * Math.sin(h.heading);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(h.x, 0.022, h.z), new THREE.Vector3(kx, 0.022, kz)]), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: editable ? 1 : 0.6 }));
      line.renderOrder = 10; line.frustumCulled = false; this.handleGroup.add(line);
      flat(new THREE.CircleGeometry(0.035, 20), color, kx, kz, 0.023);
    }
  }

  /**
   * Gets the handle under a screen point, from the same list as `showHandles`: its index, and whether the point is on
   * its heading knob. A knob wins over a disc at the same distance. Returns null if no handle is within 16 pixels.
   */
  handleAt(clientX: number, clientY: number, list: readonly { x: number; z: number; heading?: number }[]): { index: number; part: 'pose' | 'heading' } | null {
    const px = (x: number, z: number) => { const q = new THREE.Vector3(x, 0.022, z).project(this.camera); return Math.hypot(((q.x + 1) / 2) * innerWidth - clientX, ((1 - q.y) / 2) * innerHeight - clientY); };
    let best: { index: number; part: 'pose' | 'heading' } | null = null, bestPx = 16;
    list.forEach((h, index) => {
      if (h.heading !== undefined) { const d = px(h.x + KNOB * Math.cos(h.heading), h.z - KNOB * Math.sin(h.heading)); if (d <= bestPx) { bestPx = d; best = { index, part: 'heading' }; } }
      const d = px(h.x, h.z); if (d < bestPx) { bestPx = d; best = { index, part: 'pose' }; }
    });
    return best;
  }

  /** Draws the partner's AUTO trajectory, dimmed, beside the plan that `showAutoPlan` draws. Null hides it. */
  showOtherPlan(plan: { path: { x: number; z: number }[] } | null, key: string) {
    this.otherLine.visible = !!plan; if (!plan || key === this.otherKey) return; this.otherKey = key; this.otherPath = plan.path;
    this.otherLine.geometry.dispose(); this.otherLine.geometry = new THREE.BufferGeometry().setFromPoints(plan.path.map(q => new THREE.Vector3(q.x, 0.007, q.z))); this.otherLine.computeLineDistances();
  }

  private otherPath: { x: number; z: number }[] = [];
  /** Checks whether a screen point is within 10 pixels of the dimmed path that `showOtherPlan` draws. */
  nearOtherPlan(clientX: number, clientY: number): boolean {
    if (!this.otherLine.visible) return false;
    const px = this.otherPath.map(q => { const v = new THREE.Vector3(q.x, 0.007, q.z).project(this.camera); return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight }; });
    for (let i = 1; i < px.length; i++) {
      const a = px[i - 1], b = px[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((clientX - a.x) * dx + (clientY - a.y) * dy) / l2)) : 0;
      if (Math.hypot(a.x + t * dx - clientX, a.y + t * dy - clientY) <= 10) return true;
    }
    return false;
  }

  private debugLines = new THREE.Group();
  /** Draws each robot's planned path, for the review mode. An empty list clears them. */
  showDebugPaths(list: { pts: [number, number][]; color: number }[]) {
    if (!this.debugLines.parent) this.scene.add(this.debugLines); this.debugLines.clear();
    for (const l of list) { if (l.pts.length < 2) continue; const g = new THREE.BufferGeometry().setFromPoints(l.pts.map(([x, z]) => new THREE.Vector3(x, 0.014, z))); const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: l.color })); line.frustumCulled = false; this.debugLines.add(line); }
  }

  /**
   * Gets the index of the robot at a screen point, for click-to-annotate. A click that misses every robot mesh selects
   * the robot whose projected center is within 70 pixels, because a robot at the far side of the FIELD is a small target.
   */
  pickRobot(clientX: number, clientY: number): number | null {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, 1 - (clientY / innerHeight) * 2), this.camera);
    const shown = this.robotGroups.filter(g => g.visible), hit = ray.intersectObjects(shown, true)[0];
    if (hit) { let o: THREE.Object3D = hit.object; while (o.parent && !shown.includes(o as THREE.Group)) o = o.parent; return this.robotGroups.indexOf(o as THREE.Group); }
    let best: number | null = null, bestPx = 70;
    shown.forEach(g => { const q = g.position.clone().setY(0.15).project(this.camera), d = Math.hypot(((q.x + 1) / 2) * innerWidth - clientX, ((1 - q.y) / 2) * innerHeight - clientY); if (q.z < 1 && d < bestPx) { bestPx = d; best = this.robotGroups.indexOf(g); } });
    return best;
  }

  /**
   * Gets the FIELD position under a screen point, in field coordinates in meters, or null if the point misses the
   * FIELD floor. Field y is the negative of the simulator's z axis. See `buildAxisLabels`.
   */
  pickFloor(clientX: number, clientY: number): { x: number; y: number } | null {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, 1 - (clientY / innerHeight) * 2), this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hit && Math.abs(hit.x) <= FIELD.half && Math.abs(hit.z) <= FIELD.half ? { x: hit.x, y: -hit.z } : null;
  }

  /**
   * Labels the field coordinate system on the floor outside the perimeter. The origin is the FIELD center, x runs from
   * the red wall (negative) to the blue wall, y runs from the audience wall (negative) to the rear wall, and the unit
   * is the meter. With z up, the system is right-handed, and a heading is counterclockwise from +x, seen from above.
   * The simulator's code uses three.js axes, where the floor is x and z: field y is the negative of that z.
   */
  private buildAxisLabels() {
    const label = (text: string, x: number, z: number) => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96; const g = cv.getContext('2d')!;
      g.fillStyle = 'rgba(233,236,241,0.55)'; g.font = '600 44px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 48);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.225), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, -0.01, z); this.scene.add(m);
    };
    const e = FIELD.half + 0.32;
    label('+x  blue wall', e + 0.35, 0); label('-x  red wall', -e - 0.35, 0); label('-y  audience', 0, e); label('+y  rear', 0, -e);
    const cross = new THREE.BufferGeometry(); cross.setAttribute('position', new THREE.Float32BufferAttribute([-0.06, 0.003, 0, 0.06, 0.003, 0, 0, 0.003, -0.06, 0, 0.003, 0.06], 3));
    this.scene.add(new THREE.LineSegments(cross, new THREE.LineBasicMaterial({ color: 0xe9ecf1, transparent: true, opacity: 0.5 })));
  }

  cycleCamera() { this.mode = CAMERAS[(CAMERAS.indexOf(this.mode) + 1) % CAMERAS.length]; }

  sync(sim: Sim, previewKind: 'pollen' | 'nectar' | null, path: { x: number; z: number }[] | null = null) {
    this.pathLine.visible = !!path && path.length > 1;
    if (path && path.length > 1) this.pathLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(path.flatMap(q => [q.x, 0.012, q.z]), 3));
    while (this.robotGroups.length < sim.robots.length) this.robotGroups.push(this.buildRobot());
    this.robotGroups.forEach((g, i) => { g.visible = i < sim.robots.length; if (g.visible) { const r = sim.robots[i]; this.syncRobot(g, sim.view(i), this.plates[i] ?? `${r.alliance === 'red' ? 'R' : 'B'}${r.slot}`); } });
    const p = sim.robot.translation(), th = sim.heading;

    const seen = new Set<number>();
    for (const b of sim.balls.values()) {
      let m = this.ballMeshes.get(b.id);
      if (!m) { m = new THREE.Mesh(b.kind === 'pollen' ? this.ballGeo.pollen : this.ballGeo.nectar, this.ballMat.get(b.kind)); this.ballMeshes.set(b.id, m); this.scene.add(m); }
      const t = b.body.translation(); m.position.set(t.x, t.y, t.z); seen.add(b.id);
      // The ball turns with its physics body, so its holes roll. A replayed trace has positions only.
      const q = (b.body as { rotation?: () => { x: number; y: number; z: number; w: number } }).rotation?.(); if (q) m.quaternion.set(q.x, q.y, q.z, q.w);
    }
    for (const [id, m] of this.ballMeshes) if (!seen.has(id)) { this.scene.remove(m); this.ballMeshes.delete(id); }

    const key = sim.flowers.map(f => f.stack.join()).join('|');
    if (key !== this.staticKey) {
      this.staticKey = key; this.staticBalls.clear();
      for (const f of sim.flowers) { const hs = flowerHeights(f.stack); f.stack.forEach((k, i) => { const r = k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius; const m = new THREE.Mesh(k === 'pollen' ? this.ballGeo.pollen : this.ballGeo.nectar, this.ballMat.get(k)); m.position.set(f.x, hs[i] + r, f.z); this.staticBalls.add(m); }); }
    }
    // The CAD poses the red HIVE at -30 degrees and the blue HIVE at +30 degrees.
    if (this.hiveNodes.red) this.hiveNodes.red.rotation.x = sim.hives.red.phi + HIVE.tiltLimit;
    if (this.hiveNodes.blue) this.hiveNodes.blue.rotation.x = sim.hives.blue.phi - HIVE.tiltLimit;

    if (previewKind) {
      const pv = sim.previewShot(previewKind); this.arc.visible = true;
      this.arc.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pv.points.flat(), 3)); this.arcMat.color.set(pv.scores ? 0x41e07f : 0xe8e8e8);
    } else this.arc.visible = false;

    const side = sim.alliance === 'red' ? -1 : 1;
    if (this.mode === 'driver') { this.camera.fov = 52; this.camera.position.set(side * 3.5, 1.68, side * -0.6); this.camera.lookAt(side * -0.2, 0.3, 0); }
    else if (this.mode === 'overhead') {
      this.camera.fov = 40; this.camera.position.set(0, 6.4, 0.001); this.camera.up.set(side < 0 ? 1 : -1, 0, 0); this.camera.lookAt(0, 0, 0);
      // Slide the camera along the screen's horizontal axis by half the inset, so that the FIELD centers in the uncovered part.
      if (this.insetLeft > 0) {
        const pxPerM = innerHeight / (2 * 6.4 * Math.tan(((this.camera.fov / 2) * Math.PI) / 180)), right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        this.camera.position.addScaledVector(right, -this.insetLeft / 2 / pxPerM);
      }
    }
    else if (this.mode === 'audience') { this.camera.fov = 50; this.camera.position.set(0, 2.4, 4.4); this.camera.lookAt(0, 0.4, 0); }
    else {
      // The chase camera orbits the robot so that it always looks toward the robot's own HIVE: it sits on the line from the
      // center of the HIVE through the robot, behind the robot. The robot's heading doesn't matter, because a robot with a
      // rear shooter faces away from the HIVE when it launches, and a robot that launches from both ends has no single
      // shooter direction. The angle is smoothed, and it holds under the HIVE, where the line is short and turns fast.
      const hx = HIVE.pivotX[sim.alliance], dx = hx - p.x, dz = -p.z, d = Math.hypot(dx, dz), want = Math.atan2(dz, dx);
      if (this.chaseAngle === null) this.chaseAngle = want;
      else if (d > 0.4) this.chaseAngle += Math.atan2(Math.sin(want - this.chaseAngle), Math.cos(want - this.chaseAngle)) * 0.08;
      const ux = Math.cos(this.chaseAngle), uz = Math.sin(this.chaseAngle);
      this.camera.fov = 70; this.camera.position.set(p.x - ux * 1.1, 0.95, p.z - uz * 1.1); this.camera.lookAt(p.x + ux * 0.8, 0.45, p.z + uz * 0.8);
    }
    if (this.mode !== 'overhead') this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
