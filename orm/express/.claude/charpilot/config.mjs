import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { detectSrcDir } from "./srcdir.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The repo being scanned.
 *
 * Defaults to the service this pipeline lives in. `CHARPILOT_TARGET_ROOT`
 * points it at another checkout so the SAME scan can be benchmarked against
 * foreign code - which is the only way to find out whether the arm model is a
 * model of TypeScript or a model of this one service. A copy of the walk would
 * measure the copy; this measures the script that actually runs.
 *
 * Only the SOURCE-side constants follow the target. Everything that writes
 * (OUT_DIR, coverage dirs, proposals) stays in this repo, so benchmarking
 * another service cannot write into it.
 */
/**
 * WHERE THE TOOLS ARE is not where the REPO is, and conflating the two is what
 * forced a copy of all 36 scripts into every checkout.
 *
 * `here` used to fix both: the repo was `here/../..` and the artifacts were
 * `here/out`. That works only when the tools live inside the repo they measure,
 * so eight copies existed - the source in qode-characterize plus seven working
 * copies - and they drifted the moment one was edited. baseline.mjs was one
 * commit ahead in six of them.
 *
 * So: the repo is the CWD (every pilot:* script runs from the package root, and
 * `CHARPILOT_TARGET_ROOT` overrides for the bench), and the artifacts live in
 * the repo, not beside the tools. `here` is now used only to find sibling
 * scripts and vitest configs - things that genuinely travel with the toolset.
 *
 * That makes a single shared toolset safe: two repos running the same scripts
 * write to their own `.claude/charpilot/out`, where before they would have
 * overwritten each other's baseline.
 */
const SELF_ROOT = process.env.CHARPILOT_SELF_ROOT
  ? resolve(process.env.CHARPILOT_SELF_ROOT)
  : process.cwd();
export const TARGET_ROOT = process.env.CHARPILOT_TARGET_ROOT
  ? resolve(process.env.CHARPILOT_TARGET_ROOT)
  : SELF_ROOT;
export const IS_FOREIGN_TARGET = TARGET_ROOT !== SELF_ROOT;
export const REPO_ROOT = TARGET_ROOT;
export const SELF_REPO_ROOT = SELF_ROOT;
export const PILOT_DIR = here;
// In the repo being measured, never beside the tools - a shared toolset must not
// collect seven repos' artifacts in one directory.
export const OUT_DIR = resolve(SELF_ROOT, ".claude", "charpilot", "out");

/**
 * THE INCREMENTAL RECORD, AND ITS KILL SWITCH (docs/speed/README.md item 6b).
 *
 * On by default: a row is recorded again only when its proposal, the repo's
 * code it depends on (sourcedeps.mjs) or record.mjs's OBSERVATION_VERSION
 * changed, a row cigate finds red that another toolset recorded is recorded
 * again before it is withheld, and determinism observes only the rows that
 * carry no verdict.
 *
 * `CHARPILOT_INCREMENTAL_RECORD=off` (or 0, false, no) puts back what came
 * before, all of it: the record cache keyed on the whole recorder, no row taken
 * from the artifact on disk, no source stamps, every row observed a second
 * time, and cigate's red rows withheld without being recorded again. For the
 * day the incremental record is the suspect.
 */
export const INCREMENTAL_RECORD = !/^(off|0|false|no)$/i.test(String(process.env.CHARPILOT_INCREMENTAL_RECORD ?? "").trim());

/**
 * WHICH RENDERER DREW THE EMITTED SPECS: a digest of record.mjs, whose template
 * every spec is, or null when it cannot be read.
 *
 * A cigate verdict is about a TEST, and a test is the recording as this file
 * renders it. So a quarantine entry names the renderer as well as the
 * recording (record.mjs `bindQuarantine`, cigate.mjs `supersededEntry`,
 * steps/emit.mjs `unboundQuarantine`): when the renderer has been replaced
 * since the verdict, the row is rendered to run again and cigate judges it
 * once more, rather than staying `it.skip` under a reason an older template
 * earned.
 */
export function emitterDigest(file = join(here, "record.mjs")) {
  try {
    return createHash("sha1").update(readFileSync(file, "utf8")).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Refuse a CWD that is not a package root.
 *
 * Deriving the repo from the CWD is what lets one toolset serve every checkout,
 * and it fails silently in exactly one way: run a tool from somewhere else and
 * it writes `<somewhere-else>/.claude/charpilot/out`, producing a clean-looking
 * baseline for a repo that was never scanned. Every other check in this
 * pipeline exists because a wrong number looked deliberate, so this refuses
 * rather than guards.
 */
/**
 * WHERE OUR FILES GO IN THE REPO (tool backlog; verifier on PR #38).
 *
 * A repo whose own suite runs on vitest keeps them where they always were:
 * test/characterization/*.char.test.ts, test/fixtures/doubles.ts,
 * test/src-exclude.mjs. A repo whose suite runs on ANOTHER runner (runner.mjs
 * action "alongside": jest, `node --test`, mocha, ...) must not have them
 * collected by it - candidate-ms's `node --test test/**` expands to every entry
 * of test/, and node's and jest's default globs match `*.test.*` and anything
 * under test/. So there they live in a root-level characterization/, named
 * `*.char.ts`, which neither runner's defaults collect. install.sh records the
 * choice in .claude/charpilot/layout.json; nothing else decides it.
 */
const layoutDoc = (() => {
  try {
    return JSON.parse(readFileSync(resolve(TARGET_ROOT, ".claude", "charpilot", "layout.json"), "utf8"));
  } catch {
    return null;
  }
})();
export const LAYOUT = layoutDoc?.name === "alongside" ? "alongside" : "default";
export const CORPUS_REL = LAYOUT === "alongside" ? "characterization" : "test/characterization";
export const CORPUS_SUFFIX = LAYOUT === "alongside" ? ".char.ts" : ".char.test.ts";
export const FIXTURES_REL = LAYOUT === "alongside" ? "characterization/fixtures" : "test/fixtures";
export const SRC_EXCLUDE_REL = LAYOUT === "alongside" ? "characterization/src-exclude.mjs" : "test/src-exclude.mjs";
/** Is this file name one of the emitted suite's specs, in either layout? */
export const isCorpusSpec = (name) => String(name).endsWith(CORPUS_SUFFIX) || String(name).endsWith(".test.ts");

const selfExclude = await import(pathToFileURL(resolve(SELF_ROOT, SRC_EXCLUDE_REL)).href).catch(() => ({}));

/**
 * WHERE THE SOURCE IS, which is `src/` on all but a couple of these services.
 *
 * candidate-ms and contact-ms keep their TypeScript at the REPO ROOT - server.ts
 * beside routes/, service/, core/, middlewares/ - and every tool here globbed
 * `src/**\/*.ts`, so the scan found 0 files and refused, which is the correct
 * behaviour for a misconfiguration and the wrong answer for a layout.
 *
 * Declared by the SUITE beside the other scope constants, because it is the same
 * kind of fact as `coverage.include` and belongs with it. The default is "src",
 * so a repo that does not mention it is unaffected; "." means the repo root.
 *
 * A root-rooted repo leans on tsconfig to bound the walk: with no `include`,
 * TypeScript takes everything under the project except `node_modules` and
 * `outDir`, which is the file set we want. SRC_EXCLUDE still carves out specs
 * and declarations.
 */
//
// DETECTED when nothing declares it (tool backlog; srcdir.mjs): a tsconfig
// rootDir, then src/, then a tsconfig include, then the root. A FOREIGN target
// (the bench) used to be "src" unconditionally, so a root-rooted repo scanned
// nothing there while its own src-exclude.mjs said ".". Now the target's own
// declaration is read, and detection is the same one install.sh wrote from.
const targetExclude = IS_FOREIGN_TARGET
  ? await import(pathToFileURL(resolve(TARGET_ROOT, SRC_EXCLUDE_REL)).href).catch(() => ({}))
  : selfExclude;
export const SRC_DIR = targetExclude.SRC_DIR ?? detectSrcDir(TARGET_ROOT) ?? "src";
export const SRC_ROOT = resolve(REPO_ROOT, SRC_DIR);
// The glob every ts-morph walk uses. Absolute, because a relative glob resolves
// against process.cwd() and not the project root.
export const SRC_GLOB = join(SRC_ROOT, "**/*.ts");

if (!existsSync(resolve(SELF_ROOT, "package.json")) || !existsSync(resolve(SELF_ROOT, SRC_DIR))) {
  throw new Error(
    `charpilot: ${SELF_ROOT} is not a package root - it has no package.json and ${SRC_DIR}/ together.\n` +
      `  The tools resolve the repo from the CWD so one shared toolset can serve every checkout.\n` +
      `  Run them from the package root (that is what the pilot:* npm scripts do), or set CHARPILOT_SELF_ROOT.\n` +
      `  A repo whose TypeScript is NOT under src/ declares \`export const SRC_DIR\` in test/src-exclude.mjs ("." for the repo root).`
  );
}
export const TSCONFIG = resolve(REPO_ROOT, process.env.CHARPILOT_TSCONFIG ?? "tsconfig.json");

/**
 * Where the per-repo vitest configs live, which is NOT where the tools live.
 *
 * The four charpilot vitest configs cannot be shared: each one extends the
 * host's own `vitest.config.*` by a relative path, and vite has to be the one
 * to load that file - it injects the `__dirname` / `__filename` shims the host
 * config uses, which a plain dynamic `import()` does not. Measured: resolving
 * the base config from the CWD instead threw `__dirname is not defined in ES
 * module scope` out of this repo's own vitest.config.mts.
 *
 * So the configs stay in the target next to `out/`, and only the scripts are
 * shared.
 */
export const CONFIG_DIR = resolve(SELF_ROOT, ".claude", "charpilot");
export const VITEST_CONFIG = resolve(CONFIG_DIR, "vitest.charpilot.config.mts");
export const COVERAGE_DIR = resolve(REPO_ROOT, "coverage-charpilot");

/**
 * The host's vitest MAJOR, because the arm denominator depends on it.
 *
 * vitest 4 stopped emitting a branch for a downlevelled TS `enum`, and vitest 2
 * and 3 still do. Measured on one probe - one `enum`, one `const enum`, one
 * `namespace`, one `if` - run under three versions with the istanbul provider
 * pinned to each:
 *
 *   vitest 2.1.9   enum 2 arms · const enum 2 arms · namespace 2 arms
 *   vitest 3.2.4   enum 2 arms · const enum 2 arms · namespace 2 arms
 *   vitest 4.1.10  enum 0 arms · const enum 0 arms · namespace 2 arms
 *
 * The function count did not move: all three count one function per enum and
 * per namespace, so only the ARM model is version-dependent. The namespace is
 * still `N || (N = {})` under 4, which is why it is not gated with the enums.
 *
 * Unknown rather than zero when vitest cannot be read: scan.mjs keeps the
 * pre-4 model in that case, which is the model this pipeline shipped with.
 */
export const VITEST_MAJOR = (() => {
  const major = (version) => {
    const n = Number.parseInt(String(version ?? "").replace(/^[^0-9]*/, ""), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const read = (...parts) => {
    try {
      return JSON.parse(readFileSync(resolve(REPO_ROOT, ...parts), "utf8"));
    } catch {
      return undefined;
    }
  };
  // The INSTALLED version first: that is the one that will transform the
  // source, and a range in package.json is not a version.
  const installed = major(read("node_modules", "vitest", "package.json")?.version);
  if (installed) return installed;
  // Then the lockfile, then the declared range - so a scan run before
  // `npm ci`, or after a cleanup that dropped node_modules, still models the
  // right runner instead of silently falling back to the pre-4 model.
  const locked = major(read("package-lock.json")?.packages?.["node_modules/vitest"]?.version);
  if (locked) return locked;
  const pkg = read("package.json") ?? {};
  return major(pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest);
})();

export const BASELINE_JSON = resolve(OUT_DIR, "baseline.json");
// A foreign benchmark target must never overwrite this service's own scan.
// CHARPILOT_SCAN_OUT redirects it; the default is unchanged.
export const SCAN_JSON = process.env.CHARPILOT_SCAN_OUT
  ? resolve(process.env.CHARPILOT_SCAN_OUT)
  : IS_FOREIGN_TARGET
    ? resolve(OUT_DIR, "bench", `${TARGET_ROOT.split("/").filter(Boolean).pop()}.scan.json`)
    : resolve(OUT_DIR, "scan.json");

// Kept identical to vitest.config.mts coverage.exclude so the AST scan and the
// istanbul denominator describe the same set of files. If one moves, move both.
// Re-exported, not defined here. The coverage scope belongs to the suite - see
// test/src-exclude.mjs for why the dependency runs this way round.
// Loaded from the TARGET at runtime, not imported by a path relative to these
// tools. A static `../../test/src-exclude.mjs` resolves next to whichever
// checkout the scripts happen to sit in, which is the coupling that made a copy
// of the toolset mandatory in every repo. Top-level await is fine in ESM, and a
// repo with no such file gets empty lists rather than a crash - the installer
// writes one, so an absent file means the target was never installed.
const SELF_SRC_EXCLUDE = selfExclude.SRC_EXCLUDE ?? [];
const SELF_TYPE_ONLY_DIRS = selfExclude.TYPE_ONLY_DIRS ?? [];

/**
 * The coverage scope. It belongs to the SUITE, not to this pipeline - which is
 * why it is re-exported from test/ rather than defined here.
 *
 * A foreign benchmark target gets an EMPTY list rather than this service's:
 * `src/index.ts` and `src/instrumentation.ts` are excluded here because this
 * service's own vitest config excludes them, and silently applying that to
 * someone else's repo would drop files from their denominator for a reason
 * that has nothing to do with their code.
 */
/**
 * Test files are never source, whoever's list this is.
 *
 * An explicit `coverage.exclude` REPLACES vitest's default exclude, and that
 * default is the only thing that keeps a repo's own `src/**\/__tests__/**` and
 * `*.test.ts` out of an `all: true` report. Measured on turing-integration-ms
 * (run 20260923T052910Z): the host list was three concrete paths, so istanbul
 * loaded `src/middlewares/__tests__/altosApiKey.middleware.test.ts` as
 * uncovered source, vitest's mock hoister spliced `vi.mock(` onto istanbul's
 * `})`, the parse failed, and no round ever wrote coverage.json.
 *
 * So these ride on top of the host list - and on a foreign target too, where
 * the host list is empty. The scan reads the same list through isSrcExcluded,
 * so a repo whose tsconfig does not already exclude its tests gets the same
 * file set in both. The patterns are vitest's own default spellings, which is
 * why globToRegExp below reads `{a,b}`, `?(a|b)` and `[jt]`.
 */
// `**/__mocks__/**` too: a jest/vitest manual mock is test support, not source,
// and upstream 5d2d7be excludes it from stage 6, so the scan must agree.
export const TEST_FILE_EXCLUDE = ["**/__tests__/**", "**/__mocks__/**", "**/*.{test,spec}.?(c|m)[jt]s?(x)"];

/**
 * A ROOT-ROOTED REPO'S SOURCE WALK MUST NOT FIND OURS (tool backlog:
 * candidate-ms). With SRC_DIR "." the scan's walk and istanbul's include are
 * the whole repo, so our own test/fixtures/doubles.ts, the emitted suite, the
 * toolset under .claude/ and the reports we write were counted as the
 * service's source. Excluded, with the build and dependency directories, only
 * when the source IS the root; a src/ repo never sees them.
 */
export const ROOT_LAYOUT_EXCLUDE = [
  "test/fixtures/doubles.ts", "test/characterization/**", "characterization/**", ".claude/**",
  "node_modules/**", "dist/**", "build/**", "coverage/**", "coverage-charpilot/**", "coverage-charpilot-stage6/**",
  "**/*.d.ts",
];
export const SRC_EXCLUDE = [
  ...new Set([...(IS_FOREIGN_TARGET ? [] : SELF_SRC_EXCLUDE), ...TEST_FILE_EXCLUDE, ...(SRC_DIR === "." ? ROOT_LAYOUT_EXCLUDE : [])]),
];

/**
 * WHAT ISTANBUL MEASURES, in the same directory the scan walks (tool backlog).
 * Both vitest configs hard-coded `src/**\/*.ts`, so a repo whose TypeScript
 * is at the root (candidate-ms, contact-ms without its own coverage block)
 * measured ZERO files against a scan of 1179 arms.
 */
export const COVERAGE_INCLUDE = [SRC_DIR === "." ? "**/*.ts" : `${SRC_DIR}/**/*.ts`];

/**
 * SRC_EXCLUDE mirrors the host's `coverage.exclude`, and istanbul reads that
 * list as GLOBS. Comparing it with `.includes(file)` only ever matched the
 * concrete paths in it, so a globbed entry excluded the file from istanbul's
 * denominator and not from the scan - the exact drift SRC_EXCLUDE exists to
 * prevent. Measured on company-enrich, whose config excludes
 * `src/**\/types.ts`.
 *
 * Deliberately small: `**`, `*` and `?`, plus `{a,b}`, `?(a|b)` and `[jt]`
 * because TEST_FILE_EXCLUDE is written in vitest's own spelling. A leading
 * `./` is dropped so `./src/x.ts` and `src/x.ts` are one entry, and a bare
 * directory (`src/types`) matches everything under it, which is how the same
 * string reads in a coverage config.
 */
export function globToRegExp(pattern) {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    // `?(a|b)` - zero or one of the alternatives (extglob). Checked before the
    // bare `?`, which is one character.
    if (c === "?" && clean[i + 1] === "(") {
      const end = clean.indexOf(")", i);
      if (end > i) {
        const alts = clean.slice(i + 2, end).split("|").map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&"));
        out += `(?:${alts.join("|")})?`;
        i = end;
        continue;
      }
    }
    // `{a,b}` - one of the alternatives.
    if (c === "{") {
      const end = clean.indexOf("}", i);
      if (end > i) {
        const alts = clean.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&"));
        out += `(?:${alts.join("|")})`;
        i = end;
        continue;
      }
    }
    // `[jt]` - one character of the class.
    if (c === "[") {
      const end = clean.indexOf("]", i);
      if (end > i + 1) {
        out += `[${clean.slice(i + 1, end).replace(/[\\\]^]/g, "\\$&")}]`;
        i = end;
        continue;
      }
    }
    if (c === "*") {
      if (clean[i + 1] === "*") {
        // `**/` spans zero or more directories; a trailing `**` spans the rest.
        if (clean[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A directory entry excludes its whole subtree, as it does in a glob matcher.
  return new RegExp(`^${out}(?:/.*)?$`);
}

const SRC_EXCLUDE_MATCHERS = SRC_EXCLUDE.map(globToRegExp);

/** Is this src-relative path one the host's coverage.exclude removes? */
export function isSrcExcluded(file) {
  const path = String(file).replace(/^\.\//, "");
  return SRC_EXCLUDE_MATCHERS.some((re) => re.test(path));
}
export const TYPE_ONLY_DIRS = IS_FOREIGN_TARGET ? [] : SELF_TYPE_ONLY_DIRS;



/**
 * The stage-3 brief. Redirectable per target, because the guard chain
 * (worklist -> validate -> ledger) joins on arm ids and a foreign repo's ids
 * would otherwise be reconciled against this service's brief.
 */
const BENCH = IS_FOREIGN_TARGET ? resolve(OUT_DIR, "bench", TARGET_ROOT.split("/").filter(Boolean).pop()) : null;
export const WORKLIST_JSON = process.env.CHARPILOT_WORKLIST_OUT
  ? resolve(process.env.CHARPILOT_WORKLIST_OUT)
  : BENCH
    ? `${BENCH}.worklist.json`
    : resolve(OUT_DIR, "worklist.json");
export const WORKLIST_MD = BENCH ? `${BENCH}.worklist.md` : resolve(OUT_DIR, "worklist.md");
// NOT in out/. Everything in out/ is regenerable; proposals are hand-authored
// derivations and are the one artifact of this pipeline that cannot be rebuilt.
/**
 * Hand-authored derivations. Tracked in git - the one artifact of this pipeline
 * that cannot be rebuilt by running something.
 *
 * A FOREIGN target gets its own subdirectory. Arm ids are `file#line:kind:index`
 * and carry no repo, so proposals for 16 repos in one directory would collide on
 * id and the ledger would reconcile one repo's proposals against another repo's
 * scan - reporting cross-repo nonsense as unaccounted sides.
 */
export const PROPOSALS_DIR = process.env.CHARPILOT_PROPOSALS_DIR
  // PLAN 20 T2.4: `checkrow.mjs` points validate.mjs and record.mjs at a
  // SCRATCH COPY of the proposals, so a worker can check one row it has not
  // submitted yet without anything in the real corpus moving. Never set by the
  // pipeline itself.
  ? resolve(process.env.CHARPILOT_PROPOSALS_DIR)
  : IS_FOREIGN_TARGET
  ? resolve(here, "proposals", "bench", TARGET_ROOT.split("/").filter(Boolean).pop())
  : resolve(here, "proposals");

export const BEHAVIOUR_JSON = resolve(OUT_DIR, "behaviour.json");
/**
 * The doubles are a TEST dependency, so they live with the tests.
 *
 * They used to sit under this pipeline directory, and all 33 generated suites
 * imported out of it - so `npm test` depended on the pipeline, and anyone
 * deleting or relocating it as "just tooling" broke the whole characterization
 * suite. Nothing said so. They import node builtins only, so the move costs
 * nothing and makes the suite self-contained.
 */
export const FIXTURES_DIR = resolve(REPO_ROOT, FIXTURES_REL);

/**
 * The staging database, as a TRIPLE. Never a host allow-list - and never a
 * hard-coded service name either.
 *
 * WHY THE TRIPLE, which has not changed: `34.143.159.14` serves staging on
 * :5434 AND `tracy-log` on :5433, and that second one is referenced from a
 * PRODUCTION deployment manifest (qode-iac
 * manifests/deployments/production/turing-log-view.yaml:62), so a host check
 * waves a production database straight through. The database NAME matters just
 * as much: ONE staging credential reaches any service's database by swapping
 * it, and the two triples measured so far differ in nothing else -
 * `34.143.159.14:5434/ai-centralization-ms` here,
 * `34.143.159.14:5434/ptp_stg_new` on ptp-be. Host, port AND database are
 * therefore all asserted, and a mismatch refuses the run rather than warning
 * about it.
 *
 * WHAT CHANGED is only where the EXPECTATION comes from. It was the literal
 * `{ 34.143.159.14, 5434, ai-centralization-ms }`, which made `--live` refuse
 * on every other repo for a reason that had nothing to do with safety:
 *
 *     ✗ record.mjs --live: refusing to run - DATABASE_URL database is
 *       "ptp_stg_new", expected "ai-centralization-ms".
 *
 * The target already knows its own answer. Stage 1 resolves the staging
 * environment from the qode-iac manifests - no kubectl, no DNS, no probe - and
 * writes `out/staging.env`, so its `DATABASE_URL` IS "the staging database of
 * the repo being recorded", established by provenance instead of by being typed
 * here.
 *
 * It was NOT, however, derived from anything independent of the value under
 * test, and that is the defect this version fixes. `out/staging.env` is
 * precisely what the canonical live command passes as `--env-file`:
 *
 *     record.mjs --policy real-except-cache --live \
 *       --env-file .claude/charpilot/out/staging.env
 *
 * so on its own documented invocation the guard compared that file with itself
 * and could not fail. Measured: a repo whose `out/staging.env` names
 * `34.143.159.14:5433/tracy-log` - the database a PRODUCTION manifest
 * references, and the exact case the paragraph above cites - recorded
 * `dbAsserted: {5433, tracy-log}` and no refusal. Under the old hard-coded
 * literal that refused. A guard that cannot fail is worse than no guard,
 * because it reads as protection.
 *
 * The provenance of that file is also weaker than it looks: stagingenv.mjs
 * rewrites only HOST and PORT from the qode-iac manifests, `--namespace` is
 * user-supplied and defaults to `staging` rather than being verified, and the
 * database NAME is carried through from the `--env <service .env>` the operator
 * passed - a local `.env` that is frequently not staging at all.
 *
 * So `out/staging.env` is no longer trusted on its own. It is CORROBORATED
 * against `out/staging-env.json`, the stage-1 report, which is a different file
 * with different content: see corroborateStagingEnv() below for what it can
 * attest and what it cannot.
 *
 * Resolution order, and there is no third source:
 *
 *   1. `CHARPILOT_EXPECTED_DB` - an explicit override, with all three parts
 *      spelled out (`host:port/database`, or a DSN carrying an explicit port
 *      and database). A partial override is REFUSED, never completed with a
 *      default: "we asserted the database" quietly becoming "we asserted the
 *      host" is the one failure this guard exists to prevent. This one is typed
 *      by a person and cannot be the file under test, so it needs no
 *      corroboration - and it no longer widens the egress allowlist either
 *      (see exec.mjs allowedHosts).
 *   2. `out/staging.env`'s DATABASE_URL, written by stage 1 for THIS repo,
 *      AND corroborated by `out/staging-env.json`. Either both agree or the run
 *      refuses; one file vouching for itself is not evidence.
 *   3. Refuse. An expectation that cannot be determined must never become a
 *      silent pass - that would turn the only guard between this pipeline and a
 *      production database into a no-op on every repo that had not run stage 1,
 *      which is exactly the repos where nobody has checked yet.
 *
 * No DSN is ever printed, logged or stored: it carries a password. Only the
 * three fields are reported, and a database name is not a credential. That
 * promise covers EVERY refusal path here, which it previously did not - see
 * dbTriple() on three-slash DSNs.
 */
export const STAGING_ENV = resolve(OUT_DIR, "staging.env");
/**
 * The stage-1 REPORT, and the reason the guard is no longer a self-comparison.
 * Written by the same stagingenv.mjs run as STAGING_ENV, but from the qode-iac
 * manifests and with the DSN reduced to a fingerprint - so it can contradict
 * the env file, which is the whole point.
 */
export const STAGING_REPORT = resolve(OUT_DIR, "staging-env.json");

const DB_KEYS = ["host", "port", "database"];

/**
 * Protocol defaults, so an omitted port is compared as the port that is
 * actually used rather than as the empty string - `""` on both sides would be
 * a triple check that had quietly stopped checking one third of the triple.
 */
const DEFAULT_PORT = { "postgres:": "5432", "postgresql:": "5432", "mysql:": "3306" };

/**
 * A database name with nothing else attached to it.
 *
 * Belt and braces for the leak dbTriple() refuses below: any userinfo that
 * reached a path is dropped with everything before the `@`, and a query string
 * (`?sslmode=`, `?password=`) is dropped with everything after the `?`. Applied
 * where the name is EXTRACTED and again where it is RENDERED, because either
 * one alone is one edit away from printing a password.
 */
const safeDbName = (d) =>
  String(d ?? "")
    .replace(/^.*@/, "")
    .replace(/[?#].*$/, "");

/**
 * host / port / database out of a DSN, and nothing else out of it. `who`
 * appears in the error; the DSN never does.
 */
/**
 * FIX PLAN 1, RULE 2 — EVERY DATABASE GUARD CARRIES ONE MARKER, NOT A WORDING.
 *
 * These refusals keep a run's work off the remote: a DSN that may be
 * production, or no expectation to check one against. They surface in a
 * child's stderr, so the marker is text: workflow.mjs and steps/preflight.mjs
 * import SAFETY_MARKER and map it to EXIT_SAFETY, whatever the sentence after
 * it says. In-process callers can read `err.code === "CHARPILOT_SAFETY"`.
 */
export const SAFETY_MARKER = "[charpilot:safety:production-database]";

function safetyError(message) {
  const e = new Error(`${SAFETY_MARKER} ${message}`);
  e.code = "CHARPILOT_SAFETY";
  return e;
}

function dbTriple(dsn, who) {
  let u;
  try {
    u = new URL(dsn);
  } catch {
    throw safetyError(`${who} is not a parseable database URL - refusing to run (the value is not printed: a DSN carries a password)`);
  }
  /**
   * A DSN with no authority, which is where the refusal became the leak.
   *
   * `postgresql:///user:PW@34.143.159.14:5434/db` PARSES - three slashes means
   * an empty authority - and everything that should have been the authority
   * lands in `pathname`. So `database` was `user:PW@34.143.159.14:5434/db` and
   * the mismatch refusal rendered it verbatim:
   *
   *     refusing to run - DATABASE_URL is :5432/user:PW@34.143.159.14:5434/db
   *
   * printing the password to stdout, into a CI log, and into whatever the
   * operator pastes next. A three-slash typo in a hand-edited `.env` is exactly
   * the input that produces it. Refused HERE, before anything derived from the
   * value can be rendered, and the value is not shown.
   */
  if (u.hostname === "") {
    throw safetyError(
      `${who} has no host - refusing to run (the value is not printed: a DSN carries a password).\n` +
        `  A "postgresql:///…" with three slashes parses as an EMPTY authority, so the credentials end up where the path belongs. Check for one slash too many.`
    );
  }
  const explicitPort = u.port !== "";
  const port = explicitPort ? u.port : (DEFAULT_PORT[u.protocol] ?? "");
  return {
    host: u.hostname,
    port,
    database: safeDbName(u.pathname.replace(/^\//, "")),
    portFrom: explicitPort ? "explicit" : port ? `${u.protocol.replace(":", "")} default` : "absent",
  };
}

/** `host:port/database`, the only rendering of a DSN that is safe to print. */
export function dbWhere(t) {
  return `${t.host}:${t.port}/${safeDbName(t.database)}`;
}

/** `DATABASE_URL` out of a stage-1 env file, without loading the rest of it into this process. */
function databaseUrlFrom(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/** `CHARPILOT_EXPECTED_DB=none`, in any case. */
export function isNoDatabase(value) {
  return String(value ?? "").trim().toLowerCase() === "none";
}

/**
 * A DATABASE-LOOKING VARIABLE, by name or by value - the one detector every
 * `none` check uses (config.mjs, stagingenv.mjs, and its mirror in
 * docker/char/packs/nodejs.py, which a pytest keeps identical).
 *
 * `DATABASE_URL*` alone was not the fleet. qode-iac staging manifests carry
 * `DB_URL` / `DB_USERNAME` / `DB_PASSWORD` (email-sequence-ms, emaillogs-ms,
 * communication-ms, forwarder-ms-pricing), `DB_HOST` / `DB_NAME` / `DB_PORT`
 * (qode-sentinel-ms), `PGHOST`, `POSTGRES_URL`, `*_DATABASE_URL`; and a Mongo
 * service says `MONGODB_URI`. Under `none` each of those passed preflight,
 * kept its host on the egress list, and reached a database nothing asserted.
 *
 * Widened after an adversarial check: DATABASE_HOST / _NAME / _PASSWORD,
 * Prisma's DIRECT_URL, a bare DB or CONNECTION_STRING, TYPEORM_*, MSSQL_*,
 * CLICKHOUSE_*, and the values `postgresql+asyncpg://`, `jdbc:<driver>:`,
 * `mysql2://`, `clickhouse://`, ADO (`Host=..;Database=..`) and libpq
 * (`host=.. dbname=..`) connection strings.
 *
 * NOT redis: policy.mjs mocks it at `ioredis` as the one legitimate cache
 * boundary, so a REDIS_* key is not a database here. NOT a pool setting
 * (`DB_POOL_MAX`) or a bare `*_DB` index, which name no address. A VALUE with a
 * database scheme counts whatever its key, which is what catches the names
 * this list has not met yet.
 */
export const DATABASE_KEY_SOURCE =
  "^(?:SVC_)?(?:" +
  "DATABASE_URL\\w*" +
  "|\\w+_DATABASE_URL\\w*" +
  "|(?:\\w+_)?DATABASE_(?:URI|DSN|HOST|HOSTNAME|NAME|PORT|USER|USERNAME|PASS|PASSWORD|CONNECTION_STRING|CONN_STRING)(?:_\\w+)?" +
  "|(?:\\w+_)?DB_(?:URL|URI|DSN|HOST|HOSTNAME|NAME|PORT|USER|USERNAME|PASS|PASSWORD|DATABASE|CONNECTION_STRING|CONN_STRING)(?:_\\w+)?" +
  "|DB" +
  "|DIRECT_URL" +
  "|CONNECTION_STRING" +
  "|TYPEORM_\\w+" +
  "|MONGO(?:DB)?(?:_\\w+)?" +
  "|\\w+_MONGO(?:DB)?_(?:URI|URL|HOST)\\w*" +
  "|POSTGRES(?:QL)?_\\w+" +
  "|PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|URL|URI)\\w*" +
  "|MYSQL_\\w+" +
  "|MARIADB_\\w+" +
  "|MSSQL_\\w+" +
  "|SQLSERVER_\\w+" +
  "|CLICKHOUSE_\\w+" +
  "|COCKROACH\\w*" +
  ")$";
export const DATABASE_VALUE_SOURCE =
  "^\\s*[\\\"']?(?:jdbc:[a-z0-9]+:|(?:postgres(?:ql)?|mysql2?|mariadb|mongodb(?:\\+srv)?|mssql|sqlserver|cockroachdb|clickhouse)(?:\\+[a-z0-9]+)?://)" +
  "|\\b(?:host|server|data source)\\s*=[^;]*;.*\\b(?:database|initial catalog)\\s*=" +
  "|\\bhost=\\S+.*\\bdbname=";
const DATABASE_KEY = new RegExp(DATABASE_KEY_SOURCE, "i");
const DATABASE_VALUE = new RegExp(DATABASE_VALUE_SOURCE, "i");

/** Is this variable a database, by its name or by the scheme of its value? */
export function isDatabaseVar(key, value = "") {
  return DATABASE_KEY.test(String(key ?? "")) || DATABASE_VALUE.test(String(value ?? ""));
}

/**
 * TOOL BACKLOG, DEFENCE IN DEPTH: WHAT A DATABASE VARIABLE HOLDS WHERE NO
 * DATABASE MAY BE REACHED. An address that resolves nowhere (`.invalid` is
 * reserved, RFC 6761), in the variable's own shape: a URL keeps its scheme, a
 * host is a host, a port a port. Then a real client that somehow got past
 * every deny still connects to nothing.
 */
export const DATABASE_PLACEHOLDER_HOST = "db.invalid";
export function databasePlaceholder(key, value = "") {
  const k = String(key ?? "").toUpperCase();
  const scheme = /^\s*["']?(mongodb(?:\+srv)?|mysql2?|mariadb|mssql|sqlserver|cockroachdb|clickhouse|postgres(?:ql)?):\/\//i.exec(String(value ?? ""))?.[1]?.toLowerCase();
  if (/PORT/.test(k)) return "5432";
  if (/(HOST|HOSTNAME|HOSTADDR|SERVER)(_|$)/.test(k)) return DATABASE_PLACEHOLDER_HOST;
  if (/(USER|USERNAME)(_|$)/.test(k)) return "charpilot";
  if (/(PASS|PASSWORD)(_|$)/.test(k)) return "charpilot-placeholder";
  if (/(^DB$|_NAME$|_DATABASE$|^PGDATABASE)/.test(k)) return "charpilot";
  if (scheme?.startsWith("mongodb")) return `mongodb://charpilot@${DATABASE_PLACEHOLDER_HOST}:27017/charpilot`;
  if (scheme && /mysql|mariadb/.test(scheme)) return `mysql://charpilot@${DATABASE_PLACEHOLDER_HOST}:3306/charpilot`;
  if (/MONGO/.test(k)) return `mongodb://charpilot@${DATABASE_PLACEHOLDER_HOST}:27017/charpilot`;
  if (/MYSQL|MARIADB/.test(k)) return `mysql://charpilot@${DATABASE_PLACEHOLDER_HOST}:3306/charpilot`;
  return `postgresql://charpilot@${DATABASE_PLACEHOLDER_HOST}:5432/charpilot`;
}

/** Every database-looking variable of `env`, replaced in place by its placeholder. Returns `env`. */
export function maskDatabaseEnv(env) {
  for (const [k, v] of Object.entries(env ?? {})) {
    if (isDatabaseVar(k, v)) env[k] = databasePlaceholder(k, v);
  }
  return env;
}

/**
 * Every database-looking KEY that carries a value, never the value. Read from
 * an env map and from env files, because a DSN in either is one a run could use.
 */
export function databaseKeysIn({ env = process.env, files = [] } = {}) {
  const found = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (String(v ?? "").trim() && isDatabaseVar(k, v)) found.push(`${k} (environment)`);
  }
  for (const f of files) {
    if (!f || !existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[2].trim().replace(/^["']|["']$/g, "") && isDatabaseVar(m[1], m[2])) found.push(`${m[1]} (${f})`);
    }
  }
  return found;
}

/**
 * The `none` assertion: pass only when there is no DSN anywhere to assert.
 *
 * `url` is the DSN under test; the environment and out/staging.env are read
 * too, because under `none` ANY DATABASE_URL* means the expectation is wrong -
 * either the service has a database after all, or something handed the run
 * one. Keys are named, values never.
 */
function assertNoDatabase(url, who) {
  const found = databaseKeysIn({ files: [STAGING_ENV] });
  if (url && String(url).trim()) found.unshift("the DATABASE_URL under test");
  // `none` records mocked, always: a live run has nothing to assert a database
  // against, so it is refused rather than let through on the flag.
  const mode = String(process.env.CHARPILOT_MODE ?? "").trim().toLowerCase();
  if (mode === "live") {
    throw safetyError(
      `${who}: refusing to run against an unknown database - CHARPILOT_EXPECTED_DB=none forces a mocked run, and CHARPILOT_MODE=live asks for a live one.\n` +
        `  Set CHARPILOT_MODE=mocked, or name the staging database: CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }
  if (found.length) {
    throw safetyError(
      `${who}: refusing to run against an unknown database - CHARPILOT_EXPECTED_DB=none says this service has no database, and a DSN is present: ${[...new Set(found)].join(", ")}.\n` +
        `  \`none\` can never approve a DSN (the value is not printed). If the service does use a database, name it: CHARPILOT_EXPECTED_DB=host:port/database. If it does not, remove the database variables.`
    );
  }
  return { none: true, host: null, port: null, database: null, assertedBy: "CHARPILOT_EXPECTED_DB=none - no database-looking variable in the environment or out/staging.env" };
}

/** `<redacted: 122 chars, sha256:209f2438>` -> `{ length, sha }`, or null. */
function reportedFingerprint(v) {
  const m = /^<redacted: (\d+) chars, sha256:([0-9a-f]+)>$/.exec(String(v ?? ""));
  return m ? { length: Number(m[1]), sha: m[2] } : null;
}

/**
 * Does the stage-1 REPORT vouch for out/staging.env's DATABASE_URL, or
 * contradict it?
 *
 * This is what stops the guard being a comparison of a file with itself. The
 * report is written from the qode-iac manifests, not from the env file, and it
 * carries four things the env file does not:
 *
 *   namespace                  WHICH namespace's manifests were read.
 *                              `--namespace` is user-supplied and defaults to
 *                              `staging`, so `--namespace production` is how a
 *                              production DSN legitimately ends up in a file
 *                              called staging.env. Anything but `staging`
 *                              refuses.
 *   vars.DATABASE_URL.from     which source WON the merge. A qode-iac staging
 *                              manifest is provenance; the operator's local
 *                              `.env` is not, and the last writer wins - so a
 *                              `.env` DATABASE_URL silently becomes "the
 *                              staging database" without this check. Measured
 *                              across six installed repos: five say
 *                              `qode-iac secret`/`qode-iac configmap`, one has
 *                              no DATABASE_URL at all.
 *   databaseAddressRewrite.to  the `host:port` the address was rewritten TO,
 *                              i.e. the address a person typed as
 *                              `--db-address` rather than one this process read
 *                              back out of the file it is checking.
 *   vars.DATABASE_URL.value    `<redacted: N chars, sha256:xxxxxxxx>` - a
 *                              fingerprint of the DSN, never the DSN.
 *
 * The fingerprint is the load-bearing part, because it is the only one that
 * survives the report and the env file being written by the same run: a
 * staging.env hand-edited AFTERWARDS - swap `:5434/ai-centralization-ms` for
 * `:5433/tracy-log` and you have the reported defect - no longer matches it.
 *
 * WHAT THIS CANNOT DO, stated rather than implied: the report redacts the DSN,
 * so it cannot corroborate the database NAME directly. The name is pinned only
 * transitively, by the fingerprint of the whole DSN. That is why `from` is
 * checked too - it is the one signal that says whether the name came from a
 * staging manifest or from a laptop.
 */
function corroborateStagingEnv(dsn, t, how) {
  const refuse = (why, fix) => {
    throw safetyError(
      `charpilot: refusing to run - ${why}\n` +
        `  ${STAGING_ENV} is what the canonical live command passes as --env-file, so it cannot also be the only source of the expectation: that comparison passes always. ${STAGING_REPORT} has to agree with it.\n` +
        `  ${fix}\n${how}`
    );
  };

  if (!existsSync(STAGING_REPORT)) {
    refuse(
      `${STAGING_REPORT} does not exist, so nothing independent vouches for the DATABASE_URL in out/staging.env`,
      `Re-run stage 1 (npm run pilot:stagingenv) - it writes both files - or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }
  let report;
  try {
    report = JSON.parse(readFileSync(STAGING_REPORT, "utf8"));
  } catch {
    refuse(`${STAGING_REPORT} is not readable JSON, so it cannot corroborate anything`, `Re-run stage 1 (npm run pilot:stagingenv).`);
  }

  if (report.namespace !== "staging") {
    refuse(
      `stage 1 resolved the "${report.namespace ?? "(unrecorded)"}" namespace, not staging - so out/staging.env holds a ${report.namespace ?? "non-staging"} environment whatever its name says`,
      `Re-run stage 1 with --namespace staging, or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }

  const v = report.vars?.DATABASE_URL;
  if (!v) {
    refuse(`${STAGING_REPORT} records no DATABASE_URL, so it does not describe the value out/staging.env carries`, `Re-run stage 1 (npm run pilot:stagingenv).`);
  }
  if (!/^qode-iac\b/.test(String(v.from ?? ""))) {
    refuse(
      `the DATABASE_URL stage 1 resolved came from "${v.from ?? "(unrecorded)"}", not from a qode-iac staging manifest - a local .env wins the merge last and is frequently not staging at all`,
      `Re-run stage 1 without --env (or with an --env that does not override DATABASE_URL), or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }

  const fp = reportedFingerprint(v.value);
  if (!fp) {
    refuse(`${STAGING_REPORT} carries no DATABASE_URL fingerprint to compare against`, `Re-run stage 1 (npm run pilot:stagingenv).`);
  }
  const mine = createHash("sha256").update(dsn).digest("hex").slice(0, fp.sha.length);
  if (dsn.length !== fp.length || mine !== fp.sha) {
    refuse(
      `the DATABASE_URL in out/staging.env is NOT the one stage 1 resolved - the report fingerprints ${fp.length} chars/sha256:${fp.sha}, this file is ${dsn.length} chars/sha256:${mine}`,
      `That file has been edited since stage 1 ran, or the two artifacts are from different runs. Re-run stage 1 (npm run pilot:stagingenv), or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }

  // The address, from the report rather than from the file being checked. The
  // rewrite target is the strong form - a person typed it as --db-address - and
  // `vars.DATABASE_URL.host` is the fallback. Neither carries a port when there
  // was no rewrite, so the port is corroborated only when the report names one;
  // what pins it otherwise is the fingerprint above, and this says so rather
  // than implying a check it did not make.
  const to = String(report.databaseAddressRewrite?.to ?? "");
  const [reportHost, reportPort] = to ? to.split(":") : [v.host ?? "", ""];
  if (reportHost && reportHost !== t.host) {
    refuse(
      `the report resolved host ${reportHost}, out/staging.env carries ${t.host}`,
      `Re-run stage 1 (npm run pilot:stagingenv), or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }
  if (reportPort && reportPort !== t.port) {
    refuse(
      `the report resolved port ${reportPort}, out/staging.env carries ${t.port} - and the port is what separates staging from the production database on that host`,
      `Re-run stage 1 (npm run pilot:stagingenv), or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }
  if (!reportHost) {
    refuse(
      `${STAGING_REPORT} records no resolved database address, so the host in out/staging.env is corroborated by nothing`,
      `Re-run stage 1 with --db-address host:port, or state the triple explicitly with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }

  return {
    namespace: report.namespace,
    from: v.from,
    address: reportPort ? `${reportHost}:${reportPort}` : reportHost,
    portCorroborated: Boolean(reportPort),
    fingerprint: `sha256:${fp.sha}`,
  };
}

let expectedDbCache;
/**
 * Fingerprint of the DSN the expectation was READ FROM, when it came from
 * out/staging.env. Module-local on purpose: it must not reach the object
 * `expectedDb()` returns, because exec.mjs serialises that into exec-rows.json.
 * Used only to recognise a comparison of a value with itself - see
 * assertExpectedDb.
 */
let expectedDbSelfSha;

/**
 * The triple a `--live` run must match, or a refusal that says how to establish
 * one.
 *
 * Lazy and memoised. Importing this module has to stay side-effect free - the
 * gate's `tools-parse` check imports every tool in the directory - so nothing
 * here touches the filesystem until something actually asks, and a repo with no
 * stage-1 artifact can still load every tool.
 */
export function expectedDb() {
  if (expectedDbCache) return expectedDbCache;

  const override = (process.env.CHARPILOT_EXPECTED_DB ?? "").trim();
  // `none`: THIS SERVICE HAS NO DATABASE, stated by a person (fix plan 1,
  // F1.7). cv-parsing-ms has no DSN in any manifest, so there was no triple to
  // name and the pack refused it with exit 20. `none` names no host, so it can
  // never approve a DSN: assertExpectedDb refuses every database variable it can
  // see, and `fromStageOne: false` keeps every host out of exec.mjs's egress
  // allowlist - default-deny still blocks a database call.
  if (isNoDatabase(override)) {
    expectedDbCache = {
      none: true,
      host: null,
      port: null,
      database: null,
      source: "CHARPILOT_EXPECTED_DB=none",
      fromStageOne: false,
    };
    expectedDbSelfSha = undefined;
    return expectedDbCache;
  }
  if (override) {
    const t = override.includes("://")
      ? dbTriple(override, "CHARPILOT_EXPECTED_DB")
      : /^[^/:@\s]+:\d+\/[^/?\s]+$/.test(override)
        ? dbTriple(`postgresql://${override}`, "CHARPILOT_EXPECTED_DB")
        : null;
    // A half-stated override is refused rather than completed. `host:port` says
    // nothing about which of the two services on that port you meant, and
    // `host/database` says nothing about staging vs production.
    if (!t || !t.host || !t.database || t.portFrom !== "explicit") {
      throw safetyError(
        `CHARPILOT_EXPECTED_DB must name the whole triple explicitly - "host:port/database", or a DSN carrying an explicit port and database.\n` +
          `  It is not completed from a default: the port is what separates staging from the production database on the same host, and the database name is what separates this service from every other one behind the same credential.`
      );
    }
    // fromStageOne: false - and exec.mjs's egress allowlist keys off exactly
    // this. An env var that sets the DB expectation must not also open a hole
    // in the network policy; see exec.mjs allowedHosts().
    expectedDbCache = {
      host: t.host,
      port: t.port,
      database: t.database,
      source: "CHARPILOT_EXPECTED_DB",
      fromStageOne: false,
    };
    expectedDbSelfSha = undefined;
    return expectedDbCache;
  }

  const how =
    `  Establish one of the two sources:\n` +
    `    · run stage 1 for this repo   npm run pilot:stagingenv   (writes ${STAGING_ENV} AND ${STAGING_REPORT})\n` +
    `    · or state it explicitly      CHARPILOT_EXPECTED_DB=host:port/database`;
  if (!existsSync(STAGING_ENV)) {
    throw safetyError(
      `charpilot: refusing to run - no expected staging database for this repo.\n` +
        `  ${STAGING_ENV} does not exist, so there is nothing to assert a DSN against, and an unasserted DSN is how a --live run reaches production.\n${how}`
    );
  }
  const dsn = databaseUrlFrom(STAGING_ENV);
  if (!dsn) {
    throw safetyError(
      `charpilot: refusing to run - ${STAGING_ENV} carries no DATABASE_URL, so the expected staging triple is unknown.\n${how}`
    );
  }
  const t = dbTriple(dsn, "the DATABASE_URL in out/staging.env");
  if (!t.host || !t.port || !t.database) {
    throw safetyError(
      `charpilot: refusing to run - the DATABASE_URL in ${STAGING_ENV} does not yield a whole triple (host ${t.host || "?"}, port ${t.port || "?"}, database ${t.database || "?"}).\n` +
        `  Two thirds of a triple is a host check, which is what this guard exists not to be.\n${how}`
    );
  }
  // The env file alone is not the expectation. Either the report agrees with
  // it or this throws.
  const c = corroborateStagingEnv(dsn, t, how);
  expectedDbSelfSha = createHash("sha256").update(dsn).digest("hex");
  expectedDbCache = {
    host: t.host,
    port: t.port,
    database: t.database,
    source:
      `out/staging.env DATABASE_URL (stage 1, port ${t.portFrom}), corroborated by out/staging-env.json ` +
      `(namespace ${c.namespace}, from ${c.from}, address ${c.address}${c.portCorroborated ? "" : " - host only"}, ${c.fingerprint})`,
    fromStageOne: true,
  };
  return expectedDbCache;
}

/**
 * Back-compat for callers that read the constant. Every field is a getter, so
 * the resolution still happens on ACCESS and not on import, and `Object.keys`
 * returns the same three keys it did when this was a plain object literal.
 *
 * `JSON.stringify` does NOT behave as it did, and the comment here used to
 * claim it did: `toJSON` deliberately adds `source` and `fromStageOne`, so a
 * serialised expectation says where it came from and whether stage 1 vouched
 * for it. A stringified triple with no provenance is how "we asserted the
 * database" became unfalsifiable in the first place; the extra keys are the
 * point, not an accident to be papered over.
 *
 * Prefer `expectedDb()` in new code.
 */
export const EXPECTED_DB = Object.defineProperties(
  {},
  {
    ...Object.fromEntries(DB_KEYS.map((k) => [k, { enumerable: true, get: () => expectedDb()[k] }])),
    toJSON: {
      enumerable: false,
      value: () => {
        const t = expectedDb();
        return { host: t.host, port: t.port, database: t.database, source: t.source, fromStageOne: t.fromStageOne };
      },
    },
  }
);

/**
 * Throw unless `url` is exactly the expected triple. Used before any --live run.
 *
 * `url` is the value UNDER TEST - `--env-file`'s DATABASE_URL, or process.env's.
 * When it is byte-identical to the DSN the expectation was read from, the triple
 * comparison below is a tautology and proves nothing; what makes the run safe in
 * that case is the corroboration `expectedDb()` already did against
 * out/staging-env.json, and the return value SAYS SO instead of letting a
 * vacuous pass read as a check. The detection is by value, not by path, so a
 * copy of staging.env passed as --env-file is recognised too - and no caller has
 * to pass its filename in, which is what keeps record.mjs's call site unchanged.
 */
export function assertExpectedDb(url, who) {
  if (isNoDatabase(process.env.CHARPILOT_EXPECTED_DB)) return assertNoDatabase(url, who);
  if (!url) throw safetyError(`${who}: no DATABASE_URL to assert - refusing to run against an unknown database`);
  const want = expectedDb();
  const got = dbTriple(url, `${who}: DATABASE_URL`);
  const differs = DB_KEYS.filter((k) => got[k] !== want[k]);
  if (differs.length) {
    throw safetyError(
      `${who}: refusing to run - DATABASE_URL is ${dbWhere(got)}, expected ${dbWhere(want)} (differs on ${differs.join(", ")}).\n` +
        `  The same host serves a PRODUCTION database on another port, and one staging credential reaches any service's database by swapping the database name, so the whole triple is asserted - never the host, never the port alone.\n` +
        `  Expectation from: ${want.source}.\n` +
        `  If the DSN is right and the expectation is stale, re-run stage 1 (npm run pilot:stagingenv), or state it with CHARPILOT_EXPECTED_DB=host:port/database.`
    );
  }
  const selfCompared = Boolean(expectedDbSelfSha) && createHash("sha256").update(url).digest("hex") === expectedDbSelfSha;
  return {
    host: got.host,
    port: got.port,
    database: got.database,
    assertedBy: selfCompared
      ? "out/staging-env.json (the DSN under test IS the expectation's own source, so the triple comparison was not evidence)"
      : `triple comparison against ${want.source}`,
  };
}
