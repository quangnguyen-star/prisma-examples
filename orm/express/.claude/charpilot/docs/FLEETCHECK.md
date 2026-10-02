# fleetcheck — the scan against istanbul, on every service

Stage 2 builds a model of TypeScript. This checks that it is a model of
TypeScript and not a model of one Express service, by running the same scan
against every repo in the fleet and comparing it with the denominator istanbul
actually produced.

> **The scan counts. istanbul counts. Neither is allowed to explain the other.**
> A gap is closed by a MEASURED third term or it is not closed at all.

## Where this stands

Measured `2026-09-16`, deployed branches, one repo at a time.

```
fleetcheck: 33/33 repo(s) reconcile exactly

49492 branch sides · 18239 functions · 0 files drifting
29 express · 3 NestJS · 1 graphile-worker
vitest 2.1.9 · 3.2.4 · 3.2.7 · 4.1.3 · 4.1.9 · 4.1.10
```

**The scan's arm and function model needed no change to get there.** Every
failure across five passes was the driver or a repo layout. That is the result
this file exists to record: the model travels.

## One command

```bash
node tools/fleetcheck.mjs                 # every repo, from the top
node tools/fleetcheck.mjs --only a,b      # just these
node tools/fleetcheck.mjs --from pricing-ms
node tools/fleetcheck.mjs --recheck       # re-compare from CACHE, no clone, no install
node tools/fleetcheck.mjs --keep          # leave the coverage dir and the symlink
node tools/fleetcheck.mjs --branch <name> # measure a different branch fleet-wide
node tools/fleetcheck.mjs --vitest 3.2.4  # runner for a repo that pins none
```

Per repo: clone, link the toolchain, measure, cache the answer, scan, compare,
clean up. Exit 1 if any repo does not reconcile.

## Why it exists

`bench.mjs` was meant to be this and **cannot run**. It names
`.claude/charpilot/bench/vitest.bench.config.mts`, which has never existed in
git history and `install.sh` does not write. So the fleet was checked by hand,
and the last attempt ran 32 services and accounted for 20 — the other 12 have no
stated result anywhere, and no artifact survived to check them against.

## What is compared

The three-term identity, on **both** lines, per file and in total:

```
arms       ast − suppressed == istanbul
functions  ast − suppressed == istanbul
```

A repo passes only if both close and no file drifts. The suppressed terms come
from `suppressions.mjs priced()`, the same function stage 7 reports from, so
there is one measurement and not two.

**Statements and lines are NOT compared.** The scan has no model of either.
istanbul reports them; the ratchet does not use them. Anyone quoting a
fleetcheck number is quoting branch sides and functions.

## The loop, and why it is shaped like this

**Disk is the constraint.** A full `npm ci` of this fleet is 20–33 GB against
19 GB free, so the loop is serial and self-cleaning.

**The tests never run.** `coverage.all` instruments every file in `include`
without executing it, so a service that wants a database, an env file and a
green install still yields a denominator. Nothing is installed but `vitest` and
`@vitest/coverage-istanbul`.

**No host plugins.** Since nothing executes, emitted decorator metadata is
irrelevant — so the measurement config carries none, and every repo is
transformed by vite's esbuild alone. That is also the transform `scan.mjs`
models. It is what lets the NestJS services be measured at all.

**The cache is the point.** istanbul's answer for a pinned commit never changes,
so `out/fleet/<repo>/coverage-final.json` is written before cleanup, and
`scan.mjs` needs only source, `tsconfig.json` and `package.json`. `--recheck`
re-verifies all 33 offline in seconds — which is what makes *"fix the scan, then
re-verify every repo from the first"* cheap enough to actually do.

## The seven things that bite, all measured

1. **One scope, both sides.** The host's `coverage.exclude` was mirrored into
   `SRC_EXCLUDE` and never given to istanbul, so the scan honoured it and the
   report did not. `agent-cluster-control` excludes `src/index.ts` and
   `src/web/server.ts` as thin wiring; they read as **−69 arms and −38
   functions** of model error.

2. **Glob anchoring, which hid the one above.** vitest matches
   `coverage.exclude` against **absolute** paths. `**/*.test.ts` matches
   anywhere; a bare `src/index.ts` matches nothing. The test-file exclusions
   worked while every host-declared exclusion silently did not, and four
   services kept reporting exactly the files their own config excludes. Every
   unanchored entry needs a `**/` twin.

3. **`npm install <pkg>` reifies the WHOLE tree.** Half this fleet resolves
   `@qode/*` from a private Artifact Registry through a committed `.npmrc` whose
   token is env-interpolated, so `assessment-service` exited **403** over
   packages the run wanted nothing from. Installing into the clone also collided
   with the repo's own tree on vitest 4 — `ats-sourcing-service` and
   `turing-integration-ms` both died inside instrumentation. The toolchain is
   installed **per version, outside every repo**: 33 installs become the six the
   fleet pins, and each clone stays pristine.

4. **Resolution is pinned, not positional.** With the work directory under the
   pilot, vitest resolution walks up from the repo and can find an ancestor's
   `node_modules` — vitest 5 from this pipeline paired with
   `@vitest/coverage-istanbul` 2.1.9 from the toolchain, dying inside the
   provider on `reportsDirectory` of undefined. Each repo gets a `node_modules`
   symlink to its own toolchain. Pinning the version is the whole reason to
   install per version.

5. **Unresolvable imports are stubbed by ALLOWLIST.** vite's import-analysis
   resolves every import of every file it transforms, even with no test running.
   Stubbing every bare specifier swallowed `@vitest/coverage-istanbul`, which
   vitest loads through the same pipeline — the provider came back an empty
   object and vitest died on `coverageModule.getProvider is not a function`,
   three steps from the cause. Resolving first and stubbing only failures does
   not help a **workspace** package, where the directory resolves but has no
   built entry; `qode-itl-be` has `workspaces: ["packages/*"]` and died there.

6. **`SRC_EXCLUDE` must mirror vitest's DEFAULT exclusions, not only the
   host's.** Without `**/*.test.ts`, `qode-itl-be` drifted **+1257 arms and
   +4681 functions across 153 files**, every one a spec the scan counted and
   istanbul was never asked to instrument.

7. **Half the fleet pins no vitest on the branch it deploys.** The runner and
   the charpilot install live on a characterization branch instead. The version
   is not free — 4 stopped emitting a branch for a downlevelled enum and stopped
   downlevelling class fields — so `--vitest` supplies a fallback and every row
   records whether the version came from the lockfile, the manifest or that
   fallback.

## `SRC_DIR` — not every service uses `src/`

`candidate-ms` and `contact-ms` keep their TypeScript at the **repo root**:
`server.ts` beside `routes/`, `service/`, `core/`, `middlewares/`. Every source
walk globbed `src/**/*.ts`, so the scan found 0 files and refused — the right
answer to a misconfiguration and the wrong one to a layout. Neither service
could be onboarded at all.

The source root is a setting now, declared by the **suite** beside the other
scope constants, because it is the same kind of fact as `coverage.include`:

```js
// test/src-exclude.mjs
export const SRC_DIR = ".";            // default "src"; "." means the repo root
export const SRC_EXCLUDE = [...];
export const TYPE_ONLY_DIRS = [];
```

`config.mjs` derives `SRC_ROOT` and `SRC_GLOB` from it, and the five walks that
hardcoded the path go through them — `scan.mjs`, `deadcode.mjs`,
`freshness.mjs`, `baseline.mjs`, `suppressions.mjs`.

Two things make a root-rooted repo work:

- **tsconfig bounds the walk.** Neither repo sets `include`, so TypeScript takes
  everything under the project except `node_modules` and `outDir` — exactly the
  file set wanted, with no negative globs.
- **The top level needs carving.** At `"."` a `**/*.ts` sweeps in `test/`,
  `prisma/`, `dist/` and `coverage*/` — directories a `src/` repo excludes for
  free — so those join the exclude list on **both** sides.

Proved non-invasive by diffing the run before against the run after: **30 of 32
rows byte-identical**, and the only two that moved are the two that could not be
measured before.

## What this does NOT prove

**It is not stage 1.** fleetcheck bypasses the normal onboarding path on
purpose: no host plugins, no tests executed, no green-suite requirement. It
proves the scan's model, not that a service can be onboarded.

The NestJS stage-1 blocker that used to sit here **is fixed** — see
`vitest.charpilot.config.mts` and the section below — but it was fixed
separately, and fleetcheck passing says nothing about it either way.

**Statements and lines are still not compared.** The scan models neither.

**The branch is a choice.** This measured deployed branches
(`main`/`production`/`staging`/`master`/`develop`) with 2.1.9 as fallback.

**The branch is a choice.** This measured deployed branches
(`main`/`production`/`staging`/`master`/`develop`) with 2.1.9 as fallback.
`--branch feature/ai-5314-characterization` measures where the pipeline is
actually installed, and will give different numbers.

**`whatsapp-ms` is PRIVATE**, and was invisible to the token the first runs
used. An earlier version of this file called it absent from the org on that
evidence, which was wrong: `gh repo list` shows only what the caller can see.
It exists, it deploys from `main`, and it reconciles — arms 287, fns 135, first
attempt, no fixes. The `src/downstream/whatsapp-ms` module inside `qode-itl-be`
is that service's CALLER, not the service; both are measured, the caller as part
of qode-itl-be and the service on its own row.

## The NestJS stage-1 blocker, and the fix

Separate from fleetcheck, and the reason stage 1 died on both Nest services.

Stage 1 has to do two things in ONE vitest run: execute the host's suite and
confirm it green, and produce the istanbul denominator over all of `src/`
including files no spec imports. On a Nest host those wanted opposite settings.

`unplugin-swc` is there because Nest's dependency injection reads type metadata
only SWC emits. That plugin also returns `{ esbuild: false }` from its vite
`config()` hook. A file **no spec imports** never enters the module graph, so
SWC's transform never runs on it, and with vite's own esbuild disabled it
reaches istanbul as raw TypeScript — parsed by the fixed babel plugin list from
`@istanbuljs/schema`, which holds **no typescript plugin at all**:

```
plain TS type annotations    Unexpected token, expected "," (1:19)
import type                  Unexpected token, expected "from" (1:12)
enum                         Unexpected token, expected "{" (1:7)
decorator on class           Support for the experimental syntax 'decorators'
```

Decorators are **incidental** — the error lands on whatever TypeScript-only
token comes first, which is why `qode-backend` reported `@Module({` and
`qode-itl-be` `import type` from one cause. istanbul covers NestJS perfectly
well for any file in the module graph; the limitation was exactly *"a file no
spec imports, in a repo whose transform is `unplugin-swc`"*.

Measured, on identical source:

| | suite passes | unimported file instruments |
|---|---|---|
| SWC as shipped | yes | **no** |
| SWC's `config()` dropped | **no** — `design:paramtypes` gone, DI breaks | yes |
| `config()` dropped **and** `enforce: "pre"` | yes | yes |

So `vitest.charpilot.config.mts` does both: neutralises the `config()` hook so
esbuild stays available for the files SWC never sees, and sets `enforce: "pre"`
so SWC runs FIRST on the files it does see — esbuild then receives JS with
nothing left to strip. The plugin ships with no `enforce`, so it otherwise races
vite's own esbuild and loses. Only a host carrying a plugin named `swc` is
touched; an Express host has no such entry and passes through unchanged.

**Verified on the real service**, `qode-itl-be`, 435 files:

```
Test Files  1 failed | 159 passed (160)
     Tests  6 failed | 2503 passed (2509)

statements  7399/10546  70.15%
branches    4987/7065   70.58%
functions   1683/2601   64.70%
lines       6934/9711   71.40%

278 files instrumented, 91 of them imported by no spec — app.module.ts among them
```

No SyntaxError. The 6 failures are **pre-existing**: the same 6 fail on the
host's own untouched config with no coverage and no charpilot, so stage 1 will
still refuse to record a baseline from that branch — correctly, and for the
host's reason rather than the pilot's.

The denominator corroborates itself. `7065` branch sides and `2601` functions
are digit-identical to what fleetcheck measured with no plugins at all, and to
what `scan.mjs` reconciles against at zero drift. Two independent paths, one
answer.

That also retires a risk worth recording: re-processing SWC's output with
esbuild was expected to add synthesised constructors and move the function
count, because esbuild downlevels a class field that SWC leaves alone. It does
not bite here — Nest classes declare a constructor for dependency injection, so
there is nothing to synthesise. The concern is real for a fieldful,
constructor-less class and did not arise on this codebase.

**Not verified:** `qode-backend`. Its install needs the private Artifact
Registry token to resolve `@qode/*`, so only one of the two Nest services has
been through a real stage 1.

## The other half of the cache — `fleetbaseline`

fleetcheck measures the **denominator** and nothing else: its generated config is
`include: []` with `passWithNoTests: true`, deliberately, because *"a service
whose suite wants a database would otherwise decide whether we get one"*. So
every hit count in `out/fleet/<name>/coverage-final.json` is zero, and
`fleetsweep` — which does the arithmetic over that cache — can only report a
**ceiling**: what the work would be if the existing suites covered nothing.

`tools/fleetbaseline.mjs` runs the half that was missing. Per repo: clone at the
deployed branch, install the repo's **real** dependencies, run the repo's **own**
suite under istanbul over the same include/exclude fleetcheck derives, and cache
the answer beside fleetcheck's.

```bash
node tools/fleetbaseline.mjs                 # every repo in the fleet list
node tools/fleetbaseline.mjs --only a,b
node tools/fleetbaseline.mjs --from pricing-ms
node tools/fleetbaseline.mjs --keep          # leave the clone and node_modules
node tools/fleetbaseline.mjs --force         # re-measure a repo already cached
node tools/fleetbaseline.mjs --suite-minutes 30 --install-minutes 45
```

Writes `out/fleet/<name>/coverage-suite.json` (istanbul's document, same relative
keys as fleetcheck's, hits included), `out/fleet/<name>/baseline.json` (the row),
and `out/fleetbaseline.json` (the whole sweep).

**The two documents join exactly**, which is the point. Measured on `location-ms`
at `e04b2950`:

```
fleetcheck  28 files · 367 branch sides · 0 hit      (denominator, nothing executed)
suite       28 files · 367 branch sides · 221 hit    (the repo's own 52 tests)
```

Same keys, same denominator, so the subtraction is a join and not an estimate.
The repo's own suite already reaches 60.2% of its branch sides and 81.3% of its
functions — which is the number that decides whether the other 146 sides are
worth a model call.

### What the rows are for

| state | meaning |
|---|---|
| `green` | it ran, nothing failed |
| `red` | it ran, something failed. **A result, not an error** — the coverage is what the passing tests reached |
| `no-spec-files` | it ran, collected nothing, istanbul reported from `coverage.all` alone |
| `timed-out` | the bound was hit; the row says which bound, because 20 minutes and 20 hours are different findings |
| `did-not-run` | install failed, no vitest on the deployed branch, or the runner never produced either artifact |

A repo whose suite cannot run is **the most valuable row in the table** and is
never silently skipped: its ceiling is also its floor, and it tells you stage 1
will refuse it for the host's own reason before charpilot is involved. Every
failure is reported as the shortest decisive line — `npm error code E403`,
`Error: connect ECONNREFUSED 127.0.0.1:5432` — never a stack dump.

### Four things it has to handle, all measured on this fleet

- **A local `.env` changes the answer.** `notification-ms` is RED with its `.env`
  present and GREEN without it (18 files / 159 tests), because a test deletes
  `process.env.DATABASE_URL` and vitest has already restored it from the file. A
  fresh clone has none, so the row records `envFile: false` and a developer whose
  local run disagrees is looking at their `.env`, not a different suite.
- **`profile-centralized` is genuinely red**, 6 failed, no `.env` involved. It
  still gets its numbers and a reason saying they are the passing half.
- **A suite that wants a database fails.** That is the result; the sweep can then
  exclude the repo rather than guess about it.
- **`tracy-worker` ships no vitest config on any branch** and runs `vitest run`
  on the defaults, which is a legitimate shape. `install.sh` handles it by
  writing an empty base config; fleetbaseline generates its config per run and
  simply imports no base, which is the same decision without adding a file.

### Cost, bounds and resumability

Each repo's real `node_modules` is installed and then deleted — `location-ms`,
the smallest repo in the fleet, is 253 MB — because fleetcheck already measured a
full `npm ci` of this fleet at 20–33 GB against 23 GB free. `--keep` opts out for
one repo you want to open by hand.

Install is bounded at 30 minutes and the suite at 20, both overridable and both
recorded in the row. A hung suite is killed rather than allowed to eat the sweep.

The sweep is **resumable and idempotent**: a repo whose `baseline.json` is on disk
is skipped (its cached row is still printed, so a restarted sweep prints the whole
fleet), and one line per repo goes out as it goes. A run that dies at repo 19 is
worth restarting rather than repeating.

### What these percentages do and do not include

istanbul's, over `coverage.all` with fleetcheck's include/exclude — the **source**
as the denominator, not the files the tests happened to load, which is what lets
them subtract from fleetsweep's ceiling. They are not the host's own published
coverage number, which is usually v8, usually without `all`, and comparable to
nothing here. And they say nothing about whether the covered sides are covered
**well**: a line a test executed without asserting anything counts exactly like
one that is pinned down.

One limit worth naming: the host's own `npm test` is recorded in the row and not
used. It is frequently `dotenv -e .env.test -- vitest run` or a build step ahead
of vitest, and neither can be handed a coverage config, so the repo's installed
vitest is run directly. Where that script would have set env this run does not,
the difference is visible in the row rather than invisible everywhere.

## The third half of the cache — `fleetwalk`

`fleetsweep` says how much work is in each repo. `fleetbaseline` says how much of
it the repo's own suite already covers. Neither of them has ever *run the
pipeline* on a repo, so neither can say the thing that decides whether a run is
worth starting: **where does each repo break, and in which stage.**

> We do not know the bug shape or the mismatch shape in any stage until we run on
> each repo.

A characterization run costs real money — $0.23/side measured, ~$809 for the
nine-repo cover and ~$14,954 for the whole fleet — so running 32 of them to find
out is the most expensive possible way to learn it. But the money is in **one
half** of a run: the agent answering handovers. The mechanical half is free, and
it is where most of today's defects have lived — `install.sh` refusing a repo
that runs `vitest run` with no config, `handoff.mjs` dying on a fresh clone,
`--service` not reaching the tools, `vocabulary` re-probing what it had already
written, a red suite, an environment that cannot be resolved.

So `fleetwalk` does everything a docker run does **except let an agent answer**:
clone at the deployed branch, install the repo's real dependencies, run
`tools/install.sh` — the same script `docker/char/packs/nodejs.py` runs — and
then spawn `node .claude/charpilot/workflow.mjs <repo>` with the CWD at the repo,
exactly as the pack does, with no agent behind it.

```bash
node tools/fleetwalk.mjs                 # every repo in the fleet list
node tools/fleetwalk.mjs --only a,b
node tools/fleetwalk.mjs --from pricing-ms
node tools/fleetwalk.mjs --rounds 1      # how many walk passes (default 1)
node tools/fleetwalk.mjs --keep          # leave the clone and node_modules
node tools/fleetwalk.mjs --force         # walk a repo that is already cached
```

### Exit 75 is the success condition, not an error

`workflow.mjs` exits **75** when a step needs a decision and has written the
handover that asks for it. That is a **healthy** repo: the mechanical half
finished and reached the point where an agent would start earning its money.

Everything else is the finding, and it is attributed to the **step** that
produced it:

| exit | reading |
|---|---|
| 75 with a handover holding items | healthy — the walk got as far as it can without an agent |
| 75 with an empty handover | not a retry; `workflow.mjs` refuses this shape itself |
| 0 | every step said "already done" and nothing was asked — on a repo with open sides, a step answered `satisfied` from an artifact it did not earn |
| 1 | a refusal, prefixed with the step's own label |
| killed at the bound | slow or stuck, and the row cannot tell which — so it says which bound |

Stages before the walk get their own attribution: `clone`, `deps` (the repo's own
`npm ci`, falling back to `npm install` exactly as `common.npm_install` does) and
`toolset` (`install.sh`).

### The summary grouped by failure shape is the deliverable

The per-repo rows are evidence; the grouping under them is the product. It says
which defects are **one fix for many repos** and which are **one repo's own
problem** — an eleven-repo group is worth a morning, a one-repo group is that
repo's maintainer's.

The grouping is mechanical rather than a hand-written taxonomy, because nobody
has seen this sweep's output yet and a taxonomy written now would be a fourth
account of the pipeline's defects. A reason is reduced to its **shape** by
replacing the three things that differ between two instances of one defect —
absolute paths, quoted names, numbers — and keeping every other word the step
wrote. What that costs: two genuinely different failures whose sentences differ
only in a quoted module name land in one group. That is the right direction to
be wrong in for a first pass; the rows inside the group carry the unnormalised
reason, and one real example is printed with the group.

### The environment, which is the careful part

Every `CHARPILOT_*` variable the operator's shell happens to hold is **dropped**,
and exactly four are set:

```
CHARPILOT_MODE=mocked          no boundary is reachable from this host
CHARPILOT_IAC=<qode-iac>       so stage 1 can try to resolve staging from the manifests
CHARPILOT_SERVICE=<deploy name>  the FLEET entry's name, which is what stagingenv looks the ConfigMap up by
NO_COLOR=1
```

`CHARPILOT_EXPECTED_DB` is deliberately **absent** and no database address is
set. Staging is not routable from this host, so naming one would be answering a
question this machine cannot answer honestly — and what each stage *reports*
about an unreachable environment is precisely the thing being measured. A repo
whose environment cannot be resolved is a row against `stagingenv`, never a
skipped repo. There are 37 `CHARPILOT_*` variables in this toolset and three of
them change what stage 1 decides, so a row that says "the environment could not
be resolved" is worth nothing unless the sweep owns its whole environment.

### What each row records

Per repo, cached to `out/fleet/<name>/walk.json` beside `coverage-final.json` and
`baseline.json`:

- which steps ran, **in order**, and for each one: `satisfied` / `ran` /
  `refused` / `handover` / `optional-unsatisfied` / `deferred` — the walk's own
  five words for what a step did, read back off its output rather than
  reinvented, with the step's own sentences kept whole
- the furthest step reached, how far down `ORDER` that is, and the exit code
- whether a handover was written, read from **the file an agent would open**
  rather than from the walk's line about it, with its item and packet counts
- the shortest decisive line for a refusal, never a stack dump. The "Which layer
  is at fault is not something this walk can tell…" paragraph `workflow.mjs`
  appends to every such refusal is stripped: it is identical on every row, so
  keeping it would make three different defects read as one string
- **wall time per step**, so a slow stage is visible. `workflow.mjs` prints no
  timestamps, so this is recovered from when each line *arrived*: every line a
  step prints is emitted after that step has finished, so the clock between one
  step's last line and the next step's last line is that next step's run. It
  includes the step's `satisfied`, `precondition` and `run` and a few
  milliseconds of pipe latency; it does **not** include node's own startup and
  the import of `config.mjs` and ts-morph, which land in the first step's figure
- the toolset commit (out of the `INSTALLED.json` `install.sh` stamps) and the
  repo sha, because "scan refused" means nothing a week later if nobody can say
  which scan

### Bounds, disk and resumability

Three bounds, all recorded in the row: **30 min** install, **20 min** toolset,
**45 min** walk. The walk gets the largest because it runs the repo's whole suite
under istanbul (`baseline`) and ts-morph over its whole source (`scan`). A
timeout is a *wrong answer* — it says "we do not know" where a longer wait would
have said "exit 75" — so all three are generous rather than tight, and the row
names which bound it hit.

Its own work directory, `out/fleet-walk-work`, and this is not a preference:
`out/fleet-work` holds fleetcheck's **pristine** clones, which is what makes
`--recheck` honest, and this tool writes `.claude/charpilot/` into every clone it
touches. `out/fleet-baseline-work` belongs to `fleetbaseline`. All three share
only the answer cache at `out/fleet/<name>/`.

Serial and self-cleaning for the same reason `fleetbaseline` is: each repo's
whole tree plus the four packages `install.sh` adds, against a fleet fleetcheck
measured at 20–33 GB. `--keep` opts out for one repo you want to open by hand.

**Resumable and idempotent**: a repo whose `walk.json` is on disk is skipped, its
cached row is still printed, and re-running the identical command after a crash
is safe. `--force` walks it again.

### `--rounds`, and why the default is 1

A round is one pass of `workflow.mjs`. With no agent behind it, a second pass
cannot answer the first one's handover, so `derive` finds the same open sides,
defers to `record` — which is later in `ORDER`, so the walk honours it — and
`record` refuses: *"`.claude/charpilot/proposals` holds no proposal files, there
is nothing to record"*. Measured on `notification-ms`: round 1 exit 75 at
`derive`, round 2 exit 1 at `record`. That is the walk behaving correctly and
would read in the table as a repo that failed, so the default is one pass and
`--rounds 2` is for looking at that transition deliberately.

### What the first two repos did, measured 2026-09-18

```
repo             furthest step  exit  items  min  first refusal
---------------  -------------  ----  -----  ---  ---------------------------------------
image-forwarder  (toolset)         —      —  0.1  vitest is not installed in <repo>
notification-ms  derive           75     66  0.4
```

**`image-forwarder`** — 28 sides, the smallest repo in the fleet. Cloned at
`production` (519aabb5) in 2s, `npm ci` in 1s, and `install.sh` refused it: the
deployed branch has no `test` script and no vitest in its tree at all, so
`record.mjs` could never spawn `node_modules/vitest/vitest.mjs`. It never reached
the walk. This is expected to be a **large group**: fleetcheck already records
that half this fleet pins no vitest on the branch it deploys, because the runner
and the charpilot install live on a characterization branch instead.

**`notification-ms`** — 428 sides. Cloned at `production` (7c5f26c2), `npm ci` in
8s, `install.sh` in 4s, and the walk ran eight steps in 11 seconds before handing
over:

```
preflight    ran                   0.5s
stagingenv   ran                   0.3s   resolved from the mounted qode-iac
baseline     ran                   4.7s   suite green on a clean clone, denominator written
scan         ran                   2.2s   scan.mjs + armids.mjs
deadcode     ran                   2.1s
worklist     ran                   0.1s   108 open sides
vocabulary   optional-unsatisfied  0.7s   dbvocab: "Can't reach database server at postgres.database-staging:5432"
derive       handover              0.3s   66 item(s), 38 packet(s), 1.39 MB, dealt to 8 workers
```

Three things that row says and nothing before it could. `stagingenv` **resolves**
for this service against the local qode-iac checkout, so the environment is not
the blocker here. `vocabulary` fails exactly as designed — it cannot reach
staging from this host, it is `OPTIONAL`, and the walk continues without it
rather than ending a run over a probe. And `derive` reaches a real handover of
66 items, which is the point an agent would start.

One caveat recorded rather than smoothed over: the **first** walk of
`notification-ms` stopped at `baseline` with the suite RED — one failing test in
`tests/unit/envControllersAndRateLimitMore.test.ts` — and two later walks, one of
them from a deleted-and-recloned tree, were green at the same commit. The row is
what the walk saw; whether that test is flaky or was disturbed by the
`fleetbaseline` sweep running beside it is not something this tool can tell, and
it does not guess.

### What it does not prove

It does not prove a repo will finish, what it will cost, or that an agent can
answer the handover it stopped on. Every boundary here is a double. It proves
only how far the free half gets, and what stopped it.

## The fourth half of the cache — `fleetprobe`

`fleetwalk` stops exactly where the money starts. It does everything a container
run does *except* let an agent answer, which is why it can never reach `record`,
`determinism`, `emit`, `measure`, `repair`, `ruling` or `report` — nothing
answers the handover, so `record` refuses with no proposals on disk and the eight
stages after `derive` are never exercised at all.

`fleetprobe` is the half after that, bought for a rounding error instead of for
a fleet:

```sh
node tools/fleetprobe.mjs --plan                  # classify and sample only: no clone, no agent, no money
node tools/fleetprobe.mjs                         # every repo in the fleet list, with an agent answering
node tools/fleetprobe.mjs --only contact-ms
node tools/fleetprobe.mjs --from pricing-ms
node tools/fleetprobe.mjs --per-type 2 --max-functions 12
node tools/fleetprobe.mjs --rounds 3
node tools/fleetprobe.mjs --keep --force
```

It writes `out/fleet/<name>/probe.json` per repo and `out/fleetprobe.json` for
the fleet, beside the three documents the other tools already cache there.

### Why a sample, and why THIS sample

A full characterization pass over this fleet is ~65,000 open sides at the one
measured rate of **$0.23/side** — about **$15,000**, and weeks of wall time. The
thing we actually need out of each repo is not coverage. It is **where it
breaks**, and every defect this pipeline has lost a day to was a *shape* it had
not met: a proposal building its own subject whose functionId the scan does not
hold, a `null` boundary entry, a repo with vitest 4 and no config, a service
whose deploy name is not its package name, an arm inside a returned closure.

None of those needs a whole repo to find. They are properties of a function
**type**, and `fleetshapes` already classifies every function in the fleet by
exactly those, out of the scan cache, for free. So `fleetprobe` reuses that
vocabulary — it does not invent a second one:

- **TYPE** is `entry.kind` × the driver kind (`via.kind`, read whether the scan
  wrote a string or an object). The pair, because the two fail independently: an
  `import-named` function behind a `trigger` driver and the same entry behind a
  direct call are two different jobs for `derive` and two different jobs for
  `record`.
- **The boundary classes are a second key**, not part of the type, because they
  decide what stage 4 has to *answer* rather than how stage 3 *reaches* it.
  `@prisma/client`, `ioredis` and `axios` fail three different ways, so two
  functions of the same type touching different classes are two strata.

Within a shape the pick is: functions that **have uncovered sides** first (a
function with nothing open gives the walk nothing to ask, so a probe built of
those never reaches `derive`), then **fewest parameters**, then **fewest sides**,
then the function id. Deliberately the *cheap* instance of a shape: it fails the
same way the dear one does for the failures this tool looks for, and it is a
shorter full flow. Across shapes, when `--max-functions` bites, the take is
round-robin **rarest shape first** — a shape carried by one function is the one
that will otherwise be met for the first time in production.

Every comparison ends in the function id, so **the same repo at the same commit
produces the same sample every time**. A second probe that is not comparable with
the first would make this tool an anecdote generator.

### `CHARPILOT_PROBE_FUNCTIONS`, and why it is not a shard

`CHARPILOT_SHARD` is a source **prefix**, and a prefix cannot express "these
twelve functions". `worklist.mjs` therefore carries a second selector, added for
this: a file of one function id per line, exactly as `scan.json` writes them
(`src/a.ts:12:handler`), with `#` starting a comment.

It inherits the shard's three rules unchanged, and two of them are the ones a
careless second selector loses:

1. **Applied to the items, never to the scan.** The reconcile still runs over the
   whole service and the denominator is still the whole service, so a probe's
   percentage stays comparable with every other run's.
2. **`summary.probe` and `summary.probeExcluded` are written**, alongside
   `probeFunctionsRequested` and `probeFunctionsMatched` — a list of twelve that
   matched four is a scan that has moved under the list, and without both numbers
   that reads as a repo with eight closed functions. The run also says so on
   stdout, because a reader who does not know a selector is on reads the counts
   as the service's.
3. **The join self-check adds the exclusion back.**
   `uncoveredSidesMeasured + artifacts + shardExcluded + probeExcluded ==
   baselineUncovered` — the defect fixed for the shard today would have come
   straight back through this door. On `contact-ms` a twelve-function probe
   measures 2 sides against 53 recorded, and an unaccounted selector would call
   that a join defect and refuse the run.

A list matching nothing **refuses**, for the shard's reason: a run that hands out
zero sides and exits clean is indistinguishable from one that finished. So does a
file that is not there, and a file holding no id at all.

Module-scope arms are never selected, and that is not an oversight: their
synthetic owner id is `<file>:0:<module scope>`, which no scan function carries,
so a probe list built from `scan.json` cannot name one. They run at import time
and belong to no function, so there is no function type to stratify them by.

### How the agent answers, and what is NOT reproduced

`docker/localrun.py` is the reference for a walk running locally with an agent.
`fleetprobe` drives the same loop the `nodejs` pack drives — walk, answer what
the walk refuses to decide, walk again — and spawns the agent the same way
`char/agent.py` does: `claude --print --output-format stream-json --verbose
--permission-mode acceptEdits --settings docker/settings.json --max-turns 40
--add-dir <clone>`, stdin the rendered prompt file. `--settings` is what imposes
the container's allowlist without relocating `CLAUDE_CONFIG_DIR`, which on a
laptop loses the login outright; without an allowlist every Bash call is refused
and **the turn ends reporting success having done nothing**, so a missing
settings file is a refusal rather than a shrug. `CLAUDE_CODE_PRINT_BG_WAIT_
CEILING_MS=0` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8` are taken from
`entrypoint.py` for its own measured reasons.

Which prompt a round gets is a fact on disk, not a guess about the round number:
the walk writes the step that asked into `worklist-decisions.json`, and the
template follows the question (`derive` → `worklist-prompt-derive.md`, `repair` →
`worklist-prompt-repair.md`, anything else → the deriving prompt).

It does **not** go through `localrun.py` itself, and the reason is one variable:
the nodejs pack's preflight refuses a run without `CHARPILOT_EXPECTED_DB` naming
a staging database. That refusal is right for a run that may go live. There is no
live to go to here — staging is not routable from this host and every probe runs
`CHARPILOT_MODE=mocked` — so satisfying it would mean writing a database triple
into 32 env files that nothing will ever dial. The variable is left absent
exactly as `fleetwalk` leaves it. Also not reproduced, each for `localrun.py`'s
own stated reason: the clone from `GITHUB_TOKEN` (this clones anonymously from
the public org path, as `fleetcheck` and `fleetbaseline` do), the branch, the
commit, the push and the pull request.

**Credentials are checked before the first clone.** `ANTHROPIC_API_KEY` *and*
`ANTHROPIC_MODEL`, or `CHARPILOT_LOCAL_LOGIN=1` to use the machine's own login —
which drops the model pin and is said out loud, because any difference in turns
or cost is then a difference in model as much as in the pipeline. Without either,
nothing is probed: a sweep with no answering turn would record 32 walk refusals
and call a credentials problem a fleet of broken repos.

### The grouping is the deliverable

The rows are evidence. The product is `killShapes`: how many repos stopped at the
same **stage** for the same **kind of reason**, with the function **types** that
were in the packet when they did. The reason is normalised by `fleetwalk`'s own
`reasonShape`, so paths, quoted names and numbers do not split one shape into
thirty, and one unnormalised instance is kept whole beside it.

The type column is the half `fleetwalk` cannot have. A `record` refusal that only
ever appears with `entry:call-argument via:trigger` in the packet is a defect in
how the pipeline drives callbacks; the same refusal spread evenly across every
type is a defect in `record`. The two need different fixes and they read
identically without it.

### Bounds, disk and resumability

Five bounds, all recorded in the row, because a `timed-out` without its bound is
uninterpretable: `--install-minutes 30`, `--toolset-minutes 20`,
`--walk-minutes 45`, `--turn-minutes 30` and `--repo-minutes 120` end to end. The
walk is spawned in its own process group so one kill reaches the vitest and
ts-morph it started; a `SIGTERM` to the leader alone leaves those holding the
pipe and the bound then bounds nothing.

Its own work directory, `out/fleet-probe-work` — `out/fleet-work` holds
`fleetcheck`'s pristine clones, and `out/fleet-baseline-work` and
`out/fleet-walk-work` belong to the other two sweeps. Serial and self-cleaning:
`node_modules` goes after each repo, because a full `npm ci` of this fleet was
measured at 20–33 GB and three sweeps share one disk. A repo whose `probe.json`
is on disk is skipped and its cached row is still printed, so a sweep that dies
at repo 19 is worth restarting rather than repeating; `--force` probes it again.
`--plan` consults no cache and writes none, and writes `out/fleetprobe-plan.json`
rather than over the real report — a plan document carries no outcome for any
repo, and a sweep's findings replaced by one would read as a fleet that stopped
nowhere.

### What the whole fleet's selection costs, measured 2026-09-19

`--plan` over all 32 repos, from the cache alone, in seconds and for nothing:

```
384 functions selected  (12 per repo, the cap)
379 of 1,449 strata reached
1,187 uncovered sides between them
18 repos sampled against coverage-suite.json (fleetbaseline's measured suite)
14 against coverage-final.json (fleetcheck's denominator — every hit count is
   zero there, so every side reads as uncovered and the sample is against a ceiling)
every repo has at least one sampled function with an open side
```

**Do not price that at $0.23/side.** That rate came from a run that amortised its
per-round and per-packet cost over 146 sides; a probe amortises it over sixteen.
The one measured probe that reached an agent — `notification-ms`, below — cost
**$27.21 for 16 sides over 2 rounds**, which is $1.70/side. The probe is cheap
per REPO, not per side, and the honest fleet estimate is therefore a per-repo one:
**~$25–30 and ~20 minutes for each repo that gets past `install.sh`**, and $0.00
and under a minute for each one that does not. On today's cache 19 of the 32 have a
runner installed on the branch they deploy — and at least one of those,
`contact-ms`, still fails `install.sh` for its source layout — so the upper bound
is **~$500–600 and ~7 hours**, against ~$15,000 for full coverage. Both halves of that are one observation on
one repo on an unpinned model; treat them as an order of magnitude.

### What the first three repos did, measured 2026-09-19

**`image-forwarder`** — 28 sides, the smallest repo in the fleet. Classified in
milliseconds from the cache: **8 strata across 5 entry × driver types, all 8
sampled, 12 functions holding 20 uncovered sides**, taken against
`coverage-final.json` because `fleetbaseline` has not measured its suite (so
every side there reads as uncovered — a ceiling, and the row says so). Cloned at
`production` (519aabb5), `npm ci`, and `install.sh` refused it: **`vitest is not
installed in <clone>`**. The deployed branch pins no runner, so `record.mjs`
could never spawn `node_modules/vitest/vitest.mjs`. It never reached the walk and
cost $0.00. Expected to be a large group — half this fleet keeps its runner on a
characterization branch rather than on the branch it deploys.

**`contact-ms`** — 53 sides, a database boundary. **14 strata across 7 types, 12
sampled, 12 functions, 2 uncovered sides** — its own suite is green and already
covers 48 of its 53, and the probe is sampled against `coverage-suite.json`, so
2 is what is genuinely left in the sampled functions and not a ceiling. Its
packet carries `boundary:database`, `boundary:http` and `boundary:internal`
between them. `install.sh` refused it for a **different** reason: **`<clone> has
no src/ directory`**. `contact-ms` keeps its TypeScript at the repo root beside
`routes/`, `service/` and `server.ts` — the layout `fleetcheck`'s own `SRC_DIR`
already carries as `"."` — and `install.sh` has no such escape. Two toolset
refusals, two different fixes: this is exactly the distinction the grouping
exists to make.

**`notification-ms`** — run as the third repo because the first two stop before
the walk and nothing would have exercised the agent half. 428 sides; **32 strata
across 10 types, 12 sampled, 12 functions, 16 uncovered sides** against
`coverage-suite.json`. Clone 2s, `npm ci` 7s, `install.sh` 5s, then two rounds:

```
round 1  walk exit 75 in 13s
  preflight    ran                   0.5s
  stagingenv   ran                   0.2s   resolved from the mounted qode-iac
  baseline     ran                   5.5s
  scan         ran                   2.6s   scan.mjs + armids.mjs
  deadcode     ran                   2.8s
  worklist     ran                   0.1s   worklist.mjs exited 1 — see below
  vocabulary   optional-unsatisfied  0.9s   dbvocab: cannot reach staging from this host
  derive       handover              0.4s   16 sides -> 16 items in 7 packets
  AGENT        answered              11 turns, $10.02
round 2  walk exit 75 in 14s
  preflight..worklist  satisfied            already done
  derive       ran                   5.7s   7 submissions -> propose.mjs wrote the proposals
  record       ran                   1.8s   mode: mocked — every boundary answered by a double
  determinism  ran                   1.8s
  emit         ran                   0.2s   wrote test/characterization/
  measure      ran                   2.6s   coverage.mjs exited 1: the suite under measurement did not pass
  repair       handover              0.4s   22 items in 16 packets
  AGENT        answered              3 turns, $17.19
```

`result.json` was written, `status: "partial"`, `partial.step: "repair"`,
**77.8% branches / 97% functions**, `claims: 16 checked, 11 verified, 5 false`.
Total 21.2 minutes and **$27.21 on this machine's own login** — not comparable
with a container run, which pins `claude-sonnet-5`.

That is every stage of the flow — `derive`, `record`, `determinism`, `emit`,
`measure`, `repair` — exercised on one repo for twenty minutes, which is what
`fleetwalk` cannot reach and what a full run would have bought at 428 sides
instead of 16.

**And it found a defect in the selector accounting, in the one way only a real
repo could.** Round 1's `worklist` line reads:

```
worklist.mjs exited 1 — ✗ worklist measures 16 uncovered sides where
coverage-charpilot recorded 108, and CHARPILOT_PROBE_FUNCTIONS excluded 161 -
so 16 + 161 should equal 108.
```

`shardDropped` and `probeDropped` were counting removed **items**, and the
self-check they feed counts **instrumented, joined, uncovered sides**. `items`
also holds function entries and statements, which carry one nominal side each
and are not in istanbul's branch denominator at all, and one arm carries as many
sides as it has labels. The shard had the identical bug and it is not
hypothetical: on the same clone, `CHARPILOT_SHARD=src/services` read `67 + 74
should equal 108` and refused a run that was working exactly as intended. Both
now count `measuredSides(removed)`, both balance on that repo (`67 + 41 = 108`
and `16 + 92 = 108`), and
`tests/worklist.probe-functions-narrow-questions-not-denominator.test.mjs`
carries a fixture whose item count and side count deliberately differ, because
the first fixture's did not and the bug was invisible in it.

**A second finding, recorded and not fixed here:** the walk *continued* on that
refused work list. `steps/worklist.mjs` reports the tool's non-zero exit in its
`did` line and returns success anyway, so `derive` dealt a round built from a
brief the tool itself had refused. Only the `did` line said so, and nothing
downstream did. That is in `steps/worklist.mjs`, not in the selector.

### What it does not prove

The same limits `fleetwalk` states, plus one more. Every boundary is a double, so
no coverage number here describes a live path. A repo that stopped early has said
where it stops and has **not** said it would finish if that were fixed, because
only the stages before the stop ran. And the cost figure is a *probe's* cost: at
16 sides for $27.21, `notification-ms` cost $1.70/side against the $0.23/side a
full run measured, because the per-packet and per-round cost is fixed and a probe
amortises it over almost nothing. The probe is cheap per REPO, not per side.
