/**
 * WHICH TEST RUNNER A REPO USES, AND WHAT THIS PIPELINE DOES ABOUT IT.
 *
 *   node runner.mjs <repo>                    kind\nline, as install.sh reads it
 *   node runner.mjs <repo> --json <out.json>  also writes the classification
 *
 * One definition, read by install.sh (what to install), baseline (what the
 * baseline is a measurement of) and report (what the PR says). It used to be a
 * heredoc inside install.sh that could only refuse, and 11 of the fleet's 33
 * services were refused by it for four different reasons (plan 1, F4.1).
 *
 *   runner    evidence                                   action
 *   vitest    vitest is a dependency                     as-is: the repo's own suite is the baseline
 *   jest      jest / ts-jest / @jest/* / a jest block     alongside: OUR vitest in the separate toolchain
 *             or jest.config, WITH test files            home, over characterization/ only. Their
 *   other     mocha, ava, tap, jasmine, karma, cypress,   runner, config and `test` script are never
 *             playwright, `node --test`, ... WITH files   touched; stage 1 does not measure their suite.
 *   none      no runner, or a `test` script naming a      bootstrap: set up vitest (F1.7). Their files,
 *             runner that is not installed, and no test   if any, stay exactly as they are.
 *             files - nothing runs here
 *   unknown   the repo is too large to walk              alongside, as for jest: our vitest never
 *                                                         touches a suite it could not see
 *
 * Refused, still: an unreadable package.json (nobody knows what it declares,
 * and its dependencies cannot be installed either), and vitest declared but not
 * installed (install the repo's own dependencies first - the one shape that
 * advice answers).
 *
 * THE WALK IS BROAD because the answer decides what gets installed beside what
 * a repo really has: cypress (`*.cy.ts`), playwright (`*.pw.ts`), a Nest
 * `*.e2e-spec.ts`, anything under __tests__/, a test file at any depth and a
 * runner config with no dependency are all evidence (verifier, review of
 * d3e20c6). node_modules / .git / .claude are skipped; a compiled test under
 * dist/ is still evidence. Past MAX_ENTRIES the answer is `unknown`.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = new Set(["node_modules", ".git", ".claude"]);
const TEST_FILE = /\.(test|spec|e2e-spec|e2e|cy|pw)\.[cm]?[jt]sx?$/;
const CONFIG_FILE = /^(jest\.config|vitest\.config|vitest\.workspace|vite\.config|cypress\.config|playwright\.config|karma\.conf|ava\.config|wdio\.conf|jasmine)\.[a-z.]+$|^\.mocharc(\.[a-z]+)?$|^\.taprc$|^cypress\.json$/;
// Our own files, from an earlier install, are not the repo's suite.
const OURS = /^(test\/(fixtures\/doubles\.ts|src-exclude\.mjs|characterization\/.*)|characterization\/.*|vitest\.config\.mts)$/;
const MAX_ENTRIES = 200000;
// npm init's placeholder is not a test script: it runs nothing and says so.
const NPM_DEFAULT = /^echo "?Error: no test specified"? && exit 1$/;
// Any dependency that is a test runner, or a plugin of one.
const RUNNER_DEP = /^(jest|ts-jest|babel-jest|mocha|ava|tap|jasmine|karma|uvu|cypress|playwright|@playwright\/test|vitest|node-tap|tape|lab|@hapi\/lab|qunit|webdriverio|@wdio\/.+|@jest\/.+|jest-.+|mocha-.+|karma-.+|@cypress\/.+|jasmine-.+|@vitest\/.+)$/;
const JEST_DEP = /^(jest|ts-jest|babel-jest|@jest\/.+|jest-.+)$/;
const JEST_CONFIG = /^jest\.config\./;
// A runner a `test` script names, read off the script itself.
const SCRIPT_RUNNER = /\b(vitest|jest|mocha|ava|tap|jasmine|karma|cypress|playwright|uvu|tape|lab|qunit|wdio)\b/;

/** The repo's test files and runner configs, walked once. */
function walk(root) {
  let seen = 0;
  let unsure = false;
  const testFiles = [];
  const configs = [];
  const visit = (dir, rel, underTests) => {
    if (unsure) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) { unsure = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) visit(join(dir, e.name), r, underTests || e.name === "__tests__");
      } else if (!OURS.test(r)) {
        if (TEST_FILE.test(e.name) || (underTests && /\.[cm]?[jt]sx?$/.test(e.name))) testFiles.push(r);
        if (CONFIG_FILE.test(e.name) && e.name !== "vite.config.ts" && e.name !== "vite.config.mts") configs.push(r);
      }
    }
  };
  visit(root, "", false);
  return { testFiles, configs, unsure };
}

/**
 * The classification. `kind` and `line` are the legacy pair install.sh has
 * always printed; `runner`, `detail`, `evidence` and `action` are the decision.
 */
export function classifyRunner(root) {
  let pkg = {};
  let readable = true;
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { readable = false; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  const rawScript = (pkg.scripts && pkg.scripts.test) || null;
  const script = rawScript && !NPM_DEFAULT.test(String(rawScript).trim()) ? String(rawScript) : null;
  const { testFiles, configs, unsure } = walk(root);
  const has = testFiles.length > 0;
  const declared = deps.vitest || null;
  const other = Object.keys(deps).filter((r) => RUNNER_DEP.test(r) && !/^(vitest|@vitest\/.+)$/.test(r));
  for (const k of ["jest", "mocha", "ava"]) if (pkg[k]) other.push(`${k} (package.json block)`);
  const nodeTest = Boolean(script && /--test\b/.test(script));
  const named = script ? SCRIPT_RUNNER.exec(script)?.[1] ?? null : null;
  const evidence = [];
  if (rawScript) evidence.push(`scripts.test: ${rawScript}`);
  if (declared) evidence.push(`dependency vitest@${declared}`);
  for (const o of other) evidence.push(`dependency ${o}`);
  for (const c of configs.slice(0, 5)) evidence.push(`config ${c}`);
  evidence.push(`${testFiles.length} test file(s)${has ? ` (${testFiles.slice(0, 3).join(", ")}${testFiles.length > 3 ? ", …" : ""})` : ""}`);

  const out = (runner, detail, action, kind, line) => ({ runner, detail, action, kind, line, evidence, testFiles: testFiles.length });

  if (!readable) {
    return out("unknown", "package.json unreadable", "refuse", "unreadable",
      "this repo's package.json cannot be read, so what it declares - and whether it has a suite - is unknown. Nothing is installed beside an unknown suite.");
  }
  if (declared) {
    return out("vitest", `vitest@${declared}`, "as-is", "vitest-declared",
      `vitest is in this repo's package.json at ${declared} and is not in node_modules. Install the repo's OWN dependencies first: npm ci, or pnpm install in a pnpm workspace - npm cannot resolve workspace: URLs.`);
  }
  if (unsure) {
    return out("unknown", `more than ${MAX_ENTRIES} entries outside node_modules`, "alongside", "unsure",
      `this repo is too large to walk for test files (${MAX_ENTRIES} entries), so its suite is unknown - our own vitest runs alongside, over characterization/ only, and touches nothing else.`);
  }
  const jestish = other.some((o) => JEST_DEP.test(o.split(" ")[0])) || configs.some((c) => JEST_CONFIG.test(c.split("/").pop())) || named === "jest";
  if (other.length || configs.length || nodeTest || (script && named && has)) {
    const detail = nodeTest ? "node --test" : jestish ? "jest" : (other[0]?.split(" ")[0] ?? named ?? configs[0]?.split("/").pop()?.split(".")[0] ?? "unknown");
    // A runner nobody can run is not a suite: a `test` script or config naming
    // a runner that is not a dependency, with no test files, runs nothing.
    if (!other.length && !nodeTest && !has) {
      return out("none", `${detail} named but not installed, and no test files`, "bootstrap", "empty",
        `this repo names ${detail} (${rawScript ?? configs[0]}) but does not depend on it and has no test files, so nothing runs here - vitest is set up for it (F1.7).`);
    }
    return out(jestish ? "jest" : "other", detail, "alongside", "other",
      `this repo's runner is ${detail}${has ? " and it has test files" : ""}. Our own vitest runs alongside it, over characterization/ only, from a separate toolchain home - their runner, config and test script are not touched, and stage 1 does not measure their suite.`);
  }
  if (script) {
    return out("none", named ? `${named} named but not installed, and no test files` : "a test script and no runner", "bootstrap", "empty",
      `this repo declares a test script (${script}) and depends on no test runner${has ? "" : " and has no test files"}, so nothing runs here - vitest is set up for it (F1.7).`);
  }
  return out("none", has ? "test files and nothing to run them" : "no test script, runner or test files", "bootstrap", "empty",
    `this repo declares no test script and depends on no test runner${has ? `; its test files (${testFiles.slice(0, 2).join(", ")}) have nothing to run them and are left as they are` : " and has no test files"} - vitest is set up for it (F1.7).`);
}

/** The artifact: what was found, and which path the run takes. */
export function runnerDoc(root) {
  const c = classifyRunner(root);
  return {
    stage: "0-runner",
    runner: c.runner,
    detail: c.detail,
    action: c.action,
    evidence: c.evidence,
    testFiles: c.testFiles,
    measuredByStage1: c.action === "as-is",
    note:
      c.action === "alongside"
        ? `the repo's suite is ${c.detail}; not measured by stage 1 - the baseline and every coverage number describe the characterization suite, run by our own vitest alongside`
        : c.action === "bootstrap"
          ? `no runnable test suite (${c.detail}); vitest was set up for the characterization suite (F1.7)`
          : null,
  };
}

// Real paths on both sides: /var is a symlink on macOS, and argv keeps the link.
const isMain = () => {
  try { return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
};
if (isMain()) {
  const root = process.argv[2] ?? process.cwd();
  const c = classifyRunner(root);
  const at = process.argv.indexOf("--json");
  if (at > 0 && process.argv[at + 1]) {
    mkdirSync(dirname(process.argv[at + 1]), { recursive: true });
    writeFileSync(process.argv[at + 1], `${JSON.stringify(runnerDoc(root), null, 2)}\n`);
  }
  process.stdout.write(`${c.action === "alongside" ? "alongside" : c.kind}\n${c.line}`);
}
