# bench protocols

Three processes talk to bench over stdin and stdout, one message per line unless noted.

## Sim sidecar (`scripts/bench-server.ts`)

bench starts it with `npx tsx scripts/bench-server.ts` in the simulator's checkout. It prints `{"type":"ready"}`
first, then one reply per command.

| Command | Reply |
| --- | --- |
| `{"op":"reset","seed":1,"mode":"full"}` | a `field` message, then a `state` |
| `{"op":"start"}` | a `state` |
| `{"op":"step","n":4}` | a `state` after `n` physics steps of 1/240 s |
| `{"op":"drive","robot":0,"kind":"planner"}` | `{"type":"ok"}` |
| `{"op":"drive","robot":0,"kind":"inputs","inputs":{"forward":0.5,"intake":"pollen"}}` | `{"type":"ok"}` |
| `{"op":"drive","robot":0,"kind":"goto","x":0.2,"z":1.1,"heading":0,"intake":"all"}` | `{"type":"ok"}` |

A driver stays until the next `drive`. `goto` plans around the FIELD elements and follows the path with the planner's
own follower. `heading` is optional.

`state` carries the time, phase and clock, both score breakdowns, the HIVES, the FLOWER stacks, every ball as
`[id, kind, x, y, z]` (kind 0 POLLEN, 1 red NECTAR, 2 blue NECTAR), and per robot its pose, velocity, what it carries,
its tactic, its planned path and its behavior tree (the definition when it changes, then the running nodes and the
nodes that ended since the last state). Coordinates are the field CAD's: meters, X from red to blue, Y up, Z from the
rear wall to the audience. A heading of 0 faces +X and pi/2 faces the rear wall.

## Detector (`--detector`)

Each frame is a JSON header line followed by the raw image:

```
{"w":640,"h":480,"llrobot":[x, y, heading, valid]}
<w*h*3 bytes of BGR, row-major>
```

`llrobot` is the robot's pose in the Limelight field frame: meters from the field center, x toward the blue wall, y
toward the rear wall, heading counterclockwise from +x. The reply is one line:

```
{"llpython":[71 numbers]}
```

`llpython` follows version 1 of the pollen SnapScript protocol: version, row count, five stage timings in ms, then
eight rows of `id, cls, cx, cy, r, conf, field_x, field_y`. NaN goes as `null`. `{"error":"..."}` reports a failure
without stopping bench. `plugins/snapscript.py` runs any Limelight SnapScript, a file with
`runPipeline(image, llrobot)`, as a detector.

## Decision layer (`--harness`)

The pollen harness protocol, one line per robot loop:

```
F t_ms pose_valid x_in y_in heading a0 .. a70     a loop with a fresh llpython
N t_ms pose_valid x_in y_in heading               a loop with no fresh result
R                                                 the target went into the intake
```

The pose is in the decision layer's map frame: inches from the inside audience-left corner, +x toward the blue wall,
+y toward the rear wall. Each `F` or `N` gets one JSON object back with `state` (SEARCHING, CANDIDATE, LOCKED or
LOST), `tracks`, and `target` and `far`, each null or a cluster with `c`, `intake` `[x, y, heading]`, `sweep` and
`pts`, all in map inches. bench sends only the newest frame of a running MATCH, in order, as a camera would.

Without `--detector`, bench builds `llpython` from the renderer's labels: every floor POLLEN in view, mostly
unoccluded and within 3.5 m, nearest first. That is a perfect camera, so the decision layer can be tested apart from
the detector.
