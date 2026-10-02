#!/usr/bin/env node
/**
 * The scan, checked against istanbul on the whole fleet, one repo at a time.
 *
 *   node tools/fleetcheck.mjs                 # every repo, from the top
 *   node tools/fleetcheck.mjs --only a,b      # just these
 *   node tools/fleetcheck.mjs --from pricing-ms
 *   node tools/fleetcheck.mjs --recheck       # re-compare from CACHE, no clone, no install
 *   node tools/fleetcheck.mjs --keep          # do not delete node_modules afterwards
 *
 * WHY THIS EXISTS. `bench.mjs` was meant to be this and cannot run: it names
 * `.claude/charpilot/bench/vitest.bench.config.mts`, which has never existed in
 * git history and `install.sh` does not write. So the fleet has been verified by
 * hand, and the last attempt reported 32 services run and accounted for 20.
 *
 * DISK IS THE CONSTRAINT, so the loop is serial and self-cleaning: clone, install
 * the measurement toolchain, measure, cache the ANSWER, delete node_modules, next.
 * A full `npm ci` of this fleet is 20-33 GB against 23 GB free.
 *
 * WHAT IS INSTALLED, and why it is not `npm ci`. Only `vitest` and
 * `@vitest/coverage-istanbul`, pinned to the version the repo's own lockfile
 * resolves. The repo's runtime dependencies are never needed because THE TESTS
 * NEVER RUN: `coverage.all` instruments every file in `include` without
 * executing it, which is what makes this work on a service that wants a
 * database, an env file and a green install. No repo in this fleet ships the
 * istanbul provider itself, so it is added - at the host's EXACT vitest version,
 * because the provider peers on one and a major range resolves a newer patch
 * that then conflicts.
 *
 * WHY THE HOST'S VITEST CONFIG IS NOT USED. Two reasons, and the second is the
 * whole reason stage 1 died on the Nest services.
 *
 *   1. It names plugins and setup files whose packages we deliberately did not
 *      install, so loading it fails before any measurement.
 *   2. `unplugin-swc` returns `{ esbuild: false }` from its `config()` hook. A
 *      file NO spec imports never enters the module graph, so the swc plugin's
 *      transform never runs on it, and with vite's own esbuild disabled it
 *      reaches istanbul as raw TypeScript - which babel then parses with the
 *      fixed plugin list from @istanbuljs/schema, holding NO typescript plugin
 *      at all. Probed: `export function f(a: number)` fails at `Unexpected
 *      token, expected "," (1:27)`; decorators are incidental, and the error
 *      lands on whatever TS-only token comes first in the file. That is why
 *      qode-backend reported `@Module({` and qode-itl-be `import type` from one
 *      cause.
 *
 * Since nothing executes, emitted decorator metadata is irrelevant here, so the
 * measurement config carries NO host plugins and every repo is transformed by
 * vite's esbuild alone. That is also the transform `scan.mjs` already models.
 *
 * WHAT IS COMPARED. Per file and in total, the three-term identity on both
 * lines - `ast - suppressed == istanbul` - for branch SIDES and for FUNCTIONS.
 * A repo passes only if both close and no file drifts.
 *
 * THE CACHE IS THE POINT. istanbul's answer for a pinned commit never changes,
 * so `out/fleet/<repo>/coverage-final.json` is written before node_modules is
 * deleted. `--recheck` then re-runs only the scan, offline, in seconds - which
 * is what makes "fix the scanner, re-verify every repo from the first" cheap
 * enough to actually do.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// NOT from config.mjs. That module resolves the repo from the CWD and refuses a
// directory that is not a package root - correct for every tool that measures a
// target, and wrong for this one, which runs from the pilot and measures many.
const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

// ABSOLUTE. Every spawn below sets its own `cwd` - the toolchain for vitest, the
// clone for the scan - so a relative path here resolves against the wrong root
// and doubles: `--work out/x` produced
// `out/x/.toolchain/vitest-4.1.3/out/x/.toolchain/vitest-4.1.3/node_modules/...`.
const WORK = resolve(arg("--work", join(OUT_DIR, "fleet-work")));
const CACHE = resolve(arg("--cache", join(OUT_DIR, "fleet")));
const ORG = "https://github.com/Qode-Platform";
// Used only for a repo that pins none of its own. 2.1.9 is what most of this
// fleet's characterization branches pin, so it is the least surprising choice -
// but it IS a choice, and every row says which repos took it.
const FALLBACK_VITEST = arg("--vitest", "2.1.9");
// Measure a different branch fleet-wide - `--branch feature/ai-5314-characterization`
// measures where the pipeline is installed rather than where the code deploys.
const BRANCH_OVERRIDE = arg("--branch", "");

/**
 * The fleet, on the branch each service actually DEPLOYS from - which is
 * `production` for 28 of the 33, and never the org's default branch.
 *
 * This list used the GitHub default branch first, and that was wrong in a way
 * that looked like a finding. On `main`, 21 of the 33 carry no vitest at all and
 * 19 have no spec file, which reads as "this fleet has almost no tests". On
 * `production` the same repos have both: `main` is simply stale on services
 * whose release branch is `production`. Measuring it produced a clean answer
 * about code nobody runs.
 *
 * The five exceptions have no `production` branch and take their default:
 * agent-cluster-control and email-centralization-ms are `main`, qode-ptp-ms is
 * `master`, qode-backend and qode-itl-be are `staging`.
 *
 * `whatsapp-ms` is PRIVATE and was invisible to the token the first runs used,
 * which is why an earlier version of this list called it absent. It exists. The
 * `src/downstream/whatsapp-ms` module inside qode-itl-be is that service's
 * caller, not the service, and both are measured - the caller as part of
 * qode-itl-be, the service on its own row.
 */
const FLEET = [
  ["agent-cluster-control", "main", "express"],
  ["ai-centralization", "production", "express"],
  ["ai-interview-centralization", "production", "express"],
  ["assessment-service", "production", "express"],
  ["ats-sourcing-service", "production", "express"],
  ["candidate-ms", "production", "express"],
  ["company-enrich", "production", "express"],
  ["contact-ms", "production", "express"],
  // vitest 2's esbuild CANNOT PARSE this repo's own source:
  // src/services/workableService.service.ts:247 closes a generic and opens an
  // arrow as `>=>`, which esbuild tokenises as `>=` then `>` and rejects with
  // "Unexpected newline before =>". tsc accepts it - so the service builds, and
  // ts-morph reads it - but every esbuild-based tool fails. vitest 4 transforms
  // it, so it is measured there until the repo puts a space in `> =>`.
  ["crawled-data-sync-ms", "production", "express", "4.1.10"],
  ["crisp-ms", "production", "express"],
  ["cv-parsing-ms", "production", "express"],
  ["email-centralization-ms", "main", "express"],
  ["enrichment-ms", "production", "express"],
  ["image-forwarder", "production", "express"],
  ["interview-service", "production", "express"],
  ["location-ms", "production", "express"],
  ["message-templates", "production", "express"],
  ["nginx-redirecting-ms", "production", "express"],
  ["notification-ms", "production", "express"],
  ["outreach-thread-ms", "production", "express"],
  ["pricing-ms", "production", "express"],
  ["pricing-service", "production", "express"],
  ["profile-centralized", "production", "express"],
  ["qode-ptp-ms", "master", "express"],
  // qode-sentinel-ms IS NOT IN THE FLEET. Its `production` branch is a
  // Gradle/Java service with zero TypeScript files - the service was rewritten,
  // and the TypeScript only survives on `main` beside an `express-version`
  // branch. Characterizing that would be measuring code the service no longer
  // runs, so it is left out rather than measured on a stale branch. Put it back
  // if the TypeScript service returns.
  ["sourcing-ms", "production", "express"],
  ["tracy-agent-be-ms", "production", "express"],
  ["turing-integration-ms", "production", "express"],
  ["whatsapp-ms", "production", "express"],
  ["profile-ms", "production", "nest"],
  ["qode-backend", "staging", "nest"],
  ["qode-itl-be", "staging", "nest"],
  ["tracy-worker", "production", "graphile"],
];

const log = (s) => process.stdout.write(`${s}\n`);
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", timeout: 20 * 60_000, ...opts });

/**
 * The runner to measure with, and why a fallback is legitimate here.
 *
 * Half this fleet pins no vitest on the branch it DEPLOYS: the runner and the
 * charpilot install live on a characterization branch instead. The denominator
 * still has to be measured with SOME runner, and the choice is not free - vitest
 * 4 stopped emitting a branch for a downlevelled enum and stopped downlevelling
 * class fields, so the same source reconciles against a different model under 2
 * and under 4.
 *
 * So: the repo's own pin wins when it has one; otherwise `--vitest` decides and
 * the choice is RECORDED in meta.json beside the answer. The scan agrees with it
 * either way, because config.mjs reads the INSTALLED vitest first and this
 * installs into the repo before the scan runs.
 */
function pinnedVitest(dir, override) {
  if (override) return { version: override, source: "fleet-override" };
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      return undefined;
    }
  };
  const locked = read("package-lock.json")?.packages?.["node_modules/vitest"]?.version;
  if (locked) return { version: locked, source: "lockfile" };
  const pkg = read("package.json") ?? {};
  const declared = pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest;
  // A range is not a version, and the provider peers on an exact one. Strip the
  // range marker and take what is left rather than guessing a newer patch.
  if (declared) return { version: String(declared).replace(/^[^0-9]*/, ""), source: "declared" };
  return { version: FALLBACK_VITEST, source: "fallback" };
}

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

function step(name, fn) {
  const t = Date.now();
  try {
    const r = fn();
    return { ok: true, ms: Date.now() - t, ...r };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: String(e.message ?? e).split("\n").slice(0, 4).join(" | ") };
  }
}

function clone(name, branch, dir) {
  if (existsSync(join(dir, ".git"))) {
    const on = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).stdout?.trim();
    if (on === branch) return { note: "cached" };
    // The branch list changed under a clone that already exists. Reusing it
    // would measure one branch and label it another - the exact failure this
    // whole tool exists to catch - so the clone is moved to the branch asked
    // for. `--depth 1` clones carry no other ref, hence the explicit fetch.
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
 * The runner, installed OUTSIDE the repo and shared by every repo that pins the
 * same version.
 *
 * Installing into the clone does not work and the reason is not obvious:
 * `npm install <pkg>` reifies the WHOLE dependency tree, not just the package
 * named. Half this fleet resolves `@qode/*` from a private Google Artifact
 * Registry through a committed `.npmrc` whose token is env-interpolated, so npm
 * tried to fetch packages it has no credentials for and exited 403 - on a repo
 * where we wanted nothing from that registry at all.
 *
 * Installing per VERSION rather than per repo also collapses 32 installs into
 * the four distinct versions the fleet actually pins, and leaves every clone
 * pristine, which is what makes `--recheck` honest.
 */
function toolchainFor(dir, override) {
  const { version: v, source } = pinnedVitest(dir, override);
  if (!v) throw new Error("no vitest version, and no --vitest fallback");
  const home = join(WORK, ".toolchain", `vitest-${v}`);
  if (existsSync(join(home, "node_modules", "vitest"))) return { home, vitest: v, source, note: "cached" };
  mkdirSync(home, { recursive: true });
  // Its own manifest and its own .npmrc, so nothing here consults the repo's
  // registry configuration.
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "fleetcheck-toolchain", private: true, version: "0.0.0" }));
  writeFileSync(join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  const r = run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--legacy-peer-deps", `vitest@${v}`, `@vitest/coverage-istanbul@${v}`],
    { cwd: home }
  );
  if (r.status !== 0) throw new Error(`install failed: ${(r.stderr || r.stdout || "").trim().slice(-200)}`);
  return { home, vitest: v, source, note: "installed" };
}

/**
 * Point the clone's node_modules at the toolchain THIS run uses.
 *
 * Both the measure path and the recheck path need it, and for the same reason:
 * config.mjs reads the INSTALLED vitest first, so an absent or stale link lets
 * the scan model one version while the cached istanbul answer came from another.
 * crawled-data-sync-ms pins no vitest of its own and is measured under a fleet
 * override, so on recheck it fell back to 2.1.9 against a 4.1.10 answer and
 * reported +12 arms across 4 files that were not drift.
 */
function linkToolchain(dir, home) {
  const link = join(dir, "node_modules");
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(join(home, "node_modules"), link, "dir");
}

/**
 * The denominator, measured with no host plugins and nothing executed.
 */
function measure(dir, name, home, branch) {
  const include = hostInclude(dir);
  // The SAME list the scan is given. Setting only `include` left the host's own
  // `coverage.exclude` applying to one side of the comparison: agent-cluster-control
  // excludes `src/index.ts` and `src/web/server.ts` as thin wiring, the scan
  // honoured that and istanbul did not, and the two files read as -69 arms and
  // -38 functions of model error. One scope, both sides.
  const exclude = hostExclude(dir);
  // The config lives in the TOOLCHAIN, not the repo: it does
  // `import { defineConfig } from "vitest/config"`, and the repo has no
  // node_modules to resolve that from. `--root` then points vitest at the repo,
  // so `include`/`exclude` stay repo-relative and the clone gains no files.
  const cfg = join(home, `vitest.${name}.config.mts`);
  const reports = join(dir, "coverage-fleetcheck");
  writeFileSync(
    cfg,
    `import { defineConfig } from "vitest/config";\n` +
      // WHY ANYTHING UNRESOLVABLE IS STUBBED. We install vitest and the provider
      // and nothing else, so a workspace package, a tsconfig path alias or any
      // runtime dependency is simply absent - and vite's import-analysis still
      // RESOLVES every import of every file it transforms, even with no test
      // running. qode-itl-be died on ERR_RESOLVE_PACKAGE_ENTRY_FAIL for its own
      // `@qode/contract` workspace.
      //
      // Resolution only has to not throw: instrumentation reads each file's own
      // source, and the module graph is never executed. Relative specifiers are
      // left alone so a genuinely missing sibling still surfaces as an error
      // rather than being papered over.
      //
      // It is an ALLOWLIST, not a resolve-and-see. Two earlier shapes failed:
      // stubbing every bare specifier swallowed `@vitest/coverage-istanbul`,
      // which vitest loads through this same pipeline, so the provider came back
      // an empty object and vitest died on `coverageModule.getProvider is not a
      // function` three steps from the cause; and resolving first then stubbing
      // only failures does not help a WORKSPACE package, where the directory
      // resolves but has no built entry and import-analysis fails after the
      // resolve succeeded. qode-itl-be has `workspaces: ["packages/*"]` and died
      // exactly there.
      `const stub = {\n` +
      `  name: "fleetcheck:stub-unresolvable",\n` +
      `  enforce: "pre",\n` +
      `  resolveId(source) {\n` +
      `    if (/^[.\\/]/.test(source)) return null;\n` +
      `    if (/^(node:|vite$|vite\\/|vitest$|vitest\\/|@vitest\\/)/.test(source)) return null;\n` +
      `    return "\\0fleetcheck:" + source;\n` +
      `  },\n` +
      `  load(id) {\n` +
      `    return id.startsWith("\\0fleetcheck:") ? "export default {};" : null;\n` +
      `  },\n` +
      `};\n` +
      `export default defineConfig({\n` +
      `  plugins: [stub],\n` +
      `  test: {\n` +
      // No test file may run: the point is the denominator, and a service whose
      // suite wants a database would otherwise decide whether we get one.
      `    include: [],\n` +
      `    passWithNoTests: true,\n` +
      `    coverage: {\n` +
      `      provider: "istanbul",\n` +
      `      all: true,\n` +
      `      include: ${JSON.stringify(include)},\n` +
      `      exclude: ${JSON.stringify(exclude)},\n` +
      `      reporter: ["json"],\n` +
      `      reportsDirectory: ${JSON.stringify(reports)},\n` +
      `      reportOnFailure: true,\n` +
      `    },\n` +
      `  },\n` +
      `});\n`
  );
  // The repo gets a node_modules SYMLINK to the toolchain before vitest runs.
  // Without it, resolution walks up from the repo and can find an ancestor's
  // node_modules - this pipeline's own, several directories above - and load a
  // different vitest major than the provider beside it. Seen directly: vitest 5
  // from the pilot paired with @vitest/coverage-istanbul 2.1.9 from the
  // toolchain, failing inside the provider on `reportsDirectory` of undefined.
  // Pinning the version is the entire point of installing per version, so this
  // makes the resolution deterministic rather than positional.
  linkToolchain(dir, home);
  const r = run(
    process.execPath,
    [join(home, "node_modules/vitest/vitest.mjs"), "run", "--coverage", "--config", cfg, "--root", dir],
    { cwd: home }
  );
  const final = join(dir, "coverage-fleetcheck", "coverage-final.json");
  if (!existsSync(final)) {
    // The last three lines of a vitest failure are its own stack, which names
    // this tool and not the cause. Prefer, in order: a syntax error, an error
    // line naming a source file, then the first line that says "Error".
    const out = (r.stderr || r.stdout || "").trim();
    const pick =
      out.match(/SyntaxError:[^\n]*/) ??
      out.match(/[^\n]*\.(?:ts|mts|tsx):\d+[^\n]*/) ??
      out.match(/[^\n]*(?:Error|error)[^\n]*/);
    throw new Error((pick ? pick[0] : out.split("\n").slice(-3).join(" | ")).trim().slice(0, 240));
  }
  const cacheDir = join(CACHE, name);
  mkdirSync(cacheDir, { recursive: true });
  // Relative keys, so the cached answer does not carry this machine's paths and
  // a later --recheck can rebase it onto wherever the clone lands.
  const cov = JSON.parse(readFileSync(final, "utf8"));
  const rel = {};
  for (const [abs, d] of Object.entries(cov)) rel[abs.replace(`${dir}/`, "")] = { ...d, path: abs.replace(`${dir}/`, "") };
  writeFileSync(join(cacheDir, "coverage-final.json"), JSON.stringify(rel));
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout?.trim();
  writeFileSync(
    join(cacheDir, "meta.json"),
    JSON.stringify({ name, branch, sha, include, exclude, files: Object.keys(rel).length }, null, 2)
  );
  return { files: Object.keys(rel).length, sha };
}

/** The scan's model. Needs source, tsconfig and package.json - never node_modules. */
function scanRepo(dir, name) {
  // SRC_EXCLUDE/TYPE_ONLY_DIRS are owned by the SUITE, and a clone has none, so
  // they are derived from the host's coverage config on the way past.
  const se = join(dir, "test", "src-exclude.mjs");
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    se,
    `export const SRC_DIR = ${JSON.stringify(srcDir(dir))};\n` +
      `export const SRC_EXCLUDE = ${JSON.stringify(hostExclude(dir), null, 2)};\n` +
      // TYPE_ONLY_DIRS stays EMPTY and is left for a person. It is matched as a
      // directory PREFIX, so a wrong entry is not a small error: a bare "src"
      // marked all 282 functions on profile-centralized type-only and the scan
      // refused to write at all.
      `export const TYPE_ONLY_DIRS = [];\n`
  );
  const r = run(process.execPath, [join(PILOT_DIR, "scan.mjs")], { cwd: dir });
  const scanJson = join(dir, ".claude", "charpilot", "out", "scan.json");
  if (!existsSync(scanJson)) throw new Error((r.stderr || r.stdout || "scan wrote nothing").trim().split("\n").slice(-3).join(" | ").slice(0, 240));
  const cacheDir = join(CACHE, name);
  mkdirSync(cacheDir, { recursive: true });
  cpSync(scanJson, join(cacheDir, "scan.json"));
  return { scan: JSON.parse(readFileSync(scanJson, "utf8")) };
}

/** ast - suppressed == istanbul, on both lines, per file and in total. */
function compare(dir, name, scan) {
  const cov = JSON.parse(readFileSync(join(CACHE, name, "coverage-final.json"), "utf8"));
  const ist = {};
  for (const [file, d] of Object.entries(cov)) {
    ist[file] = {
      sides: Object.values(d.branchMap ?? {}).reduce((n, b) => n + (b.locations ?? []).length, 0),
      fns: Object.keys(d.fnMap ?? {}).length,
    };
  }

  // The suppressed terms, measured the way stage 7 measures them.
  let suppressed = { total: 0, totalFunctions: 0 };
  const covRel = join("coverage-fleetcheck");
  if (existsSync(join(dir, covRel, "coverage-final.json"))) {
    const r = run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { priced } from ${JSON.stringify(join(PILOT_DIR, "suppressions.mjs"))};` +
          `const p = priced(${JSON.stringify(covRel)});` +
          `process.stdout.write(JSON.stringify({ total: p.total, totalFunctions: p.totalFunctions, error: p.error, fnError: p.fnError }));`,
      ],
      { cwd: dir }
    );
    try {
      suppressed = JSON.parse(r.stdout);
    } catch {
      suppressed = { total: 0, totalFunctions: 0, error: (r.stderr || "").split("\n")[0] };
    }
  }

  const files = new Set([...Object.keys(scan.perFileArms ?? {}), ...Object.keys(ist)]);
  const drift = [];
  let astA = 0;
  let istA = 0;
  let astF = 0;
  let istF = 0;
  for (const f of [...files].sort()) {
    const a = scan.perFileArms?.[f] ?? 0;
    const fA = scan.perFileFunctions?.[f] ?? 0;
    const i = ist[f]?.sides ?? 0;
    const fI = ist[f]?.fns ?? 0;
    astA += a;
    istA += i;
    astF += fA;
    istF += fI;
    if (a !== i || fA !== fI) drift.push({ file: f, arms: [a, i], fns: [fA, fI] });
  }
  const armsGap = astA - istA - (suppressed.total ?? 0);
  const fnsGap = astF - istF - (suppressed.totalFunctions ?? 0);
  return {
    pass: armsGap === 0 && fnsGap === 0,
    astA,
    istA,
    astF,
    istF,
    suppressed,
    armsGap,
    fnsGap,
    drift,
  };
}

function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(CACHE, { recursive: true });

  const only = arg("--only", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const from = arg("--from", "");
  let fleet = FLEET;
  if (only.length) fleet = fleet.filter(([n]) => only.includes(n));
  if (from) {
    const i = fleet.findIndex(([n]) => n === from);
    if (i >= 0) fleet = fleet.slice(i);
  }

  const recheck = flag("--recheck");
  const results = [];

  for (const [name, declaredBranch, style, vitestOverride] of fleet) {
    const branch = BRANCH_OVERRIDE || declaredBranch;
    const dir = join(WORK, name);
    process.stdout.write(`\n── ${name} (${style}, ${branch})\n`);

    if (recheck) {
      if (!existsSync(join(CACHE, name, "coverage-final.json"))) {
        log("   SKIP  no cached istanbul answer - run without --recheck first");
        results.push({ name, style, state: "skip" });
        continue;
      }
      if (!existsSync(join(dir, "package.json"))) {
        log("   SKIP  clone is gone - run without --recheck first");
        results.push({ name, style, state: "skip" });
        continue;
      }
      // The SAME toolchain the cached answer was measured with, or the scan
      // models a different vitest than istanbul did - see linkToolchain.
      const tc = step("toolchain", () => toolchainFor(dir, vitestOverride));
      if (!tc.ok) {
        log(`   FAIL  toolchain: ${tc.error}`);
        results.push({ name, style, state: "install-failed", error: tc.error });
        continue;
      }
      linkToolchain(dir, tc.home);
      const s = step("scan", () => scanRepo(dir, name));
      if (!s.ok) {
        log(`   FAIL  scan: ${s.error}`);
        results.push({ name, style, state: "scan-failed", error: s.error });
        continue;
      }
      const c = compare(dir, name, s.scan);
      report(name, style, c, results);
      continue;
    }

    const cl = step("clone", () => clone(name, branch, dir));
    if (!cl.ok) {
      log(`   FAIL  clone: ${cl.error}`);
      results.push({ name, style, state: "clone-failed", error: cl.error });
      continue;
    }
    log(`   clone    ${cl.note} (${(cl.ms / 1000).toFixed(1)}s)`);

    const ins = step("install", () => toolchainFor(dir, vitestOverride));
    if (!ins.ok) {
      log(`   FAIL  install: ${ins.error}`);
      results.push({ name, style, state: "install-failed", error: ins.error });
      continue;
    }
    log(`   install  vitest ${ins.vitest} (${ins.source}) ${ins.note} (${(ins.ms / 1000).toFixed(1)}s)`);

    const me = step("measure", () => measure(dir, name, ins.home, branch));
    if (!me.ok) {
      log(`   FAIL  istanbul: ${me.error}`);
      results.push({ name, style, state: "measure-failed", error: me.error });
      continue;
    }
    log(`   istanbul ${me.files} file(s) (${(me.ms / 1000).toFixed(1)}s)`);

    const s = step("scan", () => scanRepo(dir, name));
    if (!s.ok) {
      log(`   FAIL  scan: ${s.error}`);
      results.push({ name, style, state: "scan-failed", error: s.error });
      continue;
    }

    const c = compare(dir, name, s.scan);
    report(name, style, c, results);

    // The disk is the reason this loop is self-cleaning. The ANSWER is cached,
    // so the only thing lost here is time on a re-measure. The toolchain is
    // shared between repos and deliberately survives.
    if (!flag("--keep")) {
      rmSync(join(dir, "coverage-fleetcheck"), { recursive: true, force: true });
      const l = join(dir, "node_modules");
      if (existsSync(l) && lstatSync(l).isSymbolicLink()) rmSync(l);
    }
  }

  summary(results);
}

function report(name, style, c, results) {
  const sup = c.suppressed ?? {};
  log(
    `   arms     ast ${c.astA} − suppressed ${sup.total ?? 0} vs istanbul ${c.istA}   ${c.armsGap === 0 ? "closes" : `${c.armsGap > 0 ? "+" : ""}${c.armsGap} UNEXPLAINED`}`
  );
  log(
    `   fns      ast ${c.astF} − suppressed ${sup.totalFunctions ?? 0} vs istanbul ${c.istF}   ${c.fnsGap === 0 ? "closes" : `${c.fnsGap > 0 ? "+" : ""}${c.fnsGap} UNEXPLAINED`}`
  );
  if (c.pass) {
    log(`   ✓ PASS`);
  } else {
    log(`   ✗ MISMATCH across ${c.drift.length} file(s):`);
    for (const d of c.drift.slice(0, 10)) {
      const a = d.arms[0] === d.arms[1] ? "" : `arms ast ${d.arms[0]} vs ist ${d.arms[1]}  `;
      const f = d.fns[0] === d.fns[1] ? "" : `fns ast ${d.fns[0]} vs ist ${d.fns[1]}`;
      log(`       ${d.file}  ${a}${f}`);
    }
    if (c.drift.length > 10) log(`       … ${c.drift.length - 10} more`);
  }
  results.push({ name, style, state: c.pass ? "pass" : "mismatch", ...c });
}

function summary(results) {
  const pass = results.filter((r) => r.state === "pass");
  const skipped = results.filter((r) => r.state === "no-src" || r.state === "skip");
  const bad = results.filter((r) => r.state !== "pass" && !skipped.includes(r));
  log(`\n${"═".repeat(72)}`);
  log(
    `fleetcheck: ${pass.length}/${results.length - skipped.length} repo(s) reconcile exactly` +
      `${skipped.length ? `  (${skipped.length} not measurable)` : ""}\n`
  );
  for (const r of results) {
    const mark = r.state === "pass" ? "✓" : r.state === "no-src" || r.state === "skip" ? "–" : "✗";
    const detail =
      r.state === "no-src"
        ? "no src/ - TypeScript at the repo root, unsupported layout"
        : r.state === "pass"
        ? `arms ${r.istA}, fns ${r.istF}`
        : r.state === "mismatch"
          ? `arms ${r.armsGap > 0 ? "+" : ""}${r.armsGap}, fns ${r.fnsGap > 0 ? "+" : ""}${r.fnsGap}, ${r.drift.length} file(s)`
          : `${r.state}: ${String(r.error ?? "").slice(0, 90)}`;
    log(`  ${mark} ${r.name.padEnd(30)}${String(r.style).padEnd(10)}${detail}`);
  }
  writeFileSync(join(CACHE, "fleetcheck.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  log(`\nwritten → ${join(CACHE, "fleetcheck.json")}`);
  if (bad.length) {
    log(`\n${bad.length} repo(s) did NOT reconcile. Fix the scan, then re-verify every repo`);
    log(`from the first with \`node tools/fleetcheck.mjs --recheck\` - the cached`);
    log(`istanbul answers make that offline and fast.`);
    process.exit(1);
  }
}

main();
