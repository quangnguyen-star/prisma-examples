# charpilot — characterization pilot

Build a characterization test suite from **recorded behaviour**, not from guessed
behaviour. One rule holds the whole thing together:

> **The agent derives the input. The machine records the output.
> Neither does the other's half.**

An input the agent reads off a branch arm, executed by a tool, buys ~0.70 branch
arms per test. An input a tool both derives *and* consumes buys ~0.015. That
split is the entire reason this is built in stages with different owners.

## Where this stands

Measured by `npx vitest run --coverage` in workspace mode - both projects, one
istanbul denominator, so there is no merge to get wrong. **Every number further
down this file is a measurement from the moment it describes, not a current
one.** Read this block for the current one.

```
Statements   2260/2260   100%
Functions     478/478    100%
Lines        2169/2169   100%
Branches     1449/1449   100%
```

**Read the branch denominator, not the percentage.** It was 1460. Nine sides
were suppressed by directive, and **11** sides left the denominator with them -
the 9 dead ones plus **2 exercised**, both collateral of the one directive that
had to cover a whole function because a `default-arg` side has no narrower
placement.

The first attempt at this gave up **36** exercised sides, because every
directive was placed on the enclosing statement. `istanbul ignore next` attaches
to the next instrumented AST **node**, and a `??` operand or a ternary branch is
one - so the directive belongs on the dead operand, not on the statement that
contains it. Measured on a probe:

```
control                        [2,1] [2,0] [2,1]
before the dead operand        [2,1]  [2]  [2,1]   dead side skipped, siblings kept
before the object property     [2,1] [2,0] [2,1]   INERT - a key is not a node
before the enclosing statement  (every branch location in the statement gone)
```

Nine sides finished the ratchet with a written reason instead of an input. Four
are now suppressed and five are not, and the split is not about how good the
reason is - it is about what a directive costs. `istanbul ignore next` is scoped
to a **statement**, so suppressing one side suppresses every side that shares
its statement:

| side | placement | exercised sides given up |
|---|---|---|
| `prompt.ts:225` | `ignore else` on the `if` | **0** - `ignore else` drops only the else path |
| `getAiModelV1.service.ts:262`, `:272`, `:274` | `ignore next` on `recordUsage({…})` at `:255` | **21**, taken on an explicit decision |
| `vertexAIModelV1.ts:605` | would need the whole `body` literal | 8 - not taken |
| `getAiModelV1.service.ts:351`, `:352` | would need `alertUsageError({…})` | 4 - not taken |
| `langfuse.service.ts:13` | a default arg has no statement; the whole function | 2 - not taken |
| `modelPricing.service.ts:79` | would need the `warn(…)` call | 1 - not taken |

A directive on the property itself does nothing. That was measured on a
throwaway probe with the same shape - an object literal argument whose
properties are `??` expressions - instrumented twice: before the property left
3 branch locations with the dead side still counted `[2,0]`; before the
statement left **0**. So there is no narrower placement than the enclosing
statement, and the reasons for the five that were not suppressed live in
[`proposals/BLOCKED.md`](proposals/BLOCKED.md), which `ledger.mjs` reads as the
exit condition.

Two consequences worth knowing before reading a number anywhere else:

- **`out/baseline.json` is pre-suppression.** It recorded `branches.total: 1460`
  on 2026-09-05; the live denominator is 1435. `scan.mjs`'s reconcile compares
  against that frozen number, so its "5 files drift" line is not comparable to a
  fresh coverage run until `baseline.mjs` is re-run.
- **A suppressed side is not an uncovered side.** istanbul drops it from the
  denominator, so `ledger.mjs` classifies its `BLOCKED.md` entry as STALE. Three
  entries are in that state and are correct, not rot; the ledger needs a third
  state between "covered" and "blocked".

## What "covered" means here — and what it does not

This is the part worth reading before any number in this file.

A characterization suite is not trying to prove the code is **correct**. It is
trying to **freeze what production already does**, so that a later change which
alters that behaviour shows up as a failing test instead of an incident.

So "100%" here does not mean "100% of the code is right". It means:

> every path production can take has an input that drives it, and a recorded
> output that says what it did — so the current behaviour is pinned, whatever
> that behaviour happens to be.

That distinction decides several things that would otherwise look like
contradictions:

- **A recorded pair can pin a bug.** `getClientIp` returns `"unknown"` for a
  request with no identifiable address; `alertUsageError` swallows its own
  failure; `omit` silently does nothing when the value is `0`. Those are all
  frozen as-is. Freezing a bug is correct behaviour for this suite — it means a
  refactor cannot change it by accident, and a deliberate fix has to say so.
- **Dead code is not a coverage gap.** If no input in any environment can reach
  an arm, it holds no production behaviour, so there is nothing to freeze. It is
  a defect to delete. Twenty-two sides here are in that state, and the ledger
  reports them separately with the note that a rising count is bad news, not
  progress.
- **The unit is the function, and the function has at least one branch.** Even a
  function with no decision point has one path — "was it invoked, and what did it
  do". Getting this wrong is what made the first work list miss 77 functions
  (see below).

## Stages

| # | What | Owner | State |
|---|---|---|---|
| 1 | Set up the repo, record a baseline | machine | **built** — `baseline.mjs` |
| 2 | Scan for functions and branch arms | machine | **built** — `scan.mjs` |
| 2a | Cross-check the scan against reality | machine | **built** — `verify.mjs` |
| 2b/7 | Dead code vs what is still uncovered | machine | **built** — `deadcode.mjs` · `deadcode-compare.mjs` · `suppressions.mjs` |
| 3 | Derive an input for each arm | agent | **built** — `worklist.mjs` · `validate.mjs` · `ledger.mjs` |
| 4 | Run against staging, record the pair | machine | **built** — `preflight.mjs` · `record.mjs` · `determinism.mjs` |
| 5 | Write the test from the pair | machine | **built** — `record.mjs --emit-tests` · `verify-generated.mjs` |
| 6 | Measure, verify the claims, loop to 3 | machine | **built** — `coverage.mjs` |
| 8 | Mutation-test the finished suite | machine | **built** — `stryker.conf.json` · `mutants.mjs` |

### A row that recorded the wrong side is refused at stage 4, not stage 6

`record.mjs` already knew. It computes the same verdict stage 6 does — per ROW
rather than per suite — writes it to `falseClaimsAtRecordTime`, prints it, and
exits 0. Its own comment explains why: *"Stage 6 still fails on these — this is
the same finding, ~30 minutes earlier."* The observation being real is right and
the row is still kept; routing the FAILURE to a stage three hours and about $44
downstream is the drop-off §6 forbids. Run `20260915T033521Z` wrote 119 of them
and went on to emit, measure, loop and report success.

So the recorder records and `gate.mjs`'s `reaches-at-record-time` refuses. Three
endings stay legal — **seed** it (`setup.apply.db`), **block** it (a fenced
BLOCKED.md entry, accounted and out of nobody's denominator), or be **refused** —
and the fourth, recording the not-found side silently, is closed.

**Why this is not the stage-3 static check it was asked to be.** It cannot be.
Measured over all 88 proposals of that run (`gate.record-time-claims.test.mjs`
carries the table and recomputes it):

| rule | fires on the 53 that produced a false claim | fires on the 13 that only verified |
|---|---:|---:|
| static: declares a non-empty `prisma` answer, unseeded | 36 | **6** |
| static: only reads a `create` seed could fill | 2 | 1 |
| **record-time verdict** | **50** | **3** |

The proof that no static rule does better is a matched pair:
`findBestCityInCountry-no-cities-on-country` and
`findBestCityInCountry-second-city-does-not-beat-first` share a subject, a `via`,
a boundary symbol and a non-empty `$queryRaw` declaration, and neither is
seeded — one is false, one verifies. What separates them is which side of an arm
inside the helper the empty-database path happens to take, which is the thing
being measured. A stage-3 refusal would have cut 46% of the good rows, and a
stage-3 refusal **costs sides** because it deletes the proposal before it runs.
A stage-4 refusal costs a repair.

**And seeding was never the main fix.** Of the 56 rows that recorded the wrong
side, 2 were starved by a model read a `create` seed can fill, 18 by `$queryRaw`
— raw SQL no `create` seed can steer — and 35 by nothing at all. The check says
which, from the reads the proposal DECLARED non-empty intersected with the reads
the database returned empty, so it never sends an author to write a seed that
cannot work.

### The rate is compared to a target, and the target is per mode

Nothing did this. `report.mjs` wrote `result.json`, `finish.py` checked only
that `coverage_percentage` carried two numbers, and the container opened a pull
request — so the first live run, `20260915T033521Z`, **exited 0 at 65.9% branch
coverage**, thirty points below the mocked run beside it, and nothing in the
pipeline said a word.

`coverage-ratchet` does not catch that and cannot: it asks whether the union
fell *below what the repo's pre-existing suite already covered*, which 65.9%
passed comfortably because the existing suite covered less. "Did it go down" and
"did it get there" are two questions.

`targets.mjs` answers the second, and both `report.mjs` and `gate.mjs`'s
`rate-target` check read the same verdict from it — two tools reading one
artifact must not reach opposite verdicts, which is the failure that put
`claimsFalse: 118` in `coverage.json` and `"succeeded"` in `result.json`.

| | |
|---|---|
| default floor | 96.5% branches, **stated per mode** (`DEFAULT_TARGETS`) |
| override | `CHARPILOT_TARGET_BRANCHES_LIVE` / `_MOCKED`, and the verdict prints which one it used |
| stretch | 97.5%, **reported as a distance, never gated** |
| unknown mode | a REFUSAL, not a pass — a rate is not comparable across modes, which is why `runcmp.py` exits 2 on that comparison too |

The target never moves to meet the run, and the run's own achieved rate is read
for one purpose only: comparing it.

### The denominator is live code, and both numbers are always printed

Stage 2b's rule is that a proposal characterizing a **dead export** is deleted
before any input is written — correct, because the test pins behaviour no caller
can observe. But the deletion took the side out of the numerator and left it in
the denominator, so obeying the rule *cost coverage*. Run `20260915T050314Z`:

```
iteration 3   hitByEither 358   stillUncovered  9     358/367 = 97.5%
iteration 4   hitByEither 358   stillUncovered  9     (flat)
iteration 5   hitByEither 346   stillUncovered 21     newSides -12
```

`out/dead-exports.json` had computed `correctedDenominator: 332` all along and
nothing consumed it. Dividing by it alone gives `346/332 = 104.2%` — a rate above
100, which is the proof that it removes the sides from one half of the fraction
only. A dead side the suite happens to cover is in `hitByEither` too, so both
halves or neither:

```
correctedHitByEither = hitByEither - deadSidesHit   346 - 23 = 323
correctedSides       = sides       - deadSides      367 - 35 = 332
                                                    323/332  = 97.29%
```

Which is the same figure at iteration 4 (where all 35 dead sides were covered:
`358 - 35 = 323`) and at iteration 6. **Against live code the deletion cost
nothing**, and the cross-check is that `21 - 12 = 9` live-code sides remain
uncovered — exactly iteration 4's own `stillUncovered`.

`deadcode.mjs` publishes the `functionIds` inside each dead export and
`coverage.mjs` tests each side's own `functionId` against them, so the two tools
agree by identity rather than by two matching arithmetics. Only membership in
that scan takes a side out; **an export that is merely uncovered is not dead**,
and nothing in the membership test reads a hit count. A missing or pre-`functionIds`
artifact is a refusal, never a fall back to the raw denominator.

`result.json` carries `coverage_percentage` (raw, unchanged — `finish.py` and
`runcmp.py` bind to it) and `coverage_percentage_live_code` beside it. Both,
always: a corrected rate that hides the raw one is how a smaller run comes to
wear a bigger number.

### The loop is refereed by an artifact, not by the agent

`coverage.mjs` appends one row per iteration to `out/loop.json` — `{ n, gitSha,
specs, specsMeasured, sides, hitByCharacterization, hitByEither, stillUncovered,
newSides, claimsFalse }` — and `gate.mjs`'s `progress` check reads it. Two
consecutive iterations that move zero sides are a STOP.

It has to be an artifact because of what it guards against. On a 3,385-function
service the recording lane stalled, no rule said what to do, and the agent wrote
572 tests whose every value came from running its own suite, then reported
success **because no written rule had been broken**. An unattended 3→4→5→6 loop
asks the agent to judge its own progress; a rule written in the skill the agent
reads cannot catch that, and a row written by a tool can.

`progress` also refuses a row that measured nothing — `specsMeasured: 0`, or
characterization credited with 0 sides. That case was real: `--specs` defaulted
to `out/specs`, the recorder's throwaway directory, so a bare
`npm run pilot:coverage` measured specs five days stale against a moved `src/`
and reported 0 sides characterized with 452 claims FALSE. The default is now
`test/characterization`. Same family as the four ways stage 6 measured the wrong
suite below: a flat sequence of those rows would have read as a stalled loop
rather than as a measurement of the wrong thing.

**Stages 5 and 6 were originally the other way round.** Coverage measures a test
suite, so the suite has to exist first: generate, then measure. Running them
backwards measures the recorder's own throwaway specs, which hit 845 sides where
the shipped tests hit 719 — the specs run every runnable row, the tests only the
ones with a recorded outcome. Quoting the earlier figure credited the suite with
coverage it did not have.

### Stage 6 was measuring the wrong suite — four ways at once

The number this pipeline exists to produce was being read through a path that
did not do what it said. Four independent defects, each of which alone produces
a plausible figure:

1. **`--specs` was decorative.** `coverage.mjs --specs test/characterization`
   counted `.test.ts` files in that directory, printed the count, and then ran
   vitest with a config whose `include` was hard-wired elsewhere. The flag that
   appeared to select the measured suite only changed one line of stdout.
2. **The config's `include` pointed at `.claude/charpilot/out/tests/`** — a stale
   copy of a previous generation — not at `test/characterization`, where stage 5
   actually writes. 28 stale files stood in for 29 real ones.
3. **`reportsDirectory` was never written.** `coverage.mjs` reads
   `coverage-charpilot-stage6/coverage-final.json`; that directory has never
   existed. Every successful run was in fact joining `coverage-char-only`,
   produced separately, and the flag defaults hid which.
4. **In workspace mode vitest resolves coverage at the root, not per project**,
   so `vitest.characterization.config.mts`'s own `coverage` block — the one
   carrying `all: true`, the thing that fixes the denominator at 1488 — was
   dropped whenever `vitest.workspace.mts` was present. The report came out
   empty and the failure was a missing file, not an error.

The tell was arithmetic: 17 stale spec files and 29 real ones produced
**byte-identical** totals. Two different suites cannot do that.

`--specs` now sets `CHARPILOT_SPECS`, and the config reads its `include` from it.
The config also prefers the suite's **own** `recorded.env` over
`out/staging.env`, because a characterization suite is only valid under the env
it was recorded against — measuring against the wrong one made two rows see
staging's real `SLACK_HOOK` and Langfuse baseUrl where the recording had inert
stand-ins, and they failed as harness errors rather than as assertions.

**What it cost.** Nothing in the recorded rows was wrong; the recordings were
fine throughout. What was wrong was the confidence attached to the percentage.
Measured properly, with recording and measurement under one env: **293 of 293
generated tests pass**, characterization alone covers **938/1488** sides, and
the union with the existing suite is **1333/1488 = 89.58%**. Those are the
figures *at that point*; the denominator has since moved twice, once as
suppressions were argued and once as they were applied. See **Where this
stands** at the top for the current numbers.

Same family as an `istanbul ignore` silently stripped for want of `-- @preserve`,
and as the dead-code scan reporting 0 from an empty file list: a metric that
reads as deliberate and measures something else is worse than no metric.

### Stage 4's boundary policy — `--policy` (`policy.mjs`)

The rule, stated once: **the database and every downstream service are real.
Slack and Redis are the only two mockable boundaries, and each is answered one
level BELOW the code under test.**

| flag | what it does | needs |
|---|---|---|
| `--policy as-declared` | the proposal's own answers stand. **NOT the default** — the default is `real-except-cache`, and it has been since the trapdoor it replaced was measured (a live run recording 265 hand-written doubles while stamping `"live": true`). | — |
| `--policy right-level` | drops wrong-level cache/Slack answers and injects the doubles beneath them | nothing |
| `--policy real-except-cache` | `right-level`, plus every DB/downstream answer is dropped for an observing passthrough | `--live` |

`right-level` is separate on purpose. It is a pure correction to *where the seam
is cut*, so it holds offline — and offline is what stage 6 measures, because
stage 5 deliberately does not write tests from live rows. Bundled into one flag,
the correction could only be had in a live run and so could never reach the
number it was correcting.

#### Why those two, and why one level down

`slack.service.ts` and `sendErrorToSlack.ts` are the **only** importers of
`axios` anywhere in `src` — checked, not assumed — so answering `axios` silences
Slack and nothing else, while the real `SlackService.sendMessage`, the real
payload construction and the real `axios.isAxiosError` classification at
`slack.service.ts:130` all still execute. Answering `sendSlackNotification`
instead deletes both files from the measurement, `:130` included, and that line
is itself an uncovered arm.

Same argument for the cache, but with one correction that cost a measurement to
find. **"Wrong level" is relative to the row's own subject, not a property of the
symbol.**

- `withCache` and `PromptDbCache` are **never** answerable. They are decorators:
  answering one replaces the decorator's arms *and* the query it wraps, in one
  move. The answer belongs on `prisma` underneath — a real shape, from a real
  row.
- `redisCache` depends on what the row is testing. For a row whose arms are in
  `cache.decorator.ts`, `redisCache` is strictly BELOW the subject, and a
  per-call sequence — `acquireLock: [{resolves:false},{resolves:true}]` — is the
  only thing that selects the decorator's branches. For a row whose arms are in
  `redis.service.ts`, the same symbol IS the subject and the seam has to move
  down to `ioredis`.

Dropping `redisCache` unconditionally was tried first, and it is worth recording
what it cost: the union went **1325/1488 → 1233/1488** and false claims **doubled,
102 → 201**. The always-identical `ioredis` miss cannot drive a branch that needs
two different answers on two successive calls. The rule is now
`classify(symbol, coveredFiles)`: same symbol, opposite verdict, depending on
what is under test.

Everything else is reachable — staging Postgres answers on the external LB,
Langfuse is a public host — and a canned answer where a real one is available is
exactly the degree of freedom stage 4 exists to remove.

#### The cache double must MISS

Not a detail, the whole point. A cache that ANSWERS is a cache that hides the
call beneath it: a canned `withCache` returns a value without running the
decorator's arms or the query it wraps, so the arm the row claimed to reach never
executes. **Measured at stage 6: 35 of 102 false `reaches` claims were rows in
exactly that shape.** A cache that misses is transparent — the decorator takes
the compute path and the real query runs.

So `ioredisMiss()` answers `get → null` and lock acquisition → **acquired**, so
the leader path runs the wrapped function rather than waiting on a lock nobody
holds. That is the right default for a row that is trying to reach *past* the
cache; a row whose subject is the cache still needs sequenced answers, per
above. And `REDIS_ENABLED` is set to `"true"`, not false: disabled returns early
at `redis.service.ts:38` and leaves the client null, so every method throws
instead of missing — a different arm, and it makes the whole subtree unreachable.

It is a **class**, not an object, because `connect()` reads its own construction
options: `retryStrategy` is defined inline in the options literal at
`redis.service.ts:52` and the only route to it is the instance the constructor
was handed. `applyMock` had to be taught to construct a class answer rather than
return it — the old line discarded functions, so every class-shaped double
collapsed to `{}`.

Both doubles are injected for **every** row, including rows that never mention
them. `langfuse.service.ts:143` and `loggerV2.ts:160` fire Slack without awaiting
it, and a module-scope Redis singleton is constructed by the import graph — 14
rows that had nothing to do with Slack were failing as blocked egress for
precisely that reason, and one row dialled `redis-ai-centralize.database-staging.svc.cluster.local`.

#### What the policy moved, measured

| | before | after |
|---|---|---|
| rows recorded live against staging | — | 233 |
| blocked-egress refusals, live | 61 | 40 (all provider) |
| Slack-blocked rows | 14 | 0 |
| Redis DNS leaks | 1 | 0 |
| rows needing a hand-built harness | 51 | 49 |

The 40 that remain are all `api.anthropic.com` / `api.openai.com`. Those bill,
and `--live-providers` is the only thing that opens them.

### Stage 4 will not seed staging unless it can undo it — `setup.apply.db`

`setup.apply.db: { create: { model, data } }` inserts a row the arm needs, and
only under `--live`, where every write is journalled and reverse-replayed with
verification at the end of the run. A seed is **not** a `calls` entry: those
swallow their failure on purpose ("the precondition was already satisfied"), and
a silently-unseeded row records the arm it was written to leave behind while
looking entirely correct.

It exists because of a measurement. **All 181 `api_key` rows on staging are
well-formed** — every one has langfuse keys, every one's provider key JSON parses
against its Zod schema, none has an empty `modelName`, none has a null
`provider`. So the guards at `getAiModelV1.service.ts:460-463`, repeated across
all five resolvers, cannot be reached by any row that is there. They are **not**
dead: `langfuse_key` is a nullable column and `modelName` is a bare `z.string()`,
so the state is permitted — just absent. That is an input problem, and the input
is a row.

### The row cache is keyed on the proposal, not only the harness

`harnessVersion()` hashes `record.mjs`, `doubles.ts`, the vitest config, the env
digest and the flags — everything except **the input**. So editing a proposal's
args, boundaries or invoke recipe left its old observation in the cache and the
next run served it: `294 already cached, running 0` immediately after 11
proposals had been rewritten.

That is the worst failure this cache can have, because the stale row is cited,
internally consistent, and describes a program that no longer exists. Every row
now carries a `__fingerprint` over its proposal's args, boundaries, invoke,
setup, via, covers and reaches; a mismatch re-records that row and says so.

### Where 2b and 7 sit, and why not anywhere else

**2b — dead code — runs after the RECONCILE, not with the scan.** It shares the
ts-morph project with stage 2, so that is where it is cheapest to run, but it
must come after `ast === istanbul` closes at zero drift: pruning moves the
denominator, and you cannot reconcile a count against a moving target. Order is
scan → reconcile → prune → hand stage 3 a target already net of dead code.

Getting this wrong is measurable. On this repo the pilot ran dead-code detection
LAST and paid for it: **28 of 336 proposals (8%) were written against dead
exports** — 26 dead exports, 51 sides, denominator 1518 → 1467. Five of those
were for `getClientIp`, whose only call site is commented out; a `grep` counted
that comment as a reference and `findReferencesAsNodes` correctly did not.

There is a second kind the tools do not report: **22 dead branches inside live
functions**. Those only surface when stage 6 says a side is still uncovered and
stage 3 cannot write an input for it, which is the third exit below.

**8 — stryker — runs only once stage 6 closes at 100%.** Before that it reports
surviving mutants in code nothing covers, which is information you already have.
After it, it answers the one question coverage cannot: *would these tests notice
if the code changed?* That makes it a validation of the SUITE, not a step in
building it — and it is the only step that tests the method rather than the code.

### Stage 3 has three exits, not two

The ledger originally accepted two: an input, or a written reason. A reloop needs
a third, because some sides can never take an input.

| exit | when | what it costs |
|---|---|---|
| **input** | the side is reachable | the normal path |
| **reason** | reachable, but needs a harness nobody has built | stays in the gap, honestly |
| **unreachable** | the code CANNOT take this side | leaves the denominator |

`unreachable` is the one that has to be earned. It requires the invariants that
make it so, named and written beside the directive — not "looks dead". Two worked
examples from `location-ms`, both confirmed before being ignored:

- `if (iso2Result)` — `findCountryByIso2` has exactly two returns, both truthy
  objects, and no third path, so the else is not constructible.
- a four-arm `if/else if` chain whose last two arms need a non-null entry with no
  predictions, which would already have thrown where `predictions[0]` was
  dereferenced three functions earlier.

Never delete the code to get the number. A defensive fallback whose
unreachability rests on an invariant somewhere else is exactly what you want left
in place if that invariant changes.

> **The `-- @preserve` trap.** In a vite/esbuild project
> `/* istanbul ignore next */` is **silently stripped** — esbuild drops comments
> in the TS transform and istanbul instruments the transformed output, so the
> directive is gone before istanbul sees it. It must be written
> `/* istanbul ignore next -- @preserve */`, as its own comment, on its own line,
> immediately before the statement. Inline between `else` and `if` does not
> attach, and a second comment in between breaks it. Measured on identical code:
> 94.69% branches without the marker, 100% with it. A directive that reads as
> deliberate and does nothing is worse than no directive — the gap looks decided.

```bash
npm run pilot:baseline     # stage 1  → out/baseline.json
npm run pilot:scan         # stage 2  → out/scan.json
npm run pilot:verify       # stage 2a → out/entry-verify.json  (needs scan.json)
npm run pilot:worklist     # stage 3  → out/worklist.json + out/worklist.md
npm run pilot:validate     # stage 3  → checks proposals/*.json (agent-authored)
npm run pilot:ledger       # stage 3  → asserts every side is proposed or blocked
npm run pilot:status       # any time  → THE source for every number in a report
npm run pilot:dbvocab -- --env-file <path>/.env   # stage 3 → out/db-vocabulary.json
npm run pilot:deadcode     # stage 2b → dead exports, AFTER the reconcile closes
node .claude/charpilot/record.mjs --emit-tests test/characterization --env-file <env>
node .claude/charpilot/verify-generated.mjs        # stage 5 → out/quarantine.json
node .claude/charpilot/determinism.mjs --env-file <env>   # stage 4 → out/determinism.json
node .claude/charpilot/coverage.mjs --coverage-dir <dir>  # stage 6 → out/coverage.json
```

`out/` is gitignored: every file in it is regenerable, and `baseline.json` is only
valid for the commit it was recorded at (it stores the sha and dirty flag).

`proposals/` is **tracked**. Proposals are hand-authored derivations — the one
artifact in this pipeline that cannot be rebuilt by running something. One file
per function; `validate.mjs` reads them all.

---

## Stage 1 — `baseline.mjs`

Runs the **existing** suite and records it green, with istanbul coverage, before
anything is touched. Every later claim is a delta against this file.

**Exits non-zero if the suite is not green.** A baseline recorded over a red suite
is not a baseline.

Default run does `npm ci --dry-run` to detect lockfile drift; `--install` does the
real `npm ci`. This ordering is deliberate: an install can silently destroy the
suite you are about to measure. Installing with `--legacy-peer-deps` broke 236
test files on another service, and it was caught only by re-running `npm ci` and
comparing — had the run continued, every new test would have been counted against
a denominator that no longer matched the repo.

It also records per-file **istanbul arm and function denominators** out of
`coverage-final.json`. That is the half of the arm data that only exists after
instrumentation, and stage 2 reconciles against it.

Recorded on this service:

```
suite      287/287 tests green in 31 files
statements 79.33%  (1851/2333)
branches   68.11%  (1034/1518)
functions  78.37%  (395/504)
lines      80.08%  (1790/2235)
```

### Why istanbul, not v8

v8's branch denominator grows as tests are added, so the percentage moves for
reasons that are not the work — you cannot ratchet against a moving denominator.
The pilot uses its own `vitest.charpilot.config.mts` so switching providers does
not disturb the v8-computed thresholds in `vitest.active.config.mts`.

---

## Stage 2 — `scan.mjs`

ts-morph walks the AST for the function list, its decision points, and — the part
a bare function list is missing — an **entry recipe**.

### The entry recipe

ts-morph tells you `toGeminiContents` exists; it does not tell you how to call it.
Every function gets `entry.reachable`:

| kind | reachable | meaning |
|---|---|---|
| `import-named` / `import-default` | yes | `import { f } from "<module>"` |
| `import-named-property` | yes | exported object literal — call `svc.method()` |
| `class-method` / `class-static` | yes | ctor params recorded so stage 4 can build one |
| `nested` | no | callback / returned closure — drive its enclosing call |
| `call-argument` | no | argument at module scope — runs when its call runs |
| `module-private` | no | top-level but unexported — drive a caller in the module |

A function list is not a work list. On this service **107 of 498 functions
(21.5%) can be invoked at their own id**, holding 498 of the 1505 arms. The other
391 are reachable only through a caller — stage 4 targets the first set and
reaches the second through it.

### Arms

Two artifacts, both needed: the AST gives the arm *list* (kind, line, owning
function) before you run; istanbul gives the *denominator* after instrumentation.
`scan.mjs` reconciles the two and prints per-file drift.

```
arms       ast 1518 vs istanbul 1518 — 100% match, 0 files drift
functions  ast  504 vs istanbul  504 — 100% match, 0 files drift
```

Getting there forced five corrections into the model, all worth keeping:

- **Module-scope arms.** A top-level `const x = a ?? b` or a class-property
  initializer has no owning function, but istanbul still instruments it. Reported
  under `moduleScopeArms` — they run at import time and no test drives them
  directly.
- **Parenthesized chains.** `(a || b) && c` is 3 arms, not 4. Parens are not
  nodes in the tree istanbul instruments.
- **Transpile artifacts.** A TS `enum` downlevels to `X || (X = {})` — 2 extra
  arms *and* 1 extra function (the IIFE). Counted so the denominator closes, and
  labelled `transpile-artifact` so it is never a target: no test can cover arm 2.
  Ambient `declare global { namespace … }` emits no runtime code, so istanbul
  never sees it and neither do we.
  **The arms are vitest-major-dependent, the function is not.** Probed under
  three runners with the provider pinned to each: 2.1.9 and 3.2.4 give an enum
  2 arms, 4.1.10 gives it 0, and a namespace keeps its 2 under all three. The
  same boundary moved class fields: under vitest 4 a class with an instance
  field and no constructor gets **no** synthesised constructor, whatever the
  tsconfig target says, so `downlevelsClassFields()` is gated on the major too.
- **Bodyless functions.** `abstract` methods and overload signatures are type
  surface — no runtime code, nothing to invoke, not counted.
- **`catch` is the mirror case.** A genuine decision point that istanbul does
  *not* instrument. Counted in `arms.ast`, excluded from `arms.istanbul`.

---

## Stage 2a — `verify.mjs`, the cross-check

The scan's claims are derived from AST shape, and AST shape is a guess about
runtime until something imports the module and looks. `verify.mjs` generates a
throwaway spec from `scan.json`, runs it through vitest — same TS transform, path
aliases and `test/setup.ts` mocks stage 4 will see — then deletes it.

It checks **both directions**, because verifying only the positives proves nothing
about the size of the work list:

- **Positives** — every `reachable: true` recipe must resolve to something with
  `typeof === "function"`: the named export, the default, the object property,
  the class `prototype[member]`, the static. **107/107**, covering 498 arms.
- **Negatives** — every `module-private` claim must genuinely not be on the
  module's export surface. A trailing `export { f }` exports without an inline
  modifier, and such a function would be dropped from the work list with nothing
  downstream noticing. **0 false negatives of 58.**

Exits non-zero on either. Two real bugs came out of it, neither visible from the
AST alone:

1. **An arrow passed as an argument was claimed as a named export.** In
   `export const S = z.object({ … () => {} })` the arrow *sits inside* an exported
   declaration but is not its value, so the recipe resolved to an object. Fixed by
   requiring the function to be the declaration's actual initializer (seeing
   through parens and `as`/`satisfies` casts), and by adding the `call-argument`
   kind for the 8 functions in that position.
2. **Vitest's mock proxy throws on undefined exports.** `test/setup.ts` mocks
   `@/utils/logger`; reading a name that mock does not define raises rather than
   returning `undefined`, and one such read aborted the whole run. Every module
   read is now guarded, and a module that cannot answer is reported as
   `mocked-in-setup` — a fact about the harness, not about the scan.

The second is a standing warning for stage 4: **the global mocks in
`test/setup.ts` shadow real modules.** A recorder that runs under them records the
mock's behaviour, not the service's.

### What is still not cross-checked

The 272 `nested` and 8 `call-argument` classifications are correct by definition
(not exported, cannot be imported), but nothing has proven each is genuinely
reachable *through* its caller. That is stage 4's problem — it is exactly what the
boundary plan has to solve.

---
## Stage 3 — the agent's stage

Stage 3 is where the measured difference lives, so the machine's role is
deliberately narrow: **build the brief, then judge what the agent wrote.** It
never proposes a value. A tool that derives the input *and* consumes it buys
~0.015 arms per test; this split is the reason for the whole pipeline.

### The units, and why they took three tries to get right

Coverage is counted in three different things, and conflating them produced most
of the wrong numbers in this project's history:

| unit | what it is | count here |
|---|---|---|
| **function entry** | "was this invoked at all" — every function has exactly one | 504 · 108 never invoked |
| **decision point** | one fork in the source: an `if`, a ternary, a `??` chain, a `switch` | 801 |
| **side** | one istanbul branch location — what the percentage is computed from | 1518 |

An `if` is **1 decision point with 2 sides**, even with no `else` written. A
`&&`/`||`/`??` chain is 1 point with one side per operand — `a && b && c` is
three. Only a parameter default is genuinely 1:1.

An **input is written per decision point** (that is what the condition is), but
**coverage moves per side**. One call takes exactly one side of each point it
passes through, so a point with both sides uncovered needs two calls. That is
why 484 uncovered sides group into 424 points, and why 336 proposals close 462
sides.

### `worklist.mjs` — the brief

Joins `scan.json` to the branches istanbul actually instrumented, so the brief
names **which side of each point is still uncovered**, not just which points
exist. Matching is by `(file, type, line)` then source order — safe only because
the stage 2 reconcile closes exactly, and anything that fails to join is
reported rather than dropped.

The script **exits non-zero if its uncovered-side count does not equal the
baseline's**. Without that assertion a silently dropped join looks like
progress: fewer sides in the worklist reads as less work, not as lost work.

### Reaching what you cannot call

107 of 498 functions can be invoked at their own id. The other 391 are
callbacks, closures, module-private helpers and members of unexported classes.
The first version of this file called them *"no direct input by design"*, which
was wrong — they are developer-written functions with real branches and they all
need covering. The input simply belongs to a **caller**.

So the scanner resolves a **driver** for every one of them, transitively:

| via kind | meaning |
|---|---|
| `through-caller` | a reachable function encloses it |
| `through-chain` | two or more hops out, settled to a fixpoint |
| `through-member` | a **private** member — drive the public method that calls it |
| `through-class-holder` | a public member of an unexported class held by an exported binding (`export const redisCache`) |
| `through-reference` | module-private, called by a reachable function |
| `trigger` | nothing in this repo calls it — a framework does |

That last kind matters. Express invokes a route handler, winston invokes a
formatter, Zod invokes a refinement. No call-graph pass can find those, so they
get a **named trigger** (`http-request`, `log-call`, `schema-parse`,
`process-signal`, `timer`, `module-import`) plus an instruction for firing it.
After this, **0 functions are unresolved** — the earlier "31 undriveable sides"
turned out to be 11 framework-triggered and 20 ordinary work behind
`server.start()`.

Every proposal covering such an arm must **declare its driver** in `via`, and
the validator errors if that disagrees with what the scan resolved. "No own
entry" can no longer be waved past.

### Two lanes

`unit` and `integration`. The integration lane is the 21 sides reached only
through a booted app — `server.start()` binds a port, connects Redis and
installs signal handlers — so stage 4/5 can run or skip it on its own and report
coverage with and without.

### `validate.mjs` — the guard

It cannot check that an input is *correct*; only the stage 4 run can. What it can
do is refuse the failure modes that destroy the exercise while looking like
success:

| broken input | rejection |
|---|---|
| value with no `from` | must cite the arm and file it came from |
| an `expected` value | not allowed — the machine records the output in stage 4 |
| invented `armId` | not an uncovered arm in the worklist |
| citation to a missing file | `from.evidence` points at nothing |
| args short of the driver's arity | counted against the **driver**, not the nested function |
| a `reaches` label that is not a real side of that arm | silently drops the side from the accounting |
| a prose `construct` with no executable `build` | stage 4 cannot construct the value |
| a live boundary with no `mock` | stage 4 cannot apply the answer |
| a boundary outcome filed under `setup` | belongs in `boundaries[…].mock` |

The missing-file check matters more than it looks: a citation pointing at nothing
is worse than no citation, because it reads as checked.

### `ledger.mjs` — the exit condition, made checkable

Stage 5's rule is *"every side has an input, or a written reason why it cannot"*.
That was prose in `BLOCKED.md` plus a count in a report until this existed. The
ledger reconciles three sets at **side** level — proposed, blocked, uncovered —
and fails on an unaccounted side, a side claimed by both, a stale blocked entry,
or a proof pointing at a missing file.

`BLOCKED.md` entries are therefore fenced and machine-read, one per **side**,
in three categories that are not the same kind of thing:

| category | meaning | what to do |
|---|---|---|
| `data-blocked` | reachable in principle; staging has no such row | a seed or a stub away — `fix:` says which |
| `code-dead` | no input reaches it in **any** environment | a defect: delete it |
| `needs-seam` | needs a production change | a decision, not test work |

Only `data-blocked` has anything to do with staging.

### The output has to be a program, not a document

This was found by building stage 4 and pointing it at a "finished" stage 3: only
**15% of proposals were executable**. 179 `construct` values were English
sentences ("an Express Response double that records status/json"), 1223 boundary
answers were prose, and 81 `setup` entries were boundary answers filed in the
wrong field.

So every prose field now has an executable sibling, the prose kept as the
auditable reading:

```
args[].construct  (prose)  →  args[].build       a JS expression
boundaries[].behaviour     →  boundaries[].mock  { kind: resolves|rejects|returns|throws|notCalled|passthrough|value|spy, value|build }
setup[].state              →  setup[].apply      { env } | { call } | { module } | { manual }
```

`spy` earned its own kind: for a logger or a fire-and-forget writer the
**observable is the call itself**, and naming that pattern converted ~600
boundaries in one pass.

The 179 English `construct` values collapsed to **eight typed factories** in
`fixtures/doubles.ts` — 65 CallbackHandler doubles, 46 Express Response, 26
usage recorder, plus the two decorator appliers — written once instead of
described 179 times.

### A worked example

`getClientIp`, 7 decision points, 14 sides, none covered, no boundaries. Five
inputs close all seven. The one that shows what "read the input off the arm"
means:

```jsonc
{
  "reaches": { "src/utils/helpers.ts#88:if:0": "else" },
  "args": [{
    "value": { "headers": { "x-forwarded-for": " , 203.0.113.9" }, "ip": "198.51.100.4", "socket": {} },
    "from": {
      "arm": "src/utils/helpers.ts#88:if:0",
      "evidence": "src/utils/helpers.ts:86",
      "reading": "the arm takes `ips[0].trim()` and tests it, so a leading blank entry is the documented way to make it falsy"
    }
  }]
}
```

A leading empty entry is the only shape that takes the `else` at line 88 while
still taking the `then` at 84. That is not guessable from the type — `req: any` —
and not something a generator emits. It is read off the condition.

Worth recording while looking at it: **`getClientIp`'s only call site is
commented out** (`src/server.ts:179`). It is dead code today. Characterizing it
is still correct — that is what pins behaviour before a change — but it is the
kind of fact a stage-3 pass surfaces and a coverage percentage never would.

### Where stage 3 landed

Numbers come from `npm run pilot:status`, which is the only place they should
come from. Reproduce rather than trust this paragraph.

```
uncovered SIDES    484
  with an input    462
  with a reason     22   (all code-dead)
  UNACCOUNTED        0

proposals          336 across 192 functions
validate           0 errors, 0 warnings
reconcile          1518/1518 sides · 504/504 functions
```

## How this actually went — the corrections, and what they cost

Stage 3 was declared finished three times before it was. Each time a person
asked where a number came from, and each time the number was wrong. The record
matters more than the result, because the failure mode was consistent.

**The unit was wrong, twice.**
"1518 arms" was really 1518 *sides*; "424 arms" was 424 *decision points*. Then a
harder correction: the work list was **arm-driven**, so a function with no
decision point had no row — **77 uncovered functions were invisible** until
someone pointed out that a function has at least one branch by virtue of
existing. Function-entry units were added; the work list grew from 122 to 146.

**A gap was relabelled as a design property.**
302 sides in functions with no own entry were reported as *"no direct input by
design"*. They are developer-written branches that must be covered; the input
just belongs to a caller. That sentence was doing the work of an excuse. Driver
resolution was built because of it, and 313 of those 344 sides turned out to have
a nameable driver.

**Every number derived in prose was wrong; every number printed by a script was right.**

| claimed | actual | mechanism |
|---|---|---|
| "all 181 api_key rows have `baseUrl`" | 119 of 181 | read a `DISTINCT jsonb_object_keys` **union** and reported it as per-row |
| "36 VERTEXAI / 132 OPENAI" | OPENAI 131 · VERTEXAI 39 · ANTHROPIC 11 | summed a `LIMIT 50` grouped table by eye |
| "20 label drift" | 3 | subtracted 9 from 29 without re-running |
| "123 unaccounted" | 87, then 107, then 47 | quoted a stale snapshot as current |
| "3 data-blocked" | 1 cause, 3 sides | mixed causes and sides in one sentence |

The errors were **one-directional**: every one made the state look better than it
was. That is not arithmetic noise. The fix was structural, not attitudinal —
`status.mjs` became the single source, prints the mtime of its own input, and
ends with *"This is a SNAPSHOT. Quote it, do not remember it."* If a number is
not in that output, it does not belong in a report.

**Two of the agent's own proposals were invalidated by its own findings.**
A later pass proved `buildProviderConfigType` has no `return null` past line 146,
which made `if (!providerConfig)` dead — and two proposals had been written
against exactly that unreachable state. Chasing one guard further showed a third
and fourth were affected. The right behaviour, and what happened, was to record
the contradiction rather than quietly edit the proposals so they stopped
disagreeing.

**Stage 3 was "done" at 0 validation errors and 15% executable.**
The gate only checked *provenance* — does every value cite its source. It never
asked whether the value could be **run**, so 336 proposals passed green while
being undeliverable. Same shape as the numbers: the check measured what was easy
to check.

### Why the back-and-forth is the thing to fix, not the thing to record

The rounds of question-and-answer above are not colour. They are the reason this
is not yet a skill.

Picture the automated version: stage 2 scans a service with 1,000 branch sides,
the agent delivers 100 inputs with notes about which DB rows need changing — and
then a person spends ten rounds asking *"where did that number come from"*,
*"why is that undriveable"*, *"did you actually fix it"*. That is:

1. **inefficient** — the questions are the same every time
2. **time-consuming** — each round is a context switch for a human
3. **not automatable** — a conversation has no exit code

So every question that changed the outcome has been turned into a **check with an
exit code**. `npm run pilot:gate` is the whole conversation, compressed:

| the question a person asked | now the check | what it fails on |
|---|---|---|
| are these artifacts from this commit? | `artifacts` | baseline sha ≠ HEAD |
| was the baseline green? | `suite-green` | a baseline over a red suite |
| "how many functions, how many branches" | `units` | the worklist not reporting all three units |
| "no direct input by design *how*?" | `drivers` | any function left unresolved / needs-seam / at-import |
| "20 label drift?" | `validate` | a `reaches` label that is not a real side |
| "so did u fix the step 3?" | `validate` | any error or warning at all |
| "how many have input, how many not?" | `ledger` | one unaccounted side |
| "is stage 3 done?" (it was 15% executable) | `executable` | any prose-only `construct` / `mock` / `apply` |
| "did u setup downstream to hit staging?" | `reachability` | an address defaulting to localhost |
| does a pair echo its own plan? | `no-echoed-plan` | a harness failure recorded as behaviour |

```
$ npm run pilot:gate -- --stage 4

  ✓ artifacts      baseline at a80f00c9
  ✓ suite-green    287/287 tests
  ✓ reconcile      1518 sides · 504 functions, 0 drift
  ✓ units          498 functions · 1518 sides · 108 never-invoked entries
  ✓ drivers        every no-own-entry function has a driver or a named trigger
  ✗ validate       271 errors, 0 warnings
      asked: "did u fix stage 3? (does every proposal pass its own gate?)"
      next:  node .claude/charpilot/validate.mjs and work the list
  ✓ ledger         462 with an input · 22 with a reason · 0 unaccounted
  ✗ executable     115 boundaries · 156 setup entries are prose only
  ✗ reachability   redis, zipkin fall back to a localhost default
  ✓ no-echoed-plan 40 observed, 0 harness failures
```

Every failing line carries the **next action**, not a percentage to interpret.
That is the difference between "explain this to me" and "run this".

It caught a bug in itself on the first run: `no-echoed-plan` went green against a
**stale** `behaviour.json` written before harness-error separation existed. Same
class of bug as every wrong number in this project — a real check reading a
stale input. Re-running the recorder took it from 17 undetected harness failures
to 0.

### What is still manual, and therefore still a risk

Being honest about the residue, because these are the questions the gate cannot
yet answer:

- **Is an input semantically right?** ~~Nothing verifies that an input actually
  reaches the side it claims until stage 5 measures coverage.~~ **Closed at
  stage 4** — the record pass is instrumented and every row verdicts its own
  `reaches` claims as it is recorded. See *Stage 4 verdicts its own claims*
  below. What remains is that the ledger still only checks a claim is
  *well-formed* before the run.
- **How much work is in flight?** "Of the 107 unaccounted, how many are in
  progress" needed a person, because proposals carry no owner or status. A
  `status: draft|recorded` field would fix it.
- **How many blockers, really?** `BLOCKED.md` counts sides; a reviewer counts
  causes. Reporting "3 data-blocked" when it was one row and one flag caused a
  round of confusion by itself. The ledger should group by cause as well as
  count sides.
- **Did the report quote the script?** `status.mjs` is the single source, but
  nothing forces a written summary to use it. That one stays a discipline
  problem, and the only mitigation is that every figure in this file is
  reproducible by re-running the command next to it.

### What supervision was actually required

Not code review. The interventions that changed the outcome were all of one
kind — **asking what a number meant**:

- "how many functions, how many branches" → surfaced the sides/points/functions confusion
- "no direct input by design *how*?" → killed the excuse, produced driver resolution
- "20 label drift?" → 3, and 25 genuinely missing sides behind it
- "at the smallest function scope … it have at least 1 branch" → the 77 invisible functions
- "so did u fix the step 3?" → no, and the honest answer was 271 errors still standing
- "did u setup for all downstream call to hit staging" → Redis silently defaults to `localhost`, which from a laptop is *this machine*, not staging

Each one took a single question and produced a structural fix. None of them
required reading the code. The lesson for anyone running this again: **ask where
a figure came from, and if the answer is not "a script printed it", treat it as
suspect.**

## Stage 4 — record mode

Two scripts exist and both earned their place by finding something.

### `preflight.mjs` — what can this machine reach, and what must it never call

Two different questions, both answered *before* recording:

**reachable** — a DNS + TCP check per address. If an address is unreachable from
here, a failure against it is a **harness** failure, and recording it as
behaviour is the worst outcome available.

**forbidden** — metered or side-effecting regardless of reachability, and never
dialled at all. Confirming a metered endpoint is up is not worth a billable
request.

Run against staging's env, from a laptop:

```
✓ postgres            34.143.159.14:5434          reachable
✓ langfuse-ingress    langfuse.qode.world:443     reachable   (119 of 181 rows)
✓ langfuse-cloud      cloud.langfuse.com:443      reachable   (the other 62)
✗ redis               localhost:6379              UNREACHABLE
✗ zipkin              localhost:9411              UNREACHABLE
⊘ openai / anthropic / aiplatform                 forbidden — metered
⊘ hooks.slack.com                                 forbidden — posts to a real channel
```

Langfuse is a public ingress, so it needs no adjustment. The dangerous ones are
Redis and Zipkin: staging's `.env` sets **no** `REDIS_HOST`, so `env.ts:17`
defaults it to `localhost` — which from a developer machine is not an
unreachable cluster address, it is **this machine**. Had a local Redis been
running, a passthrough would have quietly succeeded against the wrong instance
and local behaviour would have been recorded as staging behaviour. An
unreachable address fails loudly; a wrong-but-reachable one does not.

Slack is default-deny rather than unreachable-deny: `env.ts:122` carries a
**hardcoded webhook URL as a Zod default**, so any passthrough to
`sendSlackNotification` posts to a real channel.

### `record.mjs` — and the first thing it got wrong

The first real run reported 40 recorded pairs. Seventeen of them were lies:

```
threw: Cannot find module '@/prisma/client'
threw: ZodError — DATABASE_URL Required
```

Those are the harness failing, not the service behaving. The recording config
deliberately does **not** load `test/setup.ts` — that file mocks prisma, ioredis
and the loggers, and a pair recorded under those mocks would describe the mocks —
but dropping it also dropped the module resolution it happened to provide. Tests
written from those rows would have pinned *"throws ZodError: DATABASE_URL
Required"* as this service's behaviour.

So the recorder now **classifies a throw before recording it**. A
module-resolution or env-validation failure is written as `harnessError`, the row
is marked `invoked: false`, and it is never counted as behaviour. The tsconfig
path aliases are mirrored explicitly in `vitest.record.config.mts`.

Genuine pairs from the same run, for contrast:

```
normalizeLocation("  Hà Nội City  ")     →  "hanoi"
chunk([1..7], 3)                          →  [[1,2,3],[4,5,6],[7]]
removePrefixes("Senior Back-End Engineer") →  "Back End Engineer"
getClientIp({headers:{"x-forwarded-for":"203.0.113.7, 70.41.3.18"}}) → "203.0.113.7"
```

Each of those is an observation. None of them was predicted anywhere in stage 3 —
and that is the rule the whole pipeline turns on:

> the proposal's `boundaries[].behaviour` is a **plan** for what to observe.
> Stage 4 must **overwrite** it with an observation, never confirm it. A pair
> that merely echoes the plan proves nothing.

### Stage 4 verdicts its own claims — at record time, not two stages later

`reaches` says which SIDE of an arm an input takes. That is the one thing a
proposal asserts about itself and cannot check, and until this existed the only
thing that checked it was **stage 6**: a full record → generate → measure cycle,
~30 minutes, to be told what the recording run already knew. The last run
measured **406 claims, 303 verified, 103 FALSE** — a 25% miss rate, every one of
them discovered two stages downstream of the run that produced it. That delay was
the single biggest cost in the pipeline.

So the record pass is instrumented. Each row snapshots istanbul's branch
counters immediately before its subject call, diffs them once the row settles,
and reports on itself:

```jsonc
"movedBranches": { "src/decorators/cache.decorator.ts": { "11": [0], "12": [0,1] } },
"armsMoved":     [{ "armId": "src/decorators/cache.decorator.ts#211:if:0", "sides": ["then"] }],
"claimVerdicts": [{ "armId": "…#61:cond-expr:0", "side": "whenTrue", "verdict": "verified" },
                  { "armId": "…#61:cond-expr:0", "side": "whenFalse", "verdict": "false" }]
```

Five things about it are load-bearing:

- **Snapshot and diff only — never wrap.** The member-wise proxy attempt below
  broke five rows by destabilising object identity. This reads integers: no
  wrapper, no new `await`, nothing the row did not already do. Measured
  identical row counts before and after instrumentation.
- **The counters are in-process, under vitest's own name.**
  `@vitest/coverage-istanbul` keeps istanbul's ordinary shape on
  `globalThis.__VITEST_COVERAGE__` (not `__coverage__`), the counters increment
  live inside the worker, and a `vi.resetModules()` re-import does **not** reset
  them — the instrumented preamble keeps the existing object when the source
  hash matches. So they accumulate across rows and a per-row diff is the only
  thing that attributes movement.
- **The line numbers have to be remapped, and this is the part that silently
  fails.** The in-process map is keyed to the **transformed** source: esbuild
  strips types and comments first, so `cache.decorator.ts`'s branches sit at
  lines 11, 17, 35 … there and at 34, 42, 61 … in the file the AST scan read.
  Joining on the raw numbers matched **nothing** — 19 of 19 claims came back
  "no matching istanbul branch", which reads as 19 broken proposals and was one
  broken join. The provider stores vite's source map on the coverage entry as
  `inputSourceMap` (it is what the final report is remapped through), and
  `node:module`'s `SourceMap` applies it with no dependency. Checked branch for
  branch against the provider's **own** remapped report — 78 branches across
  five files, identical ids, identical lines. That equality is the reason to
  trust it and the first thing to re-check if the join ever drifts.
- **The mapping is `armjoin.mjs`'s, not a second copy.** The recorder hands over
  the branch map its worker saw (`hitIndexFromSkeleton`) and gets back the index
  stage 6 joins against; `measureArms` and `claimedSides` moved there too, and
  `coverage.mjs` imports them. A second mapping is a second thing to keep true,
  and a claim that reads as checked and is not is this project's recurring bug.
- **Two windows, one verdict.** A snapshot also opens at the top of the row,
  before its harness imports, seeds and precondition calls. The verdict is
  decided on the SUBJECT window only — an arm the arrangement moved is never
  credited to the input — and the arrangement window exists to say *why* a claim
  came back false. That distinction found a class stage 6 cannot see:
  `queuemanager-zero-env-limits-fall-back-to-literals` claims three
  `env.X || literal` arms in `RequestQueueManager`'s constructor, and its
  recorded outcome is `TypeError: Class constructor cannot be invoked without
  'new'`. The arms ran — during the **import** of the module-scope singleton.
  Stage 6 measures the whole file and calls that verified; the row's subject
  moved nothing at all.

**A false claim here is a stage-3 defect to repair, not a failed run.** The
observation is real; the ARM it is filed under is wrong. So the row is kept, the
count is printed, and the exit code is unchanged — stage 6 still fails on these,
this is the same finding earlier.

#### Measured against stage 6, which is the oracle

```
stage 6's 103 false claims        103 also FALSE at record time   100% agreement
stage 6's 303 verified claims     275 also verified                90.8%
                                   28 FALSE at record time
                                        21  another recorded row moved that same side
                                         6  moved by this row's arrangement, not its subject
                                         1  unexplained
```

The 28 are not a disagreement about the join — they are a **stricter question**.
Stage 6 asks "did any test in the suite hit this side"; a row asks "did *I* hit
it". `cache-decorator-get-throws` claims both `whenTrue` and `whenFalse` of one
ternary; one call takes one side, and stage 6 credited it with both because a
sibling row took the other. Per-row is the question `reaches` was written to
answer.

The one unexplained claim is the honest residual, and it is the constraint
working as intended: `recordUsage` hands its body to `executeInBackground`, so
the arm at `usageLog.service.ts:18` evaluates after an `await` the row never
waits on. Catching it would mean awaiting something the row did not — which is
how a recording stops describing the program.

### Where stage 4 landed

```
336 proposals
  269 runnable   =  218 recorded  +  51 blocked egress
   67 need a hand-built harness (each with a written reason)
  pending 0 · harness failures 0 · did not settle 0
  envProvenance bc4a107a4bb0   (staging.env, values never stored)
```

Two identities have to hold, and both do: `recorded + blocked = runnable`, and
`runnable + unrunnable = proposals`. Three consecutive runs produced identical
totals, which is the first evidence that the recorder is deterministic rather
than merely finishing.

### The class of bug that cost the most: a shared artifact with no owner

Not one bug — four, all the same shape, and none of them caught by the twelve
gate checks, because every check reads those same artifacts and trusts them.

| the artifact | what happened |
| --- | --- |
| `.record-cache.json` | keyed on a hash of the harness, stored at ONE fixed path. Two runs with different flags (`--row-timeout 8000` vs the default) computed different versions, so each opened the file, declared it stale, discarded it, and half-wrote it. The cache path now carries the version, so a mismatched cache is never opened instead of being clobbered. |
| the env file | `harnessVersion()` hashed the script, the doubles and the vitest config — but NOT `--env-file`. `QUEUE_TIMEOUT`, `MAX_TIMEOUT_*`, `REDIS_HOST` and `SLACK_HOOK` are read by the arms under test, so the same input under two envs gives two different answers, merged row-by-row with nothing recording which row came from where. Env CONTENT is now in the hash and its digest is stamped in the artifact. |
| `record.test.ts` + `.record-result.json` | `spawnSync("npx", …)` shells through `npm exec`, so the chunk timeout's SIGTERM hit npm and the nested vitest survived. Every chunk rewrites the same spec and result path, so a survivor from chunk N can land its result after chunk N+1 starts — attributing one chunk's observations to another's rows. Now spawns `node node_modules/vitest/vitest.mjs` directly, plus a reaper for anything that still outlives the signal. |
| `totals.skipped` | summed three unlike things: rows needing a harness, blocked egress, and rows simply **not reached yet**. An unfinished run read as a completed classification. The tell was arithmetic — 268 runnable + 224 skipped is more than the 336 proposals that exist. Now three separate fields. |

The concrete cost: an orphaned driver loop, left running by a subagent that had
already died, spent forty minutes racing this session's own recorder over the
same four files. Every number reported in that window — 228, then 112, then 135
— was real for some process and wrong for the artifact.

> The rule this earns: **an artifact written by more than one process needs its
> identity in its NAME, not inside it.** A version field inside a file cannot
> stop a second writer; a versioned filename can.

### Two egress escapes, on opposite sides of the same guard

The guard was already default-deny. It still leaked twice, in ways that only
recording exposed:

**Before the call settled.** `anthropic-safeHandleLLMStart-non-error-throw`
recorded `threw: Error: 401 {"type":"authentication_error"}` after a **2098 ms
round trip to api.anthropic.com** — a real request, free only because the key
was invalid. Its proposal declares boundaries for `loggerV2`, `v4`,
`runWithRetry` and `env`, and nothing at all for the Anthropic client.

**After the call returned.** Sixteen rows returned a value while a blocked call
sat in their path. Slack is fire-and-forget, so the service swallows the failure
and returns normally — the pair reads as ordinary behaviour, but what it froze is
*"what this returns while Slack is down"*, and production has Slack up. Those
are now classified not-recordable, naming the endpoint.

One row needed a distinction neither case covers:
`anthropic-stream-with-abort-signal-and-null-stop-reason` returned cleanly, and
the guard tripped **after** it had settled. The returned value was computed
before the attempt, so it is sound — the **call list** is not. Marked
`egressAfterSettle` and reported on the gate's pass line, because demoting it
would throw away a good value and ignoring it would hand stage 6 an incomplete
call list as a complete one.

### Findings the recording produced that no reading would have

- **A proposal's stated reasoning is provably wrong.**
  `fromGeminiToolsResponse-part-with-non-string-text` argues the empty text block
  "is dropped by the `.filter(Boolean)` at 427". Recorded output:
  `{"content":[{"text":"","type":"text"}],"stop_reason":"end_turn"}`. Not
  dropped — `filter(Boolean)` tests the block *object*, which is always truthy.
- **Five `notCalled` boundaries were called.** Plan contradicted by observation,
  the highest-value class here: `combined-timeout-yields-undefined-result →
  HttpException`, `stream-resolver-rejects-row-with-empty-model-name →
  OpenAIModelV1`, `getInvokeAction-vertex-row-with-numeric-temperature →
  VertexAIModelV1`, `redis-connect-called-twice → Redis`,
  `redis-connect-disabled → Redis`.
- **The 15 private-instance-field skips are a stage-3 defect, not a harness gap.**
  Their `setup.state` claims "REDIS_ENABLED=true, connect() awaited, and the
  client's 'connect' event emitted"; `setup.apply` carries only
  `{env: {REDIS_ENABLED: "true"}}`. The directive is strictly weaker than the
  state it claims, so injecting `this.redis` alone leaves private `isConnected`
  false, `get` early-returns, and the row records a **different arm**. A
  mis-attributed pair is worse than a skip.
- **Object-boundary observation is a dead end, recorded as one.** Member-wise
  proxying captures the ~60 `loggerV2`/`logger`/`prisma` calls that currently go
  unobserved, but a fresh wrapper per property read destabilises object identity
  and every `Set`-based cycle guard in the recursive walkers loops forever — five
  clean rows stopped settling. Reverted. **Consequence for stage 6: for an
  object-shaped `spy` boundary, an empty call list means "not observed", not "not
  called".** The fix is memoising the wrapper per `(object, key)` in a `WeakMap`.

### A ruling can stay right after its reason goes false

Both the redis and zipkin rulings say staging's `.env` "sets no" their host. It
now sets both, and they are unreachable for a different reason: cluster-internal
DNS that does not resolve off-cluster. The conclusion (mock) survives; the stated
premise does not.

Rewriting a ruling attributed to someone else is not the fix. The gate now prints
today's evidence directly beneath each one:

```
ruled: redis → mock — staging's .env sets no REDIS_HOST, so env.ts defaults it to localhost…
by:    repo owner, 2026-09-03
today: redis: preflight says unresolvable · staging.env DOES set REDIS_HOST
```

The reader compares instead of trusting. Two more gate defects of the same
"reads as checked" family were fixed alongside it: the dangling-ruling warning
compared only against the checks the *current* stage runs, so all three
reachability rulings were flagged as dead config on every stage-3 run — a gate
that cries stale about valid config is one people learn to scroll past. And
`recorded-coverage`'s next-action still read *"the recorder cannot yet apply
boundary mocks, apply setup, or invoke through a driver"* long after it could,
so the gate was printing an action already done.

### Still open

- **Redis and zipkin resolve to cluster-internal addresses** unreachable from
  this machine, so both stay mocked — which is what the proposals already
  specify, and what the recorded rulings decided.
- **The appId path needs a config toggle.** Staging's single `default_model_key`
  row has `enable: false`, and its id is `8fde956b-9df0-463b-95bd-6822d52f6b65a`
  — **37 characters, groups 8-4-4-4-13, not a valid uuid**. The column is
  `String @id @default(uuid())` so a hand-inserted typo was accepted. Any input
  using a "corrected" 36-character form silently misses the row. Flipping
  `enable` is a write to shared staging config and changes routing for anyone
  using that appId, so it is a decision, not a step.
- **118 of 336 are unrecorded, in two unlike halves.** 67 need a hand-built
  harness (39 manual setup, 15 private instance field, 8 trigger, 3 db write, 2
  captured-callback). The other 51 are a **stage-3 defect**: the proposal reaches
  a default-deny endpoint it never declared a boundary for — 21 Anthropic, 6
  OpenAI, 5 Slack, 17 prisma/redis. The fix is to add the boundary, not to open
  the endpoint.
- **Live provider capture is unauthorised and unrun.** Staging's env carries no
  provider keys at all; every credential lives in an `api_key` row, and every
  proposal passes `"charpilot-service-key"`, which matches none. Capturing real
  responses means **66 billed calls** (37 OpenAI, 28 Anthropic, 1 Vertex). That
  is metered spend against live endpoints, so it is a decision, not a step.

## What CI can check, and what it cannot

`gate.mjs` is a **local** command and has to stay one. Sixteen of its
seventeen checks read `.claude/charpilot/out/`, which is gitignored — a CI
runner has a checkout with no baseline, no scan and no `behaviour.json`, so
those checks are not merely unwired there, they are unrunnable. Committing the
artifacts to make them run would be worse: `freshness` ties every one of them to
the `src/` on disk, and a recorded artifact is a staging observation, not a
source file.

What a runner does have is the **committed suite** and its **committed
manifest**. So CI enforces exactly three things (`.github/workflows/unit-tests.yml`):

| step | what it catches |
|---|---|
| `npm ci` | a dependency tree that moved since the pairs were recorded — without it "run it twice" proves nothing |
| `npm run pilot:integrity` | a generated test edited after emit |
| `npm test`, then `npm test -- --project characterization` | a recorded value that differs run to run |

**The integrity check is the one that had no owner.** Every emitted file says
`do not hand-edit` in its first line, and nothing enforced it. That line is the
whole contract: an assertion in these files is trustworthy *because a run
produced it*, so a hand-typed expected value wears the same header as a recorded
one and reads as recorded in review. It is this pipeline's version of the
committed `actual.json` that qode-characterize refuses. `--emit-tests` now
stamps a sha256 per file into `emitted.json`, and `emitted-integrity.mjs`
compares them; a manifest with **no** hashes fails, on the same reasoning as the
determinism verdict living on the row — an absent field means the file was never
checked, not that it is unedited.

**The second run is not redundant.** `determinism.mjs` double-observes at record
time, and `verify-generated.mjs`'s own header names the case it cannot catch:
*"a value that differs run to run and that determinism.mjs did not catch,
because two runs happened to agree."* Only re-running the committed suite catches
that one, and the failure mode it prevents is specific — a value carrying per-run
identity passes once, fails at random, reads as flaky, and gets muted, which
silently removes real coverage. Second run is the characterization project only:
re-checking the hand-written suite twice buys nothing.

`verify-generated.mjs` deliberately does **not** run in CI. It quarantines a
failing test, and it is only ever correct to do that at generation time — a
failure later is production behaviour changing, which is the entire point of the
suite.

**Not gated on a coverage number, by borrowed advice.** qode-characterize's step
8 says a floor invented before you know what is achievable gets argued down the
first time it blocks someone. `coverage-ratchet` is a gate check here because
1449/1449 is measured rather than guessed — but it stays local, and a second
service starting from zero should not inherit it.

## Rules for the stages not yet built

Written down now because both are load-bearing and both are cheap to skip.

1. **A recorder that produces nothing is a stop, not a shrug.** On a
   3,385-function service the recording lane stalled, no rule said what to do, and
   the agent wrote 572 tests whose every value came from running its own suite —
   then reported success, because no written rule had been broken.
2. **Every assertion cites the row it came from.**
   `// [recorded: arm4-provider-rejects]` is not decoration; it is what lets
   someone who was not there check the value is real.
3. **Stage 5 does not loop to 100%.** Some arms are provably unreachable. The exit
   is: every arm covered, **or** carrying a written reason why it cannot be. Dead
   arms are often the evidence of a defect — suppressing them to reach 100% pins
   the symptom and hides the bug.
4. **Staging only, never production.** Redact before writing a fixture, record
   once and replay (metered APIs bill per call), and stamp every fixture with its
   capture date, because staging drifts.


## ts-prune against the ts-morph pass — the measurement, not the argument

`deadcode.mjs` argues for ts-morph in its own header. That is a hypothesis, and
AI-5314 asks for it to be measured. `npm run pilot:deadcode:compare` runs both on
this repo, whose answer is known:

```
ts-prune findings, total            54
  of those, "used in module"        26    not dead - an export that could be local
  of those, unannotated             28
ts-morph dead exports               26
  of those, referenced only by tests 24

agreed dead      26
ts-morph only     0
ts-prune only     2    LlmRequestPayloadV1Combined · LlmRequestPayloadV3Combined
```

**ts-prune found two things ts-morph did not** - both unused type exports. That
is real value and the header's argument did not predict it. Against that: 26 of
its 54 findings are exports used inside their own module, which are not dead at
all, and it answers neither of the two questions this pipeline needs.

| what the pipeline needs | ts-morph | ts-prune |
|---|---|---|
| tells a commented-out call site from a live one | yes, `findReferencesAsNodes` | not applicable - it never resolves callers, only whether an export is imported |
| separates test-only references | yes, 24 of 26 | no - a test import is an import |
| carries the branch sides inside each export | yes - 51 sides, denominator 1518 &rarr; 1467 | no - name and line only |

The last row decides it. The denominator correction has to come from the same
pass that found the dead code, or it is unsourced. So ts-morph stays as the
pipeline's pass, and ts-prune is worth one run per repo as a second opinion on
type exports - which is what `pilot:deadcode:compare` is for.

## Every stage has a command

26 `pilot:*` scripts, in stage order, so a dev runs the sequence without
knowing filenames. Stages 1, 2, 2a, 2b, 5, 6, 7 and 8 need no credentials at
all; only stage 4 reaches staging.

```
pilot:stagingenv  pilot:baseline  pilot:preflight
pilot:scan  pilot:verify  pilot:deadcode  pilot:deadcode:compare
pilot:worklist  pilot:dbvocab  pilot:validate  pilot:ledger
pilot:record  pilot:determinism
pilot:emit  pilot:verify-generated
pilot:coverage  pilot:union
pilot:suppressions  pilot:review  pilot:harvest
pilot:mutate  pilot:mutants  pilot:mutants:write
pilot:gate  pilot:status  pilot:handoff
```

`pilot:gate` now runs 18 checks across stages 1-8, with three outcomes: `fail`,
`pass`, and `accepted` — a person ruled, and the ruling is reprinted every run.
Stage 7's `suppressions` and stage 8's `mutation` are the two newest.


## Arm ids are content-addressed now

`armId` is `file#line:kind:index`, so any edit above an arm moves it and every
artifact naming that id is wrong without saying so - a reference to an arm that
no longer exists reads exactly like a reference to an arm that got covered.
Measured in one session: **1,747 references remapped by a single one-line
comment**, 1,938 by a later pair, 13 of 29 blocked entries stale at once with
shifts of +8 to +56, and 6 false "contradicted" verdicts against entries that
were correct.

`scan.mjs` now mints a `stableId` beside every `armId`, hashed over what an arm
IS rather than where it sits: the enclosing function's name, the arm kind, the
arm's own source text, and its ordinal among identical arms in that function. A
comment above it changes none of those. Function ENTRY units get one too, keyed
on the function's name, kind and parameter names - 692 references name an entry,
and leaving them out made the checker report all of them as stale, which is a
checker nobody would keep.

Both ids ship. `armId` stays authoritative until every consumer reads
`stableId`, and the ledger makes a repair a lookup instead of a search:

```
stale armId  ->  stableId       (out/armids.prev.json)
             ->  current armId  (out/armids.json)
```

```sh
npm run pilot:armids       # report
npm run pilot:armids:fix   # rewrite the references
```

**Proved end to end.** One line inserted at `redis.service.ts:2`, re-scan,
`--fix`: 386 references repaired across 12 files. Line removed, re-scan,
`--fix`: 386 repaired back, and `proposals/` came out **byte-identical** to
before the experiment.

Two things it deliberately will not do. A reference whose `stableId` has no
successor means the arm's own text or its enclosing function changed - a real
code change, not a shift - and it refuses to guess. And a stale id inside
`out/` is reported separately, because a recorded snapshot is stale the moment
the source moves; the fix there is to re-run the stage, not to rewrite the file.

One collision hazard worth knowing: the first version of the entry digest used
name + kind + params and produced **107 collisions**, because a file holds many
anonymous callbacks with the same derived name and no parameters. A colliding id
is worse than a line-based one - it maps two different arms onto one entry - so
the digest carries a per-file ordinal. Current ledger: 1301 arms, 1301 distinct.
