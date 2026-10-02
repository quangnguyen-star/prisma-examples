# Installing charpilot into a repo — the mechanical recipe

Stage 4 must stay runnable by a developer with an input file and no agent. This
is the whole install, proved end to end on `location-ms` (an Express + Prisma
service, 32 files, 116 tests already green at 95.34% branches).

## One command

```bash
bash .claude/charpilot/install.sh <target repo or PACKAGE root>
```

It copies the 43 scripts and 4 vitest configs, wires the charpilot vitest configs to whatever the
host's base config is called, writes a `doubles.ts` stub, DERIVES
`test/src-exclude.mjs` from the host's own `coverage.exclude`, and installs the
two dependencies pinned to the host's exact vitest version. Then run the three
commands it prints.

## The steps, by hand

```bash
D=<target repo or PACKAGE root>          # the dir holding package.json + tsconfig.json + the source root
S=<this repo>

# 1. the tools (856 KB, 43 scripts + 4 vitest configs). Nothing else travels.
mkdir -p $D/.claude/charpilot
cp $S/.claude/charpilot/*.mjs $S/.claude/charpilot/*.mts $D/.claude/charpilot/

# 2. the two dependencies the host repo almost never has
cd $D && npm install --save-dev ts-morph@28 @vitest/coverage-istanbul@<matching vitest major>

# 3. the coverage scope, copied from the host's OWN vitest config
cat > $D/test/src-exclude.mjs <<'JS'
export const SRC_DIR = "src";          # where the TypeScript is. "." if it is at the repo root
export const SRC_EXCLUDE = [...];      # = vitest coverage.exclude, EVERY entry, globs included
export const TYPE_ONLY_DIRS = [];      # NOT derived: a judgement about the source, left to a person
JS

# 4. an empty doubles file; grow it only when a proposal needs a shape
mkdir -p $D/test/fixtures && touch $D/test/fixtures/doubles.ts

# 5. run
node .claude/charpilot/baseline.mjs     # suite green + istanbul denominator
node .claude/charpilot/scan.mjs         # must reconcile to 0 drift
node .claude/charpilot/worklist.mjs     # self-check must be equal
node .claude/charpilot/record.mjs       # executes the inputs, records the outputs
```

## The things that bite, all measured on a real install

1. **`--no-save` installs get PRUNED by the next `npm install`.** ts-morph
   reported 28.0.0, then vanished when coverage-istanbul was installed. Use
   `--save-dev`, or ship charpilot as a package with declared dependencies.
2. **The fleet ships `coverage-v8`, not istanbul.** location-ms had
   `@vitest/coverage-v8`. v8's denominator GROWS as tests are added, so it
   cannot be ratcheted - istanbul is not a preference, it is the requirement.
   Match the host's vitest major or the provider will not load.
3. **`src-exclude.mjs` must mirror the host's own coverage exclude.** Leaving it
   empty gave `ast 367 vs istanbul 365`, and the whole 2-side drift was
   `src/instrumentation.ts` - a file the host excludes and the scan counted.
   Copying its two entries closed the reconcile to 100%, 0 files drift, on both
   arms and functions.
4. **`record.mjs` reads `test/fixtures/doubles.ts` unconditionally**, even when
   no proposal calls a factory. An empty file is enough to start.
5. **`@vitest/coverage-istanbul` peers on ONE exact vitest version.** Asking for
   `@3` resolved 3.2.7, which peers `vitest@3.2.7`, against a host on 3.2.4 -
   `ERESOLVE, Conflicting peer dependency`. Pin to the host's exact version.
6. **The host's base vitest config filename varies.** The charpilot configs
   import it by name, and the fleet is split - `vitest.config.mts` in four
   services, `vitest.config.ts` in two. A hardcoded `.mts` fails the whole run
   with an esbuild *"Could not resolve"*. The installer rewrites the import.
7. **A red host suite stops stage 1, by design.** `notification-ms` has 2 of 156
   tests failing on its OWN config, untouched by charpilot, and baseline refused
   rather than recording numbers from a red run - vitest writes no coverage
   report when a test fails, so a red suite has no denominator to record.
8. **Force `coverage.all` and `coverage.include`; never inherit them.**
   `interview-service` has no `coverage` block at all, so istanbul's denominator
   was *"the files the tests happened to load"* - `src/index.ts` was never
   imported by a test, contributed 0 arms, and read as a 2-side reconcile drift
   that was really a missing setting. Forcing them grew that denominator
   1001 -> 1003 and honestly dropped its coverage 88.31% -> 88.13%. A ratchet
   against a denominator that moves with the suite is not a ratchet.
9. **Not every host suite is green, and stage 1 will refuse.** Two of five
   internal services are red on their own configs - `notification-ms` 2 of 156,
   `profile-centralized` 6 failing - and neither can be baselined until someone
   fixes them. That is the host repo's problem, not the pipeline's.
10. **Not every service uses `src/`.** `candidate-ms` and `contact-ms` keep
   their TypeScript at the repo ROOT - `server.ts` beside `routes/`, `service/`,
   `core/`, `middlewares/`. Every source walk globs the declared root, so with
   the default `"src"` the scan finds 0 files and REFUSES, which reads as a
   broken repo and is really an unmodelled layout. Declare `SRC_DIR = "."` in
   `test/src-exclude.mjs`, and put `test/`, `prisma/`, `dist/` and `coverage*/`
   in `SRC_EXCLUDE` - a `src/` repo excludes those for free and a root-rooted
   one does not. See `docs/FLEETCHECK.md`.
11. **A NestJS host transforms with `unplugin-swc`, and that plugin vetoes
   esbuild.** It returns `{ esbuild: false }` from its vite `config()` hook, so
   a file NO spec imports gets no transform at all and reaches istanbul as raw
   TypeScript - which babel parses with no typescript plugin, dying on the first
   TS-only token (`@Module({` on qode-backend, `import type` on qode-itl-be, one
   cause; decorators are incidental). `vitest.charpilot.config.mts` handles it:
   it drops that hook and gives the plugin `enforce: "pre"`, so SWC still
   transforms what the suite imports - Nest DI needs its emitted metadata - and
   esbuild transforms the rest. Both changes are needed; dropping the hook alone
   breaks DI. Verified on qode-itl-be: 160 spec files ran and 278 files
   instrumented, 91 of them imported by nothing. An Express host has no such
   plugin and is untouched. See `docs/FLEETCHECK.md`.
12. **In a monorepo the target is the PACKAGE root, not the repo root** —
   `twenty/packages/twenty-server`, `novu/apps/api`, `vendure/packages/core`,
   `immich/server`. `backstage` has no single root at all: its backend is dozens
   of plugin packages, each its own target.

## What the first native run produced

```
baseline    116/116 tests green · branches 348/365 = 95.34% (istanbul)
scan        ast 365 vs istanbul 365 — 100% match, 0 files drift
            ast 236 vs istanbul 236 — 100% match, 0 files drift
worklist    17 uncovered sides measured, coverage says 17
record      17 runnable of 17 · 12 recorded · 0 harness failures
            6 claims verified, 0 FALSE at record time
            5 blocked egress: fetch to maps.googleapis.com
```

The 5 blocked rows are the guard working, and they are the documented case: a
boundary reached through a private HELPER is not in the scan's list, so those
proposals declared no answer for `fetch` and the egress guard refused the call
rather than making it. Declaring it is the fix, and it is stage 3's job.

Independent corroboration that the baseline is right: location-ms's own
`vitest.config.mts` already documents *"the same suite measures 89.46 / 95.34 /
87.71 / 88.93 under istanbul"* from a prior sweep. Those are the four figures
this install measured, to the digit.
