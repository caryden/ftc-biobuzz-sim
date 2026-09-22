import { describe, expect, it } from 'vitest';
import { compile, ExprError, MATH_FNS, type StaticScope } from '../src/bt/expr';
import { t, type Type } from '../src/bt/schema';

/** A small environment for expression tests: a robot, an optional partner, and a camera function. */
const schema = t.object({
  bot: t.object({ x: t.number(), facing: t.enum('front', 'rear'), full: t.boolean(), name: t.string() }),
  partner: t.nullable(t.object({ x: t.number() })),
  camera: t.object({ sees: t.fn([t.enum('rear', 'audience')], t.boolean()) }),
  list: t.array(t.number()),
});
type Env = Record<string, any>;

function scopeOf(fields: Record<string, Type>): StaticScope<Env> {
  return { fns: MATH_FNS, lookup: n => (fields[n] ? { type: fields[n], get: (s: Env) => s[n] ?? null } : undefined) };
}
const scope = scopeOf(schema.fields);
const env = (over: Env = {}): Env => ({
  bot: { x: 1.5, facing: 'rear', full: false, name: 'R1' }, partner: null, list: [3, 4],
  camera: { sees: (cell: string) => cell === 'rear' }, ...over,
});
const run = (src: string, e: Env = env(), expected?: Type) => compile(src, scope, expected).eval(e);
const fails = (src: string, pattern: RegExp) => expect(() => compile(src, scope)).toThrow(pattern);

describe('expression arithmetic and logic', () => {
  it('follows the usual precedence', () => {
    expect(run('1 + 2 * 3 - 4 / 2')).toBe(5);
    expect(run('-(2 + 3) * 2')).toBe(-10);
    expect(run('7 % 3')).toBe(1);
    expect(run('2.5e1 + .5')).toBe(25.5);
  });
  it('combines comparisons with and, or, and not', () => {
    expect(run('1 < 2 and not (3 <= 2) or false')).toBe(true);
    expect(run('bot.x >= 1.5 and bot.x != 2')).toBe(true);
  });
  it("rejects chained comparisons and other languages' operators with a hint", () => {
    fails('1 < 2 < 3', /can't be chained/);
    fails('bot.x = 1', /use '=='/);
    fails('true && false', /use 'and' or 'or'/);
    fails('!bot.full', /use 'not'/);
  });
  it('rejects mixed types', () => {
    fails('bot.x + bot.name', /needs numbers/);
    fails('bot.full and 1', /needs true or false/);
    fails('bot.x == bot.full', /can't be compared/);
  });
});

describe('expression fields and functions', () => {
  it('reads field paths and compares enums with string literals', () => {
    expect(run("bot.facing == 'rear'")).toBe(true);
    expect(run("if(bot.facing == 'front', 180, 0) - 90")).toBe(-90);
    expect(run('list.length + coalesce(list[1], 0)')).toBe(6);
    fails('list[1] + 1', /can be null/); // An index can be out of range.
    expect(run('list[5]')).toBe(null);
  });
  it('names the fields that exist when a field is missing', () => {
    fails('bot.speed', /no field 'speed'; the fields are x, facing, full, name/);
    fails('robot.x', /unknown name 'robot'/);
  });
  it('calls math functions and checks their arguments', () => {
    expect(run('min(3, bot.x, 2) + max(1, 2)')).toBe(3.5);
    expect(run('hypot(3, 4)')).toBe(5);
    expect(run('clamp(5, 0, 2)')).toBe(2);
    expect(run('deg(rad(90))')).toBeCloseTo(90);
    fails('atan2(1)', /takes 2 values, not 1/);
    fails('min()', /at least 1/);
    fails('sqrt(bot.name)', /must be a number/);
    fails('bot.x(1)', /isn't a function/);
    fails('nosuch(1)', /unknown function/);
  });
  it('calls functions in the environment with checked enum arguments', () => {
    expect(run("camera.sees('rear') and not camera.sees('audience')")).toBe(true);
    fails("camera.sees('side')", /must be a 'rear' \| 'audience'/);
  });
  it('evaluates only the chosen branch of if()', () => {
    let calls = 0;
    const e = env({ camera: { sees: () => { calls++; return true; } } });
    expect(run("if(bot.full, camera.sees('rear'), false)", e)).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('expression null rules', () => {
  it('gives null for a field of null, and false for a comparison with null', () => {
    expect(run('partner.x')).toBe(null);
    expect(run('partner.x < 5')).toBe(false);
    expect(run('partner.x > 5')).toBe(false);
    expect(run('partner == null')).toBe(true);
  });
  it('makes arithmetic on a value that can be null a type error, and suggests coalesce', () => {
    fails('partner.x + 1', /can be null; use coalesce/);
    expect(run('coalesce(partner.x, 0) + 1')).toBe(1);
    expect(run('coalesce(partner.x, 0) + 1', env({ partner: { x: 2 } }))).toBe(3);
    expect(run('exists(partner)')).toBe(false);
  });
});

describe('expression compile checks', () => {
  it('checks the expected type', () => {
    expect(() => compile('bot.x + 1', scope, t.boolean())).toThrow(/gives a number, but a boolean is needed/);
    expect(compile('bot.full', scope, t.boolean()).type.kind).toBe('boolean');
  });
  it('limits the length and reports the position', () => {
    expect(() => compile('1+'.repeat(300) + '1', scope)).toThrow(/longer than 400 characters/);
    let caught: unknown = null;
    try { compile('bot.x + )', scope); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ExprError);
    expect((caught as ExprError).pos).toBe(8);
  });
});
