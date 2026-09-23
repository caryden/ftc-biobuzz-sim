import { describe, expect, it } from 'vitest';
import { REF_ERR, defaultBot, sanitize, type BotSetup } from '../src/setup';

describe('sanitize', () => {
  it('maps a stored spreadX to the three launcher errors once, and then drops it', () => {
    const stored = { ...defaultBot(0), spreadX: 2 } as BotSetup & { spreadX?: number };
    const once = sanitize(stored, 0);
    expect([once.errElevDeg, once.errAzimDeg, once.errSpeed]).toEqual([REF_ERR.errElevDeg * 2, REF_ERR.errAzimDeg * 2, REF_ERR.errSpeed * 2]);
    expect('spreadX' in once).toBe(false);
    // The robot config popup writes the chip values into the setup and sanitizes it again (#8).
    const edited = sanitize({ ...once, errElevDeg: 3, errAzimDeg: 3.6, errSpeed: 0.24 }, 0);
    expect([edited.errElevDeg, edited.errAzimDeg, edited.errSpeed]).toEqual([3, 3.6, 0.24]);
  });
});
