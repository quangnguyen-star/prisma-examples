import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import os from "node:os";
import { parseEnvText } from "./envfile.mjs";

import { existsSync, readFileSync } from "node:fs";

import baseConfig from "../../vitest.config.mts";
import { CORPUS_REL, CORPUS_SUFFIX, COVERAGE_INCLUDE, SRC_EXCLUDE, maskDatabaseEnv } from "./config.mjs";
import { REPLAY_TEST_ENV, replayAliases, uncoveredUnderHostTransform } from "./resolution.mjs";

const root = resolve(__dirname, "..", "..");
// The host's own plugins, with its SWC transform reaching the files
// `coverage.all` instruments though no spec imports them (resolution.mjs,
// D45: qode-itl-be's stage 6 died on raw TypeScript in src/app.module.ts).
const basePlugins = (baseConfig as any).plugins;

/** A repo's own tests, wherever it keeps them. Exported for the test that pins it. */
export const TEST_FILES = ["**/__tests__/**", "**/__mocks__/**", "**/*.{test,spec}.?(c|m)[jt]s?(x)"];

/**
 * A characterization suite is only valid under the env it was RECORDED against.
 *
 * The first run of the generated tests failed 115 times with
 * `ZodError: DATABASE_URL Required` - the recorder had `--env-file
 * out/staging.env` and the suite had nothing, so src/env.ts refused to boot.
 * That is the right failure: QUEUE_TIMEOUT, MAX_TIMEOUT_*, REDIS_HOST and
 * SLACK_HOOK are read by the arms under test, so running these assertions under
 * a different env asserts about a different program.
 *
 * So the env is loaded here, from CHARPILOT_ENV_FILE or the default staging
 * file, and its absence is left to fail loudly rather than papered over with
 * placeholders that would silently change what the arms see.
 */
function recordedEnv(): Record<string, string> {
  // The suite's OWN recorded.env first - stage 5 stamps it next to the tests
  // precisely so the measurement can reproduce the recording. Defaulting to
  // out/staging.env instead measured the suite under an env it was not
  // recorded with: two rows saw staging's real SLACK_HOOK and Langfuse baseUrl
  // where the recording had inert stand-ins, and failed as harness errors.
  const stamped = resolve(
    __dirname, "..", "..",
    process.env.CHARPILOT_SPECS ?? CORPUS_REL,
    "recorded.env"
  );
  const file =
    process.env.CHARPILOT_ENV_FILE ??
    (existsSync(stamped) ? stamped : resolve(__dirname, "out", "staging.env"));
  if (!existsSync(file)) return {};
  // The one env reader (envfile.mjs): a PEM value spans lines, and a
  // line-by-line read gave cipher.ts a key it could not decode.
  const env = parseEnvText(readFileSync(file, "utf8"));
  // Defence in depth (tool backlog): the suite replays its recording and never
  // needs a database, and this falls back to out/staging.env when the suite has
  // no recorded.env. Outside a live run, no database credential survives.
  return String(process.env.CHARPILOT_MODE ?? "").toLowerCase() === "live" ? env : maskDatabaseEnv(env);
}

// Stage 6 — measurement.
//
// Measures the GENERATED TESTS (stage 5's output), because coverage is a
// property of a test suite. `--specs` can still point it at the recorder's own
// specs as a pre-generation diagnostic, but the suite is the real subject.
//
// Identical resolution to the recording run (same aliases, no test/setup.ts),
// because a spec that resolved differently would measure a different program.
// The one difference is that coverage is ON.
//
// istanbul, never v8. v8's branch denominator GROWS as tests are added, so a
// percentage from it cannot be ratcheted against and cannot be compared to the
// stage-1 baseline. istanbul's denominator is fixed by the source, which is the
// only thing that makes "1034 of 1518" a sentence with meaning.
//
// `reportsDirectory` is its own, so a measurement run can never overwrite the
// baseline it is being compared against.
/**
 * ITEM 18b - MEASURE RUNS ITS SPEC FILES `CHARPILOT_MEASURE_WORKERS` AT A TIME.
 *
 * `test` below spreads the repo's own, and qode-ptp-ms's sets `maxWorkers: 1,
 * minWorkers: 1`: every measure pass ran the whole 408-file corpus one file at
 * a time in one worker, at about 1.2 of 8 cores for more than 30 minutes on
 * Node 20 (D77). The repo's own suite may need that; this corpus does not.
 * Every row pins its own clock and tears its mocks down, and every spec file
 * runs isolated in its own worker. Measure is our number, not the repo's CI:
 * cigate.mjs, which runs the corpus the way the repo's CI will, keeps the
 * repo's setting.
 *
 * Unset, 0 or 1 is the repo's own setting, and that is the kill switch.
 */
export const AUTO_MAX = 4;
export function measureWorkers(raw: unknown = process.env.CHARPILOT_MEASURE_WORKERS, cores: number = machineCores()): number {
  // `auto`: cores less one, at most AUTO_MAX. D82: every worker hands its
  // coverage back to the one main process, and at 7 workers qode-ptp-ms's
  // largest spec (aiInterviewService.char.test.ts) failed with "[vitest-worker]:
  // Timeout calling ..." while the main process fell behind (run
  // 20260929T134110Z); the same corpus measured clean at 3 (21.7 min). An
  // explicit number still means that number.
  const cap = Math.max(1, Math.min(AUTO_MAX, cores - 1));
  if (String(raw ?? "").trim().toLowerCase() === "auto") return cap > 1 ? cap : 0;
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 16) : 0;
}
function machineCores(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}
const workers = measureWorkers();

export default defineConfig({
  ...baseConfig,
  ...(basePlugins ? { plugins: uncoveredUnderHostTransform(basePlugins) } : {}),
  // The recorder's resolution, from the one place it lives (resolution.mjs):
  // the host's aliases merged over the pipeline's floor. This hard-coded the
  // floor and dropped the host's table, while the comment above said
  // "identical resolution to the recording run".
  resolve: { ...baseConfig.resolve, alias: replayAliases(baseConfig.resolve?.alias, root) },
  test: {
    ...baseConfig.test,
    ...(workers ? { maxWorkers: workers, minWorkers: 1, fileParallelism: true } : {}),
    setupFiles: [],
    exclude: [],
    // The suite to measure comes from the CALLER, not from a path baked in
    // here. It used to be hard-wired to `out/tests` - the recorder's own
    // throwaway output - while `coverage.mjs --specs test/characterization`
    // counted files in a directory nothing ever ran. So stage 6 reported a
    // number for a stale copy of the suite, and the flag that appeared to
    // select the subject only changed one line of stdout.
    include: [
      `${process.env.CHARPILOT_SPECS ?? CORPUS_REL}/*${CORPUS_SUFFIX}`,
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { ...REPLAY_TEST_ENV, ...recordedEnv() },
    coverage: {
      enabled: true,
      // ISTANBUL EITHER WAY. With the incremental walk on (the default), the
      // stock provider is wrapped so each spec file's coverage is kept and a
      // partial measurement can be merged by vitest itself - see
      // coveragechunks.mjs for why a report-level merge cannot be exact.
      // CHARPILOT_INCREMENTAL_WALK=off is this config as it was.
      ...(String(process.env.CHARPILOT_INCREMENTAL_WALK ?? "").trim().toLowerCase() === "off"
        ? { provider: "istanbul" as const }
        : { provider: "custom" as const, customProviderModule: resolve(__dirname, "vitest.coverage.provider.mjs") }),
      // vitest defaults this to FALSE, so a red suite writes no coverage report
      // at all - and then stage 2 has no denominator to diagnose from. Measured
      // twice: notification-ms and profile-centralized both have pre-existing
      // failures, and on both, baseline.mjs ran coverage, got nothing, and the
      // reconcile silently degraded to "istanbul 0" for every file - which
      // reads as 100% drift rather than as a missing report. A red baseline is
      // exactly when the numbers are needed most.
      reportOnFailure: true,
      reportsDirectory: resolve(root, "coverage-charpilot-stage6"),
      // json feeds coverage.mjs's join; html and text are for a person. The
      // html report is the only view that shows WHICH side of a branch was
      // taken - the `I` and `E` markers - which is the whole question stage 6
      // asks and the one a percentage cannot answer.
      reporter: ["json", "html", "text-summary"],
      all: true,
      include: COVERAGE_INCLUDE,
      // TEST FILES ARE NOT SOURCE, and nothing else here says so. Vitest keeps
      // a test file out of coverage only when it matches `test.include`, and
      // this config points `test.include` at the generated suite alone - so a
      // repo that keeps its OWN tests under src/ has them matched by
      // `include: ["src/**/*.ts"]` and instrumented as source. Vitest's default
      // `exclude` is empty (4.1.3 and 5.0.0 alike), so nothing caught it.
      //
      // Measured on turing-integration-ms, which keeps 58 test files under
      // src/**/__tests__/. istanbul instrumented them, vitest's hoisting then
      // pulled their vi.mock() calls out of the instrumented code and glued two
      // together - `})vi.mock("@/env", () => {` - and every stage-6 run crashed
      // before writing coverage.json. Run 20260923T052910Z measured nothing 30
      // times in 16 rounds. The scan never counted these files, so excluding
      // them here keeps the two denominators the same set.
      exclude: [...TEST_FILES, ...SRC_EXCLUDE],
    },
  },
});
