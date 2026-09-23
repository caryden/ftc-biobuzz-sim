# Behavior-tree policies

**Status: increments 1 to 4 are built; the rest is proposed.** The first four increments of the [plan](#plan) are
done: the runtime in `src/bt/`, both periods as trees in `src/auto/trees/`, and every TELEOP decision in the TELEOP
tree, including the endgame, the bump, the yield, and full defense. For how the simulator works, see
[How the simulator works](simulator.md).

This document proposes replacing the robot's decision code with behavior trees. A behavior tree is a tree of small
nodes. The inner nodes decide what runs, and the leaves read the field and drive the robot. The same tree format
covers both periods of a MATCH:

- **AUTO trees** model the robot's own program. They see only what the robot's sensors report.
- **TELEOP trees** model the drive team. They see the whole field, as a driver does.

The end state has these parts:

- The simulator shows the running tree next to the field, live and in review mode.
- You edit a tree in the browser: its structure, its node parameters, and, in AUTO, its poses on the field.
- You save a tree, share it by link, and load someone else's tree as a robot's policy.
- You write your own leaf node in the browser, and it runs in a sandbox.

## The code that this design replaces

The planner code is in `src/auto/`. Before increments 2 and 3, three layers made its decisions:

- **`Coach`** in `src/auto/coach.ts` picked the mode. In AUTO, it ran a script. In TELEOP, it asked the policy for a
  tactic when the running tactic ended, and at least once per second.
- **`scriptedTeleop`** in `src/auto/policy.ts` picked a tactic by trying a list of options in order.
- **`Executor`** in `src/auto/executor.ts` runs one of six tactics. It also contains decisions that belong to the
  policy: the endgame check that switches to PARK or a last launch, the opportunistic bump, and yielding to a partner.

The coach now only hosts the two trees, and `scriptedTeleop` is gone. The executor's tactics run as TELEOP leaves, and
increment 4 moved its three buried decisions into the tree.

Before increment 2, `ScriptRunner` in `src/auto/script.ts` ran AUTO. An AUTO script was a list of steps with
timeouts, plus a clock check that jumped to the last step, which is the PARK. `buildScripts` computed most poses from
the robot's length and the side that its shooter faces. The AUTO trees replaced both.

These layers already work like a behavior tree, but the priority order is spread across three files. Written out as
one tree, TELEOP looks like this:

```
TELEOP, checked in priority order
├─ [full defense] Defender
├─ [time left ≤ PARK drive time] Endgame
│   ├─ [a last launch is worth more than PARK, and SWARM doesn't need this PARK] Launch everything
│   └─ PARK
├─ [time left < FLOWER start time] FLOWER work
│   ├─ [a filled FLOWER is exposed] Collect own NECTAR
│   ├─ [the fill needs more POLLEN] Collect POLLEN
│   ├─ Work the best FLOWER
│   └─ Collect own NECTAR for the plug and the cap
├─ [a TIP is possible] TIP: collect until the load is enough, then launch
├─ [carrying something] Launch
└─ PARK
```

## Environments

A leaf gets one typed object, the *environment*, instead of a blackboard. The environment holds everything that a
leaf can read and every action that it can take. There are two environment types, which share a common core:

| Environment | Used by | What it adds to the core |
| --- | --- | --- |
| Driver | TELEOP trees | Every ball, every robot, the partner channel, and the robot's driver assists |
| Onboard | AUTO trees | The camera's AprilTag sightings of the CELLS |

A driver watches the whole field, so a TELEOP tree can read opponents' positions, their loads, and where they're
heading. An AUTO tree can't. It reads only odometry, the hopper count, the robot's size, the clock, and the camera,
as `ScriptRunner` did.

The shape of the environment is as follows:

```ts
interface CoreEnv {
  clock: { phase: 'auto' | 'transition' | 'teleop'; remaining: number; elapsed: number };
  field: {
    half: number;                                  // Meters from the center to the inner wall face.
    flowers: Record<'own' | 'opponent' | 'rear' | 'audience', FlowerView>;
    hives: { own: HiveView; opponent: HiveView };
    zones: { loading: ZoneView };
  };
  bots: { me: MyBot };
}

interface MyBot {
  startPose: Pose; pose: Pose; velocity: Twist;
  hopper: { pollen: number; ownNectar: number; capacity: number; free: number };
  dimensions: { length: number; width: number };
  mass: number;
  shooter: { type: 'catapult' | 'fifo' | 'dual'; facing: 'front' | 'rear' };
  recentStalls: { target: string; reason: string; at: number }[];
  // Subsystems. Only actions can use them.
  drive: DriveSubsystem; intake: IntakeSubsystem; shooter: ShooterSubsystem; placer: PlacerSubsystem;
}

interface DriverEnv extends CoreEnv {
  field: CoreEnv['field'] & { balls: BallView[] };
  bots: { me: MyBot & { assists: DriverAssists }; partner: BotView | null; opponents: BotView[] };
  team: TeamChannel;                               // What this robot's drivers tell their partner.
}

interface OnboardEnv extends CoreEnv {
  sensors: { camera: { seesRaised(cell: 'rear' | 'audience'): boolean } };
}
```

The following rules keep the environment from becoming a blackboard:

- **No shared store.** No node can write a value that another node reads, except through a chain, which is
  described later, and through the typed partner channel.
- **Facts, not scratch space.** The environment holds observations and the robot's own history, such as its recent
  stalls. Some fields are computed when a leaf reads them, for example the number of POLLEN that the raised CELL still
  needs. They read like plain fields.
- **Logging goes through the leaf's context.** A leaf gets the environment, its parameters, its input, and a `log`
  function, which adds an event to the leaf's own span in the trace.
- **Plain data at every boundary.** Observations, action arguments, and query results are plain data. A sandboxed
  leaf needs this rule, because only plain data can cross into a sandbox.
- **One schema.** A single schema defines the environment. It produces the TypeScript types, the expression checker,
  and the editor's autocomplete. A tree that names a field that its environment doesn't have fails to load.
- **The alliance's own view.** Every position is given from the robot's own alliance. FLOWERS and HIVES are named
  `own` and `opponent`, and the rear and audience sides are named as that alliance's drivers see them. One tree then
  plays both colors, and nothing mirrors poses for blue.

**Driver assists** are the robot's own help to its drivers in TELEOP. The shot interlock is one: the robot fires only
when a physics preview of the shot says that the ball enters the CELL. A driver can't make that prediction, but a
robot with auto-aim can. To measure a drive team without assists, remove the assist from the environment. The tree
doesn't change.

### Navigation

A leaf moves the robot with one action: `drive.navigate(poses, options)`. The options apply to each segment, for
example the intake mode, whether to stop when the hopper is full, and a timeout. The action reports that it's running,
that it arrived, or that it stalled. A stall is a failure of the leaf.

The robot config, not the tree, chooses how the robot gets there:

- **The path planner.** Today it's the visibility-graph planner in `src/auto/planner.ts`, which routes around the
  field elements, and in AUTO also around the FIELD center line.
- **The path follower.** Today it's pure pursuit with a trapezoidal speed profile, in `src/auto/follow.ts`.

Other followers can come later, for example the Road Runner or Pedro Pathing libraries that many FTC teams use.
Both follow a curve that the team defines and don't plan around obstacles. To keep a tree the same when the follower
changes, a waypoint can carry optional curve hints, and a follower ignores the hints that it doesn't use. The path
still changes with the follower, so the score can change.

In TELEOP, `navigate` models the driver's steering plus any drive assists. Partner avoidance and stall recovery stay
inside it, not in the tree.

## Execution model

Trees run on simulated time. Each node is a TypeScript generator. A `yield` waits for the next physics step, so a leaf
reads as straight-line code:

```ts
function* collectAndLaunch(env: DriverEnv) {
  const need = env.field.hives.own.raised.need;
  yield* env.bots.me.drive.navigate(pickupRoute(env, need), { intake: 'all', untilFull: true });
  yield* env.bots.me.drive.navigate([launchSpot(env)]);
  return yield* env.bots.me.shooter.fireAll();
}
```

The rules are as follows:

- **The simulation loop drives the trees.** On each physics step, the runtime resumes each robot's tree in slot
  order. Each subsystem that an action commands contributes its part of the robot's inputs for that step.
- **One clock.** Timeouts, cooldowns, and every other timer read the simulation clock. No code reads the wall clock.
- **No randomness in trees.** All randomness comes from the simulator's seeded generator, so the same seed gives the
  same match.
- **A result is a value or a typed failure.** A node succeeds with a value, or it fails with a tag such as
  `ConditionFalse`, `MatchFailed`, `TimedOut`, `Stalled`, or `Blocked`. There's no running status: a node that hasn't
  returned is running. An exception that no tag covers is a bug. It stops the robot and shows in the trace.
- **Halt runs cleanup.** When a parent interrupts a child, the runtime calls the child's generator `return` method,
  which runs its `finally` blocks. Cleanup must finish within the same step.
- **Node memory is the generator's local variables.** Halting a node discards its memory.
- **No endless loop within one step.** If a loop finishes an iteration without using a physics step, the runtime makes
  it wait for the next step.

## Node types

The node types follow a vocabulary that splits the traditional "decorator" into supervisors, which wrap one child,
and chain operators, which transform a value.

| Category | Node | What it does |
| --- | --- | --- |
| Flow | `sequence` | Runs its children in order. It fails with the first failure. |
| Flow | `fallback` | Tries its children in order, and succeeds with the first success. It fails if every child fails. |
| Flow | `parallel` | Runs its children at the same time, with the `all`, `any`, or `quorum` rule. It halts the children that are still running when the result is decided. |
| Flow | `chain` | Runs its children in order, and passes each child's output to the next child as input. |
| Supervisor | `guard` | Runs its child only if a condition passes. |
| Supervisor | `timeout` | Halts its child and fails with `TimedOut` after a set time. |
| Supervisor | `retry` | Runs its child again after a failure with a listed tag, up to a set count. |
| Supervisor | `repeat` | Runs its child again each time it finishes. The TELEOP root uses it. |
| Supervisor | `cooldown` | After its child fails, or with `from: "start"` after its child starts, fails at once for a set time. |
| Supervisor | `hold` | Reuses its child's last result for a set time, so a decision can't flip every step. |
| Supervisor | `ensure` | Runs a cleanup child after its child succeeds, fails, or halts. |
| Supervisor | `recover` | Turns failures with listed tags into a success value, or into another child. |
| Chain operator | `map` | Replaces the current value with an expression's value. |
| Chain operator | `matches` | Fails with `MatchFailed` unless an expression over the current value is true. |
| Chain operator | `bind` | Names the current value, so that later children of the chain can read it. |
| Chain operator | `validate` | Fails unless the current value has a stated type. |
| Leaf | `condition` | Checks an expression. It succeeds or fails in the same step and changes nothing. |
| Leaf | `action` | Runs over one or more steps. Only actions can command a subsystem. |

The following sections describe the parts that need more than one line.

### Reactive fallback

A `fallback` can be reactive. While a child runs, the fallback checks its higher-priority children every `recheckSec`
seconds. If one can start, the fallback halts the running child and starts that one. If the running child is a guard
and its own condition fails, the fallback halts it and starts the next child. The interval starts again whenever a
child starts. The rules for "can start" are as follows:

- **A guard can start** when its condition is true and its child is ready. A `cooldown` child isn't ready while it
  cools down, so a fallback doesn't start a branch that would fail at once.
- **A running guard keeps running** while its own condition is true. A cooldown that began when the branch started
  doesn't stop it.
- **A child without a guard can always start.** Such a child ranks above the running one only if it ran earlier and
  failed, and then the fallback tries it again at the next check.

A reactive fallback needs at least one guard child.
A `recheckSec` of 0 checks every step. The endgame branch needs 0. The tactic choice uses 1 s, which matches the
coach's review that it replaced.

A reactive fallback interrupts only its own running child. It doesn't restart the whole tree, so a sequence elsewhere
keeps its place.

### Chains and dataflow

A node can get data from four places, and from nowhere else:

- **`params`:** fixed values or expressions from the tree file.
- **`input`:** the one value that a chain passes from the previous child.
- **Bound names:** values that a `bind` earlier in the same chain named. A `bind` must be a direct child of its chain.
  Only later children of that chain can read
  them.
- **The environment.**

A chain replaces the utility selector that ranks options by value. The first child returns a choice, and the next
children act on it. For example, one chain picks the best FLOWER, drives to its stand pose, and places. Another
computes the launch spot, binds it as `spot`, drives there, and fires. Each node declares its input type and output
type, and the loader checks that each child's output matches the next child's input.

### Parallel nodes and subsystems

An action declares the subsystems that it commands: `drive`, `intake`, `shooter`, or `placer`. The loader rejects a
`parallel` node whose children command the same subsystem. A subsystem command belongs to its node, so halting the
node stops the command.

For example, "sweep a lane with the intake on until the hopper is full" is a parallel node with the `any` rule and
three children: navigate the lane, run the intake, and wait for a full hopper. The intake action never finishes on its
own, so the other two children decide when the node ends.

## Expressions

Conditions, `map`, `matches`, scores, and pose parameters use a small expression language over the environment.
It has field paths, arithmetic, comparisons, `and`, `or`, `not`, `if(test, a, b)`, a few functions such as `min`,
`max`, and `hypot`, a `pose(x, z, headingDeg)` constructor, and `offset(pose, dx, dz)`. Expressions can read the
environment and bound names. They can't change anything.

A tree can declare named *definitions* in `defs`. A definition is a read-only expression, for example the distance
from a FLOWER at which the robot stands. It keeps a tree from repeating the same expression in every pose. No node can
write a definition, so definitions can't collect leftover state.

AUTO poses depend on the robot's size, so they're expressions. A pose that the user places by hand in the editor is a
plain number instead. When you drag a pose that is an expression, the editor changes an offset and keeps the
expression, so the pose still moves when the robot's length changes.

## Tree files

A tree file is JSON. It uses the shape `kind: "bt.tree"`, with a `root` that names its node type as a key. The top
level also has these fields:

- **`id`:** a stable slug, for example `wall-sweep-pair-right`. Robot setups and the catalog refer to a tree by it.
- **`name`:** the name that people see, for example "Wall-sweep pair: right robot".
- **`description`:** optional text for the AUTO list and the catalog.
- **`meta`:** optional data for the host, which the loader doesn't check. AUTO trees give their start position and,
  for a pair, the partner's id.

A leaf is a `ref` to a registered leaf type, with `params`. Each parameter's schema says whether it takes an expression. An
enum parameter, such as an intake mode, takes a plain value. Any node can carry a `note`, which keeps the reason for a
step next to the step.

The following file is `src/auto/trees/wall-sweep-pair-right.json`, the right robot's AUTO, shortened to its first three steps
and its last. Its last step, the PARK, starts when all the other steps end, or when the clock shows 2.5 s, whichever
comes first:

```json
{
  "kind": "bt.tree",
  "id": "wall-sweep-pair-right",
  "name": "Wall-sweep pair: right robot",
  "env": "onboard",
  "description": "For the right start position, on the alliance wall: the first TIP from the pre-loads, then ...",
  "meta": { "start": "right", "partner": "wall-sweep-pair-left" },
  "defs": {
    "len": "bots.me.dimensions.length",
    "flip": "if(bots.me.shooter.facing == 'front', 180, 0)",
    "hiveX": "-0.3237",
    "stand": "len / 2 + field.flowerHalfSize + 0.02",
    "launchAudience": "pose(hiveX, 1.32, -90 + flip)",
    "ownFlower": "pose(-1.7282 + stand, 0.5942, 180)",
    "park": "pose(-(field.half - len / 2 - 0.09), -0.8954, 180)",
    "parkRight": "pose(park.x, -0.8954 + 0.33, park.headingDeg)"
  },
  "root": { "sequence": { "children": [
    { "id": "steps", "parallel": { "policy": "any", "children": [
      { "id": "finish", "ref": "auto.clockAtMost", "params": { "sec": 2.5 } },
      { "sequence": { "children": [
        { "id": "s1", "ref": "auto.drive", "params": { "pose": "launchAudience", "timeoutSec": 4 } },
        { "id": "s2", "note": "The raised CELL starts with 3 NECTAR, so the third POLLEN tips the HIVE.",
          "ref": "auto.shoot", "params": { "count": 3, "timeoutSec": 2.5 } },
        { "id": "s3", "note": "The red FLOWER's POLLEN fills the wait for the left robot's TIP.",
          "ref": "auto.drive", "params": { "pose": "offset(ownFlower, 0.2, 0)", "timeoutSec": 3.5 } }
      ] } }
    ] } },
    { "id": "s23", "ref": "auto.drive", "params": { "pose": "parkRight", "intake": "all", "timeoutSec": 6 } }
  ] } }
}
```

The loader limits a tree's node count, its depth, and the length of each expression, because shared trees come from
other people.

## Tracing and the tree view

Each time a node runs, the runtime records a *span*: the node's path, its type, its start and end in simulation
seconds, its result or failure tag, its input and output, and its log events. A match's spans form a timeline of the
whole tree.

The tree view uses the spans in two ways:

- **Live.** The view highlights the branch that is running now.
- **In review mode.** Scrubbing to a moment shows the spans that were active then. Clicking a chain node shows the
  value that it passed on. A match note can name the node that was running, which makes a precise bug report.

A span per activation takes far less space than a status for every node on every step.

## Code leaves in a sandbox

A leaf that a user writes runs in QuickJS, a JavaScript engine that is compiled to WebAssembly. The page calls it
synchronously, and it runs the same way in Node.js, so the headless scripts can run shared trees.

The sandbox follows these rules:

- **One context per leaf instance.** The host loads the leaf before the match and keeps its context for the whole
  match, because a leaf runs across many steps.
- **Only the fields that the leaf declares.** The host passes the leaf only the environment fields that its
  manifest lists, not the whole environment. The measurements in the following table show why.
- **A synchronous call.** The leaf gets its observations as plain data and returns or yields plain data. The host
  runs a command through the same subsystems that built-in actions use.
- **Deterministic limits.** The host sets a memory limit, and it limits run time by counting calls to QuickJS's
  interrupt handler, not by reading the wall clock. A wall-clock limit would make a leaf's timeout depend on the
  machine. The handler runs only about once per 75 calls of a small leaf, so the count stops a leaf that loops
  forever, but it can't measure one call precisely.
- **No randomness and no clock.** The host leaves `Math.random` and `Date` out of the leaf's globals.

The WebAssembly component model can come later, for authors who want to write a leaf in another language, such as
Rust. The environment maps to a WebAssembly Interface Types (WIT) interface. The cost is the toolchain: an author
needs a compiler that targets components, and the browser needs `jco` to run them.

A benchmark measured QuickJS 0.32 in Node.js 22 on an Apple silicon Mac. One persistent context called a small leaf
37,920 times, which is one robot's MATCH at 240 steps per second. Each call passed the observation as a JSON string,
and the leaf found the nearest of 40 balls. The times vary by a few microseconds between runs.

| What each call did | Time per call |
| --- | --- |
| Nothing: an empty function | 14 µs |
| Parsed a 2.3 KB observation | 56 µs |
| Looped over 40 balls, with no parsing | 21 µs |
| Parsed the observation and looped | 63 µs |
| The same work in Node.js's own engine, for scale | 12 µs |

At 63 µs a call, four robots each running one code leaf every step spend about 10 s per MATCH in QuickJS. A headless
MATCH takes about 27 s today, so a code leaf that runs every step and reads the whole field makes a MATCH about 40%
slower. Parsing the observation is most of that cost. So code leaves follow two rules:

- **A code leaf decides, and built-in actions act.** A code leaf is a choice or a condition that runs when its node
  starts, for example which FLOWER to work next. It passes its choice on through a chain, and a built-in action such
  as `navigate` does the work of every step.
- **A code leaf reads only what it declares.** Its manifest lists the environment fields that it reads, and the host
  serializes only those fields.

A code leaf that runs every step is still possible, but its cost counts against the MATCH, and the editor shows it.
The benchmark isn't in the repository, because it needs `quickjs-emscripten` as a dependency.

The runtime itself costs little by comparison. `scripts/bt-bench.ts` runs four trees shaped like the TELEOP policy
for one MATCH, with no physics. On the same Mac, the median of 7 runs was 52 ms without a recorder and 59 ms with
one.

## Why the runtime doesn't use Effect

Effect is a TypeScript library for typed errors, interruption, and structured concurrency, and another behavior-tree
runtime by one of the mentors uses it. This design copies three of its ideas: typed failures, interruption with
cleanup, and requirements in the type, which is what the subsystem declarations do. It doesn't use the library.

A benchmark compared the two runtimes. Four robots each ran a fallback over a guarded leaf and a sequence of 50 legs,
for 37,920 steps, which is a MATCH at 240 steps per second. Both versions produced the same checksum.

| Runtime | Tree cost per MATCH, median of 5 runs |
| --- | --- |
| TypeScript generators | 10 ms |
| Effect 3.22 fibers, stepped by hand with `ControlledScheduler` | 371 ms |
| One headless match with `scripts/match.ts`, including startup, for scale | 27 s |

Speed isn't the reason. The reason is that Effect doesn't keep a behavior in step with the physics. The first Effect
version used `SyncScheduler`, which runs synchronously only until its first `flush` and then hands every task to the
default scheduler, which runs asynchronously. That version returned a checksum of zero with no error. Any Effect
feature that reaches the real scheduler or the real clock, such as `Effect.sleep`, can do the same unless the clock is
replaced. A match would still run, but its per-seed scores would change. A generator can't run anything
asynchronously, so it can't get out of step.

The benchmark isn't in the repository, because it needs Effect as a dependency.

## Plan

Each increment is one pull request. An increment either leaves every seed's score unchanged, or its change is measured
with `scripts/eval.ts` and `scripts/eval-compare.py` and logged in `experiments/policy-loop.md`.

The planner uses no randomness, and the simulator's random numbers come from a seeded generator. So a refactor that
makes the same decisions on the same physics steps gives the same score on every one of the 24 evaluation seeds. That
exact match is the test for increments 2 and 3.

1. **Build the runtime. Done.** `src/bt/` has no DOM dependency and no knowledge of BIOBUZZ. It holds the schema
   types that describe an environment, the expression language, the loader, the node types, the runner, and the
   trace recorder. `test/bt.test.ts` and `test/bt-expr.test.ts` cover each node type. QuickJS's cost per call is
   measured. No match behavior changes.
2. **Convert AUTO. Done.** `src/auto/onboard.ts` holds the onboard environment, the AUTO leaves, and `AutoProgram`,
   which runs a tree for one robot. The eight scripts are tree files in `src/auto/trees/`, and `src/auto/script.ts` is
   gone. `scripts/plan-sweeps.ts` writes the sweep lanes into the trees. Results:
   - **The inputs match on every step.** With the script runner driving and a tree running alongside, the two gave
     identical inputs on every physics step of 45 AUTO periods: 324,045 steps, four robots each, for three robot
     sizes, both shooter directions, partners and solo, and three seeds. A pose moved by 1 mm showed up at the drive's
     first replan.
   - **The scores match.** `e52-auto-trees` equals `e51-script-counts-steps` on every seed.
   - **One measured change came first.** The script runner timed a step by adding the step length on every physics
     step, and that sum drifts: 7 of the 16 timeout lengths ended one step early, including 2.5 s, 3 s, and 4 s.
     `e51-script-counts-steps` made it count steps, at a cost of 18 ± 9.5 combined points. See
     `experiments/policy-loop.md`.

   Four details differ from the design, to match the script runner exactly:
   - **Each step leaf owns its timeout,** as a `timeoutSec` parameter, and a timeout ends the step without a failure.
     A `timeout` supervisor fails instead.
   - **Each step ends with one idle physics step.** `AUTO_TUNING.idleAfterStep` switches it. Removing it is a measured
     change.
   - **The clock race is a parallel node.** An `auto.clockAtMost` leaf races the steps with the `any` policy, and the
     PARK follows the race.
   - **Both alliances use red's HIVE pivot,** as the mirrored scripts did. Blue's own pivot is 0.4 mm farther out.
3. **Convert TELEOP. Done.** `src/auto/driver.ts` holds the driver environment, the TELEOP leaves, and
   `TeleopProgram`. The coach's decision and `scriptedTeleop` are the tree `src/auto/trees/teleop-default.json`: a
   full-time defender first, and otherwise a reactive fallback, rechecked once per second, over FLOWER work, a TIP, a
   launch of what the robot carries, and PARK. Results:
   - **The inputs match on every step.** With the coach's old code driving and the tree running alongside, the two
     gave identical inputs on every physics step of 12 full matches: 455,076 steps, four robots each, over three
     seeds. The matches cover the baseline and the meta build, TIPS only and FLOWER work, and both kinds of defense.
     A recheck of 1.5 s instead of
     1 s showed up at the FLOWER start time.
   - **The scores match.** `e54-teleop-tree` equals `e53-coach-counts-steps` on every seed.
   - **One measured change came first.** `e53-coach-counts-steps` made the coach's review count steps, with no
     measurable effect: +0.5 ± 2.7 combined points.

   Three details keep the tree equal to the coach:
   - **A tactic leaf succeeds when the executor reports done or blocked,** on the next step, so the tree decides again
     from the top, as the coach did. A failure would have sent the fallback on to the next branch instead.
   - **`teleop.flowerWork` picks its FLOWER again once per second** on the fallback's schedule, because the coach's
     review could change the FLOWER without changing the branch.
   - **The endgame check stays in the executor.** It moved in increment 4.

   The driver environment holds only what the default tree reads so far: the clock, the robot's config and hopper,
   and which tactics can make progress. It grows as the buried decisions move into the tree.
4. **Move the buried behaviors into the tree.** The endgame check, the opportunistic bump, and the partner yield become
   branches. Writes to the shared plan go through the partner channel. The defender becomes a subtree. Decision
   timing can shift here, so this increment is measured.
   - **The endgame check. Done.** The TELEOP tree's `endgame` branch sits above the normal choice, in a fallback that
     checks it every step. Once the time left is no more than the PARK needs, it runs a last launch if that is worth
     more than PARK and SWARM doesn't need this robot's PARK, and PARK otherwise. The driver environment's `endgame`
     fields hold the values, and `Executor.update` takes the decision as a mode. `e58-endgame-branch` equals
     `e57-renamed-trees` on every seed, and nine more matches with FLOWER work, both kinds of defense, and the meta
     build scored the same as before, in every score component.
   - **The opportunistic bump. Done.** The tree's `bump` branch sits between the endgame and the normal choice, in the
     fallback that checks every step. When the robot is in a TIP's launch phase and an opponent that is lined up to
     launch stands within 1 m, it runs `teleop.bump` under a 0.8 s timeout, with a 6 s cooldown from the start of each
     shove. This needed two runtime changes: `cooldown` can count from its child's start, and a reactive fallback
     checks whether a branch is ready before it starts it. Results:
     - **Standard setup:** `e60-bump-branch` equals `e58-endgame-branch` on every seed, because no robot bumps there.
     - **All four robots bumping:** `e61-bump-branch-opportunistic` is -14.5 ± 8.7 combined points against
       `e59-opportunistic-base`.
     - **Red bumping, blue not:** red's margin is 3.3 ± 8.7 in `e63-red-bumps-branch`, where it was 7.3 ± 6.4 in
       `e62-red-bumps-main`. The paired change is -4.0 ± 7.5, which is noise.

     A bump now ends for good when the opponent leaves its spot. The old code could pause and resume a shove within
     its 0.8 s. On three matches, the bumps ended for the same reasons in similar proportions on both versions.
   - **The partner yield. Done.** The tree's `yield` branch sits below the bump, in the fallback that checks every
     step. It runs `teleop.yield`, which holds still, while the robot is in a TIP's launch phase and
     `partner.linesUpFirst` is true. The check reads the partner's load as the executor last judged it, without judging
     it again, because judging it starts a 2 s hold. `e64-yield-branch` is +4.6 ± 5.2 combined points against
     `e60-bump-branch`, which is noise. A robot that bumps doesn't yield in the same step any more, because the bump
     ranks higher.
   - **The partner channel. Done.** The executor writes its intent and plan through a `TeamChannel` that the TELEOP
     program passes it, and the driver environment's `partner` fields show the partner's intent, phase, CELL, and
     load to the tree. `e65-partner-channel` equals `e64-yield-branch` on every seed.
   - **The defender. Done.** The tree's `defend` branch is a subtree, checked every step: PARK when the clock requires
     it, wait near the center while both opponents rest, take the target's launch spot when this robot gets there at
     least 0.2 m sooner, and otherwise drive into the target. `Defender.targetFor` picks the target without side
     effects, and the defender keeps only its bookkeeping: the contact time, each opponent's rest, and the path.
     `e67-defender-subtree` equals `e66-full-defense-base` on every seed and in every field.

   Increment 4 is done. The executor makes no policy decisions: it runs the tactic, the mode, and the target that the
   tree gives it.
5. **Show the tree running,** live and in review mode, from the spans.
6. **Edit AUTO poses on the field.** Each navigate node shows its poses as handles that you drag, with a heading
   handle. Selecting a node highlights its poses, and clicking a pose selects its node. The path preview redraws after
   each edit, and it follows the first child of each fallback. Both robots' AUTO trees show on one timeline, because
   partners coordinate by the clock and the camera.
7. **Edit parameters.** Parameter schemas drive a form. Some robot config settings, such as the FLOWER start time and
   the defense policy, become tree parameters.
8. **Edit structure and share.** Add, remove, and reorder nodes from a palette of leaf types that fit the tree's
   environment. Import and export tree files. Share first with a link that carries the tree in the URL fragment, which
   needs no server, and then through a gallery in the D1 database, keyed by a hash of the tree. The gallery is the
   first feature that needs accounts. See [Accounts](#accounts).
9. **Score a tree in the browser.** Web Workers play a tree against the default tree on fixed seeds.
10. **Add code leaves** in the QuickJS sandbox.

## The tree catalog

Every tree has a row in the `trees` table of the site's D1 database, with its id, name, description, and file. The
system trees, which ship with the site, are the files in `src/auto/trees/`. The deployment that is live writes their
rows itself:

1. The build writes the tree files, a SHA-256 of each, and one hash over the set into `trees/catalog.json`, in the same
   deployment as the code that runs them.
2. The first request to `/api/trees` after a deployment goes live finds that D1 holds a different set. It replaces the
   system rows in one batch, which D1 runs as a transaction, and records the new hash.
3. A rollback works the same way: the older deployment's first request writes its own rows back.

No second pipeline can fall out of step with the deployment. A row that someone saves has `system` 0, and a sync never
changes it. The schema is in `migrations/`, and a production build applies new migrations after the site builds: see
the README's deployment section. Until the catalog tables exist, and in a preview, `/api/trees` serves the
deployment's own files. The page itself runs the trees that it was built with, and doesn't read the catalog yet.

## Accounts

**Status: to be decided.** Nothing about accounts gets built until a feature needs them.

Saving and sharing work without an account. The browser's storage keeps your own trees, as it keeps robot setups
today, and a share link carries a tree in its URL fragment. Two features need accounts:

- **Publishing to the gallery.** Each entry needs an owner, who is the only person who can change or remove it. Rate
  limits and bans need a person to apply to.
- **Trees on every device.** A tree saved to an account follows its owner to another computer. It can be a gallery
  entry that isn't listed.

The plan for when accounts are needed is as follows:

- **GitHub first.** Almost every FTC student who would write a policy has a GitHub account, and the project's source
  and bug reports are on GitHub. The OAuth app asks for no scopes, so it gets only public profile information. The site
  keeps the numeric user ID, the login name, and the avatar URL. It discards the access token after it reads the user.
- **Discord second.** Every FTC student has a Discord account, including drive-team members who don't write code.
  Discord's `identify` scope gives the user ID, the username, and the avatar, without the email address.
- **The minimum age.** GitHub and Discord both require users to be at least 13. FTC includes grades 7 through 12, so
  some students can't have either account. Those students can still save and share by link.
- **Cloudflare pieces.** Two Pages Functions handle sign-in: one redirects to the provider, and the other receives the
  callback, reads the user, and sets a session cookie that is `HttpOnly`, `Secure`, and `SameSite=Lax`. Each client
  secret is a Pages secret, never a file.
- **No sign-in in previews.** An OAuth app has a fixed callback URL, so preview deployments can't use the production
  app. Previews already get no database binding, and the same rule turns sign-in off, so a preview can't write to the
  real gallery.
- **No contact between users.** The gallery has no comments and no messages. FIRST's Youth Protection Program sets rules
  for online contact between adults and students, and a gallery that users can't contact each other through stays
  clear of that question. How the program's rules apply to this site isn't checked.
- **Trees stay in D1.** Storing each tree as a GitHub Gist in its author's account was considered. It would need the
  `gist` scope, which lets the site read and write every Gist that the user has. A site that only needs to know who
  you are doesn't need that access.

## Open questions

- **Gallery moderation.** Decide whether the gallery accepts trees from anyone, or only after a review. Trees without
  code are plain data, so they're low risk. Code leaves are where a review queue earns its cost, even with the sandbox.
- **Curve hints.** Decide what a waypoint's curve hints mean when a Road Runner or Pedro Pathing follower is added.
- **Human limits.** A driver environment could model a reaction delay, or a narrower view when the driver watches the
  far end of the field. These limits belong in the environment, because they change what a tree observes, not how it
  decides.
- **Commitment.** Check in increment 3 that `hold` and a reactive fallback's `recheckSec` cover every place where the
  planner holds a decision today. The known places are the 2 s hold on partner decisions, the 1 s tactic review, and
  the 0.2 s delay before a tactic counts as done.

## Prior work

- **[electric-mayhem](https://github.com/caryden/electric-mayhem)** is an NCSSM behavior-tree library for FTC robots,
  written in Kotlin with coroutines. It shows two things that this design avoids. It restarts the whole tree when any
  condition changes, which loses a sequence's place. Its subsystem commands run in their own scope. A reading of the
  code, not a test, suggests that a command can keep running after its node is cancelled.
- **A private behavior-tree runtime** by one of the mentors supplies the node vocabulary: flow nodes, supervisors, and
  chain operators, with typed values and typed failures instead of statuses. The `bt.tree` file shape and the span
  trace come from it too. It runs on real time with Effect, and this design runs on simulated time with generators.
