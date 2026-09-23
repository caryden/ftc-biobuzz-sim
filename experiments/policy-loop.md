# Planner improvement loop

This log records one planner change per row, measured on a fixed set of 24 seeds. The raw results are in
`experiments/policy-loop.jsonl`.

## Method

- **The match.** Four default robots (dual shooter, 435 rpm, 16.9 in., 28.7 lb) play a full MATCH, and the planner
  drives all of them with TIPS only.
- **The measure.** Both alliances run the same planner, so the measure is the combined red plus blue score.
- **The noise.** The standard error of the combined score over 24 seeds is 6 to 10 points. Pairing by seed doesn't
  lower it, because a small change early in a MATCH changes everything after it. Treat a difference under 20 points as
  unproven.
- **The commands.** To run the seed set, run `npx tsx scripts/eval.ts LABEL`. To compare two labels, run
  `python3 scripts/eval-compare.py BASE NEW`.

## Where TELEOP time goes

Seconds per robot, out of 120, at the baseline:

| Activity | Seconds |
| --- | --- |
| Drive to pickups and collect | 49 |
| Drive to the launch spot | 38 |
| Settle over the last 0.3 m to the spot | 13 |
| On the spot, CELL ready, firing | 6 |
| On the spot, waiting for the CELL | 4 |
| Stall recovery | 3 |
| PARK | 6 |

Transit is about 73% of TELEOP. The changes that paid were the ones that removed trips or made a trip collect more.

## Experiments

| Label | Change | Combined score | Decision |
| --- | --- | --- | --- |
| `baseline` | Commit `4a4a17f` | 736 ± 6.6 | |
| `e1-partner-load-eta` | Count the partner's carried load toward a TIP only if the partner is in its launch phase and nearer to its spot than this robot is to its own | 742 ± 8.9 | Kept. The wait for a CELL falls from 4.4 s to 3.0 s per robot. It removes "leaves a CELL that needs one ball". |
| `e2-loose-launch-tolerance` | Launch within 0.22 m and 0.08 rad of the spot, where it was 0.14 m and 0.06 rad. The shot preview remains the gate. | 756 ± 6.3 | Kept |
| `e3-decel-4` | Plan braking at 4.0 m/s², where it was 3.0 | 744 ± 10.2 | Reverted. The robots overshoot, and settling rises from 12.0 s to 13.2 s. |
| `e4-wall-lanes-closer` | AUTO wall sweep lanes at 0.25 m from the wall, where they were 0.34 m, and a longer lead lane | 774 ± 7.9 | Kept. At 0.34 m the intake stopped 1 to 2 cm short of POLLEN against the wall. AUTO points rise from 145.8 to 151.2. |
| `e5-waittip-refit-lanes` | A `waitTip` script step before each sweep that follows a TIP, and lanes refit by `scripts/plan-sweeps.ts` | 776 ± 7.8 | Kept, score-neutral. The partner used to sweep 2 s before its spill landed. |
| `e6a-park-margin` | AUTO park pose 9 cm off the wall, where it was 6 cm | 768 ± 6.7 | Kept, score-neutral. At 6 cm, LEAVE had 1.5 cm of margin. |
| `e6b-harvest-scripts` | `right_harvest` and `left_harvest`: step aside, watch the TIP, drive into the wall behind the launch spot | 758 ± 9.1 | Not the default. AUTO points fall from 151 to 137. |
| `e7-shoot-at-0.35` | Allow a shot while the robot moves at up to 0.35 m/s, where the limit was 0.2 | 731 ± 7.7 | Reverted. It loses 37 ± 9.5 points. Settling doesn't get shorter, and shots from a moving robot miss: TIPS fall from 35.1 to 33.3. |
| `e8-right-wall-sweep` | `right_harvest` with an angled wall sweep: the robot yaws 30° toward the audience wall, keeps its wall-side front corner 1.5 cm off the wall, and drives to the corner until it holds four | 780 ± 10.0 | Superseded by e10. AUTO points rise from 151 to 167. |
| `e9-under-hive-timed` | Before the second sweep, the robot waits under the HIVE for a timed 2.6 s, so that the spill passes over it | 774 ± 12.5 | Superseded by e10. AUTO points rise to 176. The camera reads neither CELL from under the HIVE, so a vision wait there ran to its timeout. |
| `e10-sweep-from-center` | The sweep starts at x = -0.31 m, the G402 limit for a robot at 30° | 776 ± 8.2 | Kept, and `right_harvest` is the default for the right start position. AUTO points are 177, where `right_cycle` scores 151. The full-match gain is +7.8 ± 9.4, because TELEOP starts with emptier hoppers. |
| `e11-rear-wall-grab` | After its last shot at the rear launch spot, the right robot drives 0.25 m into the rear wall with the intake on, returns, and launches again before it parks | 801 ± 7.6 | Kept. +24.9 ± 10.8 over e10, and AUTO points rise from 177 to 182.5. From trace 20260920-155206: three POLLEN rested there and the robot parked with 6 s left. |
| `e12-left-pocket` | `left_harvest`: the left robot checks the same rear wall pocket after its own TIP, with a 1.4 s wait | 786 ± 8.1 | Not kept. The robot reaches the pocket 1.7 s after the TIP, before the spill lands, and finds one POLLEN. |
| `e13-left-pocket-later` | The same with a 3.0 s wait | 804 ± 7.1 | Neutral against e11 (+2.8 ± 11.3), and AUTO points are 177.6. The robot finds three POLLEN, where its lane sweep finds two. `left_cycle` stays the default, and `left_harvest` is selectable. |
| `e14a-park-intake` | Every AUTO drive to PARK runs the intake | 791 ± 7.9 | Kept, score-neutral (-10.1 ± 9.4 against e11, with identical AUTO points). |
| `e14b-left-pattern` | `left_harvest`: the pocket after a 3 s wait, a launch, an angled sweep of the rear wall from the FLOWER to the corner, a sweep along the alliance wall, a launch, and another alliance wall sweep until the PARK | 791 ± 8.9 | Kept as the default for the left start position. Neutral on the match (0.0 ± 12.5), and AUTO points rise from 182.5 to 187.8. The robot used to park with 10 s left. |
| `e15-fire-all` | The dual shooter fires the whole hopper, not only what the TIP needs | 795 ± 6.5 | Not kept: +3.7 ± 10.8. The wait for a CELL falls from 3.8 s to 2.9 s, but the extra balls must be collected again. |
| `e16-endgame-value` | The PARK guard compares values: a launch that finishes a TIP is worth 20, a launch that doesn't is worth 2 per element, and PARK is worth 5. In a qualification MATCH, a robot whose PARK the alliance needs for SWARM always parks. | 800 ± 8.9 | Kept: +9.5 ± 1.4 against e14b. Matches are identical up to the endgame, so the pairing is tight. PARK points fall from 20.0 to 18.5, and TIPS rise by 0.6. |
| `e17-small-light-fast-all-four` | All four robots at 15 in., 22 lb, and 600 rpm. A robot comparison, not a planner change. | 832 ± 7.4 | +31.9 ± 10.0 against e16. Stalls fall from 3.6 to 2.8 per robot. AUTO points fall from 187.8 to 175.8, because the AUTO timing is tuned on the default robot. |
| `e18-new-default-robot` | The default setup in `src/setup.ts` is 15 in., 22 lb, and 600 rpm. `scripts/eval.ts` uses it from here on. | 832 ± 7.4 | The same matches as e17. It is the baseline for later planner experiments. AUTO points are 175.8, where the reference robot scores 187.8, so the AUTO timing for the fast robot is worth a look. |
| `e19-dual-intake-all-four` | A dual-sided intake on all four robots: a second intake box on the rear face, and the planner takes each floor pickup with whichever end needs the smaller turn | 851 ± 7.4 | +18.6 ± 10.8 against e18, or about +9 per alliance. Collecting falls from 52.3 s to 46.4 s per robot, and stalls from 2.8 to 2.4. A robot comparison, not a default. |
| `e20-dual-intake-red-only` | The same on the red robots only | red 429.3, blue 411.8 | Red rises from 416.8 to 429.3, and the margin over blue from 1.2 ± 8.6 to 17.6 ± 5.8. |
| `e21-tip-past-level-and-spot-swap` | Two fixes from trace 20260920-165529 together: a TIP counts as under way only once the HIVE is past level, and the partner nearer to the straight launch spot takes it | 782 ± 7.8 | Reverted: -49.8 ± 7.9 against e18. |
| `e21a-spot-swap-only` | The spot rule alone | 773 ± 9.6 | Reverted: -59.2 ± 9.2. The spot changes while the robot approaches it. |
| `e21b-tip-past-level-only` | The TIP detection alone | 814 ± 9.1 | Reverted: -18.0 ± 11.7. Robots then launch at a HIVE that still rocks. |
| `e22-swap-when-crossed` | Partners swap launch spots only when each stands within 0.3 m of the other's spot | 829 ± 8.2 | Kept for the behavior: it ends the mutual push in the trace. The score is -3.3 ± 2.3, so it doesn't pay in points. |
| `e23-left-waits-for-cell` | In AUTO, the left robot waits up to 8 s at its spot for the rear CELL, where it waited 2 s | 829 ± 8.2 | Kept. Identical scores on these seeds: the wait never binds with the default robot. |
| `e24-meta-build-red-only` | The combined build on red (catapult, 500 rpm, 12 in., 15.4 lb, front and rear intakes) against baseline blue. A robot comparison. | red 507.5, blue 411.7 | The margin is 95.8 ± 9, where baseline against baseline gives 1.2 ± 8.6. The design traits stack. |
| `e25-dual-shooter-red` | Red launches from both ends | red 412.2, blue 402.5 | No effect: the baseline red score is 416.8. |
| `e26-dual-shooter-dual-intake-red` | Red launches from both ends and has intakes at both ends | red 425.5, blue 408.3 | No gain over the dual intake alone, which scores 429.3. |
| `e27-referee-baseline` | The baseline with the PIN referee on | red 416, blue 413 | The reference for the defense rows. Margin +3.0 ± 8.1. |
| `e28-full-defense-left-robot` | Red's left robot plays full defense | red 323.9, blue 326.4 | A wash: it gives up 92 and takes 87. |
| `e29-opportunistic-both` | Both red robots shove an opponent that is lined up | red 407.3, blue 400.9 | No effect: margin +6.4 ± 7.9. |
| `e30-weak-red-both-score` | Red at 3 times the launch spread | red 277.1, blue 401.7 | The reference for e31. |
| `e31-weak-red-one-defends` | The same, and one red robot defends | red 209, blue 329.9 | A wash: it gives up 68 and takes 72. |
| `e32-very-weak-red-both-score` | Red at 5 times the launch spread | red 162.5, blue 398.1 | The reference for e33. |
| `e33-very-weak-red-one-defends` | The same, and one red robot defends | red 133.1, blue 329.5 | Defense pays: the margin improves by 39. |
| `e34-baseline-alone` | The baseline alliance with no opponent | red 409.7, blue 9.1 | An alliance scores the same alone as against an opponent. |
| `e35-meta-alone` | The meta alliance with no opponent | red 504.1, blue 9.2 | The same. |
| `e36-meta-vs-meta` | The meta alliance against itself | red 511.8, blue 505.6 | The same. |
| `e37-baseline-vs-meta` | The baseline against the meta alliance | red 411.6, blue 505.4 | The same. |
| `e38-meta-plus-weak-both-score` | Red is the meta robot with a partner at 5 times the launch spread, and both score | red 313.6, blue 410 | Red wins 0 of 24. |
| `e39-meta-plus-weak-defender` | The same, and the weak partner plays full defense | red 335.1, blue 339.6 | Red wins 15 of 24. Blue loses 70, and red's own score rises by 21. Defense flips matches only for a mixed alliance. |
| `e40-meta-old-tip-test` | The meta build on all four robots, with the old TIP test (the HIVE is off its stop) | 1017 ± 11 | The reference for e41. Robots wait 8.1 s each for a CELL. |
| `e41-meta-tip-by-motion` | The same, with the new test: a TIP is under way only when the HIVE is past level or turning away from its stop, and the launch interlock waits for a calm HIVE | 1032 ± 8.6 | Kept: +14.6 ± 15.3, and the wait for a CELL falls to 4.4 s. A partly loaded CELL sags by up to 0.13 rad and stays there, and the old test read that as a TIP, so robots left for the other end with a load that would have tipped the raised CELL. |
| `e42-baseline-tip-by-motion` | The new test on the baseline robots | 816 ± 6.9 | -16.3 ± 9.4 against e18. The two results cancel, so the change is kept for the behavior, not for points. `EXEC.tipByMotion` switches it. |
| `e43-elevation-error-x3` | Red with 3 times the elevation error only (3.0°) | red 354.5, blue 405.5 | -62 against a baseline red score of 416.8. |
| `e44-azimuth-error-x3` | Red with 3 times the azimuth error only (3.6°) | red 391.6, blue 400.6 | -25. |
| `e45-speed-error-x3` | Red with 3 times the launch speed error only (0.24 m/s) | red 307.6, blue 399.5 | -109. Launch speed consistency matters most. |
| `e46-all-errors-x3` | Red with all three errors at 3 times | red 260.2, blue 402.5 | -157. The three losses are sub-additive: they sum to 196. |
| `e47-andymark-masses-baseline` | The ball masses from AndyMark's product page (24.9 g and 41.3 g, where the simulator assumed 22.0 g and 35.2 g), with the HIVE's ballast height calibrated again at 0.063 m | 820 ± 7.2 | Kept. +4.2 ± 8.7 against e42, so the published results stand. |
| `e48-step-cache-base` | Commit `89c2f2e`, the reference for e48 | 820 ± 7.2 | The same as e47. |
| `e48-step-cache` | A speed change, not a planner change. Between two world steps, `Sim` reads each ball's position from Rapier once, and it counts the raised CELL's load once per alliance. `Hive` reads its angle, angular velocity, and pivot position once per step. | 820 ± 7.2 | Kept. Every per-seed score and summary field is identical to e48-step-cache-base. One MATCH on seed 11, timed by `scripts/match-timing.ts` as the mean of three runs: the planner falls from 16.99 s to 6.80 s, physics from 9.81 s to 9.56 s, and the referee from 0.29 s to 0.26 s. The MATCH falls from 27.08 s to 16.63 s. The 24-seed eval on 10 workers falls from 111 s to 73 s. |
| `e49-random-cell-nectar` | A setup change, not a planner change. The three NECTAR that start in each raised CELL drop in at random spots drawn from the seed, and the sim runs 1.5 s of physics before the MATCH. The FIELD reset crew tosses them in, so the layout differs from MATCH to MATCH. The CAD spots put them in a row against the back skin. | 812 ± 7.7 | Kept, because it models the FIELD reset. -8.5 ± 10.3 against e48-step-cache, which is noise, so the published results stand. On six seeds that I checked, all three NECTAR roll to the back skin and stay in the CELL: only their positions across the CELL change, and the load is 4.95 on every seed. |
| `e49-fixed-cell-check` | `FIXED_CELL=1`, which sets `STAGING.randomCellNectar` to false | 820 ± 7.2 | Identical to e48-step-cache in every field, so the switch restores the old layout. |
| `e50-baseline-main` | The baseline again, on the public repository's `main` | 820 ± 7.2 | The reference for e51. It ran on commit `89c2f2e`, before the random CELL NECTAR of e49-random-cell-nectar. Identical to e47 on all 24 seeds, so the code hasn't changed since e47. |
| `e51-script-counts-steps` | `ScriptRunner` times each AUTO step and its 0.15 s replanning by counting physics steps, where it added `dt` on every step. The sum drifted, so 7 of the 16 timeout lengths in the scripts, including 2.5 s, 3 s, and 4 s, ended one step early. | 802 ± 9 | Kept for the timing, not for points. -18.0 ± 9.5 is under the 20-point threshold, but 18 of 24 seeds went down. AUTO falls from 172.2 to 167.4. Exact timing lets the AUTO trees of docs/behavior-trees.md match the script runner step for step. See [How much AUTO depends on 4 ms](#how-much-auto-depends-on-4-ms). |
| `e52-auto-trees` | AUTO runs as behavior trees in `src/auto/trees/`, which replace `ScriptRunner` and `buildScripts`. See docs/behavior-trees.md. | 802 ± 9 | Kept. Identical to e51 on every seed. A separate check ran each tree alongside the script runner and found the same inputs on every physics step of 45 AUTO periods. |
| `e53-coach-counts-steps` | The coach's once-per-second TELEOP review counts physics steps, where it added `dt` on every step. Under the sum, 114 of a MATCH's 150 timed reviews came 241 steps apart, and 35 came at 240. | 803 ± 7.9 | Kept. +0.5 ± 2.7, no measurable effect. The TELEOP tree's reactive fallback counts exactly, so it needs this change to match the coach. |
| `e54-teleop-tree` | TELEOP runs as the behavior tree `src/auto/trees/teleop_default.json`, which replaces the coach's decision code and `scriptedTeleop`. See docs/behavior-trees.md. | 803 ± 7.9 | Kept. Identical to e53 on every seed. A separate check ran the tree alongside the coach's old code and found the same inputs on every physics step of full matches. |
| `e55-old-planner-reference` | The reference for e56: `main` at `3ca1eb9`, with random CELL NECTAR, plus the two timing fixes of e51 and e53 on the old planner code | 809 ± 7.5 | The reference. -2.7 against e49-random-cell-nectar, so on the random layout the two timing fixes together cost nothing measurable. |
| `e56-trees-on-random-nectar` | Both trees, merged with `main` at `3ca1eb9` | 809 ± 7.5 | Kept. Identical to e55 on every seed and in every field. |
| `e57-renamed-trees` | The trees get new ids and display names, for example `wall-sweep-pair-right` for `right_harvest`. See experiments/README.md. | 809 ± 7.5 | Kept. Identical to e56 on every seed and in every field. |

Net for the planner: 736 to 800 combined on the default robots, or about +32 per alliance. The standard error of that difference is about 11.

## How much AUTO depends on 4 ms

e51 changed when some AUTO steps end by one physics step, which is 4 ms. That changed AUTO in 10 of the 24 seeds. In 9
of them, an alliance made one or two AUTO TIPS more or fewer. Over the 24 seeds, AUTO lost 115 points: 3 alliances
gained points and 8 lost them. The choreography was tuned on the drifting timer, so some of its timing sat on
an edge that the drift happened to be on the good side of.

A real robot's timing varies by far more than 4 ms from one MATCH to the next. So a single seed's AUTO score says
little about a choreography, and a change to AUTO needs all 24 seeds.

## How fast the HIVE tips

Measured over four matches, from the moment that the raised CELL's load crosses 7.4 POLLEN equivalents to the completed TIP:

| Peak load | TIPS | Median | 90th percentile |
| --- | --- | --- | --- |
| 7.4 to 8 | 58 | 1.73 s | 1.97 s |
| 8 to 9 | 46 | 1.46 s | 1.79 s |
| 9 to 10.5 | 8 | 1.32 s | 1.45 s |
| 10.5 or more | 3 | 1.22 s | 1.23 s |

A light overload tips about 0.5 s slower than a heavy one.

## What the harvest tests showed

- The first version drove straight into the wall behind the launch spot and lowered AUTO points, because the first
  spill spreads along 0.9 m of wall.
- The angled wall sweep fixes that. The intake is 4.5 cm narrower than the chassis on each side, so a robot that is
  square to its path never reaches a ball on the wall. At 30° the wall line crosses the front of the intake box. One
  sweep after the third TIP filled the hopper in 0.8 s, where a lane sweep took 6 s to find two elements.
- The order matters. The red FLOWER trip fills the wait for the left robot's TIP, and the sweep, which is the shorter
  round trip, goes on the critical path after the audience CELL rises. The third TIP comes at about 17 s, where it
  came at 21 s, and that leaves time for a fourth TIP into the rear CELL. Four AUTO TIPS happen in some seeds.

## Why five AUTO TIPS didn't work

The plan: the left robot makes the fourth TIP alone from the rear pocket, and the right robot stays on the audience side
for a fifth. On four seeds it scored three AUTO TIPS, where the committed pair scores four, so it isn't kept.

- The rear spill centers on x = -0.1 m. In seed 1001, five of its eight POLLEN rested between x = -0.35 m and +0.10 m,
  so about half lie at or across the center line, where G402 keeps the robot out.
- The pocket yields 2 to 4 reachable elements per spill. A fourth TIP needs 8 POLLEN equivalents, and the rear CELL ended
  with 2 to 7.
- The committed pair reaches a fourth TIP because the right robot brings a full hopper across.

## Ideas not tested yet

- An angled wall sweep for the left robot. The rear FLOWER is on red's rear wall at x = -0.59 m, so that sweep can start only at x = -0.99 m.
- The lead robot loads the rear CELL during its wait, so that the second TIP comes earlier.
- The rear spill rests between the rear FLOWER and the center line. The path planner keeps the robot's circumscribed
  circle on its own side, so it can't stand there, although a robot that is square to the wall fits.
- Stalls are still 4 per robot per MATCH, mostly contention at the launch spots.
- The 13 s per robot of settling is physical braking. A robot that launches while it moves would remove it.
