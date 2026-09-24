import RAPIER from '@dimforge/rapier3d-compat';
import { readInput, type Frame } from './input';
import { AUTO_TREES, SOLO_AUTO, autoFor, autoStart, previewAuto } from './auto/onboard';
import { FieldEditor } from './field-editor';
import { loadUserTrees } from './user-trees';
import { BOT_IDS, REF_ERR, startSide, assignDriver, defaultBot, metaBot, describe, loadBots, robotConfig, sanitize, saveBots, type BotSetup, type DriverKind } from './setup';
import { MatchAudio } from './audio';
import { Coach } from './auto/coach';
import { Referee } from './ref/referee';
import { Review, clockText } from './review';
import { TraceRecorder } from './trace';
import { LiveTreeState, TreePanel, treeStateAt } from './render/tree-view';
import { TELEOP_TREES } from './auto/driver';
import { CAMERAS, View, type CameraMode } from './render/view';
import { RP } from './sim/config';
import { fmtPos, fmtSpeed, getUnits, massFromInput, massToInput, setUnits, sizeFromInput, sizeToInput, speedFromInput, speedToInput, type Units } from './units';
import { cameraSightings } from './sim/camera';
import { DT, NO_INPUT, Sim, type AllianceScore, type Inputs, type MatchMode } from './sim/world';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, '0')}` : '--:--');

await RAPIER.init();
const banner = $('banner'); let loadMsg: string | null = null;
const canvas = $<HTMLCanvasElement>('c'), view = new View(canvas, m => { loadMsg = m; });
const stageSel = $<HTMLSelectElement>('stage'), modeSel = $<HTMLSelectElement>('mode'), camSel = $<HTMLSelectElement>('camera'), refSel = $<HTMLSelectElement>('referee');
const audio = new MatchAudio(), soundSel = $<HTMLSelectElement>('sound'); soundSel.onchange = () => { audio.enabled = soundSel.value === 'on'; soundSel.blur(); };
// The tree view shows one robot's behavior tree. The setting is a convenience that this browser keeps.
const treeSel = $<HTMLSelectElement>('treeview'), treePanel = new TreePanel($('treebody'), $('treehead')), liveTrees = [0, 1, 2, 3].map(() => new LiveTreeState());
try { treeSel.value = localStorage.getItem('biobuzz.treeview') === 'on' ? 'on' : 'off'; } catch { /* Storage is a convenience. */ }
treeSel.onchange = () => { try { localStorage.setItem('biobuzz.treeview', treeSel.value); } catch { /* Storage is a convenience. */ } treeSel.blur(); paintTree(); };
let treeRobot = -1; // -1 follows the focus robot.
// One handler for the robot buttons. The buttons are rebuilt only when the robots or the choice change: a button that is
// replaced between the press and the release of a click never receives the click.
let treeBotsKey = '';
// In the AUTO editor, the buttons pick which red robot's plan the editor shows.
$('treebots').onclick = e => { const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-k]'); if (!btn) return; if (editor.active) editor.showRobot(Number(btn.dataset.k)); else { treeRobot = Number(btn.dataset.k); paintTree(); } };

// Every MATCH has two full alliances: R0, R1, B0, and B1. Each robot has its own setup, edited in the robot config popup.
// The AUTO trees that the field editor saved load first, so that a setup can name one. A setup that names a tree this
// browser doesn't have runs the default.
loadUserTrees();
const bots: BotSetup[] = loadBots();
for (const b of bots) if (b.auto !== 'default' && b.auto !== 'none' && !AUTO_TREES[b.auto]) b.auto = 'default';
let units: Units = getUnits(); const unitsSel = $<HTMLSelectElement>('units'); unitsSel.value = units;
unitsSel.onchange = () => { units = unitsSel.value as Units; setUnits(units); unitsSel.blur(); paintBots(); if (editing >= 0) openConfig(editing); };
let sim: Sim; let seed = 1; let startAt = 0; let recorder: TraceRecorder; let traceSaved = false; let coaches: Coach[] = [], referee: Referee | null = null;
const review = new Review(view, () => sim, canvas); let finalClosed = false;
// The field editor edits one robot's AUTO poses before the MATCH. An edit switches the robot to the edited copy.
const editor = new FieldEditor({ view, canvas, bots, sim: () => sim,
  setAuto: (k, id) => { bots[k].auto = id; saveBots(bots); if (coaches[k]) coaches[k].autoOverride = id === 'default' ? null : id; paintBots(); },
  changed: () => { camSel.value = view.mode; paintEditor(); paintTree(); } });
/** The robot that the HUD, the chase camera, and the shot preview follow: the first robot with a human driver, or R0. */
const focus = () => Math.max(0, bots.findIndex(b => b.driver !== 'planner'));
const settings = () => ({ match: modeSel.value, stage: stageSel.value, referee: refSel.value, ...Object.fromEntries(bots.map((b, i) => [BOT_IDS[i], `plate ${b.plate} · ${describe(b)}`])) });
/** Saves the trace into the repository's traces/ folder through the dev server. */
async function saveTrace() { try { const res = await fetch(`/api/trace/${recorder.trace.name}`, { method: 'POST', body: JSON.stringify(recorder.trace) }); sim.say(res.ok ? `Trace saved: traces/${recorder.trace.name}.json` : 'Review the match to annotate it. Export saves the trace as a file.'); } catch { sim.say('Review the match to annotate it. Export saves the trace as a file.'); } }
/** Adds this finished MATCH to the site's live counter. The dev server has no counter, so a failure is silent. */
async function countMatch() { try { const res = await fetch('/api/matches', { method: 'POST' }); if (!res.ok) return; const { count } = await res.json() as { count: number }; sim.say(`That was simulated match ${count.toLocaleString('en-US')} on this site.`); } catch { /* No counter here. */ } }
/** Starts the MATCH after the announcer's "3-2-1-go". */
function startMatch() { if (sim.phase !== 'pre' || startAt) return; closeConfig(); editor.close(); if (!audio.enabled) { sim.start(); return; } audio.play('start_countdown'); startAt = performance.now() + 3000; }
function reset() {
  editor.close();
  sim = new Sim(RAPIER, undefined, modeSel.value as MatchMode, seed++, { opponent: true, partners: true, playoff: stageSel.value === 'playoff', configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) });
  // Every robot has a Coach: it runs the robot's AUTO tree, and the planner in TELEOP unless a controller drives the robot.
  // Coaches record their trees, for the tree view and the match trace. Recording doesn't change what a robot does.
  coaches = sim.robots.map((_, i) => { const c = new Coach(), b = bots[i]; c.flowerStartSec = b.flowerStartSec; c.defense = b.defense; c.autoOverride = b.auto === 'default' || b.auto === 'none' ? null : b.auto; c.traceTrees = true; return c; });
  referee = refSel.value === 'off' ? null : new Referee(); // The referee calls PINS (G421) by the fixed rule.
  view.plates = bots.map(b => b.plate); review.plates = Object.fromEntries(bots.map((b, i) => [BOT_IDS[i], b.plate]));
  Object.assign(window, { sim, coaches, editor }); startAt = 0; review.exit(); review.notes = []; traceSaved = false; finalClosed = false;
  recorder = new TraceRecorder(sim, settings()); paintBots();
}

// ---------- robot config ----------
let editing = -1; const EDIT_TIP = $('bcedit').title;
const bc = { plate: $<HTMLInputElement>('bcplate'), driver: $<HTMLSelectElement>('bcdriver'), drive: $<HTMLSelectElement>('bcdrive'), shooter: $<HTMLSelectElement>('bcshooter'), auto: $<HTMLSelectElement>('bcauto'), plan: $<HTMLSelectElement>('bcplan'), rpm: $<HTMLInputElement>('bcrpm'), size: $<HTMLInputElement>('bcsize'), mass: $<HTMLInputElement>('bcmass'), intake: $<HTMLSelectElement>('bcintake'), ends: $<HTMLSelectElement>('bcends'), turretRange: $<HTMLInputElement>('bcturretrange'), turretSlew: $<HTMLInputElement>('bcturretslew'), defense: $<HTMLSelectElement>('bcdefense'), elev: $<HTMLInputElement>('bcelev'), azim: $<HTMLInputElement>('bcazim'), speed: $<HTMLInputElement>('bcspeed'), intakeP: $<HTMLInputElement>('bcintakep') };
/** Lists the AUTO plans for one start position. A plan named for the other position starts from the wrong wall, so the list leaves it out. */
const autoOptions = (i: number) => { const side = startSide(i);
  return `<option value="default">Default: wall-sweep pair, ${side} robot</option>` + Object.entries(AUTO_TREES).filter(([, d]) => autoStart(d) !== (side === 'right' ? 'left' : 'right')).map(([k, d]) => `<option value="${k}" title="${d.description ?? ''}">${d.name}</option>`).join('') + `<option value="none">None</option>`; };
const gear = (i: number) => `<button class="gear" data-bot="${i}" title="Robot config for ${bots[i].plate}">&#9881;</button>`;
/** Draws the robot rows in the scoreboard and in the setup panel. Called when a setup changes, not on every frame, so that the gear buttons stay clickable. */
function paintBots() {
  $('tred').innerHTML = [0, 1].map(i => `<div>${bots[i].plate}${gear(i)}</div>`).join(''); $('tblue').innerHTML = [2, 3].map(i => `<div>${gear(i)}${bots[i].plate}</div>`).join('');
  $('botlist').innerHTML = bots.map((b, i) => `<div class="bot"><b style="background:var(--${i < 2 ? 'red' : 'blue'})">${b.plate}</b><span title="${describe(b, units)}">${describe(b, units)}</span>${gear(i)}</div>`).join('');
  document.querySelectorAll<HTMLButtonElement>('button.gear').forEach(el => { el.onclick = () => openConfig(Number(el.dataset.bot)); });
}
/** Opens the robot config popup. Setups change only before a MATCH or after it, because a change rebuilds the FIELD. */
function openConfig(i: number) {
  if (review.active || (sim.phase !== 'pre' && sim.phase !== 'post') || startAt) return; editing = i; const b = bots[i];
  $('bchead').textContent = `Robot config: ${b.plate} (${BOT_IDS[i]}), ${i < 2 ? 'red' : 'blue'} alliance, ${startSide(i)} start`; bc.auto.innerHTML = autoOptions(i);
  bc.plate.value = b.plate; bc.driver.value = b.driver; bc.drive.value = b.stickFrame; bc.shooter.value = b.shooter; bc.auto.value = b.auto; bc.plan.value = String(b.flowerStartSec); bc.rpm.value = String(b.driveRpm); bc.size.value = String(sizeToInput(b.sizeIn, units)); bc.mass.value = String(massToInput(b.massLb, units)); $('bcsizelabel').textContent = `Chassis, square, ${units === 'us' ? 'in.' : 'cm'}`; $('bcmasslabel').textContent = `Mass, ${units === 'us' ? 'lb' : 'kg'}`; bc.intake.value = b.dualIntake ? 'dual' : 'front'; bc.ends.value = b.turret ? 'turret' : b.dualShooter ? 'both' : 'one'; bc.turretRange.value = String(b.turretRangeDeg ?? 360); bc.turretSlew.value = b.turretSlewDegPerSec ? String(b.turretSlewDegPerSec) : ''; for (const id of ['bcturretrow', 'bcslewrow']) $(id).classList.toggle('hidden', !b.turret); bc.defense.value = b.defense; bc.elev.value = String(b.errElevDeg); bc.azim.value = String(b.errAzimDeg); bc.speed.value = String(speedToInput(b.errSpeed, units)); bc.intakeP.value = String(Math.round(100 * b.intakeP)); $('bcspeedlabel').textContent = `Launch speed, ${units === 'us' ? 'ft/s' : 'm/s'}`;
  // Trees are written in red's frame, so AUTO poses are edited from a red robot. Blue robots run them rotated 180°.
  const edit = $<HTMLButtonElement>('bcedit'); edit.disabled = i >= 2; edit.title = i >= 2 ? 'Edit AUTO trees from a red robot. Blue robots run the same trees rotated 180° about the FIELD center.' : EDIT_TIP;
  bc.driver.disabled = i >= 2; $('bcdriverow').classList.toggle('hidden', b.driver === 'planner');
  $('bcnote').textContent = i >= 2 ? 'The planner drives the blue robots.' : 'A controller drives one robot. If another robot has the controller that you pick, that robot goes back to the planner.';
  $('botcfg').classList.remove('hidden');
}
function closeConfig() { editing = -1; $('botcfg').classList.add('hidden'); }
/** Reads the popup into the setup, saves it, and rebuilds the FIELD with it. */
function applyConfig() {
  if (editing < 0) return; const i = editing, b = bots[i];
  Object.assign(b, { plate: bc.plate.value, stickFrame: bc.drive.value, shooter: bc.shooter.value, auto: bc.auto.value, flowerStartSec: Number(bc.plan.value), driveRpm: Number(bc.rpm.value), sizeIn: sizeFromInput(Number(bc.size.value), units), massLb: massFromInput(Number(bc.mass.value), units), dualIntake: bc.intake.value === 'dual', dualShooter: bc.ends.value === 'both', turret: bc.ends.value === 'turret', turretRangeDeg: Number(bc.turretRange.value) || 360, turretSlewDegPerSec: Number(bc.turretSlew.value) || null, defense: bc.defense.value, errElevDeg: Number(bc.elev.value), errAzimDeg: Number(bc.azim.value), errSpeed: speedFromInput(Number(bc.speed.value), units), intakeP: Number(bc.intakeP.value) / 100 });
  assignDriver(bots, i, bc.driver.value as DriverKind); bots[i] = sanitize(bots[i], i); saveBots(bots); reset(); openConfig(i);
}
for (const el of Object.values(bc)) { el.onchange = applyConfig; for (const ev of ['keydown', 'keyup']) el.addEventListener(ev, e => e.stopPropagation()); }
// The 1x, 3x, and 5x chips fill in the reference launcher's errors times that factor.
document.querySelectorAll<HTMLButtonElement>('[data-err]').forEach(el => { el.onclick = () => { const k = Number(el.dataset.err); bc.elev.value = String(+(REF_ERR.errElevDeg * k).toFixed(2)); bc.azim.value = String(+(REF_ERR.errAzimDeg * k).toFixed(2)); bc.speed.value = String(speedToInput(+(REF_ERR.errSpeed * k).toFixed(3), units)); applyConfig(); }; });
/** Opens the AUTO editor on red robot `i`. After a MATCH, it resets the FIELD first, because the plan preview draws from the start positions. */
function openEditor(i: number) { if (review.active || startAt) return; closeConfig(); if (sim.phase !== 'pre') reset(); editor.open(i); }
$('bcedit').onclick = () => { if (editing >= 0 && editing < 2) openEditor(editing); };
$('editauto').onclick = () => { $('editauto').blur(); if (editor.active) editor.close(); else openEditor(treeRobot === 1 ? 1 : 0); };
$('bcdone').onclick = closeConfig; const applyPreset = (make: (i: number) => BotSetup) => { if (editing < 0) return; const i = editing, keep = { plate: bots[i].plate, driver: bots[i].driver, stickFrame: bots[i].stickFrame }; bots[i] = { ...make(i), ...keep }; saveBots(bots); reset(); openConfig(i); };
$('bcdefault').onclick = () => applyPreset(metaBot); $('bcbaseline').onclick = () => applyPreset(defaultBot);
// A click on the FIELD floor reports the position in the log, in the coordinate system that the floor labels show.
// In the review, a click on a robot adds a note instead, and the position goes to the review bar.
canvas.addEventListener('click', e => {
  if (editor.takeClick()) return;
  // In the editor, a click on the other red robot shows that robot's plan. A click on a handle never gets here.
  if (editor.active) {
    // Only a click on the robot itself counts: in the overhead view a robot is a large target, and its path passes near it.
    const other = 1 - editor.robot; if (view.pickRobot(e.clientX, e.clientY, 0) === other) { editor.showRobot(other); return; }
  }
  if (review.active && view.pickRobot(e.clientX, e.clientY) !== null) return; const q = view.pickFloor(e.clientX, e.clientY); if (!q) return;
  const text = `Field position: ${fmtPos(q.x, q.y, units)}`;
  if (review.active) $('nsaved').textContent = text; else sim.say(text);
});
canvas.addEventListener('contextmenu', e => { e.preventDefault(); const i = view.pickRobot(e.clientX, e.clientY); if (i !== null) openConfig(i); });

reset();
// Entering the review saves the trace first, so that annotations always have their trace on disk.
const openReview = () => { closeConfig(); editor.close(); void saveTrace(); review.enter(recorder.trace); };
$('reviewbtn').onclick = openReview;
modeSel.onchange = reset; refSel.onchange = reset; stageSel.onchange = reset; $('reset').onclick = reset; $('start').onclick = startMatch;
camSel.onchange = () => { view.mode = camSel.value as CameraMode; };
for (const el of [modeSel, camSel, refSel, stageSel]) el.addEventListener('change', () => el.blur());

/** Rotates stick input from the driver's point of view into the frame of robot `i`. */
function fieldCentric(inp: Inputs, i: number): Inputs {
  const v = sim.view(i), side = v.alliance === 'red' ? 1 : -1, f = inp.forward * side, s = inp.strafeRight * side, th = v.heading;
  return { ...inp, forward: f * Math.cos(th) - s * Math.sin(th), strafeRight: f * Math.sin(th) + s * Math.cos(th) };
}

type ScoreKey = Exclude<keyof AllianceScore, 'rp' | 'total'>;
const ROWS: [string, ScoreKey][] = [['LEAVE', 'leave'], ['AUTO PARK', 'autoPark'], ['AUTO TIPS', 'autoTips'], ['TELEOP TIPS', 'teleopTips'], ['In CELL', 'cell'], ['FLOWERS', 'flower'], ['Bottom NECTAR', 'bottomNectar'], ['GARDEN', 'garden'], ['PARK', 'park'], ['Opponent FOULS', 'fouls']];
const RP_ROWS: [string, keyof AllianceScore['rp']][] = [['SWARM RP', 'swarm'], ['POLLINATOR 1 RP', 'pollinator1'], ['POLLINATOR 2 RP', 'pollinator2']];
/** Builds the rows of an FTC-style score table: red at one side, the category in the middle, blue at the other side. A trace without a breakdown shows dashes. */
function scoreRows(r: AllianceScore | null, b: AllianceScore | null, totals: { red: number; blue: number }, final: boolean) {
  const row = (cls: string, n: string, x: string | number, y: string | number) => `<tr class="${cls}"><td class="r">${x}</td><td>${n}</td><td class="b">${y}</td></tr>`;
  let html = row('head', '', 'RED', 'BLUE') + ROWS.map(([n, k]) => row('', n, r?.[k] ?? '–', b?.[k] ?? '–')).join('') + row('total', 'TOTAL', totals.red, totals.blue);
  if (r && b && !sim.options.playoff) {
    html += RP_ROWS.map(([n, k], i) => row(i ? 'rprow' : 'rprow sep', n, r.rp[k] ? '+1' : '', b.rp[k] ? '+1' : '')).join('');
    if (final) {
      const result = (mine: number, theirs: number) => (mine > theirs ? RP.win : mine === theirs ? RP.tie : 0), bonus = (q: AllianceScore) => RP_ROWS.filter(([, k]) => q.rp[k]).length;
      const wr = result(r.total, b.total), wb = result(b.total, r.total), label = r.total === b.total ? 'TIE RP' : 'WIN RP';
      html += row('rprow', label, wr ? `+${wr}` : '', wb ? `+${wb}` : '') + row('total', 'RANKING POINTS', wr + bonus(r), wb + bonus(b));
    }
  }
  return html;
}
// ---------- field editor ----------
$('aedone').onclick = () => { closeNewPlan(); editor.close(); }; $('aeundo').onclick = () => editor.undo(); $('aeredo').onclick = () => editor.redo();
// Undo and redo keys, while you edit a plan. They leave the dialog's text fields to the browser.
addEventListener('keydown', e => {
  if (!editor.active || !editor.editing || (e.target as HTMLElement).closest?.('input, textarea, select')) return;
  const z = e.key === 'z' || e.key === 'Z';
  if ((e.metaKey || e.ctrlKey) && z) { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); }
  else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); editor.redo(); }
}, true); $('aereset').onclick = () => editor.resetSelected(); $('aeedit').onclick = () => editor.edit();
$('aedelete').onclick = () => { const d = editor.def; if (d && confirm(`Delete the plan "${d.name}"? This browser keeps no other copy of it.`)) editor.deletePlan(); };
// The new-plan dialog asks for the plan to copy, a name, and a description, and the editor checks them.
const newPlan = { from: $<HTMLSelectElement>('aefrom'), name: $<HTMLInputElement>('aename'), desc: $<HTMLTextAreaElement>('aedesc') };
for (const el of Object.values(newPlan)) for (const ev of ['keydown', 'keyup']) el.addEventListener(ev, e => e.stopPropagation());
function closeNewPlan() { $('aenew').classList.add('hidden'); }
$('aecreate').onclick = () => {
  const current = editor.def?.id ?? '', esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  newPlan.from.innerHTML = editor.sources().map(s => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  newPlan.name.value = ''; newPlan.desc.value = ''; $('aeerr').textContent = ''; $('aenew').classList.remove('hidden'); newPlan.name.focus();
};
$('aecancel').onclick = closeNewPlan;
$('aemake').onclick = () => { const err = editor.create(newPlan.from.value, newPlan.name.value, newPlan.desc.value); $('aeerr').textContent = err ?? ''; if (!err) closeNewPlan(); };
// In the editor, a click on a step in the tree view selects it, and its handles on the FIELD light up.
$('treebody').addEventListener('click', e => { if (!editor.active) return; const row = (e.target as HTMLElement).closest<HTMLElement>('.tv[data-path]'); if (row) editor.select(row.dataset.path!); });
/** Draws the editor bar: the tree, the selected step's pose, and the buttons. */
function paintEditor() {
  document.body.classList.toggle('editing', editor.active); $('autoedit').classList.toggle('hidden', !editor.active); if (!editor.active) return;
  const def = editor.def, plate = bots[editor.robot].plate, wrong = editor.wrongStart;
  $('aehead').textContent = `${plate} · ${def?.name ?? 'No AUTO plan'}`;
  const status = $('aestatus'); status.classList.toggle('warn', !!wrong);
  const n = editor.changed.size, changes = n ? ` · ${n} step${n === 1 ? '' : 's'} changed` : '';
  status.textContent = !def ? '' : wrong ? `This plan is for the ${wrong} start position.` : editor.isUserPlan ? `${editor.editing ? 'Your plan · editing' : 'Your plan'}${changes}` : 'System plan · read-only';
  $<HTMLButtonElement>('aeundo').disabled = !editor.canUndo; $<HTMLButtonElement>('aeredo').disabled = !editor.canRedo;
  $('aeframe').textContent = 'Red alliance frame: +x toward the blue wall, +y toward the rear wall. Blue robots run this tree rotated 180°.';
  // The bar cuts long lines short, so each line's tooltip holds the whole text.
  for (const [id, text] of [['aeframe', $('aeframe').textContent ?? ''], ['aesel', editor.describe((x, y) => fmtPos(x, y, units))]] as const) { $(id).textContent = text; $(id).title = text; }
  $<HTMLButtonElement>('aereset').disabled = !editor.selectedEdited();
  const edit = $<HTMLButtonElement>('aeedit'); edit.disabled = !editor.isUserPlan || editor.editing;
  edit.title = editor.isUserPlan ? 'Lets you drag the poses of this plan.' : 'System plans are read-only. Create a copy to change it.';
  $<HTMLButtonElement>('aedelete').disabled = !editor.isUserPlan;
}

/** Draws the tree view for the chosen robot: live during a match, and at the cursor in the review. */
function paintTree() {
  const el = $('tree'), on = treeSel.value === 'on' || editor.active; el.classList.toggle('hidden', !on);
  if (!editor.active) view.insetLeft = 0;
  if (!on) return;
  const i = treeRobot >= 0 ? treeRobot : focus(), plate = bots[i].plate;
  // The buttons are built in one place and only when they change: a button that is replaced between the press and the
  // release of a click never receives the click. In the editor they are the two red robots, in the order that the
  // drivers see them on the FIELD: R1 starts on the left, and R0 on the right.
  const order = editor.active ? [1, 0] : [0, 1, 2, 3], picked = editor.active ? editor.robot : i;
  const botsKey = `${editor.active ? 'edit' : 'view'}:${picked}:${bots.map(b => b.plate).join(',')}`;
  if (botsKey !== treeBotsKey) {
    treeBotsKey = botsKey;
    $('treebots').innerHTML = order.map(k => `<button data-k="${k}" class="${k === picked ? 'on' : ''}" style="border-color:var(--${k < 2 ? 'red' : 'blue'})">${bots[k].plate}</button>`).join('');
  }
  // The panel fills the space between the score panel and whatever is at the bottom left: the log, or the review bar.
  const below = review.active ? $('review') : editor.active ? $('autoedit') : $('log');
  el.style.top = `${$('left').getBoundingClientRect().bottom + 8}px`; el.style.bottom = `${innerHeight - below.getBoundingClientRect().top + 8}px`;
  if (editor.active) {
    // The overhead view keeps the FIELD clear of this panel, because the rear-side plans run under it.
    view.insetLeft = el.getBoundingClientRect().right + 8;
    treePanel.paint(`${bots[editor.robot].plate} · AUTO plan`, editor.def, { running: new Set(), last: new Map() }, 'This robot runs no AUTO plan.', editor.treeEdit());
    return;
  }
  const cur = review.cursor, human = bots[i].driver !== 'planner';
  if (cur) {
    const at = treeStateAt(cur.trace, cur.index, i), def = at ? AUTO_TREES[at.tree] ?? TELEOP_TREES[at.tree] ?? null : null;
    treePanel.paint(`${plate} · ${def?.name ?? 'Tree'} · at the cursor`, def, at?.state ?? null, at ? `This trace names the tree ${at.tree}, which this version doesn't have.` : 'No tree ran at this moment, or the trace predates tree recording.');
    return;
  }
  if (human && (sim.phase === 'teleop' || sim.phase === 'post')) { treePanel.paint(`${plate} · Tree`, null, null, 'A person drives this robot in TELEOP.'); return; }
  const t = coaches[i]?.currentTree();
  if (!t) { treePanel.paint(`${plate} · Tree`, null, null, 'The tree starts with the MATCH.'); return; }
  treePanel.paint(`${plate} · ${t.period === 'auto' ? 'AUTO' : 'TELEOP'} · ${t.def.name}`, t.def, liveTrees[i].read(t.recorder));
}

function hud(pads: Frame['pads']) {
  paintTree();
  // In the review, the scoreboard, the clock, and the score table show the trace frame at the cursor.
  const f = review.frame, r = f ? f.scores?.red ?? null : sim.score('red'), b = f ? f.scores?.blue ?? null : sim.score('blue');
  const totals = f ? f.score : { red: r!.total, blue: b!.total }, phase = (f ? f.phase : sim.phase) as Sim['phase'], clock = f ? f.clock : sim.timer;
  $('sred').textContent = String(totals.red); $('sblue').textContent = String(totals.blue);
  $('clock').textContent = f ? clockText(clock) : fmt(clock);
  const flowersOpen = f ? phase === 'teleop' && clock <= 60 : sim.flowersUnlocked;
  $('phase').textContent = { pre: 'Ready', auto: 'AUTO', transition: 'Transition', teleop: sim.mode === 'practice' ? 'Practice' : flowersOpen ? 'TELEOP · FLOWERS open' : 'TELEOP', post: 'Final' }[phase];
  document.body.classList.toggle('playing', !f && (sim.phase === 'auto' || sim.phase === 'transition' || sim.phase === 'teleop' || startAt > 0));
  $('scoretable').innerHTML = scoreRows(r, b, totals, phase === 'post');
  // At the end of the MATCH, a results card shows the final score, the breakdown, and the ranking points.
  const showFinal = !f && sim.phase === 'post' && !finalClosed; $('final').classList.toggle('hidden', !showFinal); $('left').classList.toggle('hidden', showFinal);
  if (showFinal && r && b && $('final').dataset.key !== `${r.total}-${b.total}`) {
    const win = r.total > b.total ? 'RED WINS' : b.total > r.total ? 'BLUE WINS' : 'TIE', bg = r.total > b.total ? 'var(--red)' : b.total > r.total ? 'var(--blue)' : '#5b6370';
    $('final').dataset.key = `${r.total}-${b.total}`;
    $('final').innerHTML = `<div class="win" style="background:${bg}">${win}</div><div class="big"><div style="background:var(--red)">${r.total}</div><div style="background:var(--blue)">${b.total}</div></div>` +
      `<div class="body"><table class="ftc">${scoreRows(r, b, totals, true)}</table><div class="btns"><button id="freview" class="primary">Review and annotate (V)</button><button id="fclose">Close</button></div><div style="color:var(--dim);margin-top:6px;text-align:center">Press R to reset the field.</div></div>`;
    $('freview').onclick = openReview; $('fclose').onclick = () => { finalClosed = true; };
  }
  // The bottom bar follows the focus robot: the first robot with a human driver, or R0.
  const me = sim.view(focus());
  $('carry').innerHTML = Array.from({ length: me.cfg.capacity }, (_, i) => `<i class="${me.carried[i] ?? ''}"></i>`).join('');
  const near = me.reachableFlower();
  // The camera matters in AUTO, where it gives the "ok to shoot" signal. The readout shows what it reads right now.
  const seen = cameraSightings(me).filter(q => q.alliance === me.alliance), cam = seen.length ? seen.map(q => `${q.cell} CELL ${q.raised ? 'raised' : 'not raised'}, ${q.tags} tags`).join('; ') : 'no tags';
  $('telemetry').textContent = `${bots[focus()].plate} · ${fmtSpeed(me.telemetry.speed, units)} · ${me.telemetry.busVoltage.toFixed(1)} V · TIPS ${sim.hives[me.alliance].tips} · NECTAR stash ${sim.stash[me.alliance]}${near ? ` · ${near.id} FLOWER in reach` : ''} · CAM ${cam}${(referee?.pins ?? []).map(q => ` · PIN on ${q.pinner.toUpperCase()} ${q.count.toFixed(1)} s${q.paused ? ' (paused)' : ''}`).join('')}`;
  $('log').innerHTML = sim.messages.slice(-4).map(m => `<div>${m.text}</div>`).join('') || '<div>—</div>';
  $('pad').textContent = [0, 1].map(k => { const who = bots.find(q => q.driver === `pad${k + 1}`); return `Controller ${k + 1}: ${pads[k] ? pads[k]!.id.slice(0, 22) : 'not connected'}${who ? `, drives ${who.plate}` : ''}`; }).join(' · ');
  const humans = bots.filter(q => q.driver !== 'planner').map(q => q.plate), who = humans.length ? `Drivers of ${humans.join(' and ')}, you have the controls. The planner drives the other robots.` : 'The planner drives every robot.';
  const text = loadMsg ?? (startAt ? 'This MATCH begins in 3, 2, 1…'
    : sim.phase === 'pre' ? `Press START or Enter to begin<small>Click a gear icon or right-click a robot to configure it. The dashed orange line is the AUTO plan of ${bots[focus()].plate}.</small>`
    : sim.phase === 'transition' ? `Drivers, pick up your controllers<small>${who}</small>`
    : null);
  banner.classList.toggle('hidden', !text || editing >= 0 || editor.active); if (text) banner.innerHTML = text;
  $('start').classList.toggle('hidden', sim.phase !== 'pre');
}

/**
 * In the editor, shows a see-through robot at the selected point, and runs another one along the path into the point and
 * out of it. The preview has a pose for each handle, in the same order, and `ends` marks where the path reaches each.
 */
function paintGhost(me: Sim, plan: ReturnType<typeof previewAuto> | null) {
  const i = editor.point;
  if (!editor.active || !plan || i < 0 || plan.poses.length !== editor.handles.length) { view.showGhost(null, null); return; }
  // Headings turn evenly by distance between two poses, the short way.
  const ramp = (pts: { x: number; z: number }[], h0: number, h1: number) => {
    const d = pts.map((_, k) => (k ? Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z) : 0)), total = d.reduce((a, b) => a + b, 0) || 1, dh = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
    let run = 0; return pts.map((q, k) => { run += d[k]; return { x: q.x, z: q.z, heading: h0 + (dh * run) / total }; });
  };
  const at = plan.poses[i], from = i ? plan.ends[i - 1] : 0, to = plan.ends[i], next = plan.ends[i + 1];
  const into = ramp(plan.path.slice(from, to + 1), i ? plan.poses[i - 1].heading : me.heading, at.heading);
  const out = next === undefined ? [] : ramp(plan.path.slice(to, next + 1), at.heading, plan.poses[i + 1].heading);
  view.showGhost({ x: at.x, z: at.z, heading: at.heading }, me.cfg, into, out);
}

let last = performance.now(), acc = 0, frame = 0, autoPlan: ReturnType<typeof previewAuto> | null = null, autoPlanKey = '';
function tick(now: number) {
  const frameDt = (now - last) / 1000; acc = Math.min(acc + frameDt, 0.05); last = now;
  const inF = readInput();
  if (inF.reset) reset(); if (inF.start) startMatch();
  if (inF.mark && recorder.trace.frames.length) { const fr = recorder.trace.frames[recorder.trace.frames.length - 1]; review.mark(recorder.trace, fr.t); sim.say(`Marked t=${fr.t.toFixed(1)} s. Press V to review.`); }
  if (inF.review) { if (review.active) review.exit(); else openReview(); }
  if (sim.phase === 'post' && !traceSaved) { traceSaved = true; void saveTrace(); void countMatch(); }
  if (review.active) { review.tick(frameDt); acc = 0; if (frame++ % 6 === 0) hud(inF.pads); requestAnimationFrame(tick); return; }
  if (startAt && now >= startAt) { startAt = 0; sim.start(); }
  for (const e of sim.events.splice(0)) audio.play(e);
  if (inF.camera) { view.cycleCamera(); camSel.value = view.mode; }
  const fi = focus();
  while (acc >= DT) {
    // AUTO always runs the robot's script (G401 allows no driver input). In TELEOP, a controller or the planner drives.
    const inAuto = sim.phase === 'auto', inputs: Inputs[] = [], flags: boolean[] = [], drivers: (Coach | null)[] = [];
    bots.forEach((b, i) => {
      const human = !inAuto && b.driver !== 'planner', pad = human ? inF.pads[b.driver === 'pad1' ? 0 : 1]?.inputs ?? NO_INPUT : NO_INPUT;
      if (human) inputs.push(b.stickFrame === 'field' ? fieldCentric(pad, i) : pad); else inputs.push(inAuto && b.auto === 'none' ? NO_INPUT : coaches[i].update(sim.view(i), DT));
      flags.push(!human); drivers.push(human ? null : coaches[i]);
    });
    sim.step(inputs, flags); referee?.update(sim, DT); recorder.record(sim, drivers, DT); acc -= DT;
  }
  // The shot preview and the planned path belong to the focus robot. A human driver gets the preview, and a program gets the path.
  const me = sim.view(fi), humanNow = bots[fi].driver !== 'planner' && sim.phase !== 'auto', next = me.carried[0], dual = me.cfg.shooter.type === 'dual';
  const kind = !next ? null : dual ? (me.carried.includes('pollen') ? 'pollen' : 'nectar') : next === 'pollen' ? 'pollen' : 'nectar';
  view.sync(me, kind, humanNow ? null : sim.phase === 'auto' ? coaches[fi].auto?.path ?? null : coaches[fi].executor.path);
  // Project the focus robot's AUTO trajectory onto the FIELD before and during AUTO.
  // In the field editor, the plan is the edited robot's, and it redraws after each edit.
  const pi = editor.active ? editor.robot : fi, pv = sim.view(pi);
  const name = bots[pi].auto === 'default' ? autoFor(pv, SOLO_AUTO) : bots[pi].auto, tree = AUTO_TREES[name], showPlan = !!tree && (editor.active || ((sim.mode === 'full' || sim.mode === 'auto') && (sim.phase === 'pre' || sim.phase === 'auto')));
  if (showPlan && sim.phase === 'pre') { const key = `${name}:${pi}:${seed}:${editor.rev}`; if (key !== autoPlanKey) { const p = pv.robot.translation(); autoPlan = previewAuto(tree, pv, { x: p.x, z: p.z }); autoPlanKey = key; } }
  view.showAutoPlan(showPlan ? autoPlan : null, autoPlanKey);
  paintGhost(pv, showPlan ? autoPlan : null);
  if (frame++ % 6 === 0) hud(inF.pads);
  requestAnimationFrame(tick);
}
void CAMERAS; requestAnimationFrame(tick);
