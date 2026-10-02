/**
 * WHAT THE REPO'S OWN SETUP FILES MOCK, so an emitted row can undo it.
 *
 * The recording runs with `setupFiles: []` (vitest.record.config.mts), and on
 * purpose: a setup file mocks prisma, the cache, the logger and the env module,
 * and a pair recorded under those mocks would describe the test harness rather
 * than the service. But the emitted suite is gated, and committed, under the
 * repo's OWN config, which loads the setup files for every test file, the
 * corpus included. So a row recorded against the real `@/env` replayed against
 * the setup file's stand-in for it:
 *
 *   - qode-ptp-ms, September 2026. test/setup.ts mocks `@/env` and `@/env.mjs`
 *     with a proxy that answers "test" for every variable. The recording ran
 *     the real env module, whose module scope logs
 *     `logger.warn("... environment variable is not defined")` for the unset
 *     ones; the replay never did, and cigate withheld 49 rows as "the
 *     downstream calls changed". Re-emitting one of them and running it alone
 *     showed the three warns as the whole difference.
 *   - email-centralization-ms, the same week. test/setup.ts mocks `@/env` with
 *     `OTP_BY_GMAIL_ENABLED: false`. The two isFromRecruiter rows set the flag
 *     through the environment, recorded `true`, and replayed `false`.
 *
 * PR #90 (D36) undid the setup file's mock of the row's SUBJECT. This is the
 * rest of it: every module the repo's setup files mock is unmocked at the top
 * of every row, before the row's own mocks, so the row replays in the world it
 * was recorded in. The recorder mocks none of these, so there the calls change
 * nothing; a proposal's own mock of one of them is registered after, and wins.
 *
 * WHY STATIC. vitest has no public API that lists the mocks a setup file
 * registered, and its mocker registry is internal and changes shape between
 * majors. The setup files are read instead: the paths come from the repo's own
 * vitest config (loaded by vite, as vitest loads it; a literal `setupFiles`
 * read from the file's text when that cannot run), and the mocked specifiers
 * from each setup file's `vi.mock(...)` / `vi.doMock(...)` calls with a
 * literal path, following the setup file's own relative imports. What cannot
 * be read is left alone: the row is then no worse off than before.
 *
 * AND THE ENV NAMES THEY SET. ai-centralization's test/setup.ts assigns
 * `process.env.REDIS_ENABLED = "false"` for every test file; the recording ran
 * with "true", so every redis.service row replayed without its `new Redis()`.
 * The spec's env prelude sets such a name outright to the recording's value
 * instead of `??=` (record.mjs renderEnvPrelude), for the names the recording
 * carried.
 *
 * WHAT IT DOES NOT UNDO. A setup file's `beforeEach` hooks, and an env name it
 * sets that the recording did not carry: neither can be undone from inside a
 * test without knowing the value it replaced.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CONFIG_NAMES = ["vitest.config.mts", "vitest.config.ts", "vitest.config.mjs", "vitest.config.js", "vitest.config.cts", "vitest.config.cjs"];
const SOURCE_EXTS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

/** The repo's root vitest config file, or null. */
export function rootVitestConfig(repoRoot) {
  for (const name of CONFIG_NAMES) {
    const p = join(repoRoot, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** `setupFiles` as vitest accepts it (a string or a list), as a list of strings. */
function asList(v) {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * The config's setupFiles, as vite evaluates the file - the same loader vitest
 * uses, so a function config, `mergeConfig` and a shared base all come out as
 * vitest sees them. Inline `test.projects` count too: each is a config the
 * corpus may run under. Returns null when vite cannot be loaded or the config
 * cannot be evaluated here.
 */
function setupFilesByVite(repoRoot, configFile) {
  const script = `
    import { createRequire } from "node:module";
    import { dirname, join } from "node:path";
    import { pathToFileURL } from "node:url";
    const req = createRequire(join(process.cwd(), "package.json"));
    const dir = dirname(req.resolve("vite/package.json"));
    const vite = await import(pathToFileURL(join(dir, "dist", "node", "index.js")).href);
    const got = await vite.loadConfigFromFile({ command: "serve", mode: "test" }, process.argv[1], process.cwd(), "silent");
    const cfg = got?.config ?? {};
    const t = cfg.test ?? {};
    const lists = [{ root: cfg.root ?? null, files: t.setupFiles ?? [] }];
    for (const p of Array.isArray(t.projects) ? t.projects : []) {
      if (p && typeof p === "object") lists.push({ root: p.root ?? cfg.root ?? null, files: p.test?.setupFiles ?? [] });
    }
    process.stdout.write("\\n@@charpilot-setup@@" + JSON.stringify(lists) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, configFile], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const line = String(r.stdout ?? "").split("\n").find((l) => l.startsWith("@@charpilot-setup@@"));
  if (r.status !== 0 || !line) return null;
  try {
    const lists = JSON.parse(line.slice("@@charpilot-setup@@".length));
    return lists.flatMap(({ root, files }) => asList(files).map((f) => resolve(repoRoot, root ?? ".", f)));
  } catch {
    return null;
  }
}

/** The literal `setupFiles` in the config's text: the fallback when vite cannot evaluate it. */
export function setupFilesByText(text) {
  const out = [];
  const re = /\bsetupFiles\s*:\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    for (const s of m[1].matchAll(/(['"`])([^'"`$]+)\1/g)) out.push(s[2]);
  }
  return out;
}

/**
 * The repo's setup files, as absolute paths that exist, in the order the
 * config names them. [] when the repo has no root config or names none.
 */
export function hostSetupFiles(repoRoot, { byVite = setupFilesByVite } = {}) {
  const configFile = rootVitestConfig(repoRoot);
  if (!configFile) return [];
  let files = byVite(repoRoot, configFile);
  if (!files) {
    let text = "";
    try { text = readFileSync(configFile, "utf8"); } catch { text = ""; }
    files = setupFilesByText(text).map((f) => resolve(dirname(configFile), f));
  }
  const seen = new Set();
  return files.map((f) => resolveSourceFile(f)).filter((f) => f && !seen.has(f) && seen.add(f));
}

/** A path as a module resolver would take it: itself, with an extension, or its index. */
function resolveSourceFile(p) {
  const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
  if (isFile(p)) return p;
  for (const ext of SOURCE_EXTS) if (isFile(p + ext)) return p + ext;
  // `./x.js` written for a `./x.ts` source, as TypeScript's NodeNext asks.
  const swapped = p.replace(/\.(m|c)?js$/, (_, k) => `.${k ?? ""}ts`);
  if (swapped !== p && isFile(swapped)) return swapped;
  for (const ext of SOURCE_EXTS) if (isFile(join(p, `index${ext}`))) return join(p, `index${ext}`);
  return null;
}

/** Source with its comments blanked, so a `vi.mock(...)` in prose is not read as a call. */
function withoutComments(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The module specifiers one setup file mocks, as written, and the relative
 * static imports it makes (which run before any test, so their mocks count).
 */
export function mocksInSource(text) {
  const src = withoutComments(text);
  const mocked = [];
  const call = /\b(?:vi|vitest)\s*\.\s*(?:mock|doMock)\s*(?:<[^>]*>\s*)?\(\s*(?:import\s*\(\s*)?(['"`])([^'"`$\\]+)\1/g;
  for (const m of src.matchAll(call)) mocked.push(m[2]);
  const imports = [];
  const imp = /^\s*import\s+(?:[^'";]*?\s+from\s+)?(['"])(\.{1,2}\/[^'"]+)\1/gm;
  for (const m of src.matchAll(imp)) imports.push(m[2]);
  // The env names it SETS: `process.env.X = ...`, `process.env["X"] = ...`
  // (never `==`/`===`), and `vi.stubEnv("X", ...)`.
  const env = [];
  const assign = /\bprocess\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`$]+)\2\s*\])\s*(?:\?\?|\|\||&&)?=(?!=)/g;
  for (const m of src.matchAll(assign)) env.push(m[1] ?? m[3]);
  for (const m of src.matchAll(/\b(?:vi|vitest)\s*\.\s*stubEnv\s*\(\s*(['"`])([^'"`$]+)\1/g)) env.push(m[2]);
  return {
    mocked,
    imports,
    env: [...new Set(env)],
    fakeTimers: /\b(?:vi|vitest)\s*\.\s*useFakeTimers\s*\(/.test(src),
    stubsGlobals: /\b(?:vi|vitest)\s*\.\s*stubGlobal\s*\(/.test(src),
  };
}

/**
 * What the repo's setup files do that a row can undo: `mocks`, every module
 * they mock, ONE entry per setup-file spelling (`{ specifier, from }`, `from`
 * the file that mocks it; a relative specifier is kept absolute here and
 * `setupUnmockSpelling` spells it for the file that will unmock it), and whether
 * any of them fakes timers or stubs a global with vi's own helpers.
 */
export function hostSetup(repoRoot, { byVite = setupFilesByVite, files = hostSetupFiles(repoRoot, { byVite }), read = (f) => readFileSync(f, "utf8") } = {}) {
  const out = [];
  let fakeTimers = false;
  let stubsGlobals = false;
  const env = new Set();
  const seen = new Set();
  const visited = new Set();
  const root = resolve(repoRoot);
  const visit = (file, depth) => {
    if (!file || visited.has(file) || depth > 4 || visited.size >= 40) return;
    // A setup file's own imports are followed only inside the repo, never into
    // node_modules: a package's vi.mock calls are not the repo's arrangement.
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("node_modules")) return;
    visited.add(file);
    let text;
    try { text = read(file); } catch { return; }
    const { mocked, imports, env: wrote, fakeTimers: ft, stubsGlobals: sg } = mocksInSource(text);
    for (const n of wrote) env.add(n);
    fakeTimers ||= ft;
    stubsGlobals ||= sg;
    for (const s of mocked) {
      const specifier = s.startsWith(".") ? resolve(dirname(file), s) : s;
      if (seen.has(specifier)) continue;
      seen.add(specifier);
      out.push({ specifier, from: relative(root, file).split(sep).join("/") });
    }
    for (const s of imports) visit(resolveSourceFile(resolve(dirname(file), s)), depth + 1);
  };
  for (const f of files) visit(f, 0);
  return { files: files.map((f) => relative(root, f).split(sep).join("/")), mocks: out, env: [...env], fakeTimers, stubsGlobals };
}

/**
 * The statements that put a row back in the recording's world, for a spec at
 * `specDir`: one `vi.doUnmock` per module the setup files mock (less any the
 * row already unmocks, `skip`), then real timers and unstubbed globals when a
 * setup file changed them. [] for a repo whose setup files do none of this.
 */
export function setupUndoLines(setup, specDir, skip = new Set()) {
  const lines = [];
  for (const m of setup?.mocks ?? []) {
    const lit = JSON.stringify(setupUnmockSpelling(m.specifier, specDir));
    if (skip.has(lit)) continue;
    skip.add(lit);
    lines.push(`vi.doUnmock(${lit});`);
  }
  if (setup?.fakeTimers) lines.push("vi.useRealTimers();");
  if (setup?.stubsGlobals) lines.push("vi.unstubAllGlobals();");
  return lines;
}

/**
 * The specifier `vi.doUnmock` is given in a spec at `specDir`: a bare or
 * aliased name as the setup file wrote it (vitest resolves it through the same
 * config), an absolute one as a path relative to the spec.
 */
export function setupUnmockSpelling(specifier, specDir) {
  if (!isAbsolute(specifier)) return specifier;
  const rel = relative(specDir, specifier).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
