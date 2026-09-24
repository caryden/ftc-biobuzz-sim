# Backlog

Work that is agreed or that the experiments point to, and that isn't built. The most useful is first. Each item is a
good first issue for a contributor who wants one.

## Launch-spot contention

Stalls are still about 3 per robot per MATCH, mostly at the launch spots, where partners and opponents converge on spots
0.6 m apart. A rule that let the nearer partner take the straight spot lost 59 points, because the spot changed while a
robot approached it. A rule that fixes the choice at the start of the approach isn't tested.

## Opponents that adapt to a defender

The full-time defender takes about 70 to 87 points from an alliance whose planner doesn't react. A real drive team
launches from another spot. The planner needs more than two launch spots per CELL, and it needs to pick one that isn't
blocked.

## Expected-value planner

Replace the fixed priority rule of the default TELEOP tree, `src/auto/trees/teleop/teleop-default.json`, with a planner that estimates points and seconds for every
available tactic and picks the best points per second, with a bonus for staying on the current tactic. The endgame
branch of that tree is a first piece of it.

## AUTO timing for the light, fast robot

The AUTO scripts were tuned on a 16.9 in., 435 rpm robot. The 15 in., 600 rpm baseline scores 176 combined AUTO points,
where the reference robot scored 188. `npx tsx scripts/auto-timeline.ts` shows the step timing.

## Left-side spill

About half of each rear spill lands at or across the FIELD center line. The path planner keeps a robot's circumscribed
circle on its own side, so a robot can't stand in the pocket between the rear FLOWER and the center line, although a
robot that is square to the wall fits legally.

## The AUTO editor

The field editor drags AUTO poses. Increments 7 to 11 of the [behavior-tree plan](behavior-trees.md#plan) make it an
editor for whole AUTO trees: motion and intake leaves, plans that you create and name, parameter forms and an
expression editor, structure editing, and a quick AUTO run with a timeline of both red robots.

## Turret follow-ups

A turret raises scores: with all four robots on one, the ideal turret adds 39.4 ± 13.6 combined points, and a
turret with 180° of range at 180°/s adds 33.9 ± 13.3. See [Subsystems](behavior-trees.md#subsystems) for the table.
Three questions are open:

- **A slow turret.** At 90°/s, a turret loses 21.2 ± 10.0 points, because the robot waits at the spot for the turret
  to aim. A planner that also turns the robot, whichever is faster, might keep the gain.
- **Accuracy or time.** Part of the gain can be accuracy rather than time: an AUTO pose arrives within 0.05 rad of its
  heading, and the turret removes that error from each open-loop shot. AUTO points rose from 177 to 190.3 with the
  ideal turret. That split isn't measured.
- **Firing on the move.** It lost 58.1 ± 9.3 points (`e82-turret-fire-en-route`), because the shot preview is wrong on
  the move: with no launch error, only 59% of the moving launches that it predicted to enter the CELL did, where 97% of
  still ones do. To try again, first make the preview agree with the launch on the move. It leaves out the Magnus lift
  from backspin, which the simulator applies. Two controlled tests without Magnus lift crashed the physics engine with
  a Rapier `unreachable` error, which is worth finding too.

## Measured bounce and roll

Ball masses are AndyMark's listed weights. Restitution, friction, and damping are estimates. A drop test and a roll
test on field tiles would replace them. The POLLEN model in the CAD is about 4 g lighter than the listed weight, so a
scale reading of ten balls would also settle the mass.

## Camera occlusion

`src/sim/camera.ts` has a field of view, a range limit, and a grazing-angle limit, but the HIVE frame, the other CELL,
and other robots don't block the view.

## Trace replay with ball rotation

A trace stores ball positions only, so the balls don't roll in the review.
