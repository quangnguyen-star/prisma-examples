/**
 * (No shebang: vitest.charpilot.config.mts imports config.mjs, which imports
 * srcdir.mjs, and vitest 2's config bundler rejects a shebang in an import -
 * contact-ms's baseline died "Syntax error !" on it.)
 *
 * WHERE A REPO KEEPS ITS TYPESCRIPT, read off the repo (tool backlog).
 *
 *   node srcdir.mjs <repo>     prints the source directory, repo-relative ("." for the root)
 *
 * One answer for install.sh (which writes it into test/src-exclude.mjs as
 * SRC_DIR) and for config.mjs (which uses it for a FOREIGN target, where no
 * src-exclude.mjs of ours may exist), so the scan, the coverage include and the
 * package-root check agree. contact-ms and candidate-ms keep their TypeScript at
 * the repo root beside routes/, service/ and server.ts, and every tool globbed
 * src/**, so the scan found nothing there.
 *
 * In order:
 *   1. tsconfig.json `compilerOptions.rootDir`, when it names a directory
 *      other than the root that holds TypeScript
 *   2. src/, when it holds TypeScript - the layout every tool assumed
 *   3. tsconfig.json `include` (or `files`), when every non-test entry shares
 *      one directory other than the root
 *   4. the repo root, when it holds TypeScript
 * and null when none of those holds a .ts file.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Test directories are not where source is, and ours live there: an emitted
// test/characterization/*.char.test.ts or test/fixtures/doubles.ts must never
// turn a repo with no source into "the root holds TypeScript" between rounds.
const SKIP = new Set(["node_modules", ".git", ".claude", "dist", "build", "coverage", "test", "tests", "__tests__", "__mocks__", "characterization"]);
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(test|spec|e2e-spec|char\.test|char)\.[cm]?tsx?$/;

/** Does `dir` hold a .ts file (not a declaration or a test) anywhere below it? */
function holdsTs(dir, depth = 0) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name) && !NOT_SOURCE.test(e.name)) return true;
  }
  if (depth > 12) return false;
  return entries.some((e) => e.isDirectory() && !SKIP.has(e.name) && holdsTs(join(dir, e.name), depth + 1));
}

/** tsconfig.json as an object, comments and trailing commas tolerated; null when unreadable. */
function readTsconfig(root) {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8")
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(text); } catch { return null; }
}

/** The leading directory of a tsconfig include/files entry, or "." when it has none. */
function leadingDir(entry) {
  const parts = normalize(String(entry)).replace(/^\.\//, "").split("/");
  const out = [];
  for (const p of parts) {
    if (/[*?{[]/.test(p) || /\.[cm]?[jt]sx?$/.test(p)) break;
    out.push(p);
  }
  return out.length ? out.join("/") : ".";
}

/** The source directory of `root`, repo-relative, or null. */
export function detectSrcDir(root) {
  const ok = (rel) => {
    const abs = resolve(root, rel);
    return abs.startsWith(resolve(root)) && existsSync(abs) && statSync(abs).isDirectory() && holdsTs(abs) ? rel : null;
  };
  const ts = readTsconfig(root);
  // A NAMED directory in tsconfig wins; `.` there says nothing src/ does not.
  const rootDir = typeof ts?.compilerOptions?.rootDir === "string" ? normalize(ts.compilerOptions.rootDir).replace(/\/$/, "") : null;
  if (rootDir && rootDir !== "." && ok(rootDir)) return rootDir;
  // src/ next, exactly as every tool has always assumed - 31 of the 33 fleet
  // services, whose tsconfigs also list setup files and prisma seeds at the
  // root that were never part of the scan.
  if (ok("src")) return "src";
  const entries = [...(Array.isArray(ts?.include) ? ts.include : []), ...(Array.isArray(ts?.files) ? ts.files : [])];
  // A test directory beside the source is not where the source is.
  const dirs = [...new Set(entries.map(leadingDir))].filter((d) => !/^(test|tests|__tests__|spec|e2e)(\/.*)?$/.test(d));
  if (dirs.length === 1 && dirs[0] !== "." && ok(dirs[0])) return dirs[0];
  return ok(".");
}

// Real paths on both sides: /var is a symlink on macOS, and argv keeps the link.
const isMain = () => {
  try { return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
};
if (isMain()) {
  const found = detectSrcDir(process.argv[2] ?? process.cwd());
  if (found === null) process.exit(1);
  process.stdout.write(`${found}\n`);
}
