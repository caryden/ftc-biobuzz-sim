/** Seeded pseudo-random source (mulberry32) so that matches can be replayed. */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0; }
  /** Gets a uniform sample in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Gets a normal sample (Box-Muller). */
  gauss(mean: number, std: number): number {
    if (std <= 0) return mean;
    const u = Math.max(this.next(), 1e-12), v = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Checks whether a Bernoulli trial with success probability p succeeds. */
  bernoulli(p: number): boolean { return this.next() < p; }
}
