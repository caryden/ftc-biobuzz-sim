# Experiments

Every number on the site and in `docs/top-ten.md` comes from a file in this folder.

| File | Contents |
| --- | --- |
| `results.jsonl` | One line per match of the robot design runs. Red gets the change under test, and blue is two baseline robots. Rows with `"tag":"v2"` are the current round: 780 matches on the current planner, with the 15 in., 22 lb, 600 rpm baseline. Rows with no tag are the first round. |
| `run-v2-report.md` | The `v2` rows pooled per configuration, written by `npx tsx scripts/exp-report.ts` |
| `run-v2-summary.md` | The summary that `scripts/exp-run.ts` printed at the end of the `v2` run |
| `policy-loop.jsonl` | One line per evaluation run of `scripts/eval.ts`: 24 fixed seeds, with the score of every match and the TELEOP time account |
| `policy-loop.md` | The log of those runs: what changed, the score, and whether the change was kept. Reverted experiments are in it too. |
| `first-round/` | Reports of the first 1,524 matches |

## The first round is history

The first round used an earlier planner, which stalled about 18 times per match, and a 16.9 in., 28.7 lb, 435 rpm
robot. Its reports also describe a language model drive coach that the project no longer uses. The `v2` round replaces
it. Two of its conclusions changed: gearing for speed doesn't hurt up to 700 rpm, and the shooter's side matters.
Read `first-round/` for the record, not for advice.

## Read a result

- One match varies by about 20 points. A design row is 12 matches, so its standard error is 5 to 12 points, and a
  difference under 25 points is unproven. An evaluation run is 24 matches, with a standard error of 6 to 10 points on
  the combined score.
- In `policy-loop`, both alliances run the same planner, so the measure is the combined red plus blue score. Divide a
  gain by two for one alliance. Runs with `red-only` or a margin in the log compare red against baseline blue.
- Settings that apply to all four robots, which are the `follow` and `path` groups in `results.jsonl`, must be read
  from the combined score, not from red's score.

To reproduce a run, see the commands in the [README](../README.md#run-matches-without-a-browser) and the method in
[CONTRIBUTING.md](../CONTRIBUTING.md#change-the-planner-or-a-robot-model).
