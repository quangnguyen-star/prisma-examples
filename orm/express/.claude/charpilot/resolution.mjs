/**
 * ONE RESOLUTION FOR EVERY CONFIG A CHARACTERIZATION SUITE RUNS UNDER.
 *
 * The recording ran under `vitest.record.config.mts`, which carries the
 * pipeline's alias floor (`@/…`, `@/prisma`, `@/env`, bare `src/…`) merged with
 * the host's own. Every other config a recorded row is replayed under used to
 * carry its OWN idea of resolution, and they drifted:
 *
 *   - `vitest.coverage.config.mts` hard-coded the floor and DROPPED the host's
 *     aliases, while its comment said "identical resolution to the recording";
 *   - the root `vitest.config.mts` install.sh writes for a BOOTSTRAPPED repo
 *     carried no alias at all, and that is the config cigate runs (it is what
 *     `npm test` = `vitest run` runs once the PR adds the script). Measured on
 *     nginx-redirecting-ms, run 20260924T054903Z: cigate withheld 55 of 103
 *     green tests - 36 `Cannot find package '@/controllers/redirect.controller'`,
 *     19 `the downstream calls changed: expected [] …` because the doubles never
 *     installed - and stage 6 fell from 131/133 live sides to 39/133;
 *   - the corpus config `test/characterization/vitest.config.mts` extended that
 *     alias-less root, and the root was left off the branch whenever the suite
 *     was red, so the delivered corpus could not load on its own branch.
 *
 * So the table and the merge live HERE, once. The two `.claude/` configs
 * import them. The two configs that must stand on a pushed branch - where
 * `.claude/` is gitignored and absent - get the SAME functions rendered into
 * them by `aliasSource()`, from their own `toString()`: one source, never a
 * second copy to keep true.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createRequire } from "node:module";

/**
 * The pipeline's FLOOR, not the repo's alias table: what the recorder has
 * always resolved (vitest.record.config.mts's comment has the history - the
 * 17 rows recorded `threw` on `Cannot find module '@/prisma/client'`).
 * `dir` entries are prefixes and keep their trailing slash.
 */
export const PILOT_ALIAS_TABLE = [
  { find: /^@\/prisma$/, to: "prisma/client", dir: false },
  { find: /^@\/prisma\//, to: "prisma", dir: true },
  { find: /^@\/env$/, to: "src/env", dir: false },
  { find: /^@\//, to: "src", dir: true },
  { find: /^src\//, to: "src", dir: true },
];

/** The floor, resolved against a repo root. */
export function pilotAliases(root, table = PILOT_ALIAS_TABLE) {
  return table.map((e) => ({ find: e.find, replacement: e.dir ? `${resolve(root, e.to)}/` : resolve(root, e.to) }));
}

/**
 * `resolve.alias` has two shapes. The array form is ordered and carries
 * regexes; the object form (`{"@": "<root>/src"}`) is a map. Merging needs one
 * shape, and the array is the one that can express the other.
 */
export function asAliasArray(alias) {
  if (!alias) return [];
  if (Array.isArray(alias)) return alias;
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

/**
 * How much of a `find` is a fixed prefix - the only ordering that makes a
 * merge safe. vite takes the FIRST alias that matches, so a generic rule ahead
 * of a specific one silently swallows it: pilot-then-host sends qode-ptp-ms's
 * `@/env.mjs` to a file that does not exist, host-then-pilot sends a bare
 * `{"@": "<root>/src"}` host's `@/prisma` to `src/prisma`. So entries are
 * ordered by specificity and the host wins a tie.
 */
export function literalPrefixLength(find) {
  if (typeof find === "string") return find.length;
  const src = typeof find?.source === "string" ? find.source : "";
  let n = 0;
  for (let i = src.startsWith("^") ? 1 : 0; i < src.length; i++) {
    const c = src[i];
    // An escaped character is one literal character: `\/` in `/^@\//` is `/`.
    if (c === "\\") {
      if (i + 1 >= src.length) break;
      i++;
      n++;
      continue;
    }
    // The first metacharacter ends the fixed prefix. `/` is NOT one.
    if ("^$.*+?()[]{}|".includes(c)) break;
    n++;
  }
  return n;
}

/** Host's aliases and the floor, most specific first; `index` keeps a tie deterministic. */
export function mergeAliases(hostAlias, pilot) {
  return [...asAliasArray(hostAlias), ...pilot]
    .map((entry, index) => ({ entry, index, prefix: literalPrefixLength(entry.find) }))
    .sort((a, b) => b.prefix - a.prefix || a.index - b.index)
    .map((e) => e.entry);
}

/** What every replay config resolves with: the host's table merged over the floor. */
export function replayAliases(hostAlias, root) {
  return mergeAliases(hostAlias, pilotAliases(root));
}

/**
 * The env a recorded row replays under, in every config (coverage's, the
 * corpus's, the bootstrapped root's). `TZ` is load-bearing: a recorded Date
 * formatted under UTC is a different string elsewhere.
 */
export const REPLAY_TEST_ENV = { NODE_ENV: "test", TZ: "UTC" };

/**
 * The query istanbul's uncovered-file pass puts on every file it asks vite to
 * transform: `?v=<n>` in vitest 2, `?cache=<n>&vitest-uncovered-coverage=true`
 * in vitest 4 and 5. Only these: every other query a module is imported with
 * reaches the host's plugins exactly as it does under the recording.
 */
export const UNCOVERED_QUERY = /\?(?:v=\w+|cache=\w+&vitest-uncovered-coverage=true)$/;

/**
 * A FILE NO SPEC IMPORTS GETS THE HOST'S OWN TRANSFORM, AS AN IMPORTED ONE DOES.
 *
 * D45, qode-itl-be (NestJS, `unplugin-swc`), the mocked run of September 26:
 * stage 6 exited 1 on every round and never wrote coverage.json, so claims
 * checked stayed 0 for five hours. vitest's unhandled error was istanbul's
 * babel parse of raw TypeScript:
 *
 *     SyntaxError: src/app.module.ts: Unexpected token, expected "from" (7:12)
 *     >  7 | import type { Request } from 'express';
 *
 * `coverage.all` transforms every source file no spec imported, as
 * `src/app.module.ts?v=<n>`. unplugin-swc tests its filter
 * (`/\.m?[jt]sx?$/`) against that id WITH the query, so it declines the file,
 * and its `config()` hook has already turned vite's esbuild off. Nothing
 * strips the types, and istanbul's parser, which has no TypeScript plugin,
 * gets the source as written. A file a spec imports carries no query and
 * never meets this.
 *
 * So the host's `swc` plugin sees that one query removed from the id and
 * transforms the file as it transforms every imported one: SWC, the repo's
 * tsconfig, decorator metadata. Imported files are not touched and esbuild
 * stays off, so the replay transforms the files it runs exactly as the
 * recording did (vitest.record.config.mts keeps the host's plugins as they
 * are). A host with no plugin named "swc" comes through unchanged.
 */
export function uncoveredUnderHostTransform(plugins) {
  const seeThrough = (fn) =>
    function (code, id, ...rest) {
      return fn.call(this, code, typeof id === "string" ? id.replace(UNCOVERED_QUERY, "") : id, ...rest);
    };
  const wrap = (plugin) => {
    if (Array.isArray(plugin)) return plugin.map(wrap);
    if (plugin && typeof plugin.then === "function") return plugin.then(wrap);
    if (!plugin || typeof plugin !== "object" || plugin.name !== "swc") return plugin;
    const hook = plugin.transform;
    if (typeof hook === "function") return { ...plugin, transform: seeThrough(hook) };
    if (hook && typeof hook.handler === "function") return { ...plugin, transform: { ...hook, handler: seeThrough(hook.handler) } };
    return plugin;
  };
  return wrap(plugins);
}

/**
 * The functions above as source, for a config that may import nothing from
 * `.claude/`. Defines `replayAliases(hostAlias, root)` and `REPLAY_TEST_ENV`;
 * the file must import `resolve` from `node:path` itself.
 */
export function aliasSource() {
  const table = PILOT_ALIAS_TABLE.map((e) => `  { find: ${String(e.find)}, to: ${JSON.stringify(e.to)}, dir: ${e.dir} },`).join("\n");
  return [
    "// ---- charpilot resolution (rendered from .claude/charpilot/resolution.mjs - the recorder's own) ----",
    `const PILOT_ALIAS_TABLE = [\n${table}\n];`,
    pilotAliases.toString(),
    asAliasArray.toString(),
    literalPrefixLength.toString(),
    mergeAliases.toString(),
    replayAliases.toString(),
    `const REPLAY_TEST_ENV = ${JSON.stringify(REPLAY_TEST_ENV)};`,
    "// ---- end charpilot resolution ----",
  ].join("\n");
}

/**
 * STANDARD DECORATORS ARE LOWERED BY THE REPO'S OWN TYPESCRIPT, AS `tsc` DOES.
 *
 * crisp-ms run 20260925T002031Z died in baseline, before a single row:
 * `@errorHandlerDecoratorForAll class CrispController` came out of vite's
 * transform unchanged and istanbul's babel parse refused it ("Support for the
 * experimental syntax 'decorators' isn't currently enabled"). crisp-ms's
 * tsconfig has no `experimentalDecorators`, so it uses STANDARD (TC39)
 * decorators, which its build (`tsc`, `ts-node`) lowers to plain classes.
 * Vite 8 transforms with oxc, which lowers only LEGACY decorators and passes a
 * standard one through - and bundles no esbuild to fall back on. Node cannot run
 * the result either, so the recording and the committed suite would have hit it
 * too; the uncovered-file coverage pass merely got there first.
 *
 * So a TypeScript file that carries a decorator is transpiled with the repo's
 * own `typescript` and its own tsconfig options - class-field semantics
 * included - before oxc sees it. Legacy repos (`experimentalDecorators: true`)
 * are left to oxc, which lowers those itself. No typescript, no plugin work.
 */
export function standardDecorators(root) {
  let plan;
  const load = () => {
    if (plan !== undefined) return plan;
    plan = null;
    let ts;
    try {
      ts = createRequire(root + "/package.json")("typescript");
    } catch {
      return plan;
    }
    let options = {};
    const at = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    if (at) {
      const read = ts.readConfigFile(at, ts.sys.readFile);
      if (!read.error) options = ts.parseJsonConfigFileContent(read.config, ts.sys, root).options;
    }
    if (options.experimentalDecorators) return plan;
    const target = options.target ?? ts.ScriptTarget.ES5;
    plan = {
      ts,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        // The repo's class-field semantics, not ES2022's default: a repo built
        // for es6 assigns its fields, and defining them instead changes what an
        // accessor or a subclass sees.
        useDefineForClassFields: options.useDefineForClassFields ?? target >= ts.ScriptTarget.ES2022,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
        jsx: options.jsx ?? ts.JsxEmit.Preserve,
        isolatedModules: true,
        verbatimModuleSyntax: false,
        sourceMap: true,
        inlineSources: true,
      },
    };
    return plan;
  };
  // A decorator on its own line or in front of a class - never `* @param` in a
  // comment or an address in a string.
  const DECORATED = /^[ \t]*@[A-Za-z_$][\w$.]*\s*(\(|$|(export|default|abstract|class)\b)/m;
  return {
    name: "charpilot-standard-decorators",
    enforce: "pre",
    transform(code, id) {
      const file = String(id).split("?")[0];
      if (!/\.[cm]?tsx?$/.test(file) || /[\\/]node_modules[\\/]/.test(file) || !DECORATED.test(code)) return null;
      const p = load();
      if (!p) return null;
      const out = p.ts.transpileModule(code, { fileName: file, compilerOptions: p.compilerOptions });
      return { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
    },
  };
}

/** The plugin, as source the rendered root configs carry (see aliasSource). */
export function decoratorSource() {
  return [
    "// ---- charpilot standard decorators (rendered from .claude/charpilot/resolution.mjs) ----",
    standardDecorators.toString(),
    "// ---- end charpilot standard decorators ----",
  ].join("\n");
}

/** The marker finish.py and install.sh know a bootstrapped root config by. */
export const BOOTSTRAP_MARKER = "BOOTSTRAPPED vitest";

/**
 * The root `vitest.config.mts` install.sh writes when it bootstraps vitest
 * into a repo with no runnable suite (or runs ours alongside another runner).
 * It is the config the repo's own `vitest run` - and so cigate - uses, so it
 * resolves exactly as the recording did, and includes the corpus only.
 */
export function bootstrapRootConfig(corpusRel, suffix) {
  return stampRendered(`// Written by nodejs/tools/install.sh, which ${BOOTSTRAP_MARKER} into this repo:
// it had no runnable test suite, or its suite runs on another runner that this
// file leaves alone. The characterization suite is all this includes. Until that
// suite holds a passing test, nothing here counts as a green suite.
//
// It resolves modules exactly as the recording did - the same alias table,
// rendered below from the recorder's own code - because this is the config
// \`vitest run\` uses here, and a suite that resolves differently from its
// recording asserts about a different program.
// @ts-nocheck
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

${aliasSource()}

${decoratorSource()}

export default defineConfig({
  plugins: [standardDecorators(__dirname)],
  resolve: { alias: replayAliases(undefined, __dirname) },
  test: {
    include: [${JSON.stringify(`${corpusRel}/*${suffix}`)}],
    setupFiles: [],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { ...REPLAY_TEST_ENV },
  },
});
`);
}

/**
 * The root config install.sh writes for a repo that runs `vitest run` with NO
 * config of its own (tracy-worker). It sets NO test setting - vitest's
 * defaults are what that suite already ran under - and adds only the
 * recording's aliases. Those can change nothing that resolved before: `@/…`
 * and bare `src/…` are not package names, so without an alias vite could not
 * resolve them at all. What they add is that cigate, which runs this config
 * over the corpus, resolves the corpus as the recording did.
 */
export function emptyRootConfig() {
  return stampRendered(`// Written by nodejs/tools/install.sh because this repo runs \`vitest run\` with
// no config of its own. It sets NO test setting on purpose: vitest's defaults are
// what the suite already ran under, and the charpilot configs need a base to
// extend by relative path. The one thing it adds is the recording's module
// aliases (rendered below from the recorder's own code), which only resolve
// specifiers - \`@/…\`, bare \`src/…\` - that vite could not resolve without them.
// @ts-nocheck
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

${aliasSource()}

${decoratorSource()}

export default defineConfig({
  plugins: [standardDecorators(__dirname)],
  resolve: { alias: replayAliases(undefined, __dirname) },
});
`);
}

/**
 * A ROOT CONFIG INSTALL.SH WROTE IS REWRITTEN ONLY WHILE NOBODY HAS EDITED IT.
 *
 * install.sh rewrites the root config it wrote on every install, so a resume
 * cannot keep an alias-less one (nginx-redirecting-ms). But "it carries our
 * header" is not "it is still ours": a maintainer who added a setup file or an
 * alias to it lost the edit on the next install (verifier, fix round 1). So a
 * file is rewritten only when its body is, byte for byte, one install.sh
 * rendered:
 *
 *   - from this version on, the render ends in a stamp line carrying the
 *     sha256 of everything above it, so any version's unedited output proves
 *     itself and no list has to grow;
 *   - before the stamp, every body any install.sh in this repo's history
 *     rendered, by sha256 (LEGACY_ROOT_CONFIG_SHA256).
 *
 * Anything else is edited, and left exactly as it is.
 */
export const RENDER_STAMP = "// charpilot-rendered sha256:";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The text, with the stamp line that lets it prove it is unedited. */
export function stampRendered(text) {
  return `${text}${RENDER_STAMP}${sha256(text)} (install.sh rewrites this file only while it hashes to this; edit it and it is yours)\n`;
}

/**
 * Every root-config body an install.sh rendered BEFORE the stamp existed, both
 * layouts (test/characterization/*.char.test.ts and characterization/*.char.ts).
 * Taken from git history: `git log --all -- nodejs/tools/install.sh`, each
 * `cat > "$D/$BASE" <<'VITESTCFG'` body with its placeholders filled, and the
 * 036ae45 renders of this file's two functions.
 */
export const LEGACY_ROOT_CONFIG_SHA256 = Object.freeze([
  // bootstrap, "no test script, no runner and no test files" (9902c4b..)
  "447be4469bbed21e4a0d539672d35e1ddd04c3cf050146492cf5a32428e76dcf",
  // bootstrap, "or its suite runs on another runner" (3c74c6b..4cda48b), both layouts
  "e21600f80214a8d202aaeece0be60e36bfc35d91a371df1d3a9ed33dfea9717c",
  "e89859c7e43b39171763486047b72bb0cac858637ae96fee43a95d9b9ea75d9a",
  // empty, "It is EMPTY ON PURPOSE" (..4cda48b)
  "83071611c85ad7c7372521f98c8d77764a3a890dbb0fb7c65d14d37954e737b6",
  // 036ae45: bootstrap (both layouts) and empty, with the aliases, unstamped
  "5f9979b90e740ab3045eacebccb540c76c594d449a3f4fe4c8abeab8513bf061",
  "6dcb715921f28990217f551929d779b59dd68b2a1d92de20390f6badaa20f185",
  "7826f94497d334d96df007a750c66fcd6925dd8befc30084c71bfd957591f435",
]);

/**
 * What a root config file is to install.sh: `rendered` (unedited output of
 * some install.sh - rewrite it), `edited` (install.sh wrote it, someone
 * changed it - leave it), or `foreign` (the repo's own). `kind` is
 * `bootstrap` or `empty` for the first two.
 */
export function rootConfigState(text) {
  const t = String(text ?? "");
  if (!t.includes("Written by nodejs/tools/install.sh")) return { state: "foreign", kind: null };
  const kind = t.includes(BOOTSTRAP_MARKER) ? "bootstrap" : "empty";
  const at = t.lastIndexOf(`\n${RENDER_STAMP}`);
  if (at !== -1) {
    const body = t.slice(0, at + 1);
    const claimed = t.slice(at + 1 + RENDER_STAMP.length).match(/^[0-9a-f]{64}/)?.[0];
    const line = t.slice(at + 1);
    const tail = line.indexOf("\n");
    // The stamp is the last line, and the body above it hashes to it.
    if (claimed && (tail === -1 || tail === line.length - 1) && sha256(body) === claimed) return { state: "rendered", kind };
    return { state: "edited", kind, why: "its body no longer hashes to the stamp install.sh wrote into it" };
  }
  if (LEGACY_ROOT_CONFIG_SHA256.includes(sha256(t))) return { state: "rendered", kind };
  return { state: "edited", kind, why: "it matches no root config any install.sh version rendered" };
}
