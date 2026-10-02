#!/usr/bin/env node
/**
 * Stage 1 — set up the repo, record a baseline, and RESOLVE THE ENVIRONMENT.
 *
 * Installs exactly as CI does (with --install), runs the EXISTING suite, and
 * records it green with its istanbul coverage before anything is touched. Every
 * later claim in the pilot is a delta against this file.
 *
 *   node .claude/charpilot/baseline.mjs                    # verify install, run, record
 *   node .claude/charpilot/baseline.mjs --install          # run `npm ci` first
 *   node .claude/charpilot/baseline.mjs --iac <qode-iac>   # where the manifests are
 *   node .claude/charpilot/baseline.mjs --no-staging-env   # opt out, RECORDED as such
 *
 * Writes .claude/charpilot/out/baseline.json. Exits non-zero if the suite is not
 * green — a baseline recorded over a red suite is not a baseline.
 *
 * THE SECOND HALF, and why it lives here now. Both skills said stage 1 resolved
 * staging into out/staging-env.json "so stage 4 does not discover its addresses
 * one failure at a time", and nothing in the documented flow ran the tool that
 * writes it: 0 mentions of stagingenv in this file, 0 gate checks demanding the
 * artifact, 0 callers anywhere. Six repos had the file because someone ran the
 * tool by hand; a fresh onboarding produced none, and every recorded row then
 * carried `envProvenance: "process-env-only"` — i.e. the ambient shell. That
 * became load-bearing when config.mjs made a `--live` run REQUIRE
 * out/staging-env.json to corroborate the database expectation. A guard whose
 * only input the documented flow never creates is not a guard.
 *
 * It is UNCONDITIONAL, with an opt-out that is recorded rather than silent.
 * Opt-in was the state that produced the defect: nobody opts in to a step no
 * failure points at. And resolution reads committed YAML only — no kubectl, no
 * DNS, no TCP probe — so it cannot fail for a reason the network owns, which is
 * what makes running it always affordable.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { delimiter, relative, isAbsolute } from "node:path";
import { BASELINE_JSON, COVERAGE_DIR, OUT_DIR, REPO_ROOT, SRC_ROOT, STAGING_ENV, VITEST_CONFIG, databasePlaceholder, isDatabaseVar, isSrcExcluded, maskDatabaseEnv } from "./config.mjs";
// D54: the repo's own suite runs under the Node its CI runs - npx, and the vitest
// it starts, are the ones on PATH first (cinode.mjs).
import { targetNodeEnv } from "./cinode.mjs";
import { REPO_ENV_FILES, planStandIns } from "./standins.mjs";
import { envNames } from "./envfile.mjs";
import { classifyRedSuite, describeRedSuite } from "./redsuite.mjs";
import { prismaPlaceholder as placeholderAt } from "./prismaclient.mjs";
import { credentialShaped } from "./secrets.mjs";
import { findIac, liveDecision, printReport, refreshStandIns, resolveStagingEnv } from "./stagingenv.mjs";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const DO_INSTALL = ARGV.includes("--install");
const SKIP_STAGING_ENV = ARGV.includes("--no-staging-env");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function trySh(cmd, args, opts) {
  try {
    return sh(cmd, args, opts);
  } catch {
    return null;
  }
}

function recordEnvironment() {
  return {
    node: process.version,
    npm: trySh("npm", ["--version"]),
    platform: `${process.platform}-${process.arch}`,
    gitSha: trySh("git", ["rev-parse", "HEAD"]),
    gitBranch: trySh("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitDirty: (trySh("git", ["status", "--porcelain"]) ?? "") !== "",
  };
}

/**
 * An install can silently destroy the suite you are about to measure — this is
 * the step that catches it before the numbers are recorded, not after.
 */
function install() {
  if (DO_INSTALL) {
    process.stdout.write("· npm ci …\n");
    const t0 = Date.now();
    spawnSync("npm", ["ci"], { cwd: REPO_ROOT, stdio: "inherit" });
    return { mode: "npm ci", ranSeconds: Math.round((Date.now() - t0) / 1000) };
  }

  process.stdout.write("· npm ci --dry-run (drift check) …\n");
  const dry = spawnSync("npm", ["ci", "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return {
    mode: "npm ci --dry-run",
    lockfileInSync: dry.status === 0,
    note:
      dry.status === 0
        ? "node_modules assumed to match package-lock.json"
        : `lockfile drift: ${(dry.stderr || "").trim().split("\n").slice(0, 3).join(" | ")}`,
  };
}

/**
 * Run the suite. A repo with NO SPEC FILE is a named state, not a crash.
 *
 * It used to die with `Error: vitest produced no JSON results (exit 1)` and a
 * Node stack, which reads as a broken harness. It is not: the denominator is
 * obtainable with no spec file at all — measured on a greenfield fixture,
 * `branches 0/13 · functions 0/4 · statements 0/12`, written by the istanbul
 * reporter from `coverage.all` alone. Only the two things that need a
 * COLLECTED FILE were missing.
 *
 *   `--passWithNoTests` is now always passed. It changes nothing for a repo
 *   that has specs, and on a repo with none it turns vitest's exit 1 ("no test
 *   files found") into a 0 and lets the json reporter write its zero-row file —
 *   measured on the same fixture: exit 1 and `success: false` before, exit 0
 *   and `success: true` after, coverage report identical in both.
 *
 *   And where even the reporter writes nothing, the coverage report is the
 *   fallback evidence: reportsDirectory is removed before the run, so its
 *   presence after an exit-0 run means istanbul instrumented the source and
 *   nothing failed. That is a zero-spec run, and it is recorded as one.
 *
 * A greenfield baseline is a legitimate artifact — it is precisely the "before"
 * the whole pipeline ratchets against, and refusing to record it means the one
 * repo where every side is uncovered is the one repo with no denominator.
 */
/**
 * THE ENVIRONMENT THE REPO'S OWN SUITE RUNS UNDER.
 *
 * SAFETY (verifier, pre-merge review of PR #38). Stage 1 runs THEIR suite -
 * runSuite and theirOwnRun - and it ran with the walk's environment as it
 * stood. In a mocked run their integration tests could then reach whatever
 * database that environment named: an operator's run.env, a DATABASE_URL
 * exported for the stages that do read staging. Mocked mode must never reach
 * a real database, so in mocked mode every database-looking variable
 * (config.mjs isDatabaseVar) is the db.invalid placeholder in its own shape:
 * those in the environment, and those named in out/staging.env or the repo's
 * own .env files, so a dotenv load (which never overrides a set value) cannot
 * bring one back. Live mode (stagingenv.mjs liveDecision) is unchanged. The
 * stages that read staging on purpose - dbvocab, providervocab, stagingenv,
 * preflight, exec - are not this function's callers.
 */
const ENV_FILES = REPO_ENV_FILES;
/** The stand-in names the last suiteEnv() applied to their suite, or null (live, or not yet run). */
let SUITE_STAND_INS = null;
/**
 * THE CAUSE, NOT THE LAST 2000 CHARACTERS.
 *
 * qode-itl-be run 20260925T080633Z: vitest died on an unhandled
 * `ERR_RESOLVE_PACKAGE_ENTRY_FAIL` ("Failed to resolve entry for package
 * @qode/contract"), then printed a dump of transformed source. The old message
 * kept only the tail, so the log carried a stack trace and no cause; the error
 * was about 25 lines earlier. This returns the first `Unhandled Error`,
 * `Unhandled Rejection` or `<Name>Error:` block (ANSI stripped), then the tail
 * for context, or the tail alone when neither is found.
 */
export function failureExcerpt(output, { head = 1500, tail = 600 } = {}) {
  const plain = String(output ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const at = plain.search(/Unhandled (?:Error|Rejection)|^\s*[A-Za-z]*Error(?: \[[A-Z_]+\])?: /m);
  if (at === -1) return plain.slice(-2000);
  const first = plain.slice(at, at + head);
  const rest = plain.length > at + head ? plain.slice(-tail) : "";
  return rest ? `${first}\n  …\n${rest}` : first;
}

export function suiteStandIns() {
  return SUITE_STAND_INS;
}
export function suiteEnv(base = process.env) {
  const env = { ...base };
  const decision = liveDecision({ outDir: OUT_DIR, argv: ARGV });
  if (decision.live) return env;
  maskDatabaseEnv(env);
  for (const f of [STAGING_ENV, ...ENV_FILES.map((n) => join(REPO_ROOT, n))]) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && isDatabaseVar(m[1], m[2])) env[m[1]] = databasePlaceholder(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  // THE SAME STAND-INS STAGE 1 PLANS AND THE RECORDER APPLIES (standins.mjs),
  // FROM THE SAME SUPPLIED SET (review S2): this environment, the repo's own
  // .env files, AND staging.env's names - as stagingenv.mjs standInsReport
  // plans them. Their suite reads no staging.env, so a name staging supplies
  // stays unset here, exactly as it was before stand-ins existed: faking it
  // would change their baseline under a name no artifact listed. Mocked only -
  // live returned above. Names only reach an artifact (SUITE_STAND_INS,
  // written to baseline.json `suiteStandIns`); the plan is not printed.
  let stagingNames = [];
  try { stagingNames = envNames(readFileSync(STAGING_ENV, "utf8")); } catch { /* nothing resolved */ }
  const plan = planStandIns({
    repoRoot: REPO_ROOT,
    srcRoot: SRC_ROOT,
    isExcluded: isSrcExcluded,
    supplied: [...Object.keys(env), ...stagingNames],
    envDefaults: scanEnvDefaults(null),
    isDatabaseVar,
  });
  for (const [n, v] of plan.values) env[n] ??= v;
  SUITE_STAND_INS = { mode: "mocked", names: plan.standIns, suppliedByStaging: stagingNames.filter((n) => !plan.values.has(n)).sort() };
  return env;
}


function runSuite() {
  const resultsPath = join(OUT_DIR, ".vitest-results.json");
  rmSync(resultsPath, { force: true });
  rmSync(COVERAGE_DIR, { force: true, recursive: true });

  process.stdout.write("· vitest run --coverage (istanbul) …\n");
  const t0 = Date.now();
  const run = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "--config",
      VITEST_CONFIG,
      "--coverage",
      // Zero spec files is a STATE this stage records, so it must not be the
      // runner's error. See the header.
      "--passWithNoTests",
      "--reporter=json",
      `--outputFile=${resultsPath}`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: targetNodeEnv(suiteEnv()) }
  );

  let results = null;
  try {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch {
    // The reporter needs one collectible file; the coverage report does not.
    // Both were deleted above, so a report here plus an exit 0 under
    // --passWithNoTests can only be a run that collected nothing and failed
    // nothing. Anything else is a genuine harness failure and still throws.
    if (run.status === 0 && existsSync(join(COVERAGE_DIR, "coverage-summary.json"))) {
      return {
        exitCode: 0,
        state: "no-spec-files",
        durationSeconds: Math.round((Date.now() - t0) / 1000),
        files: 0,
        tests: 0,
        passed: 0,
        failed: 0,
        failedFiles: 0,
        green: true,
        failures: [],
        note: "no spec file was collected and the json reporter wrote nothing; the istanbul denominator below comes from coverage.all",
      };
    }
    const output = run.stderr || run.stdout || "";
    // A DECORATOR repo - NestJS, TypeORM, type-graphql - dies here with a babel
    // syntax error and a stack that names charpilot rather than the cause.
    //
    // It is `coverage.all`, not the decorators. A file some spec imports is
    // instrumented AFTER the host's own transform (swc or esbuild), decorators
    // already lowered, and covers fine. A file NO spec imports is read off disk
    // by the provider and parsed by babel with a fixed plugin list - which
    // holds no decorator plugin in any vitest major measured (2.1.9, 3.2.4,
    // 4.1.10 all take it from @istanbuljs/schema, which lists none) and is not
    // configurable from a vitest config.
    //
    // Reproduced on a 4-file probe: one decorated class + one plain function,
    // `all: true`, no spec importing the decorated file -> this error; add a
    // spec that imports it -> green, 1 branch and 3 functions recorded for it.
    // Measured on qode-backend (NestJS + unplugin-swc), which dies on
    // src/app.module.ts at the `@Module({` on line 21.
    //
    // THE COMMON CAUSE IS NOW HANDLED, so reaching this is newly informative.
    // `unplugin-swc` returned `{ esbuild: false }` from its vite `config()`
    // hook, which left the files SWC never sees with no transform at all;
    // vitest.charpilot.config.mts neutralises that hook and gives the plugin
    // `enforce: "pre"`, so SWC still transforms what the suite imports and
    // esbuild covers the rest. Verified on qode-itl-be: 160 spec files ran,
    // 278 files instrumented including 91 that no spec imports - app.module.ts
    // among them - and the denominator came out 7065 branch sides and 2601
    // functions, digit-identical to the plugin-free measurement.
    //
    // So this error now means a transform the pilot does NOT know about is
    // suppressing vite's esbuild the same way. Name it here when it is found.
    // WITHOUT ANSI. vitest colours "SyntaxError" and the path, and the codes
    // between them kept this match from firing: crisp-ms run 20260925T002031Z
    // got the generic "produced no JSON results" instead of this diagnosis.
    const untransformed = output.replace(/\x1b\[[0-9;]*m/g, "").match(
      /SyntaxError: (\S+\.ts)[^\n]*?(experimental syntax '(\w+)'|Unexpected token[^\n]*)/
    );
    if (untransformed) {
      throw new Error(
        `vitest parsed a source file that NO spec imports as plain JavaScript (exit ${run.status}).\n` +
          `  ${untransformed[1]}\n` +
          `  ${untransformed[2]}\n\n` +
          `  coverage.all reads such a file off disk and hands it to babel with a fixed plugin list -\n` +
          `  no typescript plugin and no decorator plugin - so the host's own swc/esbuild transform\n` +
          `  never runs on it. A file a spec DOES import is instrumented after that transform and\n` +
          `  covers fine, which is why only part of the tree fails. The list is not configurable from\n` +
          `  a vitest config and is the same in every major measured (2.1.9, 3.2.4, 4.1.10 all read it\n` +
          `  from @istanbuljs/schema).\n\n` +
          `  Standard (TC39) decorators in a repo with no \`experimentalDecorators\` are handled too:\n` +
          `  a root config install.sh writes carries charpilot-standard-decorators (resolution.mjs),\n` +
          `  which lowers them with the repo's own typescript. A repo with its own vitest config\n` +
          `  needs the same plugin, or a transform of its own, for that case.\n\n` +
          `  The unplugin-swc case is already handled: vitest.charpilot.config.mts drops that plugin's\n` +
          `  \`config()\` hook (which returned \`esbuild: false\`) and gives it \`enforce: "pre"\`, so SWC\n` +
          `  transforms what the suite imports and vite's esbuild transforms the rest. If you are seeing\n` +
          `  this, some OTHER plugin is disabling esbuild the same way - find it in the host's vite\n` +
          `  config and give it the same treatment.\n\n` +
          `  Failing that: import the file from a spec so the normal transform covers it, or exclude it\n` +
          `  in the host's coverage.exclude and mirror that in test/src-exclude.mjs. Dropping\n` +
          `  coverage.all is NOT an option - the denominator would then move with the suite.\n` +
          `${output.slice(-2000)}`
      );
    }
    throw new Error(`vitest produced no JSON results (exit ${run.status}).\n${failureExcerpt(output)}`);
  }

  const files = results.testResults?.length ?? 0;
  const tests = results.numTotalTests ?? 0;
  const red = !(files === 0 && tests === 0) && !(run.status === 0 && (results.numFailedTests ?? 1) === 0);

  return {
    exitCode: run.status,
    // Three states, not two. `green` alone cannot distinguish "nothing failed"
    // from "nothing ran", and status.mjs printed the second as "0/0 green".
    state: files === 0 && tests === 0 ? "no-spec-files" : (run.status === 0 && (results.numFailedTests ?? 1) === 0 ? "green" : "red"),
    durationSeconds: Math.round((Date.now() - t0) / 1000),
    files,
    tests,
    passed: results.numPassedTests ?? 0,
    failed: results.numFailedTests ?? 0,
    // A FILE that failed to collect runs no test, so numFailedTests stays 0
    // while the suite is red. ptp-be refused with "0 failed" and one filename -
    // an import error (an ungenerated Prisma enum read as undefined at module
    // scope), which is a different problem with a different fix from a failing
    // assertion. Counted separately so the refusal can say which it is.
    failedFiles: (results.testResults ?? []).filter((f) => f.status === "failed").length,
    // A zero-spec run has nothing that could have failed, so it is not red -
    // and the state field above is what says which kind of not-red it is. The
    // exit code is 0 only because --passWithNoTests is passed; without it
    // vitest returns 1 for "no test files found", which is not a suite verdict.
    green: files === 0 && tests === 0 ? true : run.status === 0 && (results.numFailedTests ?? 1) === 0,
    failures: (results.testResults ?? [])
      .filter((f) => f.status === "failed")
      .map((f) => f.name.replace(`${REPO_ROOT}/`, "")),
    // WHY IT IS RED, file by file, and whose each cause is (redsuite.mjs).
    ...(red ? { classification: classifyRedSuite(results, { repoRoot: REPO_ROOT }) } : {}),
  };
}

/**
 * THE PRISMA CLIENT THE REPO'S CI GENERATES, generated here too - and only
 * when the suite was red for want of it (redsuite.mjs `setup`).
 *
 * qode-backend's CI runs `npm run prisma:generate` before `npm test` and needs
 * no database; in a fresh container its 5 e2e/spec files failed to collect on
 * "Cannot find module '.prisma/client/default'". `prisma generate` reads the
 * schema and writes node_modules/.prisma/client; it opens no connection. It is
 * run with every database variable masked (config.mjs maskDatabaseEnv) and a
 * db.invalid DATABASE_URL where none is set, because prisma.config.ts reads
 * that variable eagerly.
 *
 * Not run when a generator declares its own `output`: that client is written
 * into the repo's tree, where finish.py would commit it.
 *
 * AND WHEN THE CLIENT INSTALL LEFT IS PRISMA'S PLACEHOLDER (D42), whatever the
 * suite says. @prisma/client's postinstall copies a placeholder into
 * node_modules/.prisma/client BEFORE it tries to generate, and leaves it there,
 * silently, when that generate fails. The placeholder exports PrismaClient
 * (which throws "did not initialize yet" when constructed) and a bare
 * `Prisma` - no enum, no error class. qode-ptp-ms, mocked, late September
 * 2026: one of its four runs had its suite red on "Cannot convert undefined
 * or null to object" (939 tests in 137 files, a module-scope
 * `Object.keys(SomeEnum)`), which reads as the repo's own bug and was ruled
 * so, and every row that loaded an enum died "No \"RoleType\" export is
 * defined on the \"@prisma/client\" mock": 2911 sides pipeline_defect, the
 * run ending at 28.3% against 54.8% on the run before it. The placeholder
 * reproduces both exactly, under every recorder from before the regression
 * to now, and a generated client clears both. Nothing looked at the client,
 * because it existed.
 */
export function prismaPlaceholder(repoRoot = REPO_ROOT) {
  return placeholderAt(repoRoot);
}

function prismaSchemas() {
  const found = [];
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")); } catch { /* none */ }
  const named = typeof pkg?.prisma?.schema === "string" ? [pkg.prisma.schema] : [];
  for (const rel of [...named, "prisma/schema.prisma", "schema.prisma"]) {
    if (existsSync(join(REPO_ROOT, rel)) && !found.includes(rel)) found.push(rel);
  }
  const dir = join(REPO_ROOT, "prisma", "schema");
  try {
    for (const n of readdirSync(dir)) if (n.endsWith(".prisma")) found.push(`prisma/schema/${n}`);
  } catch { /* no multi-file schema */ }
  return found;
}

/**
 * THE REPO'S OWN COMMAND, for the one comparison redsuite.mjs needs: nothing
 * passed under our config - does anything pass under theirs?
 *
 * Their `test` script when it runs vitest (its flags kept, `watch` and a
 * leading `run` dropped), else bare `vitest run`; with the json reporter and
 * no coverage, and the same environment runSuite gives ours. Null when it
 * wrote no results.
 */
export function theirOwnRun() {
  let script = "";
  try { script = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))?.scripts?.test ?? ""; } catch { /* none */ }
  const m = /(?:^|&&\s*|\s)(?:npx\s+)?vitest((?:\s+[^&|;]+)?)/.exec(script);
  const flags = m ? m[1].trim().split(/\s+/).filter(Boolean).filter((a, i) => !(i === 0 && (a === "run" || a === "watch")) && a !== "--watch") : [];
  const resultsPath = join(OUT_DIR, ".vitest-theirs.json");
  rmSync(resultsPath, { force: true });
  const args = ["vitest", "run", ...flags, "--passWithNoTests", "--reporter=json", `--outputFile=${resultsPath}`];
  process.stdout.write(`· nothing passed under our config: running the repo's own \`${args.slice(0, 2 + flags.length).join(" ")}\` to compare …\n`);
  spawnSync("npx", args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 900_000, env: targetNodeEnv(suiteEnv()) });
  try {
    const r = JSON.parse(readFileSync(resultsPath, "utf8"));
    return { command: args.slice(0, 2 + flags.length).join(" "), tests: r.numTotalTests ?? 0, passed: r.numPassedTests ?? 0, failed: r.numFailedTests ?? 0 };
  } catch {
    return null;
  } finally {
    rmSync(resultsPath, { force: true });
  }
}

export function generatePrismaClient(because = "the suite was red for want of its generated client") {
  const schemas = prismaSchemas();
  if (!schemas.length) return { ran: false, ok: false, why: "no Prisma schema found" };
  const custom = schemas.filter((rel) => /generator\s+\w+\s*\{[^}]*\boutput\s*=/.test(readFileSync(join(REPO_ROOT, rel), "utf8")));
  if (custom.length) return { ran: false, ok: false, why: `a generator in ${custom.join(", ")} declares its own output, inside the repo's tree` };
  const bin = join(REPO_ROOT, "node_modules", ".bin", "prisma");
  if (!existsSync(bin)) return { ran: false, ok: false, why: "the prisma CLI is not in node_modules/.bin" };
  // THE CLIENT IS WRITTEN BESIDE THE RESOLVED @prisma/client, as
  // node_modules/.prisma/client. In a hoisted monorepo that is outside this
  // repo, and generating there would change a tree this run does not own.
  let client = null;
  try {
    client = dirname(realpathSync(createRequire(join(REPO_ROOT, "package.json")).resolve("@prisma/client/package.json")));
  } catch {
    return { ran: false, ok: false, why: "@prisma/client does not resolve from the repo, so there is no client to generate" };
  }
  const root = realpathSync(REPO_ROOT);
  const rel = relative(root, client);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ran: false, ok: false, why: `@prisma/client resolves to ${client}, outside the repo root (a hoisted install) - the client would be generated there, so it was not` };
  }
  const env = maskDatabaseEnv({ ...process.env });
  if (!env.DATABASE_URL) env.DATABASE_URL = databasePlaceholder("DATABASE_URL");
  // NOTHING LEAVES THE MACHINE. No telemetry (CHECKPOINT_DISABLE), no update
  // check, and no engine download: the mirror is an address that refuses at
  // once, so generate uses the engines the install put in node_modules, and
  // a repo without them fails here and is named as a setup pipeline defect.
  env.CHECKPOINT_DISABLE = "1";
  env.PRISMA_HIDE_UPDATE_MESSAGE = "1";
  env.PRISMA_ENGINES_MIRROR = "http://127.0.0.1:9";
  env.PRISMA_GENERATE_SKIP_AUTOINSTALL = "1";
  // node_modules/.bin FIRST on PATH, as npx or an npm script would put it: a
  // second generator is run by name. qode-ptp-ms's schema also declares
  // `prisma-json-types-generator`, and generate failed "not found" after the
  // client without this (the install-time generate in docker/char/packs/common.py
  // does the same).
  env.PATH = [join(REPO_ROOT, "node_modules", ".bin"), env.PATH ?? ""].join(delimiter);
  process.stdout.write(`· prisma generate (${because}) …\n`);
  const t0 = Date.now();
  const r = spawnSync(bin, ["generate"], { cwd: REPO_ROOT, encoding: "utf8", env, timeout: 300_000 });
  const tail = `${r.stderr || ""}${r.stdout || ""}`.trim().split("\n").slice(-3).join(" | ");
  const noEngines = r.status !== 0 && /127\.0\.0\.1:9|ECONNREFUSED|download|engine/i.test(tail);
  return {
    ran: true, ok: r.status === 0, exit: r.status, seconds: Math.round((Date.now() - t0) / 1000), schemas,
    ...(r.status === 0 ? {} : { why: `${noEngines ? "its engines are not installed and were not downloaded (no network is used for this): " : ""}${tail.slice(0, 400)}` }),
  };
}

/** out/runner.json, or null when install.sh wrote none (a hand-run baseline). */
function readRunner() {
  try {
    return JSON.parse(readFileSync(join(OUT_DIR, "runner.json"), "utf8"));
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * istanbul supplies the arm DENOMINATOR, and only after instrumentation. The AST
 * scan (stage 2) supplies the arm LIST. They are different artifacts and the
 * pilot needs both — this is the half that has to be read out of a coverage run.
 */
function readCoverage() {
  const summary = readJson(join(COVERAGE_DIR, "coverage-summary.json"));
  const final = readJson(join(COVERAGE_DIR, "coverage-final.json"));

  const pct = (m) => ({
    covered: m.covered,
    total: m.total,
    pct: m.pct,
  });

  const perFile = {};
  for (const [absPath, entry] of Object.entries(final)) {
    const rel = absPath.replace(`${REPO_ROOT}/`, "");
    const branchArms = Object.values(entry.branchMap ?? {}).reduce(
      (n, b) => n + (b.locations?.length ?? 0),
      0
    );
    const coveredArms = Object.values(entry.b ?? {}).reduce(
      (n, counts) => n + counts.filter((c) => c > 0).length,
      0
    );
    perFile[rel] = {
      istanbulArms: branchArms,
      istanbulArmsCovered: coveredArms,
      istanbulFunctions: Object.keys(entry.fnMap ?? {}).length,
      branchKinds: Object.values(entry.branchMap ?? {}).reduce((acc, b) => {
        acc[b.type] = (acc[b.type] ?? 0) + (b.locations?.length ?? 0);
        return acc;
      }, {}),
    };
  }

  return {
    provider: "istanbul",
    totals: {
      statements: pct(summary.total.statements),
      branches: pct(summary.total.branches),
      functions: pct(summary.total.functions),
      lines: pct(summary.total.lines),
    },
    perFile,
  };
}


/* ------------------------------------------------- stage 1's second half */

/**
 * A FIELD WHOSE SCHEMA IS A LOCAL HELPER CALL, and whether that helper defaults.
 *
 * THE DEFECT, measured on notification-ms run `20260921T115426Z`. `src/env.ts`
 * declares
 *
 *   const envBoolean = (d: boolean) => z.string().default(String(d)).transform(…)
 *   ENABLE_INTEGRATION_CACHE: envBoolean(false),
 *
 * The field body is `envBoolean(false)` and holds no `.default(`, so this file
 * called the variable `requiredNoDefault`. It is not: it defaults to `"false"`.
 * `record.mjs:6084` then synthesised a placeholder for a variable that never
 * needed one, chose `"charpilot-placeholder"` because the NAME matches neither
 * its DSN nor its URL pattern, and the helper's own transform rejected it:
 *
 *   Expected boolean, received "charpilot-placeholder"
 *
 * That threw at module import, in `phase: "arrangement"`, so the subject was
 * never entered. **39 of that run's 41 failing emitted tests are that one
 * variable**, and every one of the 39 is also a `path-not-taken` false claim,
 * because an arm cannot move in a subject that never ran. One type mismatch
 * produced both symptoms and six measurements of a "false-claim rate".
 *
 * `PORT: envNumber(4005)` is the same shape and was next: a number schema
 * rejects that string too.
 *
 * ONE LEVEL, AND IT REFUSES RATHER THAN GUESSES. The body has to be a bare call
 * to a single identifier declared in this same file; anything else — a member
 * call, a helper from another module, an identifier with no `const` here —
 * returns null and the field is read exactly as it was before. A wrong `true`
 * here would drop a genuinely required variable from the list and the module
 * would throw at import for want of it, which is worse than the placeholder.
 */
export function helperDefaults(text, body) {
  const call = body.match(/^\s*[A-Z][A-Z0-9_]*\s*:\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (!call) return null;
  const name = call[1];
  // `z` is the schema library itself, not a local helper: `z.string()` is
  // already read correctly by the caller and must not be chased.
  if (name === "z") return null;
  const decl = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).exec(text);
  if (!decl) return null;
  // To the next top-level declaration, so the search stays inside this helper.
  const after = text.slice(decl.index);
  const end = after.slice(1).search(/\n(?:const|let|var|function|export)\s/);
  const scope = end === -1 ? after : after.slice(0, end + 1);
  return scope.includes(".default(");
}

/** Where a service declares its environment schema, in the order tried. */
const ENV_SCHEMA_CANDIDATES = [
  "src/env.ts",
  "src/env/index.ts",
  "src/config/env.ts",
  "src/configs/env.ts",
  "src/common/env.ts",
];

/**
 * AN ENV SCHEMA AT A PATH NOT ON THAT LIST IS STILL THE ENV SCHEMA (D43).
 *
 * tracy-worker, the mocked run of September 26: its schema is `src/config.ts`,
 * a `z.object({ .. GEMINI_API_KEY: z.string().min(1), GRAPHQL_URL: z.url() ..
 * })` that `loadEnv()` runs through `safeParse(process.env)` at import, calling
 * `process.exit(1)` when it fails. None of the five paths above exists there,
 * so envDefaults said "no env schema found", `requiredNoDefault` was empty,
 * neither name was stood in, and every row whose imports reached the config
 * died in arrangement with vitest's `process.exit unexpectedly called with
 * "1"` - most of the repo's rows.
 *
 * So after the fixed paths, the source directory is read for the file that
 * parses `process.env` through a zod object: `.parse(process.env)`,
 * `.safeParse(process.env)` (or `{ ...process.env }`, or an async parse) in a
 * file that builds a `z.object(`. TEXT ONLY, as the rest of this scan: the
 * schema is never imported. More than one such file: the one declaring the
 * most UPPER_SNAKE keys, then the shortest path, so the answer is stable.
 */
const PARSES_PROCESS_ENV = /\.(?:safeParse|parse|safeParseAsync|parseAsync)\(\s*(?:\{\s*\.\.\.\s*)?process\.env\b/;
const NOT_SCHEMA_SOURCE = /\.d\.[cm]?ts$|\.(?:test|spec|e2e-spec|char\.test|char)\.[cm]?[jt]sx?$/;
export function findEnvSchemaFile(repoRoot, srcRoot, isExcluded = () => false) {
  const fixed = ENV_SCHEMA_CANDIDATES.find((f) => existsSync(join(repoRoot, f)));
  if (fixed) return fixed;
  if (!srcRoot || !existsSync(srcRoot)) return null;
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 16 && e.name !== "node_modules" && !e.name.startsWith(".")) walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !/\.[cm]?[jt]sx?$/.test(e.name) || NOT_SCHEMA_SOURCE.test(e.name)) continue;
      if (isExcluded(relative(srcRoot, abs))) continue;
      let text = "";
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      if (!/\bz\.object\(/.test(text) || !PARSES_PROCESS_ENV.test(text)) continue;
      const keys = (text.match(/^\s+[A-Z][A-Z0-9_]*\s*:/gm) ?? []).length;
      if (keys) found.push({ file: relative(repoRoot, abs).split("\\").join("/"), keys });
    }
  };
  walk(srcRoot, 0);
  found.sort((a, b) => b.keys - a.keys || a.file.length - b.file.length || (a.file < b.file ? -1 : 1));
  return found[0]?.file ?? null;
}

/** The parenthesised argument of `.default(` starting at `from`, balanced. */
function balancedArg(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(from + 1, i);
    }
  }
  return "";
}

/**
 * Which vars in the target's own env schema carry a `.default(...)`.
 *
 * This is a PROVENANCE question, not a secrets question, and the distinction is
 * the whole reason the check exists. A var with a default cannot fail loudly
 * when stage 1's resolution misses it. In every other context that is fine —
 * production supplies the value from the qode-iac manifests, so the fallback
 * never activates where it matters. In the RECORDING context it is not:
 * `vitest.record.config.mts` sets `setupFiles: []`, so the target's own test
 * setup never loads, and a row's environment is `--env-file` or the ambient
 * shell and nothing else. A schema full of defaults therefore self-satisfies in
 * silence, and a row that LOOKS configured may have been answered by a source
 * literal instead of by resolved staging. That makes the recorded pair's inputs
 * untraceable, which is the defect — not the literal's existence.
 *
 * So this reports what stage 1's resolution has to COVER. Once the resolution
 * covers a var, its default is never consulted during recording at all, which
 * is why this is the check on whether resolution was complete rather than a
 * finding in its own right.
 *
 * Parsed from TEXT, never imported. Importing the schema executes it — the one
 * thing stage 1 must not do, because a schema that throws on a missing required
 * var would take the baseline down with it.
 *
 * NO VALUE LEAVES THIS FUNCTION. `secrets.mjs`'s detectors are asked which
 * defaults are credential-shaped, purely so those sort first in the report; the
 * literal is a local, and what comes back is a name, a line and a sentence.
 */
/**
 * The SHAPE a field will accept, so a stand-in can satisfy it.
 *
 * WHY THIS EXISTS. Stage 5 stamps `recorded.env` with the names the recording
 * ran under and values that are true of nothing, and a value chosen by NAME is
 * a string. Two rounds of that have now failed in opposite directions:
 *
 *   PORT: envNumber(4005)                  Expected number, received
 *                                          "charpilot-placeholder"
 *   APP_ENV: z.enum(["DEVELOPMENT", …])     Invalid enum value … received
 *                                          'CHARPILOT-PLACEHOLDER'
 *
 * The first fix omitted every defaulted variable so the schema would supply its
 * own. That broke the other way, on pricing-ms:
 *
 *   ZIPKIN_COLLECTOR_ENDPOINT: z.string().default("")
 *   src/tracer.ts:16   url: env.ZIPKIN_COLLECTOR_ENDPOINT
 *                      -> new URL("") -> TypeError: Invalid URL
 *
 * thrown at import, `phase: "arrangement"`, one row of 358 - and it took the
 * repo's OWN `Unit Tests` check red, because pricing-ms's
 * `include: ["test/**\/*.test.ts"]` matches the corpus. A schema default can be
 * unusable, and a variable staging SET is one the replay needs a value for:
 * the recording never consulted that default, so substituting it is not
 * reproducing the recording.
 *
 * So neither "always stamp" nor "never stamp a defaulted var" is right. The
 * value has to be present AND type-correct, which needs the field's shape.
 *
 * READ FROM TEXT, like everything else here, and it reports a SHAPE - never a
 * value. The one literal it returns is an enum MEMBER, which is already
 * committed in the repo's own source three lines from the variable's name.
 */
export function envKind(body) {
  const enums = body.match(/\.enum\(\s*\[([^\]]*)\]/);
  if (enums) {
    const first = enums[1].match(/["'`]([^"'`]+)["'`]/);
    if (first) return { kind: "enum", member: first[1] };
  }
  if (/\.transform\(\s*Number\s*\)|z\.coerce\.number|z\.number\(/.test(body)) return { kind: "number" };
  if (/z\.coerce\.boolean|z\.boolean\(/.test(body)) return { kind: "boolean" };
  // A URL RULE (ats-sourcing-service, run 20260925T072715Z). `CV_PARSING_MS_URL:
  // z.string().min(1).refine((v) => new URL(v).protocol === "https:")` read as a
  // plain string, so its stand-in was `http://standin.charpilot.invalid`, the
  // schema refused it at import, and 113 sides died in arrangement with
  // "CV_PARSING_MS_URL must be a valid HTTPS URL" - the repo's own suite went
  // red on it at stage 1 too. `.url()`, `z.url()`/`z.httpUrl()`, a `new URL(`
  // in a refine or transform, and an `https:` protocol test all say URL; the
  // stand-in for one is https, which every one of them accepts. Comments are
  // stripped first: this body runs to the next key, so it carries the NEXT
  // field's comment ("the URL is still required to be HTTPS"), not its own.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  if (/\.url\(|\bz\.(?:url|httpUrl)\(|\bnew URL\(|protocol\s*[!=]==?\s*["'`]https?:|startsWith\(\s*["'`]https?:/.test(code)) return { kind: "url" };
  // A helper whose name says what it builds. `envBoolean(false)` and
  // `envNumber(4005)` are the two real shapes this pipeline has met, and the
  // body here is the CALL, so the helper's own definition is not in view.
  const call = body.match(/:\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (call) {
    if (/bool/i.test(call[1])) return { kind: "boolean" };
    if (/num|int|port/i.test(call[1])) return { kind: "number" };
  }
  return { kind: "string" };
}

function scanEnvDefaults(resolvedVarNames) {
  const file = findEnvSchemaFile(REPO_ROOT, SRC_ROOT, isSrcExcluded);
  if (!file) {
    return {
      file: null,
      note: "no env schema found at any of " + ENV_SCHEMA_CANDIDATES.join(", ") + ", nor any source file that parses process.env through a z.object schema",
    };
  }
  return envDefaultsOf(readFileSync(join(REPO_ROOT, file), "utf8"), file, resolvedVarNames);
}

/** scanEnvDefaults on a schema file's TEXT (`file` is repo-relative). Exported for the tests. */
export function envDefaultsOf(text, file, resolvedVarNames = null) {
  const lines = text.split("\n");

  // A schema field: an UPPER_SNAKE key at object indent. The body of the field
  // runs to the next such key, because a `.default(` is frequently three lines
  // below the name it belongs to.
  const decls = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s+([A-Z][A-Z0-9_]*)\s*:/);
    if (m) decls.push({ name: m[1], line: i + 1, at: lines.slice(0, i).join("\n").length + (i ? 1 : 0) });
  });

  const vars = [];
  for (let i = 0; i < decls.length; i++) {
    const body = text.slice(decls[i].at, decls[i + 1]?.at ?? text.length);
    const at = body.indexOf(".default(");
    // `.default(` ON THE FIELD, or inside the one local helper the field calls.
    // See `helperDefaults`: without the second half, a field declared as
    // `envBoolean(false)` reads as required-with-no-default and the harness
    // supplies a placeholder its own transform then rejects.
    const viaHelper = at === -1 ? helperDefaults(text, body) : null;
    const hasDefault = at !== -1 || viaHelper === true;
    // Unquoted, because the detectors test the VALUE and `"false"` with its
    // quotes still attached read as a non-inert string - which is how
    // VERIFY_API_KEY_ENABLE, a boolean flag whose name contains the segment
    // API_KEY, came out top of the credential-shaped list.
    const literal = hasDefault
      ? balancedArg(body, at + ".default".length).trim().replace(/^(["'`])([\s\S]*)\1$/, "$2")
      : null;
    vars.push({
      name: decls[i].name,
      line: decls[i].line,
      hasDefault,
      // WHERE the default was found, because a reader who sees `hasDefault`
      // true on a body with no `.default(` in it needs to know why.
      defaultVia: at !== -1 ? "field" : viaHelper === true ? "helper" : null,
      // A default of the EMPTY STRING, which a truthiness guard reads as unset.
      // See `withEmptyDefaultNames`. A boolean, never the literal.
      emptyDefault: at !== -1 && /^(["'`])\1$/.test(balancedArg(body, at + ".default".length).trim()),
      optional: /\.optional\(\)/.test(body),
      // The reason string only; the literal itself is dropped with `body`.
      credentialShaped: hasDefault ? credentialShaped(decls[i].name, literal ?? "") : null,
      // Host only, never the rest of the literal.
      defaultHost: hostOfLiteral(literal),
      // THE SHAPE, so stage 5's stand-in satisfies it. See `envKind`: a value
      // chosen by name is a string, and a string is wrong for a number, a
      // boolean and an enum.
      ...envKind(body),
    });
  }

  const defaulted = vars.filter((v) => v.hasDefault);
  const resolved = resolvedVarNames ? new Set(resolvedVarNames) : null;
  // The actionable set: a default that stage 1's resolution does NOT cover, so
  // a recording run fills it from the source literal and says nothing.
  const uncovered = resolved ? defaulted.filter((v) => !resolved.has(v.name)) : defaulted;
  // Credential-shaped first — not because a committed literal is a finding
  // (the repo owner has ruled that it is intended and staying), but because
  // those are the vars where "answered by a source literal" is hardest to
  // notice and most worth resolving first.
  uncovered.sort((a, b) => Number(Boolean(b.credentialShaped)) - Number(Boolean(a.credentialShaped)) || a.line - b.line);

  return {
    file,
    declared: vars.length,
    withDefault: defaulted.length,
    optional: vars.filter((v) => v.optional && !v.hasDefault).length,
    required: vars.filter((v) => !v.hasDefault && !v.optional).length,
    // The NAMES, not just the count. A hermetic test still has to IMPORT the
    // module, and a required var with no default throws at import time before
    // the subject is ever entered - measured on location-ms, where
    // `DATABASE_URL: z.string()` made server.char.test.ts fail with a ZodError
    // in the arrangement phase, in a PR, with the pair itself perfectly fine.
    // Stage 5 fills exactly these with inert placeholders.
    requiredNoDefault: vars.filter((v) => !v.hasDefault && !v.optional).map((v) => v.name),
    // THE DEFAULTED NAMES, so stage 5 can leave them alone.
    //
    // `recorded.env` is stamped beside the emitted suite with the env the
    // recording ran under, BY NAME and with inert values - and an inert value
    // chosen by name is wrong for any variable whose schema is not a string.
    // Measured here: `PORT: envNumber(4005)` came back
    // `Expected number, received "charpilot-placeholder"` and
    // `APP_ENV: z.enum(["DEVELOPMENT","STAGING","PRODUCTION"])` came back
    // `Invalid enum value … received 'CHARPILOT-PLACEHOLDER'`, 15 files red.
    //
    // A variable with a default needs no value from anybody: omit it and the
    // schema supplies its own, which is the value the recording saw unless
    // staging overrode it. `notCoveredByResolvedEnv` cannot answer this - it is
    // the defaulted vars MINUS whatever resolution covered, so it shrinks to
    // nothing on a resolved environment and the caller would stamp them all.
    //
    // Names only. The literal is still dropped with `body` above.
    withDefaultNames: defaulted.map((v) => v.name),
    // THE NAMES WHOSE DEFAULT IS "" (qode-ptp-ms, run 20260925T072635Z).
    // `SOURCING_MS_HOST: z.string().default('')` is defaulted, so it was never
    // stood in - and `if (env.SOURCING_MS_HOST) {..} else { throw }` runs at
    // import, so the default IS the refusal: 212 sides died in arrangement with
    // "SOURCING_MS_HOST is not set". planStandIns stands in such a name when a
    // read of it refuses to load (standins.mjs). A non-empty default passes the
    // same guard, so it is still left to the schema. Names only.
    withEmptyDefaultNames: defaulted.filter((v) => v.emptyDefault).map((v) => v.name),
    // THE SHAPE OF EVERY DECLARED VARIABLE, so stage 5 can stamp a stand-in a
    // field will accept. See `envKind`. `withDefaultNames` is no longer enough
    // on its own: omitting a defaulted variable is what made
    // `ZIPKIN_COLLECTOR_ENDPOINT: z.string().default("")` replay as `new
    // URL("")` and take pricing-ms's own test check red. Name, kind, and for an
    // enum the first member - which is source-visible beside the name already.
    shapes: vars.map((v) => ({
      name: v.name,
      kind: v.kind,
      ...(v.member === undefined ? {} : { member: v.member }),
    })),
    resolvedEnvVars: resolved ? resolved.size : null,
    // Names and locations only.
    notCoveredByResolvedEnv: uncovered.map((v) => ({ name: v.name, at: `${file}:${v.line}`, credentialShaped: v.credentialShaped })),
    // HOSTS ONLY, from the defaults. A default staging does not override IS
    // what staging runs on, so the host in it is a host this service talks to —
    // and stage 4's allowlist is meant to be derived from that rather than
    // hand-kept. The host is not the credential: a Slack webhook default
    // contributes `hooks.slack.com` and never its path, which is where the
    // secret lives.
    defaultHosts: [...new Set(defaulted.map((v) => v.defaultHost).filter(Boolean))].sort(),
  };
}

/**
 * Hosts written as LITERALS in src, which no config names at all.
 *
 * The third category of the egress rule. Measured on location-ms:
 * `maps.googleapis.com` and `places.googleapis.com` appear only inside
 * `googleMap.service.ts`, named by neither the staging ConfigMap nor an
 * `env.ts` default — so a purely config-derived allowlist denies the one
 * downstream that service exists to call.
 *
 * `localhost` and `127.*` are deliberately EXCLUDED. From a recording machine
 * those mean THIS machine, not staging, and a wrong-but-reachable address
 * answers instead of failing — which is the failure stage 1 already warns
 * about. Interpolated hosts (`${...}`) are skipped: the literal is not the
 * address.
 */
/** The host inside a default literal, or null. Host only - never the path. */
function hostOfLiteral(literal) {
  if (!literal || typeof literal !== "string") return null;
  const m = literal.match(/^[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9._-]+)/i);
  const h = m ? m[1] : (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(literal.trim()) ? literal.trim() : null);
  if (!h || !h.includes(".") || /^(localhost|127\.|0\.0\.0\.0)/.test(h)) return null;
  return h;
}

function sourceLiteralHosts(srcDir) {
  const hosts = new Set();
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.[cm]?tsx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue;
      let text = "";
      try { text = readFileSync(p, "utf8"); } catch { continue; }
      for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
        const h = m[1];
        if (!h.includes(".") || h.includes("$")) continue;
        if (/^(localhost|127\.|0\.0\.0\.0)/.test(h)) continue;
        hosts.add(h);
      }
    }
  };
  walk(srcDir);
  return [...hosts].sort();
}

/**
 * Resolve the environment, and return what to record.
 *
 * `--no-staging-env` is an OPT-OUT and it is written into the artifact, so a
 * baseline that skipped it says so and the gate can see it. A silent skip is
 * the state this whole fix removes.
 */
function stagingEnv() {
  if (SKIP_STAGING_ENV) {
    process.stdout.write("· staging env resolution SKIPPED (--no-staging-env) — recorded as skipped\n");
    return { state: "skipped", why: "--no-staging-env was passed" };
  }
  const explicit = arg("--iac");
  const found = explicit ? { iac: explicit, from: "--iac" } : findIac();
  process.stdout.write("· resolving staging from qode-iac manifests (no kubectl, no DNS, no probe) …\n");
  const report = resolveStagingEnv({
    iac: found.iac,
    namespace: arg("--namespace", "staging"),
    dbAddress: arg("--db-address"),
    service: arg("--service"),
    // NEVER a local .env by default. It wins the merge last and is frequently
    // not staging at all — `.env.example` in this fleet points at localhost
    // with real-shaped credentials. Ask for it explicitly with pilot:stagingenv
    // --env if you have personally confirmed the file is staging.
    envFile: null,
  });
  printReport(report);
  // The report is the artifact; baseline.json carries the PROVENANCE, not a
  // second copy of the values. No value, secret-shaped or not, is duplicated
  // here — out/staging-env.json is the one place any of it lives.
  return {
    state: report.state,
    iac: found.iac ? (report.iac ?? found.iac) : null,
    iacFrom: found.from,
    service: report.serviceName ?? null,
    serviceFrom: report.serviceFrom ?? null,
    namespace: report.namespace,
    resolvedFrom: report.resolvedFrom ?? null,
    sources: report.sources ?? [],
    vars: Object.keys(report.vars ?? {}).length,
    scopes: report.scopes ?? {},
    databaseUrl: report.vars?.DATABASE_URL
      ? { present: true, from: report.vars.DATABASE_URL.from, scope: report.vars.DATABASE_URL.scope }
      : { present: false, from: null, scope: null },
    findings: report.findings ?? [],
    unverified: report.unverified ?? [],
    report: "out/staging-env.json",
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // A PLACEHOLDER CLIENT IS GENERATED BEFORE ANYTHING RUNS ON IT. See prismaPlaceholder.
  const placeholder = prismaPlaceholder();
  const pregenerated = placeholder
    ? { placeholder, ...generatePrismaClient(`${placeholder} is @prisma/client's placeholder - install did not generate the client`) }
    : null;

  const baseline = {
    stage: "1-baseline",
    recordedAt: new Date().toISOString(),
    environment: recordEnvironment(),
    install: install(),
    suite: runSuite(),
    // WHICH SUITE THIS IS A MEASUREMENT OF (runner.mjs, written by install.sh).
    // For a repo on jest or another runner, our vitest runs alongside it over
    // test/characterization only, and this baseline says so: the repo's own
    // suite is not what stage 1 measured.
    runner: readRunner(),
  };
  if (baseline.runner?.note) baseline.suite.note = baseline.runner.note;
  // WHICH VARS THEIR SUITE RAN WITH A STAND-IN FOR, by name (review S2).
  // Live: none - suiteEnv applies no stand-in there.
  baseline.suiteStandIns = suiteStandIns() ?? { mode: "live", names: [] };
  if (pregenerated) baseline.prismaGenerate = pregenerated;

  // A SUITE RED FOR WANT OF ITS GENERATED PRISMA CLIENT is prepared the way its
  // CI prepares it, and run once more. See generatePrismaClient.
  if (!pregenerated && baseline.suite.state === "red" && baseline.suite.classification?.needs?.includes("prisma-client")) {
    baseline.prismaGenerate = generatePrismaClient();
    if (baseline.prismaGenerate.ok) {
      const note = baseline.suite.note;
      baseline.suite = runSuite();
      if (note) baseline.suite.note = note;
      baseline.suiteStandIns = suiteStandIns() ?? baseline.suiteStandIns;
    }
  }

  // A RED SUITE IS RECORDED, NOT A STOP (tool backlog: qode-backend). Its
  // coverage is still the repo's coverage - vitest writes it on failure
  // (reportOnFailure) - so the failing tests are written down as a note and the
  // baseline is taken from the suite as it stands. The run goes on to stage 3.
  // Only a red suite with no coverage report at all still has no denominator.
  //
  // NOTHING PASSED UNDER OUR CONFIG: does anything pass under theirs?
  // (redsuite.mjs, "0 of N passing when the repo's own suite passes".)
  if (baseline.suite.state === "red" && baseline.suite.passed === 0 && baseline.suite.classification?.verdict === "theirs") {
    const ownRun = theirOwnRun();
    if (ownRun) {
      const resultsPath = join(OUT_DIR, ".vitest-results.json");
      try {
        baseline.suite.classification = classifyRedSuite(JSON.parse(readFileSync(resultsPath, "utf8")), { repoRoot: REPO_ROOT, ownRun });
      } catch {
        baseline.suite.classification = { ...baseline.suite.classification, ownRun };
      }
    }
  }

  // WHOSE RED IT IS (verifier, review of PR #38; redsuite.mjs). A service the
  // mocked run does not have, or the repo's own test failing on its own code,
  // is the repo's: a note. Our config, our files, or a generated client we did
  // not make is ours: `owner: "pipeline"`, which steps/baseline.mjs writes as a
  // pipeline defect, so the run goes on and cannot succeed.
  const redWithCoverage = baseline.suite.state === "red" && existsSync(join(COVERAGE_DIR, "coverage-summary.json"));
  // A placeholder client generate could not replace is the pipeline's, whatever
  // the failures read as: every enum the suite and the rows load is undefined.
  const stillPlaceholder = pregenerated && prismaPlaceholder();
  if (baseline.suite.state === "red" && stillPlaceholder && baseline.suite.classification) {
    baseline.suite.classification = {
      ...baseline.suite.classification,
      verdict: "setup",
      owner: "pipeline",
      needs: [...new Set([...(baseline.suite.classification.needs ?? []), "prisma-client"])],
    };
  }
  const classification = baseline.suite.classification;
  if (baseline.suite.state === "red" && classification) {
    baseline.suite.owner = classification.owner;
    const said = describeRedSuite(classification, baseline.suite);
    if (classification.owner === "pipeline") {
      baseline.suite.pipelineDefect = stillPlaceholder
        ? `the Prisma client is still @prisma/client's placeholder (${stillPlaceholder}), so every enum and the Prisma namespace's error classes read undefined; prisma generate did not make the client: ${baseline.prismaGenerate.why ?? "it exited 0 and left the placeholder"}`
        : baseline.prismaGenerate && !baseline.prismaGenerate.ok
        ? `${said} prisma generate did not make the client: ${baseline.prismaGenerate.why}`
        : said;
    }
    if (redWithCoverage) baseline.suite.note = said;
  }
  if (redWithCoverage) {
    process.stdout.write(`\n! ${baseline.suite.pipelineDefect ?? baseline.suite.note}\n`);
  }
  if (baseline.suite.state === "red" && !redWithCoverage) {
    writeFileSync(BASELINE_JSON, JSON.stringify(baseline, null, 2));
    console.error(
      `\n✗ suite is NOT green. Baseline not usable.\n` +
        `    ${baseline.suite.failed} failing test(s) in ${baseline.suite.failedFiles} file(s)` +
        (baseline.suite.failed === 0 && baseline.suite.failedFiles
          ? ` — 0 failing TESTS with a failing FILE means the file never collected: an import-time error, not an assertion.\n` +
            `      Check a generated client first (npx prisma generate) - an ungenerated enum reads as undefined at module scope.\n`
          : "\n") +
        baseline.suite.failures.map((f) => `    ${f}`).join("\n")
    );
    process.exit(1);
  }

  baseline.coverage = readCoverage();
  // The second half of the stage. It runs AFTER the suite because a red suite
  // is the one thing that makes this whole artifact unusable, and there is no
  // point resolving an environment for a baseline nobody can quote.
  baseline.stagingEnv = stagingEnv();

  // Stage 1 owns the environment, so stage 1 answers the question stage 4 acts
  // on: will recording be REAL or MOCKED? Discovering that at stage 4 means a
  // run learns at minute 99 that everything it recorded was mocked - measured
  // twice, at 96.5% and 93.5% against denied boundaries.
  baseline.recordingWillBe = liveDecision({ outDir: OUT_DIR, argv: ARGV });
  process.stdout.write(
    `\n  stage 4 will record: ${baseline.recordingWillBe.live ? "LIVE against staging" : "MOCKED"}\n` +
      `    ${baseline.recordingWillBe.why}\n` +
      (baseline.recordingWillBe.live
        ? ""
        : `    Fix this NOW, at stage 1. A mocked recording reports success and\n` +
          `    freezes the behaviour of denied boundaries, which protects nothing.\n`)
  );
  baseline.envDefaults = scanEnvDefaults(
    baseline.stagingEnv.state === "resolved" || baseline.stagingEnv.state === "resolved-no-database"
      ? Object.keys(readJson(join(OUT_DIR, "staging-env.json")).vars ?? {})
      : null
  );
  // The stand-in plan stage 1 wrote before the schema was scanned: a name the
  // schema defaults is not faked, so re-plan with it (stagingenv.mjs).
  if (baseline.stagingEnv.state !== "skipped") {
    const standIns = refreshStandIns(baseline.envDefaults);
    if (standIns) baseline.stagingEnv.standIns = standIns.mode === "live" ? { mode: "live", names: [], missing: standIns.missing } : { mode: standIns.mode, names: standIns.names };
  }


  // THE EGRESS RULE, second and third categories. Stage 1 already knows both:
  // a default staging never overrides is what staging runs on, and a URL
  // written into src is a host this service dials whatever the config says.
  // record.mjs unions these with staging-env.json's `allowHosts`, so the
  // allowlist is derived end to end instead of hand-kept.
  baseline.egressHosts = {
    fromDefaults: baseline.envDefaults?.defaultHosts ?? [],
    fromSource: sourceLiteralHosts(SRC_ROOT),
  };  writeFileSync(BASELINE_JSON, JSON.stringify(baseline, null, 2));

  const t = baseline.coverage.totals;
  const arms = Object.values(baseline.coverage.perFile).reduce(
    (n, f) => n + f.istanbulArms,
    0
  );
  const e = baseline.envDefaults;
  const uncovered = e.notCoveredByResolvedEnv ?? [];
  process.stdout.write(
    `\n✓ baseline recorded → ${BASELINE_JSON.replace(`${REPO_ROOT}/`, "")}\n` +
      (baseline.suite.state === "no-spec-files"
        ? `    suite      NO SPEC FILE — nothing ran, and the denominator below is still real (coverage.all)\n`
        : baseline.suite.state === "red"
          ? `    suite      RED - ${baseline.suite.passed}/${baseline.suite.tests} tests passed in ${baseline.suite.files} files (${baseline.suite.durationSeconds}s); the denominator is the suite as it stands\n`
          : `    suite      ${baseline.suite.passed}/${baseline.suite.tests} tests green in ${baseline.suite.files} files (${baseline.suite.durationSeconds}s)\n`) +
      (baseline.runner?.note ? `    runner     ${baseline.runner.runner} (${baseline.runner.detail}) - ${baseline.runner.note}\n` : "") +
      `    statements ${t.statements.pct}%  (${t.statements.covered}/${t.statements.total})\n` +
      `    branches   ${t.branches.pct}%  (${t.branches.covered}/${t.branches.total})\n` +
      `    functions  ${t.functions.pct}%  (${t.functions.covered}/${t.functions.total})\n` +
      `    lines      ${t.lines.pct}%  (${t.lines.covered}/${t.lines.total})\n` +
      `    istanbul arm denominator: ${arms}\n` +
      `    staging env  ${baseline.stagingEnv.state}${baseline.stagingEnv.vars ? ` · ${baseline.stagingEnv.vars} var(s) from ${baseline.stagingEnv.sources.length} manifest(s)` : ""}\n` +
      (e.file
        ? `    env schema   ${e.file} · ${e.declared} var(s) declared, ${e.withDefault} with a default, ${e.required} required\n`
        : `    env schema   ${e.note}\n`)
  );

  // The provenance line, in stage 1's own voice. Not a secrets finding: the
  // defaults are intended and the manifests are the source of truth in
  // production. What this says is that during RECORDING there is no production
  // to be the source of truth, so any of these that stage 1 did not resolve
  // gets filled from a source literal and nothing says so.
  if (uncovered.length) {
    const shaped = uncovered.filter((v) => v.credentialShaped);
    process.stdout.write(
      `\n  ! ${uncovered.length} var(s) in ${e.file} carry a default that the resolved environment does NOT cover,\n` +
        `    so a gap there is filled silently rather than failing. Stage 4 loads no setup file\n` +
        `    (vitest.record.config.mts sets setupFiles: []), so a row's env is --env-file or the\n` +
        `    ambient shell and nothing else — a row that looks configured may have been answered\n` +
        `    by the source literal. NAMES ONLY; no value is read, printed or stored.\n` +
        (shaped.length ? `    ${shaped.length} of them are credential-shaped, listed first:\n` : "") +
        uncovered.slice(0, 12).map((v) => `      ${v.name.padEnd(32)}${v.at}${v.credentialShaped ? "   ← credential-shaped" : ""}\n`).join("") +
        (uncovered.length > 12 ? `      … ${uncovered.length - 12} more (all of them in out/baseline.json envDefaults)\n` : "") +
        (baseline.stagingEnv.state === "resolved" || baseline.stagingEnv.state === "resolved-no-database"
          ? `    Closing these is a qode-iac question: a var in the ConfigMap or Secret is resolved and\n    its default is then never consulted during recording.\n`
          : `    The resolved environment is ${baseline.stagingEnv.state}, so NONE of the schema is covered.\n    Resolve it first — this list is what that resolution has to cover.\n`)
    );
  }
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead - which happened three
// times in one session: importing exec.mjs to read one function overwrote
// exec-rows.json, importing record.mjs to check it loaded started a 366-row
// recording, and importing diversity.mjs for its shape signature ran the whole
// census AND consumed the caller's own --json argument.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}