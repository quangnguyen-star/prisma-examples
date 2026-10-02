/**
 * sourcedeps — which of the repo's files a recorded row depends on, and whether
 * any of them has changed since the row was recorded (item 6b).
 *
 * WHY THIS EXISTS. The record cache was keyed on a hash of the whole recorder,
 * and it never left the container: the row caches are hidden files, and a
 * checkpoint carries none of them (char/checkpoint.py). So every resume
 * recorded every row from scratch, and determinism recorded them all a second
 * time - qode-ptp-ms, 1460 rows, about 60 minutes of recording and 50 of
 * determinism before the agent's first turn (26 September 2026), with the repo
 * at the same production commit and the proposals unchanged. Only the tools had
 * moved, and the fixes behind that (a clock, an import allowance, a NaN tag)
 * changed a few rows each.
 *
 * A row is now re-recorded only when something it depends on changed. The
 * INPUT is the proposal fingerprint (record.mjs proposalFingerprint), the TOOLS
 * are record.mjs's OBSERVATION_VERSION plus the cigate path (steps/emit.mjs),
 * and the CODE is this file: the subject's module, the entry the row imports,
 * the modules its builds and boundaries name and the files its branches moved
 * in, plus everything those import, statically, and the few repo-wide files
 * every row runs under (GLOBAL_FILES).
 *
 * WHY THE STATIC CLOSURE AND NOT "THE FILES THE ROW EXECUTED". A row records
 * the branch counters it moved (`movedBranches`), not the files it ran: a
 * straight-line helper, or a module whose only effect is a constant read at
 * import, moves no branch and is invisible there. And module scope runs once
 * per chunk, so an execution trace would credit the first row of a chunk with
 * every import and the others with none. The closure over-approximates, which is
 * the safe direction: an edit re-records every row that COULD see it. The
 * `movedBranches` files are added as roots, so a module reached dynamically is
 * in the set as well.
 *
 * WHAT A STAMP IS. `{ roots, digest }` on the row: the roots it was computed
 * from, and one hash over the path and content of every file in their closure
 * plus the global files. The same roots over an unchanged tree give the same
 * digest, and the closure of unchanged files is itself unchanged (their import
 * lists are part of their content), so a digest match is the whole question. A
 * file that appears in the closure and was not there before is a change: it is
 * hashed into the digest.
 *
 * A ROW RECORDED BEFORE THE STAMP EXISTED carries none. It is judged by git
 * instead - `recordedAgainst` (the commit test/characterization/recorded.json
 * names) against the tree on disk - and stamped if nothing it depends on moved.
 * No commit, or a git that cannot answer, and the row is recorded again: the
 * absence of evidence is not evidence that nothing changed.
 *
 * THE BACKSTOP. None of this makes a reused row HONEST on its own: a reused
 * recording is reported as covered only through the suite cigate replays green
 * under the current tools, and a red one recorded by another toolset is
 * recorded again before it is withheld (steps/emit.mjs ciGate).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Files every row runs under, whichever module it imports. A change to one of
 * them re-records every row.
 *
 * The lockfiles and the manifest decide what is in node_modules - the
 * generated Prisma client among it, with prisma's schema - and the tsconfigs
 * and the repo's own vitest/vite configs decide how every specifier resolves
 * (the recording config merges the host's aliases, vitest.record.config.mts).
 * package.json is read for the fields that change what runs, not its bytes:
 * install.sh merges its `charpilotScripts` into `scripts` on every install, and
 * a script entry decides nothing a row observes.
 */
export const GLOBAL_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "prisma/schema.prisma",
  "schema.prisma",
]);
const GLOBAL_PATTERNS = [/^tsconfig(?:\.[\w-]+)?\.json$/, /^(?:vitest|vite)\.config\.[cm]?[jt]s$/];
const PRISMA_SCHEMA_DIR = "prisma/schema";
const PACKAGE_FIELDS = ["type", "main", "module", "exports", "imports", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", "workspaces"];

/** Specifiers inside a build string, a boundary's `module`, or `vi.mock(...)`. */
const SPECIFIER = /(?:\bimport\s*\(\s*|\bfrom\s+|\brequire\s*\(\s*|\bvi\.(?:do)?[mM]ock\s*\(\s*)(["'`])([^"'`\n]+)\1/g;

const toPosix = (p) => p.split(sep).join("/");
const sha = (text) => createHash("sha1").update(text).digest("hex").slice(0, 12);

/** The repo-wide files that exist in `root`, sorted, repo-relative. */
export function globalFiles(root) {
  const out = GLOBAL_FILES.filter((f) => existsSync(join(root, f)));
  try {
    for (const f of readdirSync(root)) if (GLOBAL_PATTERNS.some((re) => re.test(f))) out.push(f);
  } catch {
    // an unreadable root has no globals of its own; the rows say why elsewhere
  }
  try {
    for (const f of readdirSync(join(root, PRISMA_SCHEMA_DIR))) if (f.endsWith(".prisma")) out.push(`${PRISMA_SCHEMA_DIR}/${f}`);
  } catch {
    // no multi-file schema
  }
  return [...new Set(out)].sort();
}

/** What a file contributes to a digest: its bytes, or package.json's runtime fields. */
export function contentOf(rel, text) {
  if (rel !== "package.json") return text;
  try {
    const doc = JSON.parse(text);
    return JSON.stringify(PACKAGE_FIELDS.map((k) => [k, doc?.[k] ?? null]));
  } catch {
    return text;
  }
}

/**
 * TypeScript's own lexer and resolver, from the ts-morph scan.mjs already
 * needs, or null when it cannot be loaded - in which case no row can be
 * cleared and every one is recorded again, which is slow and never wrong.
 */
async function loadTs() {
  try {
    return (await import("ts-morph")).ts;
  } catch {
    return null;
  }
}

/**
 * The repo's module graph, read lazily and memoised for the life of the
 * process: one lexer pass per file, one resolution per (file, specifier), one
 * closure per root. On sourcing-ms that is a few hundred files, once.
 */
export async function sourceGraph(root, { tsconfig = join(root, "tsconfig.json"), ts: given } = {}) {
  const ts = given === undefined ? await loadTs() : given;
  if (!ts) return null;
  let options = { allowJs: true, resolveJsonModule: true };
  try {
    const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
    if (!read.error) {
      options = { ...options, ...ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig)).options };
    }
  } catch {
    // resolved with the defaults; an alias that does not resolve is simply not followed
  }
  // The recorder's config resolves through vite, which does not read
  // `moduleResolution`; `bundler` is the tsc mode that follows the same
  // extension-less, index-file and `paths` rules, whatever the repo's tsconfig
  // says for its own build.
  if (ts.ModuleResolutionKind?.Bundler !== undefined) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    if (ts.ModuleKind?.ESNext !== undefined) options.module = ts.ModuleKind.ESNext;
  }
  const host = ts.sys;
  const texts = new Map();
  const imports = new Map();
  const closures = new Map();
  const hashes = new Map();

  const inRepo = (abs) => {
    const rel = relative(root, abs);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("node_modules") ? toPosix(rel) : null;
  };
  const read = (rel) => {
    if (!texts.has(rel)) {
      let text = null;
      try {
        text = readFileSync(join(root, rel), "utf8");
      } catch {
        text = null;
      }
      texts.set(rel, text);
    }
    return texts.get(rel);
  };
  const resolveFrom = (spec, fromAbs) => {
    try {
      const r = ts.resolveModuleName(spec, fromAbs, options, host).resolvedModule;
      if (!r || r.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(r.resolvedFileName)) return null;
      return inRepo(resolve(r.resolvedFileName));
    } catch {
      return null;
    }
  };
  const importsOf = (rel) => {
    if (imports.has(rel)) return imports.get(rel);
    const out = [];
    const text = /\.[cm]?[jt]sx?$/.test(rel) ? read(rel) : null;
    if (text !== null) {
      let found = [];
      try {
        found = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
      } catch {
        found = [...text.matchAll(SPECIFIER)].map((m) => m[2]);
      }
      const from = join(root, rel);
      for (const spec of new Set(found)) {
        const hit = resolveFrom(spec, from);
        if (hit) out.push(hit);
      }
    }
    imports.set(rel, out);
    return out;
  };

  const graph = {
    root,
    /** A repo file, as it is on disk now: its content hash, or null when it is not there. */
    hashOf(rel) {
      if (!hashes.has(rel)) {
        const text = read(rel);
        hashes.set(rel, text === null ? null : sha(contentOf(rel, text)));
      }
      return hashes.get(rel);
    },
    /** Every file hashed so far, for the artifact's table (writeDoc). */
    hashed() {
      return Object.fromEntries([...hashes].filter(([, h]) => h !== null).sort(([a], [b]) => (a < b ? -1 : 1)));
    },
    /** Resolve a specifier as `fromRel` would import it, or a repo-relative path as itself. */
    resolveSpecifier(spec, fromRel) {
      if (!spec || typeof spec !== "string") return null;
      if (!spec.startsWith(".") && !spec.startsWith("/") && existsSync(join(root, spec)) && statSync(join(root, spec)).isFile()) return toPosix(spec);
      return resolveFrom(spec, join(root, fromRel ?? "index.ts"));
    },
    /** The repo files `rel` imports directly (record.mjs cycleImporters, D73). */
    importsOf(rel) {
      return importsOf(rel);
    },
    /** The static import closure of `roots`, roots included, sorted. */
    closureOf(roots) {
      const key = [...roots].sort().join("\n");
      if (closures.has(key)) return closures.get(key);
      const seen = new Set();
      const queue = [...roots].filter(Boolean);
      while (queue.length) {
        const f = queue.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        for (const g of importsOf(f)) if (!seen.has(g)) queue.push(g);
      }
      const out = [...seen].sort();
      closures.set(key, out);
      return out;
    },
    /** The files `roots` depend on: their closure plus the repo-wide files. */
    dependencies(roots) {
      return [...new Set([...graph.closureOf(roots), ...globalFiles(root)])].sort();
    },
    /** One hash over the path and content of every file the roots depend on. */
    digest(roots) {
      const h = createHash("sha1");
      for (const f of graph.dependencies(roots)) h.update(`${f}\0${graph.hashOf(f) ?? "absent"}\n`);
      return h.digest("hex").slice(0, 12);
    },
  };
  return graph;
}

/**
 * The roots of one row: where its code starts.
 *
 * `r` is the runnable row record.mjs built from the proposal (`functionId`,
 * `entry`, `args`, `mocks`, `covers`, the proposal itself), `observed` the row
 * the recorder wrote (`movedBranches`). Only files inside the repo; a specifier
 * that resolves nowhere is dropped rather than guessed at.
 */
export function rootsOf(graph, r, observed = {}) {
  const subject = String(r?.functionId ?? observed?.functionId ?? "").split(":")[0];
  const out = new Set();
  const add = (rel) => {
    if (rel && existsSync(join(graph.root, rel))) out.add(rel);
  };
  if (subject) add(subject);
  const entryModule = r?.entry?.module;
  if (typeof entryModule === "string") add(graph.resolveSpecifier(entryModule, subject || null));
  for (const a of r?.covers ?? observed?.covers ?? []) add(String(a).split("#")[0]);
  for (const f of Object.keys(observed?.movedBranches ?? {})) add(f);
  for (const f of Object.keys(observed?.movedBranchesBeforeSubject ?? {})) add(f);
  for (const m of r?.mocks ?? []) if (typeof m?.module === "string") add(graph.resolveSpecifier(m.module, subject || null));
  // The builds, the setup and the boundaries as the proposal wrote them: any
  // specifier they name, resolved the way the subject's own file would.
  const proposal = r?.proposal ?? r;
  const words = JSON.stringify({ args: proposal?.args, setup: proposal?.setup, invoke: proposal?.invoke, boundaries: proposal?.boundaries });
  for (const m of String(words ?? "").replace(/\\"/g, '"').matchAll(SPECIFIER)) add(graph.resolveSpecifier(m[2], subject || null));
  for (const b of Object.values(proposal?.boundaries ?? {})) if (typeof b?.module === "string") add(graph.resolveSpecifier(b.module, subject || null));
  return [...out].sort();
}

/**
 * The stamp a freshly recorded row carries: its roots and their digest.
 */
export function stampOf(graph, r, observed) {
  const roots = rootsOf(graph, r, observed);
  return { roots, digest: graph.digest(roots) };
}

/**
 * Why a stamped row's code is no longer the code it was recorded against, or
 * null when it is. `table` is the previous artifact's `sources.files`, used
 * only to NAME the file that moved - the digest alone decides.
 */
export function stampChanged(graph, stamp, table = {}) {
  if (!stamp?.digest || !Array.isArray(stamp.roots)) return { files: [], why: "it carries no source stamp" };
  if (graph.digest(stamp.roots) === stamp.digest) return null;
  const files = graph.dependencies(stamp.roots).filter((f) => (table?.[f] ?? null) !== graph.hashOf(f));
  return { files, why: files.length ? `${files.slice(0, 3).join(", ")}${files.length > 3 ? `, … ${files.length - 3} more` : ""} changed` : "a file it depends on changed" };
}

/**
 * The repo files that differ from `sha`, committed or not, plus the untracked
 * ones - or null when git cannot say. For rows recorded before stamps existed.
 */
export function changedSince(root, sha, run = git) {
  if (!sha) return null;
  try {
    const diffed = run(root, ["diff", "--name-only", "--no-renames", sha, "--"]);
    const untracked = run(root, ["ls-files", "--others", "--exclude-standard"]);
    return new Set(`${diffed}\n${untracked}`.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/** package.json differs in bytes on every install; only its runtime fields count. */
export function packageMoved(root, sha, run = git) {
  try {
    const then = run(root, ["show", `${sha}:package.json`]);
    return contentOf("package.json", then) !== contentOf("package.json", readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return true;
  }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Why an unstamped row's code moved since `sha`, or null when nothing it
 * depends on did. `changed` is `changedSince`'s set (null: git could not say).
 */
export function legacyChanged(graph, roots, sha, changed, packageChanged) {
  if (!sha) return { files: [], why: "no commit names what it was recorded against" };
  if (changed === null) return { files: [], why: `git could not diff ${String(sha).slice(0, 8)} against the tree on disk` };
  const moved = graph.dependencies(roots).filter((f) => changed.has(f) && (f !== "package.json" || packageChanged));
  return moved.length ? { files: moved, why: `${moved.slice(0, 3).join(", ")}${moved.length > 3 ? `, … ${moved.length - 3} more` : ""} changed since ${String(sha).slice(0, 8)}` } : null;
}
