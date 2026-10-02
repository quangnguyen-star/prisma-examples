// Written by nodejs/tools/install.sh, which BOOTSTRAPPED vitest into this repo:
// it had no runnable test suite, or its suite runs on another runner that this
// file leaves alone. The characterization suite is all this includes. Until that
// suite holds a passing test, nothing here counts as a green suite.
//
// It resolves modules exactly as the recording did - the same alias table,
// rendered below from the recorder's own code - because this is the config
// `vitest run` uses here, and a suite that resolves differently from its
// recording asserts about a different program.
// @ts-nocheck
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// ---- charpilot resolution (rendered from .claude/charpilot/resolution.mjs - the recorder's own) ----
const PILOT_ALIAS_TABLE = [
  { find: /^@\/prisma$/, to: "prisma/client", dir: false },
  { find: /^@\/prisma\//, to: "prisma", dir: true },
  { find: /^@\/env$/, to: "src/env", dir: false },
  { find: /^@\//, to: "src", dir: true },
  { find: /^src\//, to: "src", dir: true },
];
function pilotAliases(root, table = PILOT_ALIAS_TABLE) {
  return table.map((e) => ({ find: e.find, replacement: e.dir ? `${resolve(root, e.to)}/` : resolve(root, e.to) }));
}
function asAliasArray(alias) {
  if (!alias) return [];
  if (Array.isArray(alias)) return alias;
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}
function literalPrefixLength(find) {
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
function mergeAliases(hostAlias, pilot) {
  return [...asAliasArray(hostAlias), ...pilot]
    .map((entry, index) => ({ entry, index, prefix: literalPrefixLength(entry.find) }))
    .sort((a, b) => b.prefix - a.prefix || a.index - b.index)
    .map((e) => e.entry);
}
function replayAliases(hostAlias, root) {
  return mergeAliases(hostAlias, pilotAliases(root));
}
const REPLAY_TEST_ENV = {"NODE_ENV":"test","TZ":"UTC"};
// ---- end charpilot resolution ----

// ---- charpilot standard decorators (rendered from .claude/charpilot/resolution.mjs) ----
function standardDecorators(root) {
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
// ---- end charpilot standard decorators ----

export default defineConfig({
  plugins: [standardDecorators(__dirname)],
  resolve: { alias: replayAliases(undefined, __dirname) },
  test: {
    include: ["test/characterization/*.char.test.ts"],
    setupFiles: [],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { ...REPLAY_TEST_ENV },
  },
});
// charpilot-rendered sha256:b2a7d63c7450c0db7df752d60a8520fd6f59d0cbfaf26ae3c18b9aa38f7a91a5 (install.sh rewrites this file only while it hashes to this; edit it and it is yours)
