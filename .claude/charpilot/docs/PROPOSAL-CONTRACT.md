# What a proposal is

Read this instead of reading `record.mjs`.

**Why this file exists.** Measured on run `20260914T080742Z`: the agent made
**236 calls reading pipeline source** — `record.mjs` 134, `validate.mjs` 72,
`ledger.mjs` 21 — across **279 distinct search terms**. It almost never asked
the same question twice, so this was never a caching problem; the schema was
simply written nowhere. That is 18% of every command in the run, and it buys no
coverage.

Every rule below is taken from `validate.mjs`'s actual refusals, so this
describes what is **enforced**, not what was intended. Where the two ever
disagree, `validate.mjs` is right and this file is a bug.

---

## Before the shape: ask the tools, do not reshape them

The same measurement, in the same run, one category over. **57 calls in run
`20260915T033521Z` ran a pipeline tool and then reshaped its output inline, or
parsed an `out/*.json` inside a heredoc** — a group-by written by hand because
the tool could not be asked for one, and `scan.json` filtered by file because
nothing said it need not be. Both questions are now arguments.

```bash
# how many uncovered units per file / per kind / per function — one call, no pipe
node .claude/charpilot/worklist.mjs --count-by file
node .claude/charpilot/worklist.mjs --count-by kind --file location.service
node .claude/charpilot/worklist.mjs --count-by owner.functionId --json

# which functions are in this file, and how do I call each one
node .claude/charpilot/recipes.mjs --file md5.ts
node .claude/charpilot/recipes.mjs --id 'src/utils/md5.ts:47:md5' --json
```

`--count-by` takes any field `--fields` takes, dotted paths included, and
composes with `--file` and `--all`. TSV by default, largest group first, so the
answer is the first line; `--json` when something downstream parses it. The
counts always sum to the item total — that is the `# N group(s), N item(s)` line
on stderr, and it is checkable.

**All four refuse rather than return an empty answer**, because an empty
grouping and a file with no uncovered arms look identical and only one of them
means stop:

- a `--count-by` field **no row carries** is refused by name, and so is one only
  *some* rows carry (`column` and `unit` exist on statement units only) — a
  grouping cannot be short by rows that had nowhere to fall.
- `--count-by` over an **empty work list** is refused: over no rows a wrong
  field and a wrong `--file` give the same answer.
- `--file` matching **no function** and `--id` naming one **the scan does not
  hold** are refused with what was asked for, printed back. A stale id is a
  right file with a wrong line; `npm run pilot:armids` repairs it.

There is no bucket, no `unknown` group and no default: if one of these exits
zero, the number it printed is a number about your repo.

---

## The shape

A proposal file is `{ "proposals": [ ... ] }` in
`.claude/charpilot/proposals/*.json`. Each proposal:

| field | what it is |
|---|---|
| `id` | unique; names the row in every later artifact |
| `functionId` | the function under test, `file:line:name` |
| `covers` | the arm ids this row is written for |
| `reaches` | per arm id, the side(s) it claims to reach |
| `via` | how the subject is entered |
| `invoke` | how the subject is called |
| `args` | the arguments, each with `value` or `build`, plus `from` |
| `boundaries` | what each downstream answers, when it may not be real |
| `setup` | state the row needs before the subject runs |

`boundaries` may also be declared once per file as `functionBoundaries` and
inherited; `validate.mjs` tracks what was inherited and what a proposal
overrode.

---

## covers vs reaches — they are not the same list

`covers` is the set of arms this row is **written for**. `reaches` is what it
**claims** each of them does — which side runs.

> *"cites an arm this proposal does not list in `covers`"*

A `reaches` entry for an arm absent from `covers` is refused. Stage 6 checks
every `reaches` claim against istanbul and reports it verified or FALSE, so a
claim is a statement you are held to, not a hint.

---

## Every value cites where it came from

> *"missing `from` — every value must cite the arm and file it came from"*
> *"must be an object with a `value` or a `build`, plus a `from`"*
> *"must carry a `value` (a literal) or a `build` (a JS expression stage 4 evaluates) — plus a `from`"*

- `value` — a literal, used as written
- `build` — a JS **expression** stage 4 evaluates. Not a statement.
- `from` — the arm and file the value was derived from

The `from` is not bookkeeping. A value with no stated origin is a value someone
invented, and this pipeline exists to stop that.

---

## Boundaries: what may answer, and what must be real

**The policy decides this, not the proposal.** `policy.mjs` classifies every
symbol, and on a repo its table does not describe an unnamed symbol is
**`real`** — the recording reaches the real dependency and writes down what it
did. A proposal's answer for such a boundary is dropped.

Mocked at all times, and only these two:

- **redis / ioredis** — a cluster-internal DNS name with no external route. A
  real call does not fail fast; it retries until the row times out. Unreachable
  infrastructure.
- **Slack** — guarded at the endpoint, not the transport. `hooks.slack.com` is
  in no egress allowlist. `axios` is a TRANSPORT and calls for real.

When a boundary IS answered:

> *"a live boundary needs a `mock` directive stage 4 can apply, alongside the prose `behaviour`"*
> *"must declare a `behaviour` (e.g. resolves / rejects / throws)"*
> *"mock.build must be a JS expression"*
> *"answers a boundary nothing touches"*

`mock.kind`'s legal values are printed by the checker that enforces them:

```
node .claude/charpilot/validate.mjs --schema
```

That list used to be written out here, and it was wrong: it offered `live`,
which `validate.mjs` refuses, and omitted `value`, which it accepts. A
vocabulary copied into prose drifts from the Set that enforces it, and the copy
is the one you read. `--schema` prints from the Set, so it cannot disagree with
the refusal you would have got. It also prints every other vocabulary — the
`setup[].apply` directives, `BLOCKED.md`'s categories and killers, the boundary
policy sets — and every rule the checker enforces, in the checker's own words.

`behaviour` is the prose statement; `mock` is the directive stage 4 applies.
Both are required — prose alone cannot be executed, and a directive alone
cannot be reviewed.

Answering a boundary the subject never touches is refused. So is a value that
cannot be revived: a recorded `$function` has no identity to replay.

**The receiver of an instance method when no constructor argument is answered**
is the class's own singleton if it keeps one by name — a static `INSTANCE` /
`instance` / `_instance` / `singleton` / … or `getInstance()`/`getSingleton()` —
and it is an instance of that class itself (not a subclass); any other static,
such as `static ZERO = new Money(0)`, is not. Otherwise the class is constructed
with the unanswered parameters `undefined`. To opt out of the singleton, declare
the constructor arguments (`<instance field>` boundaries): a declared ctor arg
always wins.

---

## setup — state the row needs first

> *"needs an `apply` directive: { env }, { call }, { module } or { manual }"*
> *"`apply` is … not an object — it is a DIRECTIVE KEYED BY KIND, and the kind is the KEY"*
> *"apply.call must be a JS expression stage 4 can evaluate, and …"*

One entry has **three** fields, and the kind is the KEY of `apply`, never its
value — `"apply": "call"` is the largest single fault class this checker has
recorded. `validate.mjs --schema` prints the entry whole:

```json
{ "state": "<prose: the precondition this arranges>",
  "apply": { "call": "<a JS expression>" },
  "from": { "arm": "<an arm this row covers>", "evidence": "<file:line>", "reading": "<what that line says>" } }
```

| directive | what it does |
|---|---|
| `apply.env` | sets env vars for this row, restored after it; a `null` value **unsets** the var for the row (the missing-env side of a var staging supplies or the mocked run stood in for) |
| `apply.call` | runs an expression first; its failure is **swallowed** as "precondition already satisfied". It is **already awaited** at the call site, so a top-level `await` in it is redundant and is refused |
| `apply.module` | `"fresh"` — every row resets the registry anyway |
| `apply.manual` | refused: a hand-built harness is not a directive |
| `apply.db` | writes a row into **real staging** |

### apply.db writes to a shared database

A row staging does not have is an **input**, not a blocked side — write it.
Unlike `apply.call`, a failed seed **throws**, because a silently unseeded row
records the arm it was written to leave behind.

> *"apply.db.create needs `model` — record.mjs:605 refuses a seed without it"*
> *"apply.db needs `why` — a row written into shared staging says what it is for"*
> *"apply.db.urlVar points at a read-only URL; a mutation needs the writable one, named explicitly"*

Only `{ create: { model, data } }` is accepted, and only under `--live`, because
an undo has to be derivable. Every mutation is journalled and reverse-replayed
with read-back verification. That reversibility is the whole permission: three
keys — `create.model`, `create.data`, `why` — and **no `revert` and no
`confirmedBy`**. The undo is the created id, and `confirmedBy` is a person's
ruling when the pull request is reviewed, not a field stage 3 fills in.

```jsonc
"setup": [{
  "state": "a cached_location row exists for the placeId this arm looks up",
  "from": { "arm": "…#186:if:0", "evidence": "prisma/schema.prisma:40", "reading": "…" },
  "apply": { "db": { "create": { "model": "cachedLocation", "data": { … } }, "why": "…" } }
}]
```

> **Corrected 2026-09-15.** This section used to quote *"apply.db.revert is
> identical to `set` — that is not an undo"* alongside the create form, which
> reads as though a create seed owes a `revert` too. It does not: that refusal
> belongs to the six-key `urlVar`/`table`/`where`/`set`/`revert` shape, and
> `record.mjs:605` refuses that shape outright, so a seed written in it is
> skipped every run. `gate.mjs` likewise asked every `apply.db` for a `revert`
> and a `confirmedBy` until today; it now asks only the non-create shapes, and
> prints a create seed as *journalled and reverse-replayed, `confirmedBy`
> awaiting a person's ruling*. The old wording cost coverage: `setup.apply.db`
> was used in **0 of 88 proposals** on run 20260915T033521Z, whose 92 FALSE
> claims in one file were all aimed at row-found sides that never ran.

---

## When no input can reach a side

Write a `BLOCKED.md` entry, not a guess — **with `blocked.mjs`, in one call**.
The fields `ledger.mjs` reads are `arm`, `side`, `category`, `killer`, `proof`,
plus `fix` when the category is `data-blocked`; the prose around the fence is
for a person and no tool parses it.

(**Corrected 2026-09-15:** this list used to read `side`, `killer`, `proof`,
`category`, `why` — it omitted `arm`, which the ledger refuses an entry for,
and named `why`, which it does not read.)

```bash
node .claude/charpilot/blocked.mjs \
  --arm 'src/services/location.service.ts#186:if:0' --side else \
  --category code-dead --killer code-local \
  --proof src/services/location.service.ts:392 \
  --why 'findCountryByIso2 returns an object on every path, including not-found.'
```

**46 calls in run `20260915T050314Z` landed on that one file — 13 reads and 9
edits, for 15 entries.** Reading it first was not a choice: an edit that replaces
a string owes a read of that string. This appends, so it owes nothing.

It refuses rather than repairs, and a refusal leaves `BLOCKED.md` byte-identical:
an arm the work list does not hold, a side that is not one of that arm's labels
or is already **covered**, a side some proposal already claims, a **duplicate**
(`--replace` overwrites one entry and prints what it removed), and every rule
`ledger.mjs` would apply later — the category, the killer, the `fix` a
`data-blocked` side owes, a proof citing the arm's own line. There is no bucket,
no `unknown`, and no field beyond the six: if it exits zero, the entry it wrote
is one the ledger accepts.

`killer: code-callers` says the side is unreachable given the argument shape
every current caller passes, so it needs callers to be true of. `ledger.mjs`
refuses it over an export with **zero** references in `src/` (read from
`out/dead-exports.json`): with no call site fixing the arguments, a
characterization test calls the export directly and can pass anything.

A reason is only acceptable once an input has been ruled out — and **never for
a database value**, because `setup.apply.db` always serves that. A dictated read
records an answer no query produced.

`dictate` is for what no seed can arrange: a database **failure**
(`rejects`/`throws`), or a provider response that cannot be steered.

---

## What stage 4 does with all this

Records the row against the real boundaries, writes both halves down, and the
emitted test replays **the recording** — not the proposal's answer for it. So an
argument carrying a per-run identity (a `new Date()`, a uuid) is matched
leniently at replay and never asserted on: `__unstablePaths` is computed for the
returned value only, which is why the call ledger asserts symbols and order
rather than arguments.

---

## A boundary that takes a CALLBACK cannot be answered by a static double

Two boundaries in this fleet take a function and call it, and a `returns` or
`resolves` answer for either of them produces a row that records cleanly and
then cannot replay. Neither is a judgement call; both have one correct shape.

### `startActiveSpan` and anything like it — declare `passthrough`

```ts
trace.getTracer("ptp-trace").startActiveSpan(name, async (span) => { … fetch … });
```

A static double captures the callback as `{ $function: "anonymous" }` — one of
the `UNREVIVABLE` tags — so at replay there is nothing to call, the `fetch`
inside it never runs, and the row quarantines as a replay mismatch *two stages
away from its cause*.

```json
"trace": { "mock": { "kind": "passthrough" },
           "behaviour": "the real @opentelemetry/api runs; with no TracerProvider registered its default no-op tracer calls the callback synchronously with a no-op span. No exporter, no network." }
```

`passthrough` means the real export runs at record time and `replayRoot` answers
at replay time, so the queues `installReplay` loaded are what respond. Nothing
in the toolset detects a callback-taking boundary on the static-double path and
substitutes this for you — `observingFn`'s general `passthroughCallback`
mechanism only engages for a boundary the run is already OBSERVING, which a
declared double is not. Declare it.

### `prisma.$transaction` — the outer rejection is not recordable

`$transaction` is handled by a hand-written special case that is TRANSPARENT: no
`CALLS` entry is written for the transaction itself, and the replay side answers
it by invoking the callback unconditionally. That is correct for the ordinary
case and false for exactly one:

> a double that makes **`$transaction` itself** reject, without ever entering its
> callback — a lock-wait timeout, say — so that only an outer `.catch` runs.

Recorded, that row is right. Replayed, the callback runs anyway, the calls
inside it match no recorded exchange, and the row fails on `replayMismatch`. It
is a **known toolset defect, not a defect in your proposal**; the fix belongs in
`record.mjs`'s `replayNode` and its record-side twin, which need the record half
to note that the callback was never entered and the replay half to honour it.

Until that lands: reach the outer `.catch` some other way if the arm allows it,
or write a `BLOCKED.md` entry naming this defect rather than a property of the
code. Do **not** hand-edit `it.skip` into the generated file — a re-emit
regenerates it, because the only skips the tool itself can emit are
`notSettled`, `__quarantine` and a wholly-unstable value.

---

## Under `--live` your declared database answer is DROPPED. Plan for that.

`--policy real-except-cache` is the default, and under `--live` it classifies
`prisma` as **real**: your `boundaries.prisma.mock` is discarded and the real
staging database answers. So a proposal that writes

```json
"prisma": { "mock": { "kind": "returns", "build": "{ country: { findFirst: () => Promise.resolve({ id: 'c-al', … }) } }" } }
```

is not arranging anything. It is describing what it *hopes* staging holds. On
run `20260915T033521Z` that produced **119 false claims over 56 rows**: the row
recorded the `not found` side, froze it under the label of the `found` side, and
nothing refused until stage 6.

A side that needs data has exactly **three legal endings**, and
`gate.mjs`'s `reaches-at-record-time` refuses the fourth.

### 1 · Seed it — when a `create` can put the row there

```json
"setup": [{ "state": "a country row exists for iso2 'al'",
            "apply": { "db": { "create": { "model": "country", "data": { "iso2": "al", "name": "Alderaan" } },
                               "why": "the found side of findCountryByIso2 needs a row to find" } } }]
```

Journalled and reverse-replayed under `--live`; no `revert` and no `confirmedBy`
(see the `apply.db` section above).

### 2 · Do NOT seed a `$queryRaw` — it cannot work, and this is measured

`setup.apply.db` creates a row in a **named model**. `$queryRaw` is raw SQL with
a similarity ranking over whatever staging holds; creating a row does not make
the scan return it in the shape and order your arm needs.

Of the 56 rows that recorded the wrong side on that run:

| starved by | rows | what to do |
|---|---:|---|
| a model read (`findFirst`, `findUnique`, `findMany`) | **2** | seed it |
| `$queryRaw` | **18** | drive the subject **directly**, passing the data as an argument — or block the side |
| nothing — no declared read came back empty | **35** | not a database problem: the input does not select the side it claims |

So seeding fixes two of them. The instinct to "add a seed" is wrong for 54.

### 3 · Block it — when no input can reach it

A fenced `BLOCKED.md` entry with a `category`, a `killer` and a sourced `proof`.
Accounted, not covered; the denominator is untouched.

### What is refused

Anything else. A row whose `reaches` claim did not hold **at record time** fails
`reaches-at-record-time` naming the row, the claim, the boundary that came back
empty, and which of the three endings applies. That verdict is stage 4's, not
stage 6's — three hours and about $44 earlier than where it used to surface.
