#!/usr/bin/env node
/**
 * fleetbaseline — what each repo's OWN suite already covers, so the sweep can
 * subtract it.
 *
 *   node tools/fleetbaseline.mjs                 # every repo in the fleet list
 *   node tools/fleetbaseline.mjs --only a,b      # just these
 *   node tools/fleetbaseline.mjs --from pricing-ms
 *   node tools/fleetbaseline.mjs --keep          # leave the clone and node_modules
 *   node tools/fleetbaseline.mjs --force         # re-measure a repo already cached
 *
 * WHY THIS EXISTS. `fleetsweep` ranks the fleet by open branch sides and says so
 * itself: the number is a CEILING, not a quote. It has to be, because the cache
 * it reads was written by `fleetcheck`, whose generated config is `include: []`
 * with `passWithNoTests: true` — deliberately, because "a service whose suite
 * wants a database would otherwise decide whether we get one". Every hit count
 * in `out/fleet/<name>/coverage-final.json` is therefore zero, and no amount of
 * arithmetic over that file can tell you what a repo's existing tests already
 * reach. Deciding which of the fleet's repos to spend model budget on needs the
 * other half: the sides the suite ALREADY covers, which is the half nobody has
 * to pay a model to write.
 *
 * So this tool runs the expensive half exactly once per repo: clone at the
 * deployed branch, install the repo's REAL dependencies, run the repo's OWN
 * suite under istanbul over the same scope fleetcheck measured, and cache
 * `coverage-suite.json` beside fleetcheck's `coverage-final.json`. Two documents
 * with the same keys and the same denominator, so the subtraction is a join and
 * not an estimate.
 *
 * A REPO WHOSE SUITE CANNOT RUN IS THE MOST VALUABLE ROW IN THE TABLE, and it is
 * never silently skipped. "This suite wants a database" is an ANSWER: it tells
 * the sweep that this repo's ceiling is also its floor, and it tells whoever
 * plans the run that stage 1 will refuse the repo for the host's own reason
 * before charpilot is involved at all. Every row therefore carries what happened
 * and the shortest line that identifies it, never a stack dump.
 *
 * DISK IS THE CONSTRAINT AND IT IS WORSE HERE THAN IN fleetcheck. fleetcheck
 * installs two packages per vitest version and shares them across repos; this
 * installs each repo's whole tree, which fleetcheck measured at 20–33 GB for the
 * fleet against 23 GB free. So the loop is serial and self-cleaning: install,
 * measure, cache the ANSWER, delete node_modules, next. `--keep` opts out for
 * one repo you want to look at by hand.
 *
 * AND IT IS RESUMABLE, because it will run unattended for hours. A repo whose
 * `baseline.json` is already on disk is skipped and its cached row is still
 * printed in the final table, so a sweep that dies at repo 19 is worth
 * restarting rather than repeating. `--force` re-measures.
 *
 * WHAT THE NUMBERS DO AND DO NOT INCLUDE. The branch and function percentages
 * are istanbul's, over `coverage.all` with fleetcheck's include/exclude — so the
 * denominator is the SOURCE, not "the files the tests happened to load", and it
 * is digit-for-digit the denominator fleetsweep already holds. They are not the
 * host's own published coverage number, which is usually v8, usually without
 * `all`, and therefore not comparable to anything here. They also say nothing
 * about whether the covered sides were covered WELL; a line executed by a test
 * that asserts nothing counts here exactly like one that is pinned down.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// NOT from config.mjs, for the same reason fleetcheck is not: that module
// resolves one repo from the CWD and refuses a directory that is not a package
// root, which is right for a tool that measures a target and wrong for one that
// runs from the pilot and measures many.
const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

// A WORK DIRECTORY OF ITS OWN, not fleetcheck's `out/fleet-work`. fleetcheck
// leaves every clone pristine on purpose — "which is what makes `--recheck`
// honest" — and an `npm ci` into those clones would write a real node_modules
// over the symlink it expects and change what a recheck measures. Separate
// trees, one shared answer cache.
const WORK = resolve(arg("--work", join(OUT_DIR, "fleet-baseline-work")));
// The SAME cache fleetcheck writes, because the whole point is that
// `coverage-suite.json` lands beside `coverage-final.json` with the same
// relative keys for the same commit.
const CACHE = resolve(arg("--cache", join(OUT_DIR, "fleet")));
const ORG = "https://github.com/Qode-Platform";
const BRANCH_OVERRIDE = arg("--branch", "");

/**
 * The two bounds, in minutes, and why a bound is not optional.
 *
 * A hung suite must not hang the sweep: this runs unattended over the whole
 * fleet, and one repo waiting forever on a database socket costs every repo
 * after it. Both are generous rather than tight, because a timeout is a WRONG
 * ANSWER — it says "we do not know" where a longer wait would have said "green"
 * — and both are recorded in the row so a reader can tell a slow suite from a
 * stuck one. `npm ci` on the Nest services is minutes of network on its own,
 * which is why install gets the larger of the two.
 */
const INSTALL_MINUTES = Number(arg("--install-minutes", "30"));
const SUITE_MINUTES = Number(arg("--suite-minutes", "20"));

const log = (s) => process.stdout.write(`${s}\n`);

/**
 * Every child, with the two settings a long unattended sweep needs.
 *
 * `maxBuffer` is 64 MB and not node's 1 MB default: a red suite with a few
 * hundred failures prints more than a megabyte, and the default does not
 * truncate — it KILLS the child with ENOBUFS, which would arrive here looking
 * exactly like the suite crashing. `NO_COLOR` keeps ANSI escapes out of the one
 * line we quote as the reason.
 */
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, NO_COLOR: "1", ...(opts.env ?? {}) },
  });

/* ------------------------------------------------------------------ the list */

/**
 * The fleet, READ from fleetcheck.mjs rather than copied into this file.
 *
 * THE LIST HAS ONE OWNER and it is `fleetcheck.mjs`. It is not exported — that
 * module calls `main()` at the bottom, so importing it would clone and measure
 * the whole fleet as a side effect of asking what is in it — so this parses the
 * literal out of its source. That is uglier than an import and much better than
 * a second copy: a copy drifts, and the way it drifts is that this tool measures
 * a repo on `main` that fleetcheck measured on `production`, producing two
 * halves of a subtraction taken from different code. The parse is strict and
 * fails loudly, which is the behaviour to want if somebody reshapes that array.
 *
 * Four cells per row: name, the branch the service DEPLOYS from, its style, and
 * an optional vitest override fleetcheck uses for a repo whose own runner cannot
 * parse its own source. The override is not used here — this runs the repo's own
 * installed runner, which is the point — but it is carried into the row so a
 * reader can see which repos fleetcheck measured under a different one.
 */
export function parseFleet(source) {
  const at = source.indexOf("const FLEET = [");
  if (at === -1) {
    throw new Error("fleetcheck.mjs no longer declares `const FLEET = [` — the fleet list moved, follow it");
  }
  const end = source.indexOf("\n];", at);
  if (end === -1) throw new Error("fleetcheck.mjs's FLEET array is not terminated by a line `];`");
  const body = source.slice(at, end);
  const rows = [];
  // Only whole bracketed lines. Every comment inside that array starts with
  // `//`, so none of them can match, and a row split across lines would be
  // dropped rather than mis-read — which the count check below then catches.
  for (const m of body.matchAll(/^\s*\[([^\]]+)\],?\s*$/gm)) {
    const cells = [...m[1].matchAll(/"([^"]*)"/g)].map((q) => q[1]);
    if (cells.length >= 3) rows.push({ name: cells[0], branch: cells[1], style: cells[2], vitest: cells[3] ?? null });
  }
  if (!rows.length) throw new Error("fleetcheck.mjs's FLEET array parsed to zero rows — the row shape changed");
  return rows;
}

export function fleetFromDisk(pilotDir = PILOT_DIR) {
  return parseFleet(readFileSync(join(pilotDir, "fleetcheck.mjs"), "utf8"));
}

/* ------------------------------------------------- the scope, fleetcheck's */

/*
 * THE NEXT THREE FUNCTIONS ARE fleetcheck's, BYTE FOR BYTE.
 *
 * They decide which files istanbul counts, and the two halves of this
 * subtraction have to be counted over the SAME set or the answer is not a
 * difference of anything. fleetcheck exports nothing and runs `main()` on
 * import, so they cannot be imported today, and it is another agent's file this
 * pass. They are therefore copied, and
 * `tests/fleetbaseline.a-suite-that-ran-is-a-different-answer.test.mjs` asserts
 * the text of all three still matches fleetcheck's character for character — so
 * a change over there fails a test here instead of silently measuring a
 * different scope on one side. If fleetcheck ever exports them, delete these and
 * import them; the guard test is what makes that safe to forget until then.
 */

/**
 * Where this service keeps its TypeScript.
 *
 * Most use `src/`. candidate-ms and contact-ms keep it at the repo ROOT, beside
 * routes/, service/, core/ and server.ts, and every source walk in the pipeline
 * globbed `src/**\/*.ts` - so the scan found nothing and refused, which reads as
 * a broken repo and is really an unmodelled layout. `SRC_DIR` in
 * test/src-exclude.mjs now carries it, "." meaning the repo root.
 */
function srcDir(dir) {
  if (existsSync(join(dir, "src"))) return "src";
  return ".";
}

/** The coverage `include` the host declares, or the convention. */
function hostInclude(dir) {
  for (const f of ["vitest.config.mts", "vitest.config.ts", "vite.config.mts", "vite.config.ts"]) {
    if (!existsSync(join(dir, f))) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const covAt = text.search(/coverage\s*:\s*\{/);
    if (covAt === -1) continue;
    const m = text.slice(covAt).match(/include:\s*\[([^\]]*)\]/);
    if (m) {
      const list = [...m[1].matchAll(/["']([^"']+)["']/g)].map((q) => q[1]);
      if (list.length) return list;
    }
  }
  const root = srcDir(dir);
  return [root === "." ? "**/*.ts" : `${root}/**/*.ts`];
}

/**
 * What istanbul will NOT count, mirrored so the scan counts the same set.
 *
 * Two sources, and leaving out either one produced drift that looks like a model
 * error. The host's own `coverage.exclude`, entry for entry as globs; and
 * vitest's DEFAULT coverage exclusions, which drop every `*.test.ts` and
 * `*.spec.ts` whether or not the host says so. Without the second, qode-itl-be
 * drifted +1257 arms and +4681 functions across 153 files - every one of them a
 * spec file the scan counted and istanbul had never been asked to instrument.
 *
 * `*.d.ts` goes with them: it emits no runtime code, so istanbul never sees it.
 */
function hostExclude(dir) {
  const out = ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx", "**/*.spec.tsx", "**/*.d.ts"];
  // With the source root at ".", `**\/*.ts` would otherwise sweep in the
  // directories a `src/` repo excludes for free. tsconfig already keeps
  // node_modules and outDir out of the ts-morph project; these are the ones it
  // does not.
  if (srcDir(dir) === ".") out.push("**/test/**", "**/tests/**", "**/prisma/**", "**/dist/**", "**/coverage*/**");
  for (const f of ["vitest.config.mts", "vitest.config.ts", "vite.config.mts", "vite.config.ts"]) {
    if (!existsSync(join(dir, f))) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const covAt = text.search(/coverage\s*:\s*\{/);
    if (covAt === -1) continue;
    const m = text.slice(covAt).match(/exclude:\s*\[([^\]]*)\]/);
    if (m) out.push(...[...m[1].matchAll(/["']([^"']+)["']/g)].map((q) => q[1]));
    break;
  }
  // ANCHORING. vitest matches these against ABSOLUTE paths, so `**/*.test.ts`
  // matches anywhere while a bare `src/index.ts` matches nothing - and the
  // difference is invisible, because the test-file entries kept working while
  // the host's own entries silently did not. ai-centralization, notification-ms,
  // profile-centralized and qode-sentinel-ms all reported exactly the files
  // their config excludes. Each unanchored entry gets a `**/` twin.
  const anchored = out.flatMap((e) => (e.startsWith("**") || e.startsWith("/") ? [e] : [e, `**/${e}`]));
  return [...new Set(anchored)];
}

/* --------------------------------------------------------- the pure decisions */

/**
 * The shortest line that identifies a failure, never a stack dump.
 *
 * The last lines of a node or vitest failure are its own frames, which name this
 * tool and not the cause; the first lines are usually a banner. So the pick is
 * ordered by how decisive the line is, and every entry earned its place on this
 * fleet: npm's `code E403` is the whole diagnosis for a repo whose `@qode/*`
 * packages live behind the private Artifact Registry, and `ECONNREFUSED
 * 127.0.0.1:5432` is the whole diagnosis for a suite that wants a database. A
 * reader who needs the rest has the clone (`--keep`) and can run it by hand.
 */
export function decisiveLine(text, limit = 200) {
  const out = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trim();
  if (!out) return "no output at all";
  const picks = [
    // npm says what went wrong in one line and then repeats itself for twenty.
    /npm (?:error|ERR!) code [A-Z0-9]+[^\n]*/,
    /Cannot find module[^\n]*/,
    /SyntaxError:[^\n]*/,
    // A named error with its message: `Error: connect ECONNREFUSED …`,
    // `ZodError: DATABASE_URL Required`, `PrismaClientInitializationError: …`.
    /[A-Za-z]*Error:[^\n]*/,
    // Anything that named a source file and a line.
    /[^\n]*\.(?:ts|mts|tsx|js|mjs):\d+[^\n]*/,
    /[^\n]*(?:ECONNREFUSED|ETIMEDOUT|EACCES|ENOTFOUND|authentication failed)[^\n]*/,
  ];
  for (const p of picks) {
    const m = out.match(p);
    if (m) return m[0].trim().slice(0, limit);
  }
  // Nothing matched, so the last thing it said is the best there is.
  return out.split("\n").filter((l) => l.trim()).pop().trim().slice(0, limit);
}

/**
 * What the suite did, in states rather than a boolean.
 *
 * `green` alone cannot distinguish "nothing failed" from "nothing ran", and
 * stage 1 printed the second as "0/0 green" until it was split — the same split
 * is made here for the same reason. Five states:
 *
 *   green           it ran and nothing failed
 *   red             it ran and something failed. A RESULT, not an error.
 *   no-spec-files   it ran, collected nothing, and istanbul still wrote a
 *                   report from `coverage.all`. A real state on this fleet.
 *   timed-out       the bound was hit. We do not know the answer; the row says
 *                   which bound and how long it was.
 *   did-not-run     it never got far enough to produce either artifact.
 *
 * `failedFiles` is counted apart from `failed`, because a FILE that fails to
 * collect runs no test at all: `numFailedTests` stays 0 while the suite is red.
 * On this fleet that is an import error — an ungenerated Prisma client, a missing
 * env — which is a different problem with a different fix from a failing
 * assertion.
 */
export function suiteOutcome({ results, status, timedOut = false, coverageWritten = false, output = "" }) {
  const empty = { files: 0, tests: 0, passed: 0, failed: 0, failedFiles: 0, failures: [] };
  if (timedOut) {
    return { ...empty, ran: false, state: "timed-out", exitCode: status ?? null };
  }
  if (!results) {
    if (status === 0 && coverageWritten) {
      return {
        ...empty,
        ran: true,
        state: "no-spec-files",
        exitCode: 0,
        note: "no spec file was collected; the percentages below come from coverage.all over the source",
      };
    }
    return { ...empty, ran: false, state: "did-not-run", exitCode: status ?? null, reason: decisiveLine(output) };
  }
  const files = results.testResults?.length ?? 0;
  const tests = results.numTotalTests ?? 0;
  const failed = results.numFailedTests ?? 0;
  const failedFiles = (results.testResults ?? []).filter((f) => f.status === "failed").length;
  const nothingRan = files === 0 && tests === 0;
  return {
    ran: true,
    state: nothingRan ? "no-spec-files" : status === 0 && failed === 0 && failedFiles === 0 ? "green" : "red",
    exitCode: status ?? null,
    files,
    tests,
    passed: results.numPassedTests ?? 0,
    failed,
    failedFiles,
    // The failing FILES, not the failing assertions: on a red suite of 6 there
    // are 6 names and on a red suite of 300 there are still only a handful of
    // files, which is the size that fits in a row.
    failures: (results.testResults ?? [])
      .filter((f) => f.status === "failed")
      .map((f) => String(f.name ?? ""))
      .slice(0, 5),
  };
}

/**
 * istanbul's two percentages, and nothing derived from them.
 *
 * Read out of `coverage-summary.json` rather than recomputed from
 * `coverage-final.json`, because istanbul already did the arithmetic and a
 * second implementation of it would be a second thing that can be wrong. Only
 * branches and functions are quoted in the table; statements and lines are kept
 * in the file because they cost nothing and answer the next question.
 */
export function coveragePercents(summary) {
  const t = summary?.total;
  if (!t) return null;
  const one = (m) => (m ? { covered: m.covered ?? 0, total: m.total ?? 0, pct: m.pct ?? 0 } : null);
  return {
    branches: one(t.branches),
    functions: one(t.functions),
    statements: one(t.statements),
    lines: one(t.lines),
  };
}

/**
 * Whether this repo is already answered.
 *
 * The sweep is hours long and dies for reasons that have nothing to do with the
 * repo it died on — a laptop sleeping, a registry timing out. Re-running it must
 * therefore cost only what is missing. A cached row is still PRINTED, so the
 * final table after a restart is the whole fleet and not the tail.
 */
export function resumeDecision({ cached, force = false }) {
  if (force) return { skip: false, why: "--force: measuring again over the cached row" };
  if (cached) return { skip: true, why: "baseline.json already on disk (--force to measure again)" };
  return { skip: false, why: "no baseline.json cached yet" };
}

/**
 * One repo's row, assembled from the parts each step produced.
 *
 * Kept pure and separate from the steps that produce those parts so the shape
 * can be tested without cloning anything — the row IS the artifact, and a field
 * missing from it is a repo nobody can plan for.
 */
export function buildRow({ name, branch, style, sha = null, fleetVitest = null, clone = {}, install = {}, suite = {}, coverage = null, vitest = {}, envFile = false, testScript = null, bounds, ms = 0 }) {
  const row = {
    name,
    branch,
    style,
    sha: sha ? String(sha).slice(0, 8) : null,
    // Whether the CLONE carried a `.env`, which it will not, and why that is
    // worth a field. A local `.env` is auto-loaded and CHANGES THE OUTCOME:
    // notification-ms is red with its own `.env` present and green without it
    // (18 files / 159 tests), because a test deletes `process.env.DATABASE_URL`
    // and vitest has already restored it from the file. So this row is the
    // answer for a clean checkout, which is what CI has and what a container
    // run would have — and a developer whose local run disagrees is looking at
    // their `.env`, not at a different suite.
    envFile,
    // The host's own `npm test`, recorded and NOT used. It is frequently
    // `dotenv -e .env.test vitest run` or a build step followed by vitest, and
    // neither can be handed a coverage config; this runs the repo's installed
    // vitest directly instead. Where the script sets env this row does not, that
    // difference is visible here rather than invisible everywhere.
    testScript,
    install: {
      ok: install.ok ?? false,
      mode: install.mode ?? null,
      seconds: Math.round((install.ms ?? 0) / 1000),
      ...(install.reason ? { reason: install.reason } : {}),
    },
    vitest: {
      version: vitest.version ?? null,
      config: vitest.config ?? null,
      provider: vitest.provider ?? null,
      // Which runner fleetcheck used for the DENOMINATOR, when it overrode one.
      // vitest 2 and 4 do not model the same branches (4 stopped emitting one
      // for a downlevelled enum), so a repo measured on different majors on the
      // two sides is a repo whose subtraction needs a second look.
      fleetOverride: fleetVitest,
    },
    suite: {
      ran: suite.ran ?? false,
      state: suite.state ?? "did-not-run",
      exitCode: suite.exitCode ?? null,
      files: suite.files ?? 0,
      tests: suite.tests ?? 0,
      passed: suite.passed ?? 0,
      failed: suite.failed ?? 0,
      failedFiles: suite.failedFiles ?? 0,
      seconds: Math.round((suite.ms ?? 0) / 1000),
      ...(suite.failures?.length ? { failures: suite.failures } : {}),
      ...(suite.note ? { note: suite.note } : {}),
    },
    // Null is a real answer here and not a missing field: it means istanbul
    // wrote no report, which the state above explains.
    coverage,
    // The bounds are in the row because a `timed-out` state without them is
    // uninterpretable — 20 minutes and 20 hours are different findings.
    bounds,
    minutes: Number((ms / 60_000).toFixed(1)),
    generatedAt: new Date().toISOString(),
  };
  row.reason = rowReason(row, clone, install, suite);
  return row;
}

/** The one sentence that says where this repo stopped, or why it is fine. */
function rowReason(row, clone, install, suite) {
  if (clone.ok === false) return `clone failed: ${clone.reason ?? "unknown"}`;
  if (install.ok === false) return `install failed: ${install.reason ?? "unknown"}`;
  if (suite.state === "timed-out") return `suite hit the ${row.bounds.suiteMinutes} min bound and was killed — slow or stuck, this run cannot tell which`;
  if (suite.state === "did-not-run") return `suite never ran: ${suite.reason ?? "no results and no coverage report"}`;
  if (suite.state === "no-spec-files") return "no spec file was collected — the percentages are coverage.all over the source, and this repo's suite covers nothing";
  if (suite.state === "red") {
    const where = suite.failedFiles ? ` in ${suite.failedFiles} file(s)` : "";
    return `suite is RED: ${suite.failed} test(s) failed${where} — the coverage below is what the PASSING tests reached`;
  }
  return "suite ran green";
}

/* ------------------------------------------------------------------ the table */

export function renderTable(rows) {
  const head = ["repo", "install", "suite", "pass", "fail", "branch %", "fn %", "min"];
  const pct = (c) => (c ? `${c.pct.toFixed(1)}` : "—");
  const body = rows.map((r) => [
    r.name,
    r.install?.ok ? "ok" : "NO",
    r.suite?.state ?? "—",
    r.suite?.ran ? String(r.suite.passed) : "—",
    r.suite?.ran ? String(r.suite.failed) : "—",
    pct(r.coverage?.branches),
    pct(r.coverage?.functions),
    String(r.minutes ?? 0),
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i <= 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

/** The single line printed per repo as the sweep goes, so a dead run is readable. */
export function progressLine(row) {
  const pct = (c) => (c ? `${c.pct.toFixed(1)}%` : "—");
  return (
    `${row.name.padEnd(28)}` +
    `install ${row.install.ok ? "ok " : "NO "} · ` +
    `suite ${String(row.suite.state).padEnd(13)} · ` +
    `${row.suite.passed}/${row.suite.tests} passed, ${row.suite.failed} failed · ` +
    `branches ${pct(row.coverage?.branches)} · functions ${pct(row.coverage?.functions)} · ` +
    `${row.minutes} min`
  );
}

/* ------------------------------------------------------------------ the steps */

function step(fn) {
  const t = Date.now();
  try {
    const r = fn();
    return { ok: true, ms: Date.now() - t, ...r };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, reason: decisiveLine(String(e.message ?? e)) };
  }
}

/** fleetcheck's clone, with the same rule: a clone on the wrong branch is moved. */
function clone(name, branch, dir) {
  if (existsSync(join(dir, ".git"))) {
    const on = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).stdout?.trim();
    if (on === branch) return { note: "cached" };
    const f = run("git", ["fetch", "--depth", "1", "origin", `${branch}:refs/remotes/origin/${branch}`], { cwd: dir });
    if (f.status !== 0) throw new Error(`fetch ${branch} failed: ${(f.stderr || "").trim().slice(0, 200)}`);
    const c = run("git", ["checkout", "-B", branch, `refs/remotes/origin/${branch}`], { cwd: dir });
    if (c.status !== 0) throw new Error(`checkout ${branch} failed: ${(c.stderr || "").trim().slice(0, 200)}`);
    return { note: `switched ${on} -> ${branch}` };
  }
  rmSync(dir, { recursive: true, force: true });
  const r = run("git", ["clone", "--depth", "1", "--branch", branch, `${ORG}/${name}.git`, dir]);
  if (r.status !== 0) throw new Error(`clone failed: ${(r.stderr || "").trim().slice(0, 200)}`);
  return { note: "cloned" };
}

/**
 * The repo's REAL dependencies, which is the expensive thing this tool buys.
 *
 * `npm ci` first, because it is what CI does and it is the only mode that
 * reproduces the lockfile exactly. It refuses outright when package.json and the
 * lockfile disagree, and several services on this fleet carry a lockfile a
 * branch older than their manifest — so the fallback is `npm install`, RECORDED
 * as such, because a suite measured against resolved-today dependencies is a
 * slightly different program from the one CI runs and the row should say which
 * it was.
 *
 * `--legacy-peer-deps` is not passed. It is right for fleetcheck, which installs
 * two packages into a synthetic manifest, and wrong here: a peer conflict in the
 * repo's own tree is the repo's own state, and papering over it would install a
 * combination the service never runs.
 */
function install(dir, bounds) {
  const opts = { cwd: dir, timeout: bounds.installMinutes * 60_000 };
  const ci = run("npm", ["ci", "--no-audit", "--no-fund"], opts);
  if (ci.status === 0) return { mode: "npm ci" };
  if (ci.error?.code === "ETIMEDOUT") {
    throw new Error(`npm ci hit the ${bounds.installMinutes} min bound`);
  }
  const first = decisiveLine(ci.stderr || ci.stdout || "");
  const fallback = run("npm", ["install", "--no-audit", "--no-fund"], opts);
  if (fallback.status === 0) return { mode: "npm install", note: `npm ci refused: ${first}` };
  if (fallback.error?.code === "ETIMEDOUT") {
    throw new Error(`npm install hit the ${bounds.installMinutes} min bound`);
  }
  throw new Error(decisiveLine(fallback.stderr || fallback.stdout || first));
}

/** The vitest this repo actually installed, or nothing — which is a result. */
function installedVitest(dir) {
  const pkg = join(dir, "node_modules", "vitest", "package.json");
  if (!existsSync(pkg)) return null;
  try {
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The istanbul provider, added at the repo's EXACT installed vitest version.
 *
 * No repo in this fleet ships `@vitest/coverage-istanbul` — fleetcheck found the
 * same and installs it for the same reason. It goes into the repo's own tree
 * with `--no-save`, rather than being symlinked from a shared directory the way
 * fleetcheck does it, because the provider peers on the runner and must load the
 * SAME copy of vitest the suite is running under; a symlink resolves the
 * provider's own imports from the shared tree's realpath and would give two
 * vitest instances at one version. The exact version matters for the usual
 * reason: the provider peers on one, and a major range resolves a newer patch
 * that then conflicts.
 *
 * This can only run after `npm ci` succeeded, so the repo's registry
 * configuration — several services resolve `@qode/*` from a private Artifact
 * Registry through a committed `.npmrc` — is already known to work.
 */
function ensureProvider(dir, version, bounds) {
  if (existsSync(join(dir, "node_modules", "@vitest", "coverage-istanbul"))) return { provider: "already present" };
  const r = run("npm", ["install", "--no-save", "--no-audit", "--no-fund", `@vitest/coverage-istanbul@${version}`], {
    cwd: dir,
    timeout: bounds.installMinutes * 60_000,
  });
  if (r.status !== 0) throw new Error(`@vitest/coverage-istanbul@${version}: ${decisiveLine(r.stderr || r.stdout || "")}`);
  return { provider: `installed @${version}` };
}

/**
 * The measurement config, written INTO the clone.
 *
 * It extends the host's own config rather than replacing it, which is the
 * opposite of what fleetcheck does and for the opposite reason: fleetcheck runs
 * NO tests, so host plugins and setup files are pure liability; here the tests
 * must actually run, and on the Nest services they only run under the host's own
 * `unplugin-swc` transform and its setup files. What is forced is the coverage
 * block alone.
 *
 * A REPO WITH NO CONFIG AT ALL IS NOT A REPO WITHOUT VITEST. tracy-worker
 * declares `"test": "vitest run"` and vitest ^4.1.5 and ships no config on any
 * branch: it runs on vitest's defaults, which is a legitimate shape.
 * `install.sh` handles that by writing an EMPTY base config so its relative
 * import resolves; this config is generated per run and simply imports no base
 * in that case, which is the same decision without adding a file to the repo.
 */
function writeConfig(dir, name) {
  const include = hostInclude(dir);
  // The SAME scope fleetcheck measured. A wider include here would count sides
  // the sweep's denominator does not hold, and the subtraction would go
  // negative on files that only one side knows about.
  const exclude = hostExclude(dir);
  const base = ["vitest.config.mts", "vitest.config.ts", "vite.config.mts", "vite.config.ts"].find((f) =>
    existsSync(join(dir, f))
  );
  const cfg = join(dir, "vitest.fleetbaseline.config.mts");
  writeFileSync(
    cfg,
    `import { defineConfig } from "vitest/config";\n` +
      (base ? `import base from "./${base}";\n` : `const base: any = {};\n`) +
      `\n` +
      // A config may be a FUNCTION of the vite env — `defineConfig(({ mode }) => …)`
      // — and spreading a function yields an empty object, which would silently
      // drop every plugin the suite needs. Calling it costs one line and turns
      // that into a normal run.
      `const b: any = typeof (base as any) === "function"\n` +
      `  ? await (base as any)({ command: "serve", mode: process.env.NODE_ENV ?? "test" })\n` +
      `  : (base as any);\n` +
      `\n` +
      // SWC KEEPS ITS TRANSFORM AND LOSES ITS VETO ON esbuild — the same two
      // changes vitest.charpilot.config.mts makes, and both are needed.
      // `unplugin-swc` returns `{ esbuild: false }` from its vite `config()`
      // hook, so a file NO spec imports reaches istanbul as raw TypeScript and
      // babel — whose plugin list from @istanbuljs/schema holds no typescript
      // plugin — dies on the first TypeScript-only token. `coverage.all` has to
      // instrument exactly those files. `enforce: "pre"` is the other half:
      // without it SWC races vite's esbuild and loses, Nest's
      // `design:paramtypes` metadata disappears and DI breaks. Measured on
      // qode-itl-be: 160 spec files, 278 files instrumented, 91 of them imported
      // by no spec. An Express host has no plugin named swc and passes through.
      `const unvetoSwc = (p: any): any =>\n` +
      `  Array.isArray(p) ? p.map(unvetoSwc)\n` +
      `  : (p && typeof p === "object" && p.name === "swc" ? { ...p, config: undefined, enforce: "pre" } : p);\n` +
      `\n` +
      `export default defineConfig({\n` +
      `  ...b,\n` +
      `  ...(b.plugins ? { plugins: unvetoSwc(b.plugins) } : {}),\n` +
      `  test: {\n` +
      // The host's `test` block verbatim: its include, its exclude, its setup
      // files, its timeouts. That block IS the repo's suite, and this tool's
      // question is what that suite covers — not what some other selection of
      // its files would cover. `test.exclude` especially is left alone: a host
      // that sets none relies on vitest's default (`**/node_modules/**` and the
      // rest), and replacing it with `[]` made a baseline run collect every
      // .test.js shipped inside node_modules — ai-centralization reported 37
      // failures from fast-uri, pg-protocol and gensync, none of them its own.
      `    ...(b.test ?? {}),\n` +
      `    coverage: {\n` +
      `      ...((b.test ?? {}).coverage ?? {}),\n` +
      `      enabled: true,\n` +
      // istanbul, never v8. v8's branch denominator GROWS as tests are added, so
      // its percentage cannot be compared with fleetcheck's fixed denominator —
      // and the comparison is the entire product of this tool.
      `      provider: "istanbul",\n` +
      // FORCED, both of them. Without `all` and an explicit include, istanbul's
      // denominator is "the files the tests happened to load", so a file no test
      // imports contributes zero arms and the percentage looks better than it
      // is. The two halves would then not be over the same set.
      `      all: true,\n` +
      `      include: ${JSON.stringify(include)},\n` +
      `      exclude: ${JSON.stringify(exclude)},\n` +
      // vitest defaults reportOnFailure to FALSE, so a red suite writes no
      // report at all — and a red suite is exactly when the numbers are needed
      // most. Measured twice on this fleet: notification-ms and
      // profile-centralized both have pre-existing failures, and on both the
      // coverage silently degraded to "istanbul 0" for every file.
      `      reportOnFailure: true,\n` +
      `      reporter: ["json", "json-summary"],\n` +
      `      reportsDirectory: "./coverage-fleetbaseline",\n` +
      // A host that gates on coverage thresholds would exit non-zero for a
      // reason that has nothing to do with whether its tests passed, and this
      // tool measures rather than gates.
      `      thresholds: undefined,\n` +
      `    },\n` +
      `  },\n` +
      `});\n`
  );
  return { cfg, base: base ?? "none (vitest defaults, as `vitest run` already uses here)", include, exclude };
}

/** Run the repo's own suite under that config, bounded. */
function runSuite(dir, cfg, bounds) {
  const reports = join(dir, "coverage-fleetbaseline");
  const resultsPath = join(dir, "fleetbaseline-results.json");
  rmSync(reports, { recursive: true, force: true });
  rmSync(resultsPath, { force: true });
  const t0 = Date.now();
  const r = run(
    process.execPath,
    [
      join(dir, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--coverage",
      "--config",
      cfg,
      // Zero spec files is a STATE this tool records, not the runner's error:
      // without this vitest exits 1 for "no test files found", which reads as a
      // broken suite and is really an empty one.
      "--passWithNoTests",
      "--reporter=json",
      `--outputFile=${resultsPath}`,
    ],
    { cwd: dir, timeout: bounds.suiteMinutes * 60_000 }
  );
  const ms = Date.now() - t0;
  const timedOut = r.error?.code === "ETIMEDOUT";
  let results = null;
  try {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch {
    results = null;
  }
  const summaryPath = join(reports, "coverage-summary.json");
  const finalPath = join(reports, "coverage-final.json");
  const outcome = suiteOutcome({
    results,
    status: r.status,
    timedOut,
    coverageWritten: existsSync(summaryPath),
    output: r.stderr || r.stdout || "",
  });
  return { ...outcome, ms, summaryPath, finalPath };
}

/**
 * Cache the answer, in the shape fleetsweep already reads.
 *
 * `coverage-suite.json` carries the same relative keys as fleetcheck's
 * `coverage-final.json` — the absolute prefix is stripped so the document does
 * not carry this machine's paths — which is what lets a sweep join the two
 * documents per file and subtract. It is written even for a red suite: the
 * passing tests still covered what they covered, and that is still work nobody
 * has to pay a model to do again.
 */
function cacheAnswer(name, dir, suite, row) {
  const cacheDir = join(CACHE, name);
  mkdirSync(cacheDir, { recursive: true });
  let coverage = null;
  if (existsSync(suite.finalPath)) {
    const cov = JSON.parse(readFileSync(suite.finalPath, "utf8"));
    const rel = {};
    for (const [abs, d] of Object.entries(cov)) {
      const key = abs.replace(`${dir}/`, "");
      rel[key] = { ...d, path: key };
    }
    writeFileSync(join(cacheDir, "coverage-suite.json"), JSON.stringify(rel));
  }
  if (existsSync(suite.summaryPath)) {
    coverage = coveragePercents(JSON.parse(readFileSync(suite.summaryPath, "utf8")));
  }
  writeFileSync(join(cacheDir, "baseline.json"), `${JSON.stringify(row, null, 2)}\n`);
  return coverage;
}

/* -------------------------------------------------------------------- the run */

function measure(name, branch, style, fleetVitest, bounds) {
  const t0 = Date.now();
  const dir = join(WORK, name);
  const parts = { name, branch, style, fleetVitest, bounds };

  const cl = step(() => clone(name, branch, dir));
  if (!cl.ok) return buildRow({ ...parts, clone: cl, ms: Date.now() - t0 });

  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout?.trim() ?? null;
  const envFile = existsSync(join(dir, ".env"));
  let testScript = null;
  try {
    testScript = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.test ?? null;
  } catch {
    testScript = null;
  }
  const common = { ...parts, clone: cl, sha, envFile, testScript };

  const ins = step(() => install(dir, bounds));
  if (!ins.ok) return buildRow({ ...common, install: ins, ms: Date.now() - t0 });

  const version = installedVitest(dir);
  if (!version) {
    // A REAL STATE, not a crash. Half this fleet pins no vitest on the branch it
    // deploys — the runner lives on a characterization branch instead — and for
    // this tool that means the repo has no suite to measure on the code it runs.
    // fleetcheck could answer anyway because it never executes anything; this
    // cannot, and says so.
    return buildRow({
      ...common,
      install: ins,
      suite: { ran: false, state: "did-not-run", reason: "the deployed branch installs no vitest, so it has no suite to run" },
      ms: Date.now() - t0,
    });
  }

  const prov = step(() => ensureProvider(dir, version, bounds));
  if (!prov.ok) {
    return buildRow({
      ...common,
      install: ins,
      vitest: { version, config: null, provider: null },
      suite: { ran: false, state: "did-not-run", reason: prov.reason },
      ms: Date.now() - t0,
    });
  }

  const cfg = writeConfig(dir, name);
  const suite = runSuite(dir, cfg.cfg, bounds);
  const row = buildRow({
    ...common,
    install: ins,
    vitest: { version, config: cfg.base, provider: prov.provider },
    suite,
    ms: Date.now() - t0,
  });
  row.coverage = cacheAnswer(name, dir, suite, row);
  // The row is written once more, now carrying the percentages the cache step
  // read back out of istanbul's own summary. Cheap, and it keeps the file on
  // disk identical to the row in the table.
  writeFileSync(join(CACHE, name, "baseline.json"), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(CACHE, { recursive: true });

  const only = arg("--only", "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = arg("--from", "");
  const force = flag("--force");
  const bounds = { installMinutes: INSTALL_MINUTES, suiteMinutes: SUITE_MINUTES };

  let fleet = fleetFromDisk();
  if (only.length) fleet = fleet.filter((r) => only.includes(r.name));
  if (from) {
    const i = fleet.findIndex((r) => r.name === from);
    if (i >= 0) fleet = fleet.slice(i);
  }
  if (!fleet.length) {
    process.stderr.write(`no repo matched. \`--only\` takes names from fleetcheck.mjs's FLEET array.\n`);
    process.exit(1);
  }

  log(
    `fleetbaseline: ${fleet.length} repo(s), bounded at ${bounds.installMinutes} min install and ` +
      `${bounds.suiteMinutes} min suite each. Cache → ${CACHE}\n`
  );

  const rows = [];
  for (const { name, branch: declared, style, vitest: fleetVitest } of fleet) {
    const branch = BRANCH_OVERRIDE || declared;
    const cachedPath = join(CACHE, name, "baseline.json");
    const cached = existsSync(cachedPath) ? JSON.parse(readFileSync(cachedPath, "utf8")) : null;
    const decision = resumeDecision({ cached, force });
    if (decision.skip) {
      log(`${progressLine(cached)}   [cached]`);
      rows.push(cached);
      continue;
    }

    const row = measure(name, branch, style, fleetVitest ?? null, bounds);
    log(progressLine(row));
    // The reason is on its own line under the repo, because the table has no
    // column wide enough for a sentence and the sentence is the finding.
    if (row.reason !== "suite ran green") log(`  ↳ ${row.reason}`);
    rows.push(row);

    // Self-cleaning, and this is not optional: fleetcheck measured a full `npm
    // ci` of this fleet at 20–33 GB against 23 GB free, and that was before this
    // tool started installing whole trees rather than two packages. The ANSWER
    // is cached, so what `--keep` buys back is only the time to install again.
    if (!flag("--keep")) {
      const dir = join(WORK, name);
      const nm = join(dir, "node_modules");
      if (existsSync(nm) && !lstatSync(nm).isSymbolicLink()) rmSync(nm, { recursive: true, force: true });
      rmSync(join(dir, "coverage-fleetbaseline"), { recursive: true, force: true });
    }
  }

  log(`\n${renderTable(rows)}\n`);

  const ran = rows.filter((r) => r.suite?.ran);
  const green = rows.filter((r) => r.suite?.state === "green");
  const red = rows.filter((r) => r.suite?.state === "red");
  const blocked = rows.filter((r) => !r.suite?.ran);
  for (const r of rows.filter((x) => x.reason && x.reason !== "suite ran green")) {
    log(`! ${r.name}: ${r.reason}`);
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    cache: CACHE,
    work: WORK,
    bounds,
    repos: rows,
  };
  const path = join(OUT_DIR, "fleetbaseline.json");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

  log(
    `\n${ran.length}/${rows.length} suite(s) ran · ${green.length} green · ${red.length} red · ` +
      `${blocked.length} could not run at all\n` +
      `The percentages are istanbul's, over coverage.all with fleetcheck's include/exclude — the SOURCE as the\n` +
      `denominator, not the files the tests happened to load, so they subtract from fleetsweep's ceiling directly.\n` +
      `They do not say the covered sides are covered WELL: a line a test executed without asserting anything\n` +
      `counts here exactly like one that is pinned down. A repo whose suite could not run has no subtraction at\n` +
      `all — its ceiling IS its floor, and stage 1 will refuse it for the host's own reason.\n` +
      `\nwrote ${path}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
