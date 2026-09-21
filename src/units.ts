/** The display units of the site. Every page shares the choice through the browser's storage. Default: metric. */
export type Units = 'metric' | 'us';
const KEY = 'biobuzz.units', LB = 0.45359237, IN = 0.0254;

export function getUnits(): Units { try { return localStorage.getItem(KEY) === 'us' ? 'us' : 'metric'; } catch { return 'metric'; } }
export function setUnits(u: Units) { try { localStorage.setItem(KEY, u); } catch { /* The choice then lasts for this page only. */ } }

/** Formats a robot mass that is stored in pounds. */
export const fmtMass = (lb: number, u: Units) => (u === 'us' ? `${lb} lb` : `${(lb * LB).toFixed(1)} kg`);
/** Formats a chassis size that is stored in inches. */
export const fmtSize = (inch: number, u: Units) => (u === 'us' ? `${inch} in.` : `${(inch * IN * 100).toFixed(1)} cm`);
/** Formats a speed in meters per second. */
export const fmtSpeed = (mps: number, u: Units | 'usft') => (u === 'usft' ? `${(mps / 0.3048).toFixed(2)} ft/s` : u === 'us' ? `${(mps / IN).toFixed(0)} in/s` : `${mps.toFixed(2)} m/s`);
/** Converts a launch speed error between meters per second, which a setup stores, and the value that an input shows: m/s or ft/s. */
export const speedToInput = (mps: number, u: Units) => (u === 'us' ? Math.round((mps / 0.3048) * 100) / 100 : mps), speedFromInput = (v: number, u: Units) => (u === 'us' ? v * 0.3048 : v);
/** Formats a field position in meters. */
export const fmtPos = (x: number, y: number, u: Units) => (u === 'us' ? `x ${(x / IN).toFixed(1)} in., y ${(y / IN).toFixed(1)} in.` : `x ${x.toFixed(2)} m, y ${y.toFixed(2)} m`);
/** Converts a mass or a size between the stored US value and the value that an input shows. */
export const massToInput = (lb: number, u: Units) => (u === 'us' ? lb : Math.round(lb * LB * 10) / 10), massFromInput = (v: number, u: Units) => (u === 'us' ? v : Math.round((v / LB) * 10) / 10);
export const sizeToInput = (inch: number, u: Units) => (u === 'us' ? inch : Math.round(inch * IN * 1000) / 10), sizeFromInput = (v: number, u: Units) => (u === 'us' ? v : Math.round((v / 100 / IN) * 10) / 10);
