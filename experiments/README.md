# Experiments

Every number on the site and in `docs/top-ten.md` comes from a file in this folder.

| File | Contents |
| --- | --- |
| `results.jsonl` | One line per match of the robot design runs. Red gets the change under test, and blue is two baseline robots. Rows with `"tag":"v3"` are the current round: 7,584 matches, 96 seeds for each of 79 setups, on the planner of September 24, 2026, with the 15 in., 22 lb, 600 rpm baseline, and with the CELL NECTAR at random spots. Rows with `"tag":"v2"` are the round before, 12 seeds per setup, and rows with no tag are the first round. |
| `run-v3-report.md` | The `v3` rows pooled per configuration, written by `npx tsx scripts/exp-report.ts`. The Change column compares each configuration with the baseline seed by seed. |
| `run-v3-summary.md` | The summary that `scripts/exp-run.ts` prints for the `v3` rows |
| `run-v2-report.md` and `run-v2-summary.md` | The same two reports for the `v2` round |
| `policy-loop.jsonl` | One line per evaluation run of `scripts/eval.ts`: 24 fixed seeds, with the score of every match and the TELEOP time account |
| `policy-loop.md` | The log of those runs: what changed, the score, and whether the change was kept. Reverted experiments are in it too. |
| `cell-layout-check.md` and `cell-layout-check.jsonl` | A rerun of 14 `v3` setups with the CELL NECTAR in the row that the rules prescribe: 1,344 matches, tagged `cell-placed`. No setup moved by more than 1.2 standard errors. |
| `first-round/` | Reports of the first 1,524 matches |

## The first round is history

The first round used an earlier planner, which stalled about 18 times per match, and a 16.9 in., 28.7 lb, 435 rpm
robot. Its reports also describe a language model drive coach that the project no longer uses. The `v2` round replaces
it. Two of its conclusions changed: gearing for speed doesn't hurt up to 700 rpm, and the shooter's side matters.
Read `first-round/` for the record, not for advice.

## The v2 round is history too

The `v2` round ran 12 seeds per setup, so a difference under 25 points was unproven. The `v3` round reran every setup
on 96 seeds with the planner of September 24, 2026, and added the turret and the combined build. One setup moved by
more than 2.5 standard errors: launching from the far edge of the scoring window costs less than `v2` measured.
Differences that `v2` couldn't resolve now resolve: gearing down to 435 rpm or 500 rpm helps, and an 11.8 in. chassis
gains less than `v2` suggested.

## The v3 round started the CELL NECTAR at random spots

From September 22 to September 26, 2026, the sim dropped the three NECTAR in each raised CELL at random spots across
the CELL. The rules place them in a row against the back skin, packed toward their own ALLIANCE AREA (issue #22). The
`v3` round and the `policy-loop` runs from e49 to e95 used the random spots, except e49-fixed-cell-check and
e50-baseline-main. A rerun of 14 `v3` setups on the prescribed row found no setup that moved by more than 1.2 standard
errors. See `cell-layout-check.md`. To reproduce a `v3` row or one of those runs, set `RANDOM_CELL=1`.

## Read a result

- One match varies by about 23 points. A design row in the `v3` round is 96 matches on the same seeds as the
  baseline, so a change measured seed by seed has a standard error of 2 to 4 points, and a difference under
  7 points is unproven. An evaluation run is 24 matches, with a standard error of 6 to 10 points on
  the combined score.
- In `policy-loop`, both alliances run the same planner, so the measure is the combined red plus blue score. Divide a
  gain by two for one alliance. Runs with `red-only` or a margin in the log compare red against baseline blue.
- Settings that apply to all four robots, which are the `follow` and `path` groups in `results.jsonl`, must be read
  from the combined score, not from red's score.

To reproduce a run, see the commands in the [README](../README.md#run-matches-without-a-browser) and the method in
[CONTRIBUTING.md](../CONTRIBUTING.md#change-the-planner-or-a-robot-model).

## Renamed AUTO trees

On September 23, 2026, the AUTO trees got new ids. The logs and reports from before that date use the old names:

| Old name | New id |
| --- | --- |
| `right_harvest` | `wall-sweep-pair-right` |
| `left_harvest` | `wall-sweep-pair-left` |
| `right_cycle` | `lane-sweep-pair-right` |
| `left_cycle` | `lane-sweep-pair-left` |
| `left_cycle_no_park` | `lane-sweep-pair-left-no-park` |
| `cycle_and_park` | `solo-two-tip-sweep` |
| `cycle_no_park` | `solo-two-tip-sweep-no-park` |
| `leave_only` | `leave-and-park` |
