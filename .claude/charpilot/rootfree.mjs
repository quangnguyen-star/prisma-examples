/**
 * AN EMITTED SPEC NAMES NO ABSOLUTE REPO ROOT (D55).
 *
 * THE DEFECT. The recording runs in a container whose checkout is /work/repo,
 * and that path went into the committed tests three ways:
 *
 *   - a proposal's input: cv-parsing-ms PR #68, arg1-of-withSpan-45-binary-expr-0
 *     and parse-38-default-arg-0 pass `{ filepath: "/work/repo/test/fixtures/doubles.ts" }`
 *     (an args value) and `{ filepath: "/work/repo/package.json" }` (an args
 *     build). On the runner the checkout is /home/runner/work/<repo>/<repo>, so
 *     the subject read nothing and threw
 *       Parse CV failed "ENOENT: no such file or directory, open '/work/repo/test/fixtures/doubles.ts'"
 *     where the recording had it get past the read;
 *   - a proposal's build that imports by absolute path: qode-itl-be
 *     request-336-cond-expr-0, `Failed to load url
 *     /work/repo/src/downstream/notification-ms/notification-ms.client`;
 *   - the row runtime itself: every spec carried
 *     `const REPO_ROOT_PREFIX = "/work/repo/"` and
 *     `const DB_CLIENT_FILES = new Set(["/work/repo/prisma/client"])`, so on a
 *     runner the database-client guard matched no file at all.
 *
 * cigate did not see it: it ran the suite in the same container, at the same
 * /work/repo, where every one of those paths exists.
 *
 * THE FIX IS A REWRITE, NOT A REFUSAL. The root is per-checkout identity, like
 * a temp directory: the right value at test time is wherever the file is
 * checked out. So every string or template literal in the emitted spec that
 * contains the run's root at a path boundary has the root replaced by
 * `CHARPILOT_REPO_ROOT`, a constant the spec computes from its own
 * `import.meta.url` (the spec's depth below the root is known when it is
 * written). That covers the input, the expected value that echoes it (a
 * recorded ENOENT message, a returned path), and the runtime's constants, in
 * one pass - and the recording is unchanged, because at /work/repo the
 * expression IS /work/repo. A static import cannot take an expression, so its
 * specifier becomes the relative path from the spec to the same file.
 *
 * Parsed with TypeScript (ts-morph's, which install.sh guarantees), not with a
 * regular expression: the spec holds agent-written code, and only a parser
 * tells a string from a regex, a template or a comment.
 *
 * WHAT IS LEFT is returned as `leftovers` (a regex literal, an escaped slash,
 * a type-position literal is ignored - types are erased), and cigate.mjs scans
 * every spec for them again with `rootLeaks`, which withholds the row: a test
 * that names /work/repo is red on every runner that is not this container.
 */
import { dirname, relative } from "node:path";
import { createRequire } from "node:module";

/**
 * TypeScript, loaded when first asked for, not imported: record.mjs imports
 * this module, and a probe or a fleetcheck toolchain that installs vitest
 * alone must still record. Without it the rewrite does nothing and SAYS so,
 * and the scan falls back to a line match (`rootLeaks`).
 */
let ts = null;
function loadTs() {
  if (ts) return ts;
  try {
    ts = createRequire(import.meta.url)("ts-morph").ts;
  } catch {
    ts = null;
  }
  return ts;
}

export const ROOT_VAR = "CHARPILOT_REPO_ROOT";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The offsets in `raw` (a literal's source text) where `root` starts a path:
 * not inside a longer path segment on either side, and not behind an escaping
 * backslash.
 */
export function rootOffsets(raw, root) {
  const out = [];
  const re = new RegExp(`${esc(root)}(?![\\w.-])`, "g");
  for (let m; (m = re.exec(raw)); ) {
    const before = raw[m.index - 1] ?? "";
    if (/[\w.-]/.test(before)) continue;
    let bs = 0;
    for (let i = m.index - 1; i >= 0 && raw[i] === "\\"; i--) bs++;
    if (bs % 2) continue;
    out.push(m.index);
  }
  return out;
}

function lineOf(text, pos) {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The row whose block holds `pos`: the nearest `// [recorded: <id>]` above it. */
function rowAt(text, pos) {
  const head = text.slice(0, pos);
  const at = head.lastIndexOf("// [recorded: ");
  if (at !== -1) return head.slice(at).match(/^\/\/ \[recorded: (\S+)\]/)?.[1] ?? null;
  // Above the first test: inside the ROWS literal, a row's own entry opens
  // with its id (record.mjs writes it with JSON.stringify(_, null, 2)).
  const rows = head.lastIndexOf("\nconst ROWS = [");
  if (rows === -1 || /\n\];\n/.test(head.slice(rows))) return null;
  const ids = [...head.slice(rows).matchAll(/\n {4}"id": "([^"\\]+)"/g)];
  return ids.length ? ids[ids.length - 1][1] : null;
}

const isStringy = (k) =>
  k === ts.SyntaxKind.StringLiteral ||
  k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
  k === ts.SyntaxKind.TemplateHead ||
  k === ts.SyntaxKind.TemplateMiddle ||
  k === ts.SyntaxKind.TemplateTail;

/** Is `node` in a type position (erased at runtime)? */
function inType(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return true;
    if (ts.isStatement(n) || ts.isExpression(n)) return false;
  }
  return false;
}

/** Every literal in `text` that names `root`, parsed. */
function literalsNaming(text, root) {
  const sf = ts.createSourceFile("spec.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    const k = node.kind;
    if (isStringy(k) || k === ts.SyntaxKind.RegularExpressionLiteral) {
      const start = node.getStart(sf);
      const raw = text.slice(start, node.end);
      if (raw.includes(root)) found.push({ node, start, end: node.end, raw });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * THE SPEC WITH ITS ROOT RESOLVED AT TEST TIME: `{ text, rewritten,
 * leftovers }`. `specPath` is where the file will live, which fixes how far
 * above it the root is.
 */
export function rootFree(text, { root, specPath }) {
  const r = String(root ?? "").replace(/\/+$/, "");
  if (!r || r === "/" || !String(text).includes(r)) return { text, rewritten: 0, leftovers: [] };
  if (!loadTs()) {
    return { text, rewritten: 0, leftovers: lineLeaks(text, r).map((l) => ({ ...l, kind: "ts-morph is not installed, so nothing was rewritten" })) };
  }
  const found = literalsNaming(text, r);
  const edits = [];
  const leftovers = [];
  const leave = (f, kind) => leftovers.push({ line: lineOf(text, f.start), kind, row: rowAt(text, f.start), snippet: f.raw.slice(0, 160) });
  const relToRoot = relative(dirname(specPath), r) || ".";
  for (const f of found) {
    const { node, raw } = f;
    if (inType(node)) continue;
    const offsets = rootOffsets(raw, r);
    if (!offsets.length) {
      if (rootLeaksIn(raw, r)) leave(f, "an occurrence the rewrite cannot place");
      continue;
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      leave(f, "a regular expression literal");
      continue;
    }
    const parent = node.parent;
    // A dynamic `import("/work/repo/src/...")` too (qode-itl-be
    // request-336-cond-expr-0: "Failed to load url /work/repo/src/downstream/
    // notification-ms/notification-ms.client" anywhere but the container): a
    // literal specifier keeps vite's own resolution of it, which an expression
    // would trade for a runtime path.
    const isDynamicImport =
      ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node &&
      node.kind === ts.SyntaxKind.StringLiteral && offsets.length === 1 && offsets[0] === 1;
    const isSpecifier =
      (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node ||
      ts.isExternalModuleReference(parent) ||
      isDynamicImport;
    if (isSpecifier) {
      // A static import takes no expression: the relative walk to the same file.
      const q = raw[0];
      const inner = raw.slice(1, -1);
      const rel = inner.split(r).join(relToRoot);
      edits.push({ start: f.start, end: f.end, text: `${q}${rel.startsWith(".") ? rel : `./${rel}`}${q}` });
      continue;
    }
    if (node.kind === ts.SyntaxKind.StringLiteral) {
      const q = raw[0];
      const inner = raw.slice(1, -1);
      const parts = [];
      let at = 0;
      for (const o of rootOffsets(inner, r)) {
        if (o > at) parts.push(`${q}${inner.slice(at, o)}${q}`);
        parts.push(ROOT_VAR);
        at = o + r.length;
      }
      if (at < inner.length) parts.push(`${q}${inner.slice(at)}${q}`);
      let expr = parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
      // A property NAME is not an expression position: computed, then.
      if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) expr = `[${expr}]`;
      edits.push({ start: f.start, end: f.end, text: expr });
      continue;
    }
    // A template part: the root becomes a substitution. The part's own
    // delimiters (` ${ }) are outside the offsets, which are inside the raw.
    let out = "";
    let at = 0;
    for (const o of offsets) {
      out += raw.slice(at, o) + "${" + ROOT_VAR + "}";
      at = o + r.length;
    }
    out += raw.slice(at);
    edits.push({ start: f.start, end: f.end, text: out });
  }
  if (!edits.length) return { text, rewritten: 0, leftovers };
  let outText = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) outText = outText.slice(0, e.start) + e.text + outText.slice(e.end);
  outText = withRootConstant(outText, relToRoot);
  return { text: outText, rewritten: edits.length, leftovers };
}

/**
 * Whether `raw` names `root` as a path, escaped or not. At a boundary on both
 * sides: a checkout at /repo is not named by "/work/repo/x" - that is another
 * directory, and a spec recorded there fails its run here, which is the gate
 * catching it the other way.
 */
function rootLeaksIn(raw, root) {
  return new RegExp(`(?<![\\w.-])${esc(root)}(?![\\w.-])`).test(raw);
}

/**
 * The constant the rewrite names, after the last top-level import - so it
 * exists before any row body runs, and a `vi.mock` factory (hoisted above the
 * imports) is the one place that cannot read it, which is why none is emitted.
 */
function withRootConstant(text, relToRoot) {
  if (new RegExp(`^const ${ROOT_VAR} =`, "m").test(text)) return text;
  const walk = relToRoot === "." ? "./" : `${relToRoot.replace(/\/+$/, "")}/`;
  const decl =
    "\n// D55: THE REPO ROOT IS WHEREVER THIS FILE IS CHECKED OUT, not the container\n" +
    "// it was recorded in. Every path the recording saw under that root is\n" +
    `// written as ${ROOT_VAR} + the rest (record.mjs rootFreeSpec).\n` +
    `const ${ROOT_VAR} = decodeURIComponent(new URL(${JSON.stringify(walk)}, import.meta.url).pathname).replace(/\\/+$/, "");\n`;
  // The emitter writes each import on one line (record.mjs writeSpec).
  const lastImport = [...text.matchAll(/^import [^\n]*;[ \t]*$/gm)].pop();
  if (!lastImport) return decl.slice(1) + text;
  const eol = lastImport.index + lastImport[0].length;
  return text.slice(0, eol) + decl + text.slice(eol);
}

/**
 * EVERY PLACE A SPEC STILL NAMES `root` where it runs (cigate.mjs): string,
 * template and regex literals, outside type positions - comments are not
 * code, and the constant's own definition names no root. `{ line, kind, row,
 * snippet }` each; `row` is the recorded row whose block holds it, or null
 * for the file's shared runtime.
 */
export function rootLeaks(text, root) {
  const r = String(root ?? "").replace(/\/+$/, "");
  if (!r || r === "/" || !String(text).includes(r)) return [];
  if (!loadTs()) return lineLeaks(text, r);
  const out = [];
  for (const f of literalsNaming(text, r)) {
    if (inType(f.node) || !rootLeaksIn(f.raw, r)) continue;
    out.push({
      line: lineOf(text, f.start),
      kind: f.node.kind === ts.SyntaxKind.RegularExpressionLiteral ? "regex" : "string",
      row: rowAt(text, f.start),
      snippet: f.raw.slice(0, 160),
    });
  }
  return out;
}

/** Without a parser: every non-comment line that names `root` as a path. */
function lineLeaks(text, root) {
  const re = new RegExp(`(?<![\\w.-])${esc(root)}(?![\\w.-])`);
  const out = [];
  let pos = 0;
  String(text).split("\n").forEach((line, i) => {
    const at = pos;
    pos += line.length + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || !re.test(line)) return;
    out.push({ line: i + 1, kind: "string", row: rowAt(text, at), snippet: line.trim().slice(0, 160) });
  });
  return out;
}
