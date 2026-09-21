# Hive calibration

The Event Field Setup Guide, section 12.3, defines when a HIVE must tip. Field
staff tune each HIVE with ballast washers until all six rows hold:

| CELL contents | Test action | Required result |
| --- | --- | --- |
| 3 NECTAR + 1 POLLEN | Second POLLEN tossed in | No tip |
| 3 NECTAR + 2 POLLEN | Third POLLEN gently placed | Tip (preferred) |
| 3 NECTAR + 2 POLLEN | Third POLLEN tossed in | Tip |
| 6 POLLEN | Seventh POLLEN tossed in | No tip |
| 7 POLLEN | Eighth POLLEN gently placed | Tip (preferred) |
| 7 POLLEN | Eighth POLLEN tossed in | Tip |

## How the simulator models the HIVE

The `Hive` class in `src/sim/hive.ts` is a Rapier dynamic body on a revolute
joint with hard stops at -30° and +30°. The CELL walls are colliders whose
dimensions come from the CAD skins. Balls in the CELL are rigid bodies, so the
tipping moment comes from contact forces, not from a ball count.

The center of mass sits above the pivot. Gravity therefore holds the hive
against the stop that it rests on, and the hive snaps through when the load
moment exceeds the holding moment. `HIVE_DYN.comHeight` plays the role of the
ballast washers.

## How to recalibrate

1. To sweep `comHeight` and print the values that pass all six rows, run
   `npx vitest run --config scripts/calibrate.vitest.config.ts`.
2. In `src/sim/config.ts`, set `HIVE_DYN.comHeight` to the middle of the
   passing range.
3. To confirm the result, run `npm test`.

With the AndyMark ball masses, the values from 0.060 m to 0.066 m pass. The
configured value is 0.063 m. With the masses that the simulator assumed before
September 21, 2026 (22 g and 35.2 g), the passing range was 0.052 m to 0.056 m.

## Assumptions

The Competition Manual gives no ball mass. Section 9.8 says that POLLEN and
NECTAR are Gopher ResisDent polyethylene balls of about 2.8 in. and 3.6 in.
The simulator uses the weights on AndyMark's product page: 0.055 lb (24.9 g)
for POLLEN, am-5851, and 0.091 lb (41.3 g) for NECTAR, am-5852. Their ratio is
1.65, and the guide needs a ratio under 1.667, because it states that
3 POLLEN + 3 NECTAR weigh less than 8 POLLEN.

`node scripts/ball-mass.mjs` cross-checks the weights against the official CAD:
the plastic volume of each ball model times the density of polyethylene. The
NECTAR model holds 42.8 cm³, which is 39.4 g to 40.7 g at 0.92 g/cm³ to
0.95 g/cm³, within 2% of the listed weight. The POLLEN model holds 22.2 cm³,
which is 20.4 g to 21.0 g, about 4 g under the listed weight, so the real
POLLEN wall is probably thicker than the modeled 1.7 mm. If you weigh real
balls, update `BALL` in `src/sim/config.ts` and recalibrate.
