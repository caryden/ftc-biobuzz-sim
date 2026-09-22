# How the simulator works

This page describes the simulator for someone who wants to read or change the code. For what the simulations found, see
[the ten lessons](top-ten.md). To set up and contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Robot model

`src/sim/config.ts` holds every robot parameter. The drivetrain model in
`src/sim/drivetrain.ts` computes wheel forces from four goBILDA 5203 Yellow
Jacket motors, a battery with internal resistance, and a traction
limit. Intake, launching, and FLOWER placement use bulk parameters with
sampled distributions, not mechanism physics.

The reference robot, `DEFAULT_ROBOT`, is 16.9 in. square with a 435 rpm drive. `src/setup.ts` turns a robot setup
from the config popup into a `RobotConfig` relative to it. Ball masses are AndyMark's listed weights. Restitution,
friction, and damping are estimates.

## Program drivers

Code drives the robot and presses the buttons. A decision maker picks what to
work on. `src/auto/executor.ts` runs six tactics: `tip_hive`, `collect_pollen`,
`collect_own_nectar`, `launch_into_hive`, `work_flower`, and `park`. A proposed replacement for these decision layers
is in [Behavior-tree policies](behavior-trees.md).

- **`tip_hive`** collects only the POLLEN that the next TIP needs. It counts
  balls in flight, and when a TIP is certain it collects for the opposite CELL.
  An exhaustive search over the nearest floor balls and FLOWER bottoms picks
  the fastest pickup order that ends at the launch spot.
- **Path following.** `src/auto/planner.ts` plans with a visibility graph around
  the HIVE frame foot bars, the frame legs, and the FLOWERS, with an 8 cm buffer
  beyond the robot's diagonal radius. The executor follows the path by pure
  pursuit and turns to the goal heading while it travels. The page draws the
  path in blue.
- **Own NECTAR in a TIP.** Own NECTAR weighs 1.65 POLLEN toward a TIP, which is the ratio of the listed ball masses, so `tip_hive` collects it with a small
  preference. `nectarReserve` keeps one NECTAR in hand for a FLOWER cap. The policy sets it when 75
  seconds remain.
- **Stalls.** If the robot makes no progress toward a target, the executor backs away, avoids that target for 7
  to 12 seconds, and reports `blocked` with a reason, for example "another robot is in the way". The coach then
  picks something else. Inside 0.56 m, robots also push straight away from each other, so they don't wedge.
- **Shooter.** The shooter has a fixed azimuth, with no turret. The default
  shooter faces the rear of the robot, opposite the intake.
- **Endgame by value.** When the drive time to the LOADING ZONE says that it is time to PARK, the executor compares
  values: a launch that finishes a TIP is worth 20 points, a launch that doesn't is worth 2 per element, and PARK is
  worth 5. In a qualification MATCH, a robot whose PARK the alliance still needs for the SWARM ranking point always
  parks. **Stage** in the game setup selects a qualification or a playoff MATCH.
- **Reading a TIP.** A TIP counts as under way only when the HIVE is past level or turning away from its stop. A partly
  loaded CELL sags off its stop, and a driver can see that it hasn't tipped.
- **Defense.** `src/auto/defend.ts` is a full-time defender, and the executor has an opportunistic shove. Both limit a
  contact burst, so that no PIN count reaches 3 s. **Defense** in the robot config selects one.

| Period | Decision maker | Setting |
| --- | --- | --- |
| AUTO | A behavior tree in `src/auto/trees/`, for every robot | **AUTO plan** in the robot config |
| TELEOP | The scripted policy in `src/auto/policy.ts`: TIPS, and FLOWERS from the time that **TELEOP plan** sets | **Driver**: Planner |
| TELEOP | A person with controller 1 or controller 2. Only the red robots can have a human driver. | **Driver**: Controller 1 or Controller 2 |

### Robot config

Every MATCH has four robots: R0, R1, B0, and B1. To configure a robot before a MATCH, click the gear icon next to
its number in the scoreboard or in the **Game setup** panel, or right-click the robot. The popup sets the following:

- The number plate, the driver, and the stick frame for a human driver, which is field-centric by default.
- The shooter's release, whether it launches from both ends, and the intake layout: front, or front and rear.
- The launcher's shot-to-shot error as one standard deviation each: elevation, azimuth, and launch speed. Chips fill
  in 1, 3, or 5 times the reference launcher.
- The intake success probability, the AUTO plan, the TELEOP plan, and the defense policy.
- The drive motor's free speed in rpm, the side of the square chassis, and the mass.

**Units** in the options switches the popup, the telemetry, and the field position readout between metric, which is
the default, and US units. A controller drives
one robot: if you give a robot the controller that another robot has, that other robot goes back to the planner.
The simulator opens with the meta build on all four robots: a four-element catapult, 12 in., 15.4 lb, 500 rpm, and
intakes at both ends. Two such robots beat two baseline robots by 96 points over 24 seeds. The popup's **Meta build** and
**Baseline** buttons apply either robot, and they keep the number plate and the driver. The baseline (15 in., 22 lb,
600 rpm, two at a time, a front intake) is the reference of every experiment, so the headless scripts still use it.
On a first visit, the robots carry the team numbers 5064, 8569, 22377, and 772 as number plates, in a random order on
every visit, until you configure a robot. R0, R1, B0, and B1 stay the robot ids in traces. The browser stores the
setups. `src/setup.ts` turns a setup into a `RobotConfig`: the rpm changes the gear ratio of
the same motor, so the stall torque scales inversely, and the size scales the wheelbase, the track, and the intake.

### AUTO trees

Each AUTO plan is a behavior tree in `src/auto/trees/`. It runs in the onboard environment of `src/auto/onboard.ts`,
which has what an OpMode can know: the robot's own pose, its carried count, its size, the clock, and the camera. It
has no ball, FLOWER, or robot positions. For how trees work, see [Behavior-tree policies](behavior-trees.md).

A tree is a list of steps, and each step is a leaf:

- **`auto.drive`** drives to a pose. **`auto.sweep`** drives a list of planned lanes.
- **`auto.push`** pushes with the intake on, and **`auto.shoot`** launches a count open loop.
- **`auto.wait`** waits, and **`auto.waitClock`** waits until a clock time.
- **`auto.waitCell`** waits until the camera reads a CELL as raised, and **`auto.waitTip`** until it sees that CELL tip.

Each step ends on its condition or its timeout. The robot then does nothing for one physics step, as a state machine
that advances on its next loop does. A tree that ends with a PARK races its steps against the clock, so that the PARK
starts in time whatever step is running. Poses are expressions over the robot's size and shooter direction, so one
tree fits every robot. Each step's note in the tree file says why the step is there.

Paths avoid the fixed FIELD elements and a virtual wall on the FIELD center line, so each robot stays on its own side
(G402). A blue robot mirrors the red poses through the FIELD center. One sensor is modeled: a Limelight 3A that reads
the AprilTag cluster under each CELL, so a `waitCell` step or a `shoot` step with a `cell` holds until the camera
reads that CELL as raised. `src/sim/camera.ts` applies the camera's 54.5° by 42° field of view, a range limit, and
a grazing-angle limit. The camera sits on the shooter side, 0.30 m up and pitched 50°, which frames the raised
CELL's tags from both launch spots. The camera reads the HIVE, not the balls, and only AUTO uses it.

The sweeps are blind but planned from data: `scripts/plan-sweeps.ts` records where spilled balls come to rest over
many simulated AUTO periods, prints a heatmap, searches for the lanes that collect the most, and writes them into the
sweep steps of the trees. Lanes lead with the intake, except along a wall, where the robot faces the wall and strafes.
The page projects the tree onto the FIELD as a dashed orange line, with a wedge at each pose and a red ring where the
robot shoots.

### Alliance partners

Every alliance has two robots, which makes four on the FIELD. Partners coordinate through a shared `intent` and a
shared `plan`, the way drive teams talk:

- **Left and right.** The robot that starts on the left of its drivers is the left robot for the whole MATCH: the
  rear side for red and the audience side for blue. At PARK, the robot with the smaller z takes the end of the LOADING ZONE with the smaller z, so partners
  never pass each other along the wall.
- **Routes.** Both robots feed the raised CELL, because the score follows TIPS almost exactly (19.7 points per TIP,
  correlation 0.996 over 1,277 matches). After a TIP both head for the other end at once, so the right robot goes
  under the HIVE and the left robot goes around it on the alliance's own side. `Executor.convention` also offers
  `sides`, where each robot owns one CELL. It removes all contact but leaves a loaded robot waiting, and it scored
  293 against 359 for `routes`.
- **Own side.** A pickup on the opponent's half of the FIELD costs an extra 1.5 m in the route search.
- **Launch spots.** The first robot launches from straight in front of the raised CELL. Its partner launches from
  0.62 m to the side, angled at the opening, because the shooter has a fixed azimuth.
- **TIP load.** A robot counts its partner's carried load toward the TIP only if the partner delivers it first: the
  partner is in its launch phase and nearer to its launch spot. If that covers the TIP, the robot collects for the
  opposite CELL.
- **Yield and swap.** When both partners head for the same CELL, the one with the smaller load waits until the other is
  lined up. If each arrives on the other's launch spot, they swap spots.
- **FLOWERS.** A FLOWER that the partner works on is taken.
- **AUTO.** `right_harvest` and `left_harvest` are the default pair, named by start position as the drivers see it.
  They sweep walls at 30° toward the wall, wait for a spill to land, and take the pocket behind the launch spot.
  `right_cycle` and `left_cycle` are the earlier pair, with lane sweeps.
  The right robot (R0 or B0) starts on the alliance wall and takes the first TIP. The left robot (R1 or B1) starts on
  the rear wall for red, which is the audience wall for blue, and fills the CELL that the first TIP raises. Both robots
  score LEAVE and AUTO PARK, which earns the SWARM ranking point.
- **PARK.** Partners take opposite ends of the LOADING ZONE, and both are partly inside.

### Opponent robots

The blue robots run the same AUTO trees and the same TELEOP policy as the red robots, with their own robot
configs. Robots collide with each other, and each planner treats the other robots as obstacles. To compare
scripted strategies against the blue alliance, run `npx tsx scripts/sweep.ts`.

### Referee

`src/ref/referee.ts` calls PINS under G421. Code keeps the facts and the clock: contact, each robot's speed and
commanded direction, how far it moved in the last 2 seconds, and whether a wall or a FIELD element boxes it in.
Code also runs the 3-count, the pause and end conditions A, B, and C, and a MAJOR FOUL of 20 points every 3
seconds. A fixed rule, `ruleJudge`, answers the fuzzy part for each direction: is this robot PINNING that one?
The **Referee** list also has an off setting.

### Sounds

`src/audio.ts` plays the cues of Table 9-1 of the Competition Manual. The cues
are synthesized, and speech uses the browser's voice. FIRST's sound files
aren't bundled. To use your own files, put them in `public/sounds/` with these
names and a `.wav` or `.mp3` extension: `start_countdown`, `match_start`,
`auto_end`, `pick_up_controllers`, `countdown`, `teleop_start`,
`flowers_unlock`, `endgame`, and `match_end`.

### FLOWER doctrine

The middle ring passes POLLEN and retains NECTAR (G418), so NECTAR seats at the
ring and plugs the FLOWER. A finished FLOWER is a plug, four POLLEN, and a cap:
`[RN,P,P,P,P,RN]`. It scores 17 points and it is full, so the opponent can't
cap it. `flowerAction` fills a FLOWER only while a cap NECTAR is still
obtainable, and `flowerStep` fetches the cap for a filled FLOWER before any
other FLOWER work.

### Headless matches

To run a full four-robot match with the planner on every robot, run `npx tsx scripts/match.ts`. The script
prints a timeline for red robot 0, the stalls per robot, and the final score of each alliance. The arguments
are the match mode, the AUTO routine, the seed, and the time at which each group of robots starts FLOWER work.
The comment at the start of `scripts/match.ts` lists them.

## Review and annotate a match

The page records every match at 10 Hz, with each frame's full score breakdown, so that the scoreboard scrubs too.

1. During a match, press **M** to mark a moment that looks wrong.
2. Press **V**, or click **Review match**, to open the timeline at the bottom edge.
3. Drag the scrub bar, press **Play**, or type a match clock time such as `0:50` and press Enter.
4. Click a robot, type what went wrong, and press Enter. The note attaches to that robot at the cursor time, and a dot
   marks it on the timeline.

With the dev server, the trace saves to `traces/<name>.json` and the notes to `traces/<name>.annotations.md` and
`.json`. On the deployed site there is no server, so notes stay in the browser's storage, and **Export** downloads the
notes and the trace as files. The Markdown file repeats every robot's position, tactic, goal, and stall at each note,
in field coordinates, so it can be read without the trace. To summarize a trace, run `npx tsx scripts/trace-report.ts`.

Field coordinates: the origin is the FIELD center, +x is the blue wall, +y is the rear wall, and the unit is the meter.
Field y is the negative of the z axis in the code. A click on the FIELD floor reports the position.

## Watching a match without a screen

`npx tsx scripts/watch-match.ts 6` plays scripted four-robot matches and reports driving quality for the red
alliance: goals abandoned before they were achieved, course reversals, seconds against the partner, idle seconds,
meters per element, and balls left under the HIVE. `npx tsx scripts/auto-check.ts 8` reports AUTO points, TIPS,
and hopper fill.
