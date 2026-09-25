# Ten lessons for an FTC team, from 12,000 simulated matches

We are the students and mentors of the three FTC teams at NCSSM: 5064, 8569, and 22377. This post is for a team that is
deciding what to build, what to practice, and how to plan a match. We simulated BIOBUZZ, the 2026-2027 FIRST Tech
Challenge game, about 12,000 times and changed one thing at a time. The game details are BIOBUZZ, but most of the
lessons carry to any season in which robots collect, launch, and race a clock.

The [Match Lab](results.html) page shows the same results as charts, and it estimates the score of a robot that you
configure.

Each lesson starts with the advice. The numbers follow, and then something to try at practice. Read the ranking as
"where to look first", not as a prediction for your robot. The section
[What a simulator can't tell you](#limits) lists what the numbers leave out.

<!-- id: numbers -->
## How to read the numbers

- **Points are per alliance, per match.** A typical alliance in these matches scores about 410 points.
- **One match varies by about 23 points.** Each design row is 96 matches, compared with the baseline seed by seed, so a
  change has a standard error of about 3 points and a difference under 7 points is unproven. We say so where it applies.
- **The baseline robot** is 15 in. square, 22 lb, and geared for 600 rpm at the wheel, with a rear-facing shooter that
  releases two elements at a time and a 95% reliable intake.

BIOBUZZ in one paragraph: robots collect POLLEN and NECTAR and launch them into the raised CELL of their HIVE. About 8
POLLEN tip the HIVE for 20 points, which dumps that CELL onto the floor and raises the other one. FLOWERS are a slower
second objective. PARK is 5 points at the end.

<!-- id: lessons -->
## The ten lessons

<!-- id: launcher -->
### 1. Make your launcher repeatable before anything else

Nothing else comes close. The baseline launcher varies by 0.08 m/s in speed, 1° in elevation, and 1.2° in yaw. Three
times that spread costs more than a third of the score.

| Launch spread | Score | Change |
| --- | --- | --- |
| Baseline | 409 | |
| 3 times the baseline | 259 | -150 |
| 5 times the baseline | 160 | -249 |
| 8 times the baseline | 95 | -314 |

A miss isn't one lost point. It delays a 20-point TIP, and the element has to be collected again. AUTO suffers most,
because an open-loop AUTO can't correct: AUTO points fall from 90 to 43 at 3 times the spread.

Stop before you shoot, too. Letting the robot launch while it still moved at 0.35 m/s cost about 18 points and saved no
time.

Not every error costs the same. We tripled one error at a time, over 24 matches each:

| Error at 3 times the baseline | Score | Change |
| --- | --- | --- |
| Launch speed: 0.24 m/s | 308 | -109 |
| Elevation: 3.0° | 355 | -62 |
| Azimuth: 3.6° | 392 | -25 |
| All three | 260 | -157 |

A shot that is too fast or too slow misses long or short, and the CELL's opening is shallow in that direction. A shot
that is off to one side still goes in. So spend your effort on a consistent launch speed first.

**At practice:** launch 20 elements from one spot and measure the group. Then chase the causes: flywheel speed control,
how each element seats, battery voltage, and worn wheels.

<!-- id: scoring-window -->
### 2. Find your scoring window, and launch from the middle of it

The window is a distance, not an angle. The baseline shot scores from any standoff between about 1.16 m and 1.58 m along
the line of the shot. Launching from the far edge of that window costs 73 points, and from the near edge 117. A robot
never stops exactly on its spot, and at the edge of the window a few centimeters off is a miss.

Angled launches are fine. In every match here, the second robot of each alliance launches from a spot 0.62 m to the
side, about 40° off the HIVE's axis, and it scores as well as the robot in front. Two launch spots are also what lets
partners launch at the same time.

**At practice:** find the nearest and the farthest distance that still scores, from straight on and from an angle, and
mark the middle of each on your practice field. Teach your drivers those spots, not "somewhere near the goal".

<!-- id: auto -->
### 3. Run an AUTO, and plan it with your partner

| AUTO plan | AUTO points | Score | Change |
| --- | --- | --- | --- |
| A planned pair | 90 | 409 | |
| Both robots run a good solo routine | 30 | 357 | -52 |
| One solo routine, the partner only parks | 47 | 369 | -40 |
| Both robots only LEAVE and PARK | 16 | 341 | -68 |
| No AUTO | 0 | 327 | -82 |

Two good solo routines collide at the same launch spot and score 30 AUTO points, where a planned pair scores 90. The
value of AUTO is also more than its points: a planned pair starts TELEOP with full hoppers and a loaded CELL.

What made the pair work:

- **Plan by start position.** One routine for the robot that starts at the right, and one for the left. Each robot
  launches from its own spot, 0.62 m apart, so they never share one.
- **Wait on a sensor, not on the clock.** Each robot holds its fire until its camera reads the AprilTags of the raised
  CELL. An earlier version used clock waits, and a launch 1.5 s early cost 23 AUTO points.
- **Put the short trip on the critical path.** The slow trip fills the dead time while you wait for your partner. That
  order moved the third TIP from 21 s to about 17 s, which left time for a fourth.

**Before a match:** ask your partner where they start, where they launch from, and what they collect. Agree on who
goes where.

<!-- id: main-cycle -->
### 4. Keep doing the thing that pays, and send at most one robot to the side objective

| TELEOP plan for the two robots | Score | Change |
| --- | --- | --- |
| Both keep tipping | 409 | |
| One tips, the partner works FLOWERS from 30 s | 406 | -3 |
| One tips, the partner works FLOWERS from 45 s | 400 | -8 |
| Both work FLOWERS from 30 s | 383 | -26 |
| Both work FLOWERS from 45 s | 363 | -46 |
| Both work FLOWERS from 66 s | 341 | -68 |

A TIP is 20 points for 6 to 8 elements. A finished FLOWER is 17 points for 6 elements, and it takes longer. One robot
on FLOWERS for the last 30 s costs nothing and takes those FLOWERS away from the opponent. Two robots on FLOWERS for
the last minute is the worst plan tested.

The answer changes if your launcher is poor. At 8 times the launch spread, FLOWER work from 45 s adds 36 points, because
placing doesn't depend on aim.

**In general:** work out the points per element and per second for every way to score, and check it against how well
your robot does each one.

<!-- id: match-time -->
### 5. Watch where your robot waits

Where a robot's 120 s of TELEOP went in these matches:

| Activity | Seconds |
| --- | --- |
| Driving to elements and collecting | 49 |
| Driving to the launch spot | 38 |
| Slowing down onto the spot | 13 |
| Launching | 6 |
| Waiting at the spot for the CELL to rise | 4 |
| Recovering from a collision | 3 |
| PARK | 6 |

Driving is about 73% of the match, and launching is 5%. Fixing decisions, with no change to the robot, was worth about
32 points per alliance. The mistakes were ones that a drive team makes too:

- **A long trip with a nearly empty hopper.** A robot carried one element across the field and waited 5 s for a CELL.
- **Driving past a free element.** A robot with two empty slots passed a POLLEN 0.22 m away, because it had "enough".
- **Assuming your partner has it.** A robot left a CELL that needed one more element, because its partner held a full
  load, and the partner was still across the field. Call out who delivers first.
- **Pushing your partner.** Two robots arrived at each other's launch spots and shoved for 2 s. The closer robot takes
  the spot that it is on.

**At practice:** film a match, and count the seconds in which a robot holds elements and doesn't launch, waits for
something, or drives past an element with room in the hopper.

<!-- id: shooter -->
### 6. Release your whole load fast, and face the shooter away from the intake

| Shooter | Score | Change |
| --- | --- | --- |
| Two at a time, 0.3 s between releases (baseline) | 409 | |
| All four at once | 469 | +60 |
| Two at a time, 0.15 s between releases | 430 | +21 |
| One at a time, in intake order | 430 | +21 |
| Two at a time, 0.6 s between releases | 386 | -23 |
| Shooter on the same side as the intake | 377 | -32 |

Time at the launch spot is paid on every cycle, about 14 times per match. The HIVE also tips faster under a heavy
overload: 1.2 s, against 1.7 s when the load barely crosses the threshold.

The shooter's side matters for a reason that carries to other games. With the shooter opposite the intake, the robot
arrives at the launch spot from a pickup without turning around, and its intake faces the wall where the dumped
elements land.

A turret takes the same idea further, if it turns fast and its range faces away from the intake. We put the shooter on a
turret that turns to the raised CELL:

| Turret | Score | Change |
| --- | --- | --- |
| None (baseline) | 409 | |
| A full turn, instantly: an upper bound | 426 | +17 |
| 360° of range, 360°/s | 423 | +14 |
| 270° of range, 360°/s | 422 | +13 |
| 180° of range, 360°/s | 423 | +14 |
| 90° of range, 360°/s | 423 | +14 |
| 360° of range, 180°/s | 424 | +15 |
| 180° of range, 180°/s | 422 | +13 |
| 360° of range, 90°/s | 403 | -6 |
| 270° of range, 360°/s, centered on the intake side | 414 | +5 |
| 180° of range, 360°/s, centered on the intake side | 413 | +4 |
| 90° of range, 360°/s, centered on the intake side | 407 | -2 |

Every range except the last three is centered on the rear, away from the intake. There, range didn't matter: from 90° to
a full turn, a turret that turns 360°/s gained 13 to 14 points. Centered on the intake side, the same turrets changed
the score by -2 to +5. Speed matters once the turret is slower than the robot: at 90°/s the robot waits for the turret
at the spot, and the score falls below the baseline.

The turret helps because the robot no longer has to face the CELL when it arrives. With all four robots on the ideal
turret, the time to reach the launch spot fell from 38 s to 34 s per robot. It also stacks with an intake on both ends:
both together gained 42 points, where the 270° turret alone gained 13 and the second intake alone 17.

The simulator's turret points exactly where it aims. A real turret adds its own aim error, so read lesson 1 before you
build one.

<!-- id: chassis -->
### 7. Build light, stay small, and don't chase top speed

| Robot mass | Score | Change |
| --- | --- | --- |
| 15 lb (7 kg) | 428 | +20 |
| 22 lb (10 kg, baseline) | 409 | |
| 29 lb (13 kg) | 389 | -20 |
| 37 lb (17 kg) | 368 | -41 |

| Chassis, square | Score | Change |
| --- | --- | --- |
| 18 in., the legal maximum | 397 | -12 |
| 16.9 in. | 395 | -14 |
| 15 in. (baseline) | 409 | |
| 13.4 in. | 412 | +3 |
| 11.8 in. | 413 | +4 |

| Drive gearing, at the wheel | Score | Change |
| --- | --- | --- |
| 312 rpm | 405 | -3 |
| 435 rpm | 423 | +14 |
| 500 rpm | 419 | +11 |
| 600 rpm (baseline) | 409 | |
| 700 rpm | 400 | -8 |
| 850 rpm | 376 | -32 |

Mass is the clear one: about 6 points per kilogram, in a straight line. The field is 12 ft across and crowded, so a
robot spends its time speeding up and stopping, and traction limits how fast any robot speeds up. A light robot stops
sooner, and a robot that settles sooner launches sooner.

Size pays one way only. A chassis bigger than 15 in. cost 14 points at 16.9 in. and 12 at 18 in., and a smaller one
gained 3 to 4, within the noise. Gearing down pays: 435 rpm and 500 rpm gained 14 and 11 over 600 rpm. 312 rpm is within
the noise, 700 rpm cost 8, and 850 rpm cost 32. A heavy robot needs the torque most: at 37 lb, 435 rpm cost 14 points,
where 600 rpm cost 41.

**The simulator doesn't check** whether your mechanisms fit in 12 inches or weigh 15 lb. Treat the tables as the price
of every pound and every inch.

<!-- id: intake -->
### 8. Check what your intake can actually reach

Elements end up against walls and in corners. An intake that is narrower than the chassis can't reach an element on a
wall while the robot drives along that wall. In this model the gap was 4.5 cm on each side, and a wall sweep missed the
elements by 1 cm to 2 cm.

| Intake | Score | Change |
| --- | --- | --- |
| Front, 3.5 in. narrower than the chassis (baseline) | 409 | |
| Front, full width | 424 | +16 |
| Front and rear | 425 | +17 |
| Front and rear, full width | 437 | +28 |
| Succeeds 80% of the time | 394 | -15 |
| Succeeds 60% of the time | 362 | -47 |

An idea from one of our mentors fixed the wall problem without a new mechanism: turn the robot 30° toward the wall, put the front
corner on the wall, and drive to the field corner. At that angle the wall crosses the mouth of the intake. One such
sweep filled a hopper in 0.8 s, where a straight pass took 6 s to find two elements.

An intake on both ends lets the robot take an element with whichever end is nearer, so it turns less. It was worth 17
points here, and about 9 per alliance in a test in which all four robots had it. With intakes on both ends, the
shooter's side stops mattering: 429 with the shooter at the front, and 425 at the rear. A rear intake has to share a
face with a rear shooter, which is a packaging problem that the simulator ignores.

**At practice:** put elements against a wall and in a corner, and find out how your robot gets them.

<!-- id: spill -->
### 9. Go where the elements end up, and let them land first

A TIP dumps 8 elements, and that dump is most of the supply for the next TIP. Three measurements changed how the robots
collect:

- **The dump lands in the same place every time:** along the wall behind the launch spot. A robot that drove 10 inches
  into that wall after its last shot, and then launched again, gained about 12 points.
- **The dump needs about 2 s to land.** Robots that swept early found one or two elements. Robots that waited found
  three or four.
- **Get out of the way.** A robot that stands in the path of the dump blocks it. Backing under the HIVE let the dump
  pass overhead to the wall.

The supply is finite. Changes that collected more in AUTO raised AUTO points and barely moved the match score, because
those elements weren't there in TELEOP. The changes that raised the match score removed waiting and driving.

**In general:** learn where game elements come to rest after every scoring event, and plan your routes to end there.

<!-- id: endgame -->
### 10. Know what your last 8 seconds are worth

The robots used to PARK whenever the clock said so. A robot holding four elements that would finish a TIP drove off to
PARK for 5 points instead of 20.

| Choice in the last seconds | Points |
| --- | --- |
| A launch that finishes a TIP | 20 |
| A launch that doesn't | 2 per element in the CELL |
| PARK | 5 |

Choosing by value was worth about 5 points per alliance, measured to within 1 point.

Ranking points change the answer. In a qualification match, the SWARM ranking point is worth more than 15 match points,
so a robot whose PARK the alliance still needs for it must PARK. A normal AUTO already secures SWARM with LEAVE and
AUTO PARK. In a playoff match, only points count, so take the TIP.

**Before a match:** decide who parks and who takes a last cycle, and what on the scoreboard changes that.

<!-- id: meta-build -->
## The build that these lessons point to

The tables change one thing at a time, so we tested whether the traits stack. Two robots with every design choice from
lessons 6 to 8 played 96 matches against two baseline robots.

| Trait | The combined build | Baseline |
| --- | --- | --- |
| Release | All four at once | Two at a time |
| Shooter | Rear, on the same face as the second intake | Rear, opposite the intake |
| Mass | 15.4 lb | 22 lb |
| Chassis | 12 in. square | 15 in. square |
| Gearing | 500 rpm | 600 rpm |
| Intake | Front and rear | Front |
| Launcher spread | Baseline | Baseline |

The combined build scored 520, and its baseline opponents scored 411. The margin is 109 points, with a standard error of
4. With baseline robots on both sides, the same seeds give 409 to 404. So the traits stack: the build is worth 111
points per alliance, and its parts, measured one at a time, add up to 111. A 270° turret at 360°/s on top of the build
changed its score by +2, with a standard error of 4.4, within the noise. The turret's gain on the baseline robot didn't
carry over to this build.

How that alliance plays is lessons 2 to 5, 9, and 10: a planned AUTO pair, launches from the middle of the scoring
window, both robots on the main cycle, routes that end where the dumps land, and a last launch over a PARK when the
ranking points allow it.

Hold the build loosely, for four reasons:

- **The launcher still comes first.** The combined build keeps the baseline launcher. At 3 times the spread, lesson 1
  takes away more than this build adds.
- **Nobody plays defense here.** A 15 lb, 12 in. robot gets pushed around in a way that these matches never test. That
  is the best reason for a real robot to carry more mass.
- **Packaging is ignored.** A four-element catapult, two intakes, and a rear shooter in 12 inches and 15 lb is a hard
  build. The tables price every pound and every inch. They don't say that the build is possible.
- **The opponent is the baseline.** Against the same build, the margin is whatever the better launcher and the better
  decisions give.

<!-- id: defense -->
## When to play defense

We tested one robot that defends for all of TELEOP. It goes after the opponent that carries the biggest load: it takes
that robot's launch spot if it can get there first, and otherwise it drives into it. It breaks contact every 1.6 s, and
no PIN was called in any match.

| Your alliance | The defender gives up | It takes from the opponent | Your margin | Your wins |
| --- | --- | --- | --- | --- |
| Equal to the opponent | 92 | 87 | +3 to -3 | 13 of 24 to 14 of 24 |
| Both robots at 3 times the launch spread | 68 | 72 | -125 to -121 | 0 to 0 |
| Both robots at 5 times the launch spread | 29 | 69 | -236 to -196 | 0 to 0 |
| A strong robot with a partner at 5 times the spread | Nothing: the score rises by 21 | 70 | -97 to -5 | 0 to 15 of 24 |

Defense rarely wins a match, for the reason that experienced teams give: the best defense against defense is a lead
after AUTO. A robot with a poor TELEOP has a poor AUTO too. At 3 times the launch spread, AUTO points fall from 90 to
43. A weak alliance that defends improves its margin and still loses every match, with a lower score for both sides.
Between equal alliances, defense is a wash.

The exception is a mixed alliance, which is what a qualification schedule deals you. A strong robot with a weak partner
lost all 24 matches while both scored, and won 15 of 24 with the weak partner on defense, from about 47 points behind
after AUTO. Two things moved: the opponent lost 70 points, and the alliance's own score rose by 21. A poor launcher
scatters elements and takes up the launch spot and the floor elements that its strong partner uses better.

**Before a match:** if your partner can't score reliably, ask them to defend, or at least to stay clear of your
launch spot and your elements. If you are that partner, offer it.

A lighter version did nothing: a robot that shoves an opponent that is lined up to launch, and then launches itself,
moved the margin by 3 points.

Two limits. The only contact rule in the simulator is the PIN rule, G421, so check your game's rules on contact near a
scoring zone. And the opponents here don't adapt: a real drive team launches from another spot when a defender takes
theirs.

<!-- id: what-didnt-help -->
## What didn't help

- **A shooter that launches from both ends.** A two-position shooter or a double catapult changed the score by -3,
  within the noise. A mecanum robot turns while it drives to the launch spot, or while it waits for the CELL, so a
  second fixed direction saves little. The dual intake helps because pickups come quickly and at any heading, and a
  turret helps because it aims at any heading: see lesson 6.

- **Top speed.** See lesson 7.
- **Harder braking.** Planning to stop at 5.0 m/s², where the baseline plans 3.0, cost about 7 points per alliance. At
  4.0 m/s², robots overshot the launch spot in one test.
- **Wider or tighter lines around obstacles.** A 4 cm and a 12 cm clearance, where the baseline is 8 cm, changed the
  combined score by +7 and +4, within the noise. An earlier round of matches said that tight lines paid, and this round
  doesn't confirm it.
- **Clever partner rules.** "The nearer robot takes the better launch spot" lost 30 points per alliance, because the
  spot changed while a robot drove to it. Fixed roles with one narrow exception did better.
- **Five AUTO TIPS.** About half of each dump lands across the field center line, where G402 keeps you out in AUTO.
  Four was the most that any plan reached.
- **A language model as drive coach.** In six paired matches it scored 333, and a fixed policy scored 340. It wavered
  toward FLOWERS at 32% to 52% confidence, against a written strategy that said never.

<!-- id: limits -->
## What a simulator can't tell you

- **Bounce and roll are estimates.** The ball masses are AndyMark's listed weights, 24.9 g for POLLEN and 41.3 g for
  NECTAR, and the HIVE is calibrated to the six rows of the Event Field Setup Guide, section 12.3, so the counts that
  tip it are right. We haven't measured how the balls bounce and roll, and where a dump lands depends on both. When we
  switched from assumed masses to the listed ones, the scores didn't move.
- **Nobody plays defense.** No robot blocks, pins on purpose, or steals from an opponent's FLOWER.
- **The drivers are code.** The code never tires, and it still collides about 3 times per robot per match. A human
  driver gains more from a forgiving robot than this driver does: a wide intake, a wide scoring window, and a light
  chassis.
- **Designs are parameters.** A chassis of 11.8 in., a robot of 15 lb, and a catapult are numbers here. Whether you can
  build them is outside the model.
- **The intake is a box.** An element is collected when its center enters a box in front of the robot. The 30° wall
  sweep works because of that geometry. Test it on a real intake.
- **The baseline moves.** With 96 matches per row, every score in the design tables has a standard error of 2 to 3
  points, and every change 2 to 4 points.

<!-- id: method -->
## How the matches were run

Every match is a full 2:30 MATCH with four robots in a rigid-body physics simulator built from the official field CAD.
AUTO is a fixed script per robot that reads only its own pose, its hopper count, and the AprilTags of the HIVE. In
TELEOP, a planner picks pickups, plans paths around the field elements and the other robots, and launches only when
the predicted shot scores.

- **7,584 matches**, 96 for each of 79 setups, tested the designs and strategies in lessons 1 to 4 and 6 to 8, the
  turret, and the combined build: red gets the change, and blue is two baseline robots. The pooled tables are in
  `experiments/run-v3-report.md`.
- **2,460 matches** in runs of 24 fixed seeds tested one decision change at a time, for lessons 5, 9, and 10, and also
  the combined build, the launcher errors one at a time, and defense. The log is `experiments/policy-loop.md`.
- **2,304 earlier matches** used older planners. The first 1,524 used a heavier robot, and 780 more used 12 matches per
  setup. This round replaces them. Against the first round, gearing for speed no longer hurts up to 700 rpm, and the
  shooter's side now matters. Against the 12-match round, gearing down to 435 rpm or 500 rpm now measurably helps, and
  the far edge of the scoring window costs less than the near one.

To rerun the design tables, run `npx tsx scripts/exp-run.ts all 96 10 101 TAG` with a tag of your own, and then run
`npx tsx scripts/exp-report.ts`. It is 7,584 matches, about 8 hours on a 10-core laptop. To watch a match, run
`npm run dev`. To configure a robot, click the gear icon next to its number.
