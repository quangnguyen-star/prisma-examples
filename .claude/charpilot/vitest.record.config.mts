import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

import baseConfig from "../../vitest.config.ts";
import { COVERAGE_INCLUDE, SRC_DIR, SRC_EXCLUDE } from "./config.mjs";
import { replayAliases } from "./resolution.mjs";

const root = resolve(__dirname, "..", "..");

// Recording run.
//
// It does NOT load test/setup.ts: that file mocks prisma, ioredis and the
// loggers, and a pair recorded under those mocks would describe the mocks
// rather than the service.
//
// But dropping setup.ts also dropped the module resolution it happened to
// provide. The first real run recorded 17 rows as `threw` when the actual cause
// was `Cannot find module '@/prisma/client'` — a harness failure written down
// as behaviour. So the tsconfig paths this pipeline depends on are declared
// here explicitly, longest prefix first, because vite matches an alias by
// prefix.
//
// These are the pipeline's FLOOR, not the repo's alias table. They were the
// whole table once - this config spread the host's `vitest.config.mts` and then
// replaced `resolve` wholesale - and that discarded every alias the host
// declares that charpilot does not happen to know. Measured on qode-ptp-ms,
// whose host config's FIRST alias is `{find: /^@\/env\.mjs$/}`: without it the
// generic `/^@\//` rule below rewrote `@/env.mjs` to `<root>/src/env.mjs`,
// which does not exist (`src/env.ts` does), so every row whose module graph
// reached it failed with `Cannot find module '@/env.mjs'` - 114 of 887 src
// files import it directly, and five benchmark agents each worked around it
// per row by declaring a boundary on the config module.
//
// So the host's aliases are MERGED in, not dropped: they are facts about the
// repo under test, and this file is not entitled to overrule them.
// The table and the merge are in resolution.mjs, shared with every other config
// a recorded row is replayed under (coverage's, the corpus's, the bootstrapped
// root's), so none of them can resolve differently from this one. The ordering
// rule - most specific first, host wins a tie - is documented there.
const alias = replayAliases(baseConfig.resolve?.alias, root);

export default defineConfig({
  ...baseConfig,
  resolve: { ...baseConfig.resolve, alias },
  test: {
    ...baseConfig.test,
    setupFiles: [],
    exclude: [],
    include: [".claude/charpilot/out/record.test.ts"],
    // Coverage is ON here for one reason, and it is not a report.
    //
    // A proposal's `reaches` says which SIDE of an arm its input takes. That
    // claim used to be checked only at stage 6, which needs a full record ->
    // generate -> measure cycle: 406 claims checked, 103 of them FALSE, all of
    // them discovered ~30 minutes downstream of the run that could have said
    // so. Instrumenting the record pass lets each row diff istanbul's own
    // counters across its own subject call and self-report which arms it
    // actually moved.
    //
    // `all: false` because a row only needs the files it touches - the
    // denominator is stage 6's question, not stage 4's - and instrumenting
    // every src file per chunk would cost time for nothing.
    //
    // `reporter: []` and a scratch reportsDirectory because there is no report
    // to keep: each chunk is its own vitest process and would overwrite the
    // last one's file, so a merged coverage-final.json from a record run would
    // describe the final chunk and read as the whole. The counters are read
    // in-process instead (globalThis.__VITEST_COVERAGE__ - see ROW_RUNTIME in
    // record.mjs) and the branch map travels out with the chunk's results.
    coverage: {
      enabled: true,
      provider: "istanbul",
      reportsDirectory: resolve(__dirname, "out", ".record-coverage"),
      reporter: [],
      all: false,
      // The scan's directory, as the coverage and baseline configs already
      // use (config.mjs COVERAGE_INCLUDE). This one still said `src/**/*.ts`,
      // and contact-ms keeps its TypeScript at the repo root: nothing was
      // instrumented, so every row it recorded (late September 2026) came back
      // "no istanbul counters in this run" and its entry file's module-scope
      // arms were never observed at record time. A root-rooted repo gets the
      // scan's exclusions too, as the coverage config gives it, so the specs,
      // fixtures and .claude/ are not instrumented as source.
      include: COVERAGE_INCLUDE,
      ...(SRC_DIR === "." ? { exclude: SRC_EXCLUDE } : {}),
      thresholds: undefined,
    },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
