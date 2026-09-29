# CELL NECTAR layout check

The `v3` round started the three NECTAR in each raised CELL at random spots across the CELL. The Event Field Setup
Guide, section 11.1, and the Competition Manual, section 10.3.1, place them in a row against the back skin, packed
against the side wall nearest their own ALLIANCE AREA (issue #22). This check reran 14 of the 79 `v3` setups on the
same 96 seeds with the prescribed row: 1,344 matches. The rows are in `cell-layout-check.jsonl`, with the tag
`cell-placed`.

## Result

No setup's change moved by more than 1.2 standard errors, and every setup kept its sign. By chance alone, about 4 of
13 shifts exceed 1 standard error. Three did. Each claim in `docs/top-ten.md` that these rows support still holds, for
example that the near edge of the scoring window costs more than the far edge. The `v3` tables stay as published.

The baseline robots don't notice the layout either:

- **The baseline row.** Red scored 408.1 on the prescribed row and 408.8 on the random layout, a change of
  -0.7 ± 4.0 over 96 seeds. AUTO points were 89.8 and 89.9.
- **The baseline opponents.** Blue is two baseline robots in every row. Over the 1,152 matches of the 12 rows that
  change red alone, blue scored +1.6 ± 1.1 points more on the prescribed row.
- **The planner evaluation.** `e96-placed-cell-nectar` scored 819 ± 7.0 combined, against 817 ± 9.3 for
  `e95-random-cell-check` on the random layout. See `policy-loop.md`.

Each change is red's score against the baseline row on the same seed, except for the two scoring-window rows, which
change all four robots and are read from the combined score. The shift is the prescribed row's change minus the
random layout's, with the two standard errors combined as independent, because the two layouts' matches diverge after
the first step.

| Setup | Lesson | Change, random layout (`v3`) | Change, prescribed row | Shift |
| --- | --- | --- | --- | --- |
| Launch spread x3 | 1 | -150.2 ± 2.9 | -146.9 ± 3.7 | +3.2 ± 4.7 |
| Launch from the closest scoring spot, combined | 2 | -233.4 ± 5.1 | -226.4 ± 5.8 | +7.0 ± 7.7 |
| Launch from the farthest scoring spot, combined | 2 | -145.2 ± 5.5 | -146.4 ± 5.9 | -1.1 ± 8.1 |
| No AUTO at all | 3 | -81.8 ± 3.4 | -83.8 ± 3.7 | -2.0 ± 5.0 |
| Both robots: FLOWERS from 45 s | 4 | -45.9 ± 1.5 | -46.5 ± 1.8 | -0.6 ± 2.4 |
| Catapult, all at once | 6 | +60.3 ± 4.2 | +57.8 ± 4.5 | -2.5 ± 6.2 |
| Single shooter, FIFO | 6 | +21.1 ± 3.2 | +23.9 ± 4.0 | +2.8 ± 5.1 |
| Shooter on the intake side | 6 | -32.1 ± 3.2 | -25.7 ± 4.3 | +6.4 ± 5.3 |
| Turret, 270° range, 360°/s | 6 | +13.3 ± 3.3 | +19.6 ± 3.8 | +6.3 ± 5.0 |
| 435 rpm | 7 | +14.4 ± 3.4 | +13.7 ± 4.3 | -0.7 ± 5.5 |
| 15.4 lb (7 kg) robot | 7 | +19.5 ± 3.5 | +19.3 ± 3.6 | -0.2 ± 5.0 |
| Intakes on the front and the rear | 8 | +16.5 ± 2.7 | +21.2 ± 3.6 | +4.6 ± 4.5 |
| Combined build | The build | +111.2 ± 4.0 | +113.7 ± 4.0 | +2.6 ± 5.7 |

The two largest shifts are the turret and the shooter on the intake side, both about +6 points. Lesson 6 says that a
360°/s turret gained 13 to 14 points. On the prescribed row this one gained 19.6 ± 3.8, which isn't a proven
difference. A rerun of the whole turret group would settle it.

## What this check leaves out

- 65 of the 79 `v3` setups weren't rerun. The rows here cover lessons 1 to 4 and 6 to 8, and the combined build.
- Lessons 5, 9, and 10 come from `policy-loop.md`, whose runs from e51 to e94 used the random layout. Only the
  baseline was rerun, as e96.

## Reproduce it

`scripts/exp-run.ts` appends to `results.jsonl`. The check's rows were moved to this folder's
`cell-layout-check.jsonl`, because `scripts/exp-report.ts` reads the latest tag of each setup and would mix the two
layouts. To rerun the check and compare it, run these commands:

```bash
npx tsx scripts/exp-run.ts shoot-dual,strat-f45-f45,shoot-catapult,shoot-fifo,shoot-front,drive-435,mass-7,intake-dual,turret-270-360,meta-build,acc-x3,auto-none,path-standoff-far,path-standoff-near 96 10 101 cell-placed
```

```bash
python3 scripts/tag-compare.py v3 cell-placed experiments/results.jsonl experiments/cell-layout-check.jsonl
```

To reproduce a `v3` row, set `RANDOM_CELL=1`. For example, `RANDOM_CELL=1 npx tsx scripts/exp-worker.ts shoot-dual 101`
prints the `v3` row for seed 101: 380 to 386.
