# ftc-biobuzz-sim

Instructions for an AI coding agent that works in this repository. People: read [CONTRIBUTING.md](CONTRIBUTING.md).

- `src/sim/` has no DOM or three.js dependency. Keep it that way so that matches run headless.
- No Node-only code in `src/`: the same files run in the browser, where `process` doesn't exist. Put an experiment
  switch in an exported tuning object, such as `EXEC`, and set it from a script.
- Field constants come from `cad/field-manifest.json` and the Competition Manual. Cite the source when you add one.
- After any change to `src/sim/hive.ts` or `BALL` in `src/sim/config.ts`, run `npm test`. The calibration rows must pass.
- Measure a planner change before you keep it: `npx tsx scripts/eval.ts LABEL`, and then
  `python3 scripts/eval-compare.py BASE LABEL`. Log the result in `experiments/policy-loop.md`, kept or not.
- After a change to `docs/top-ten.md`, `scripts/results-page.template.html`, or the result files, run
  `python3 scripts/build-site.py` and commit the pages under `public/`.
- Match annotations are in `traces/*.annotations.md`. The newest file is the match that was reviewed last.
- Never deploy without the account guard: `sh scripts/deploy.sh` reads the account name from `.deploy.env`.
