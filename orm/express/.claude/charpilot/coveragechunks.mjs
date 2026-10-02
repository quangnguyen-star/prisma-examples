/**
 * STAGE 6'S ISTANBUL PROVIDER, UNCHANGED, WITH EACH SPEC FILE'S COVERAGE KEPT.
 *
 * WHY A MEASUREMENT CANNOT BE MERGED FROM REPORTS. istanbul's counters add up
 * across spec files, so the coverage of a suite is the sum of its files'. But
 * `coverage-final.json` is the sum AFTER vitest has remapped it through the
 * source maps and added every `coverage.include` file no spec imported, and a
 * sum cannot be taken apart again: re-running the three spec files that changed
 * and merging the result into last walk's report (union.mjs's move for two
 * halves) counts those three files twice - their old hits are still in it. What
 * a per-file merge needs is each spec file's OWN coverage, before the remap.
 *
 * vitest hands exactly that to its provider: `onAfterSuiteRun({ coverage,
 * testFiles, environment, projectName })` once per worker batch, which is one
 * spec file whenever `isolate` is on (vitest's default, and the only setting
 * under which a spec file's coverage does not depend on the file run before
 * it). It is the public CoverageProvider interface, not an internal. So this
 * module is the stock `@vitest/coverage-istanbul` module with two hooks around
 * that provider (vitest.coverage.provider.mjs, loaded as `coverage.provider:
 * "custom"` by vitest.coverage.config.mts; the hooks live here, where a test
 * can import them without vitest):
 *
 *   CHARPILOT_COVERAGE_CHUNKS_OUT=<dir>  every batch's raw coverage is written
 *        there too, gzipped, with the files and environment it came from, and
 *        whether the run was isolated. coverage.mjs keeps them per spec file.
 *   CHARPILOT_COVERAGE_REUSE=<list.json> before the report, the chunks listed
 *        are handed to the provider exactly as a batch that ran would have
 *        been, and the report is generated as for a run of every test.
 *
 * So a partial measurement is vitest's own merge, remap and untested-file pass
 * over the same inputs a full run feeds it - the chunks of the spec files that
 * ran now, and the stored chunks of the ones whose bytes did not change - and
 * nothing here re-implements a line of it. coverage.mjs checks the result is
 * what it should be; this module only moves chunks.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const CHUNKS_OUT_ENV = "CHARPILOT_COVERAGE_CHUNKS_OUT";
export const REUSE_ENV = "CHARPILOT_COVERAGE_REUSE";

/**
 * WHAT A BATCH IS, apart from its counters: every field vitest put on it, kept
 * as vitest put it. vitest 4 and 5 key a batch by `environment`, vitest 2 and 3 by
 * `transformMode` (ssr or web); a chunk handed back under the wrong key is
 * merged under a key the report never reads.
 */
export function batchOf(meta) {
  const { coverage: _coverage, ...batch } = meta ?? {};
  return batch;
}

/** The name a batch's chunk is written under: the same batch, the same name. */
export function chunkName(meta) {
  const key = JSON.stringify(Object.entries(batchOf(meta)).sort(([a], [b]) => a.localeCompare(b)));
  return `${createHash("sha1").update(key).digest("hex")}.json.gz`;
}

/** One chunk as written: the batch vitest reported, and how it was run. */
export function readChunk(path) {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
}

/**
 * The two hooks, on a provider vitest built. Exported so the test can hand it a
 * provider of its own; `env` is read once, when vitest asks for the provider.
 */
export function keepChunks(provider, env = process.env) {
  const out = env[CHUNKS_OUT_ENV] || null;
  const reuse = env[REUSE_ENV] || null;
  const onAfterSuiteRun = provider.onAfterSuiteRun.bind(provider);
  const generateCoverage = provider.generateCoverage.bind(provider);
  const initialize = provider.initialize.bind(provider);
  let isolate = null;
  // HOW THIS VITEST HANDS A BATCH OVER. vitest 2, 3 and 4 pass the coverage object
  // itself; vitest 5 has the worker write it to a file and passes the file's
  // name ("Expected string coverage payload"). Learnt from the first batch of
  // the run, or from the provider's major version when no batch had any.
  let byFile = null;
  const handsFiles = () => byFile ?? Number.parseInt(String(provider.version ?? "0"), 10) >= 5;
  provider.initialize = (ctx) => {
    // Written onto every chunk: a run that was not isolated shares module
    // state between the files of a worker, so no file's coverage is its own
    // and coverage.mjs keeps none of them.
    // vitest 4 and 5 resolve it to `config.isolate`; vitest 2 and 3 decide it
    // per pool (`poolOptions.forks.isolate ?? true`), so both are asked.
    const config = ctx?.config ?? {};
    isolate = config.isolate !== false && config.poolOptions?.[config.pool]?.isolate !== false;
    return initialize(ctx);
  };
  provider.onAfterSuiteRun = (meta) => {
    if (meta?.coverage) byFile = typeof meta.coverage === "string";
    if (out && meta?.coverage) {
      mkdirSync(out, { recursive: true });
      const target = join(out, chunkName(meta));
      const about = { ...batchOf(meta), testFiles: meta.testFiles ?? [], isolate };
      const coverage = typeof meta.coverage === "string" ? JSON.parse(readFileSync(meta.coverage, "utf8")) : meta.coverage;
      const body = gzipSync(JSON.stringify({ ...about, coverage }), { level: 1 });
      writeFileSync(`${target}.${process.pid}.tmp`, body);
      renameSync(`${target}.${process.pid}.tmp`, target);
      // The same facts beside it, small, so a reader can sort the chunks by
      // spec file without unzipping megabytes of counters.
      writeFileSync(`${target}.meta.json`, JSON.stringify(about));
    }
    return onAfterSuiteRun(meta);
  };
  provider.generateCoverage = async (options = {}) => {
    if (!reuse) return generateCoverage(options);
    const list = JSON.parse(readFileSync(reuse, "utf8"));
    const files = handsFiles();
    for (const [i, path] of (list.chunks ?? []).entries()) {
      const chunk = readChunk(path);
      // Handed over the way this vitest's own workers hand a batch over: a
      // file beside the reuse list, which the provider reads and never
      // deletes (it removes only its own directory), or the object itself.
      let coverage = chunk.coverage;
      if (files) {
        coverage = join(dirname(reuse), `reused-${i}.json`);
        writeFileSync(coverage, JSON.stringify(chunk.coverage));
      }
      const { coverage: _kept, isolate: _isolate, ...batch } = chunk;
      onAfterSuiteRun({ ...batch, coverage });
    }
    // AS FOR A RUN OF EVERY TEST. vitest adds the `coverage.include` files no
    // spec imported only when all tests ran, and a run given file filters is
    // not one; with the reused chunks in, this one is.
    return generateCoverage({ ...options, allTestsRun: true });
  };
  return provider;
}

