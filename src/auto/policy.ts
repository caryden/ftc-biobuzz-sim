import type { Sim } from '../sim/world';
import { flowerAction, flowerLocked, nectarSupply, parkLeadSec, pollenToFill, type FlowerAction, type FlowerId, type Tactic } from './executor';

export interface Decision { tactic: Tactic; flower: FlowerId | null }

// Finish what is closest to locked first: a cap locks a FLOWER, a fill or a pull moves it toward the cap, a plug starts one.
const PRIORITY: Record<FlowerAction, number> = { cap_with_own_nectar: 0, fill_with_pollen: 1, pull_pollen_to_seat_plug: 1, place_own_nectar_to_plug: 2, none: 9 };

/** Gets the FLOWER to work on: the most advanced useful action first, then the nearest. */
export function bestFlower(sim: Sim, avoid: FlowerId[] = []): FlowerId | null {
  const p = sim.robot.translation(); let best: FlowerId | null = null, score = Infinity;
  const claimed = sim.partner()?.intent; // A FLOWER that the alliance partner works on is taken.
  const zone = sim.robots[sim.me].plan.zone; // Under the sides convention a robot works the two FLOWERS in its own half.
  for (const f of sim.flowers) { const a = flowerAction(sim, f); if (a === 'none' || avoid.includes(f.id as FlowerId) || claimed === `work_flower:${f.id}` || (zone && (zone === 'rear') !== f.z < 0)) continue; const s = PRIORITY[a] * 10 + Math.hypot(f.x - p.x, f.z - p.z); if (s < score) { score = s; best = f.id as FlowerId; } }
  return best;
}

const floorHas = (sim: Sim, kind: string) => [...sim.balls.values()].some(b => b.kind === kind && b.body.translation().y < 0.13);
const own = (sim: Sim) => (sim.alliance === 'red' ? 'nectar_red' : 'nectar_blue');

/** Checks whether a tactic can make progress now. The policy checks a tactic with this function before it picks it. */
export function available(sim: Sim, t: Tactic): boolean {
  const free = sim.cfg.capacity - sim.carried.length;
  const pollenSource = floorHas(sim, 'pollen') || sim.flowers.some(f => f.stack[0] === 'pollen' && sim.flowerStatus(f).owner !== sim.alliance);
  if (t === 'tip_hive') return sim.carried.includes('pollen') || (free > 0 && (pollenSource || floorHas(sim, own(sim))));
  if (t === 'collect_pollen') return free > 0 && pollenSource;
  if (t === 'collect_own_nectar') return free > 0 && floorHas(sim, own(sim));
  if (t === 'launch_into_hive') return sim.carried.length > 0;
  if (t === 'work_flower') return bestFlower(sim) !== null;
  // PARK is a choice only near the end. The executor's park guard starts it on time in any case.
  return sim.phase !== 'teleop' || sim.timer <= parkLeadSec(sim) + 3;
}

/**
 * Gets the next step of FLOWER work: place, pull, fill, or cap at a FLOWER, or fetch the POLLEN or own NECTAR
 * that the next placement needs. Null means that no FLOWER work is possible now.
 * @param preferred The coach's FLOWER choice. It is used when that FLOWER has a useful action.
 * @param avoid FLOWERS that the robot stalled at recently, for example because another robot is there.
 */
export function flowerStep(sim: Sim, preferred: FlowerId | null = null, avoid: FlowerId[] = []): Decision | null {
  const free = sim.cfg.capacity - sim.carried.length, unfinished = sim.flowers.some(f => !flowerLocked(sim, f));
  if (sim.flowersUnlocked) {
    // Exposure first: a filled FLOWER with room is worth more to the opponent than to us. Fetch its cap before anything else.
    const exposed = sim.flowers.some(q => q.stack[0] === own(sim) && pollenToFill(sim, q) === 0 && !flowerLocked(sim, q) && q.stack.length > 1);
    if (exposed && !sim.carried.includes(own(sim)) && free > 0 && available(sim, 'collect_own_nectar')) return { tactic: 'collect_own_nectar', flower: null };
    const pf = sim.flowers.find(f => f.id === preferred), f = pf && flowerAction(sim, pf) !== 'none' && !avoid.includes(pf.id as FlowerId) ? preferred : bestFlower(sim, avoid);
    // A fill takes one trip: collect all the POLLEN that the FLOWER needs, or that the robot can hold, before driving
    // to it. In trace 20260920-131052, R1 carried one POLLEN at a time from a pile to the red FLOWER and back.
    const target = sim.flowers.find(q => q.id === f);
    if (target && flowerAction(sim, target) === 'fill_with_pollen') {
      const have = sim.carried.filter(k => k === 'pollen').length, want = Math.min(pollenToFill(sim, target), have + free);
      if (have < want && sim.timer > 12 && available(sim, 'collect_pollen')) return { tactic: 'collect_pollen', flower: null };
    }
    if (f) return { tactic: 'work_flower', flower: f };
    // A plugged FLOWER that lost its POLLEN needs floor POLLEN for the fill.
    const fill = sim.flowers.reduce((n, q) => n + pollenToFill(sim, q), 0);
    if (fill > 0 && nectarSupply(sim) > 0 && sim.timer > 16 && !sim.carried.includes('pollen') && available(sim, 'collect_pollen')) return { tactic: 'collect_pollen', flower: null };
  }
  // A FLOWER needs two own NECTAR: the plug and the cap.
  if (unfinished && free > 0 && sim.carried.filter(k => k === own(sim)).length < 2 && available(sim, 'collect_own_nectar')) return { tactic: 'collect_own_nectar', flower: null };
  return null;
}
