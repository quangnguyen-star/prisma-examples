import { defaultExclude, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.mts";
import { CORPUS_REL, COVERAGE_INCLUDE, SRC_DIR, SRC_EXCLUDE } from "./config.mjs";

// Pilot-only config. Deliberately separate from vitest.config.mts so the pilot
// can use the istanbul provider without moving the numbers the existing
// thresholds (vitest.active.config.mts) were computed against under v8.
//
// istanbul, not v8: v8's branch denominator grows as tests are added, so the
// percentage moves for reasons that are not the work. istanbul's denominator is
// fixed by the instrumented source, which is what lets stage 5 ratchet.
/**
 * SWC KEEPS ITS TRANSFORM AND LOSES ITS VETO ON esbuild.
 *
 * A Nest host transforms with `unplugin-swc`, because Nest's dependency
 * injection reads type metadata that only SWC emits. That plugin also returns
 * `{ esbuild: false }` from its vite `config()` hook, to avoid transforming
 * everything twice - and that is what stopped stage 1 dead on both Nest
 * services.
 *
 * `coverage.all` has to instrument files NO spec imports. Such a file never
 * enters the module graph, so SWC's transform never runs on it, and with vite's
 * own esbuild disabled it reaches istanbul as raw TypeScript. istanbul parses
 * that with the fixed babel plugin list from @istanbuljs/schema, which carries
 * no typescript plugin at all, so it dies on the first TypeScript-only token -
 * `@Module({` on qode-backend, `import type` on qode-itl-be, one cause.
 * Decorators are incidental: `export function f(a: number)` fails the same way.
 *
 * Two changes, and both are needed:
 *
 *   config: undefined   stops the plugin disabling vite's esbuild, so the files
 *                       SWC never sees still get transformed
 *   enforce: "pre"      makes SWC run FIRST on the files it does see, so esbuild
 *                       only ever receives JS with nothing left to strip. The
 *                       plugin ships with no `enforce`, so it races vite's own
 *                       esbuild and loses - measured: metadata gone, and a Nest
 *                       DI test asserting `design:paramtypes` fails.
 *
 * Only a host that actually carries the plugin is touched. An Express host has
 * no `plugins` entry named "swc" and comes through unchanged.
 *
 * KNOWN EFFECT ON THE DENOMINATOR. With esbuild re-processing SWC's output, a
 * class with an instance field and NO constructor gains the synthesised
 * constructor SWC alone does not emit - 1 function becomes 2 on such a class.
 * That is the model `scan.mjs` already has, so it moves the number TOWARDS the
 * scan rather than away, but it is a change and it is why this is written down.
 */
const unvetoSwc = (plugin: any): any => {
  if (Array.isArray(plugin)) return plugin.map(unvetoSwc);
  if (plugin && typeof plugin === "object" && plugin.name === "swc") {
    return { ...plugin, config: undefined, enforce: "pre" };
  }
  return plugin;
};
const basePlugins = (baseConfig as any).plugins;

export default defineConfig({
  ...baseConfig,
  ...(basePlugins ? { plugins: unvetoSwc(basePlugins) } : {}),
  test: {
    ...baseConfig.test,
    // The baseline is the PRE-EXISTING suite's coverage, by definition, so the
    // generated tests are excluded. Including them made stage 1 measure the
    // very thing stage 6 compares against, and the denominator then moved with
    // the suite. It also avoids a real interference: the two projects each pass
    // under coverage and fail together, because instrumentation loosens the
    // isolation that keeps test/setup.ts out of the characterization files.
    // `?? defaultExclude`, never `?? []`. A host that sets no `test.exclude`
    // relies on vitest's own default - `**/node_modules/**`, `**/dist/**` and
    // the rest - and spreading an empty array in its place REPLACED that
    // default with one entry, so the baseline run collected every .test.js
    // shipped inside node_modules. Measured on two services: ai-centralization
    // reported "37 failing test(s) in 41 file(s)", every one of them from
    // node_modules (fast-uri, pg-protocol, gensync), and ats-sourcing-service
    // the same from zod and tsconfig. Both suites are green on their own
    // config. A host that DOES set exclude keeps its own list verbatim, because
    // that is what vitest does with it.
    exclude: [
      ...(baseConfig.test?.exclude ?? defaultExclude),
      "test/characterization/**",
      `${CORPUS_REL}/**`,
    ],
    coverage: {
      ...baseConfig.test?.coverage,
      provider: "istanbul",
      // vitest defaults this to FALSE, so a red suite writes no coverage report
      // at all - and then stage 2 has no denominator to diagnose from. Measured
      // twice: notification-ms and profile-centralized both have pre-existing
      // failures, and on both, baseline.mjs ran coverage, got nothing, and the
      // reconcile silently degraded to "istanbul 0" for every file - which
      // reads as 100% drift rather than as a missing report. A red baseline is
      // exactly when the numbers are needed most.
      reportOnFailure: true,
      // FORCED, not inherited. Without `all: true` and an explicit `include`,
      // istanbul's denominator is "the files the tests happened to load", not
      // the source - so a file no test imports contributes ZERO arms and the
      // percentage looks better than it is. Measured on interview-service,
      // whose vitest config has no `coverage` block at all: the scan counted
      // `src/index.ts` and istanbul reported 0 arms for it, showing up as a
      // 2-side reconcile drift that was really a missing setting.
      //
      // A ratchet against a denominator that moves with the suite is not a
      // ratchet, which is the same reason this pipeline refuses v8.
      all: true,
      // The scan's directory, not always src/ (config.mjs COVERAGE_INCLUDE).
      include: baseConfig.test?.coverage?.include ?? COVERAGE_INCLUDE,
      // A root-rooted repo with no coverage block of its own gets the scan's
      // exclusions, so the two walk the same file set.
      ...(SRC_DIR === "." && !baseConfig.test?.coverage?.include
        ? { exclude: [...(baseConfig.test?.coverage?.exclude ?? []), ...SRC_EXCLUDE] }
        : {}),
      reporter: ["text-summary", "json", "json-summary"],
      reportsDirectory: "./coverage-charpilot",
      // The pilot measures; it does not gate. Ratcheting happens in stage 5
      // against baseline.json, not here.
      thresholds: undefined,
    },
  },
});
