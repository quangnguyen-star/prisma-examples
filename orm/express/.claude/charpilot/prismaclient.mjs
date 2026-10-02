/**
 * THE PRISMA CLIENT AN INSTALL LEFT, AND THE ROWS IT BROKE (D42).
 *
 * @prisma/client's postinstall copies a placeholder into
 * node_modules/.prisma/client BEFORE it tries to generate, and leaves it there,
 * silently, when that generate fails. The placeholder exports PrismaClient
 * (which throws "did not initialize yet" when constructed) and a bare
 * `Prisma`: no enum and no error class. A row recorded over it dies in
 * arrangement with one of PLACEHOLDER_FAILURE's messages.
 *
 * Both halves live here because two tools need them: baseline.mjs generates
 * over a placeholder, and the recorder (record.mjs's cache, steps/record.mjs's
 * `satisfied`) must not keep a row that failed on the placeholder once the
 * client is generated. qode-ptp-ms, late September 2026: a resumed run's
 * container generated its client at install, and the recording it resumed
 * from - 931 rows that died on the placeholder in the container before - was
 * "already done", so round 1 dealt around sides whose only reason was the
 * previous container's client.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

const PRISMA_PLACEHOLDER = "did not initialize yet";

/**
 * The entry of the client beside the resolved @prisma/client that is the
 * placeholder, relative to `repoRoot` - or null (a generated client, or no
 * Prisma at all). A generated client never carries the sentence.
 */
export function prismaPlaceholder(repoRoot) {
  let pkgDir = null;
  try {
    pkgDir = dirname(realpathSync(createRequire(join(repoRoot, "package.json")).resolve("@prisma/client/package.json")));
  } catch {
    return null;
  }
  // node_modules/@prisma/client -> node_modules/.prisma/client, where the
  // package's own entry (`require('.prisma/client/default')`) resolves.
  const client = join(pkgDir, "..", "..", ".prisma", "client");
  for (const name of ["default.js", "index.js"]) {
    let head = "";
    try {
      head = readFileSync(join(client, name), "utf8").slice(0, 65536);
    } catch {
      continue;
    }
    if (head.includes(PRISMA_PLACEHOLDER)) return relative(realpathSync(repoRoot), join(client, name)) || join(client, name);
  }
  return null;
}

/** Whether Prisma is installed beside the repo at all. */
export function prismaInstalled(repoRoot) {
  try {
    createRequire(join(repoRoot, "package.json")).resolve("@prisma/client/package.json");
    return true;
  } catch {
    return false;
  }
}

/**
 * What a row recorded over the placeholder dies with: a module double of
 * @prisma/client whose spread of the real module has no enum, or a member of
 * the bare `Prisma` that is not there.
 */
export const PLACEHOLDER_FAILURE = /No "[\w$]+" export is defined on the "@prisma\/client" mock|\bPrisma\.[\w$]+ is not a (?:constructor|function)\b/;

/** A recorded row that failed on the placeholder client. */
export function failedOnPlaceholder(row) {
  return Boolean(row?.harnessError) && PLACEHOLDER_FAILURE.test(String(row.harnessError.message ?? ""));
}

/**
 * Whether rows that failed on the placeholder are stale here: Prisma is
 * installed and its client is generated now.
 */
export function placeholderRowsAreStale(repoRoot) {
  return prismaInstalled(repoRoot) && prismaPlaceholder(repoRoot) === null;
}

/* --------------------------------------------------------------------------
 * D67 - A ROW THE ENVIRONMENT FAILED IS NOT AN OBSERVATION, AND A MASS OF THEM
 * IS THE ENVIRONMENT'S DEFECT, NOT A SMALLER SUITE.
 *
 * WHAT HAPPENED. qode-itl-be's checkpoint `3a0dd7e-20260926T184305Z` was
 * resumed where `@qode/contract` (an npm workspace whose `main` is
 * dist/index.js) had not been built and the Prisma client had not been
 * generated - the two things docker/char/packs/common.py does after install
 * ("built workspace packages/contract", "generated the Prisma client"), and
 * warns rather than fails when it cannot. The recorder ran all 1323 rows and
 * 884 died in arrangement on `Failed to resolve entry for package
 * "@qode/contract"` and `Cannot find module '.prisma/client/default'`. The
 * recording ACCOUNTED for every row, so D66 had nothing to refuse: `record`
 * was satisfied, and the emit read 884 harness failures as "no outcome" and
 * took the delivered suite from 142 spec files to 64. Silently, and green.
 *
 * WHAT AN ENVIRONMENT FAILURE IS. Not a share of rows on its own - a share
 * cannot tell a broken install from a round of bad inputs - but a harness
 * failure whose message names something the INSTALL owes the repo and did not
 * deliver, and which the disk can be asked about:
 *
 *   entry:<pkg>     `Failed to resolve entry for package "<pkg>"`: the package
 *                   is there and its main/module/exports file is not - an
 *                   unbuilt workspace. Set up once those files exist.
 *   prisma-client   `Cannot find module '.prisma/client/default'`, or D42's
 *                   placeholder: `prisma generate` never ran, or failed. Set
 *                   up once a generated client is beside @prisma/client.
 *   module:<pkg>    `Cannot find module|package '<pkg>'` for a bare specifier
 *                   the repo's package.json (or a workspace's) DECLARES: the
 *                   install is incomplete. A specifier nobody declares is a
 *                   proposal's typo, not the environment, and is left alone.
 *
 * Each is asked of the disk NOW (`environmentFixed`), so the walk tells "still
 * broken" from "set up since" without a state file, and a row that failed on a
 * cause that is set up now is recorded again (steps/record.mjs
 * `environmentRows`, record.mjs's cache) - D42's rule for the placeholder,
 * for every cause.
 *
 * WHEN IT IS A DEFECT (`environmentDefect`): the causes still broken account
 * for a MASS of the recording - ENV_MASS_ROWS rows, or ENV_MASS_SHARE of them -
 * or for a row the delivered suite asserts. Then the recording does not stand
 * in for the subject's behaviour: steps/record.mjs names it as the run's defect
 * ("the environment is not set up: @qode/contract dist missing ..."),
 * steps/emit.mjs is blocked behind it, and record.mjs --emit-tests refuses to
 * shrink the delivered suite on it, as D66 refuses to empty it. One row on one
 * missing module under that bar, asserted by nothing delivered, is a row that
 * failed, ruled as before: it does not fail a run.
 * ------------------------------------------------------------------------ */

/** Rows of the recording that make a still-broken environment a mass. */
export const ENV_MASS_ROWS = 5;
/** Or this share of them, for a recording smaller than that. */
export const ENV_MASS_SHARE = 0.1;

const ENTRY_UNRESOLVED = /Failed to resolve entry for package "([^"]+)"/;
const CLIENT_MISSING = /Cannot find module '\.prisma\/client\/(?:default|index)(?:\.js)?'/;
const MODULE_MISSING = /Cannot find (?:module|package) '([^']+)'/g;

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`, or null for a path. */
function packageOf(spec) {
  const s = String(spec ?? "");
  if (!s || s.startsWith(".") || s.startsWith("/") || /^[a-z]+:/i.test(s)) return null;
  const parts = s.split("/");
  if (!s.startsWith("@")) return parts[0];
  return parts.length > 1 ? `${parts[0]}/${parts[1]}` : null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The package.json of `name` as installed for `repoRoot`, or null. Looked up
 * in node_modules, walking up, and NOT through require.resolve: a workspace
 * whose `exports` names only "." refuses `<name>/package.json`.
 */
function installedManifest(repoRoot, name) {
  for (let dir = repoRoot; ; dir = dirname(dir)) {
    const file = join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The files `main`, `module` and `exports` name, and those of them that do not
 * exist (relative to `repoRoot`). Runtime entries only - a `types` condition
 * is not what an import resolves to. common.py `_entry_targets` reads the same.
 */
function entryFiles(repoRoot, manifestFile) {
  const manifest = readJson(manifestFile) ?? {};
  const targets = [];
  for (const key of ["main", "module"]) if (typeof manifest[key] === "string") targets.push(manifest[key]);
  const walk = (node, condition = null) => {
    if (typeof node === "string") {
      if (condition !== "types" && node.startsWith("./") && !node.includes("*")) targets.push(node);
    } else if (Array.isArray(node)) {
      for (const v of node) walk(v, condition);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(manifest.exports);
  const dir = real(dirname(manifestFile));
  const files = [...new Set(targets.map((t) => join(dir, t)))];
  return {
    dir: relative(real(repoRoot), dir),
    all: files.length,
    missing: files.filter((f) => !existsSync(f)).map((f) => relative(real(repoRoot), f) || f),
  };
}

/** Every package the repo's package.json, and each of its workspaces', declares or is. */
function declaredPackages(repoRoot) {
  const names = new Set();
  const add = (doc) => {
    if (!doc) return;
    if (typeof doc.name === "string") names.add(doc.name);
    for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const n of Object.keys(doc[k] ?? {})) names.add(n);
    }
  };
  const root = readJson(join(repoRoot, "package.json"));
  add(root);
  const patterns = Array.isArray(root?.workspaces) ? root.workspaces : root?.workspaces?.packages;
  for (const p of Array.isArray(patterns) ? patterns : []) {
    // `packages/*` and `packages/contract`, the two shapes these repos use.
    const base = String(p).replace(/\/\*+$/, "");
    let dirs = [base];
    if (String(p).endsWith("*")) {
      try {
        dirs = readdirSync(join(repoRoot, base)).map((d) => join(base, d));
      } catch {
        dirs = [];
      }
    }
    for (const d of dirs) add(readJson(join(repoRoot, d, "package.json")));
  }
  return names;
}

/** Whether a GENERATED client - not the placeholder, not nothing - is beside @prisma/client. */
function prismaClientGenerated(repoRoot) {
  if (!prismaInstalled(repoRoot) || prismaPlaceholder(repoRoot) !== null) return false;
  try {
    const pkgDir = dirname(realpathSync(createRequire(join(repoRoot, "package.json")).resolve("@prisma/client/package.json")));
    const client = join(pkgDir, "..", "..", ".prisma", "client");
    return existsSync(join(client, "default.js")) || existsSync(join(client, "index.js"));
  } catch {
    return false;
  }
}

/**
 * The environment cause a recorded row failed on, `{ key, pkg }`, or null: a
 * row that ran, or a harness failure that is not the install's.
 */
export function environmentCause(row, repoRoot) {
  if (!row?.harnessError || row.invoked === true) return null;
  const text = String(row.harnessError.message ?? "");
  if (CLIENT_MISSING.test(text) || PLACEHOLDER_FAILURE.test(text) || text.includes(PRISMA_PLACEHOLDER)) {
    return { key: "prisma-client", pkg: "@prisma/client" };
  }
  const entry = ENTRY_UNRESOLVED.exec(text);
  if (entry) return { key: `entry:${entry[1]}`, pkg: entry[1] };
  let declared = null;
  for (const m of text.matchAll(MODULE_MISSING)) {
    const pkg = packageOf(m[1]);
    if (!pkg) continue;
    declared ??= declaredPackages(repoRoot);
    if (declared.has(pkg)) return { key: `module:${pkg}`, pkg };
  }
  return null;
}

/** Whether the environment cause `key` is set up in `repoRoot` now. */
export function environmentFixed(key, repoRoot) {
  if (key === "prisma-client") return prismaClientGenerated(repoRoot);
  const [kind, ...rest] = String(key).split(":");
  const manifest = installedManifest(repoRoot, rest.join(":"));
  if (kind === "entry") {
    if (!manifest) return false;
    const { all, missing } = entryFiles(repoRoot, manifest);
    return all > 0 && missing.length === 0;
  }
  if (kind === "module") return manifest !== null;
  return false;
}

/** One cause as a clause: what is not set up, and what sets it up. */
export function environmentWhat(key, repoRoot) {
  if (key === "prisma-client") {
    const placeholder = prismaPlaceholder(repoRoot);
    return (
      "the Prisma client is not generated (" +
      (placeholder ? `${placeholder} is Prisma's placeholder` : "node_modules/.prisma/client does not exist") +
      "; `prisma generate` writes it)"
    );
  }
  const [kind, ...rest] = String(key).split(":");
  const pkg = rest.join(":");
  if (kind !== "entry") return `${pkg} is not installed (the repo's package.json declares it; the install did not deliver it)`;
  const manifest = installedManifest(repoRoot, pkg);
  const { dir, missing } = manifest ? entryFiles(repoRoot, manifest) : { dir: null, missing: [] };
  // "dist missing": the directory the entry lives in, which is what its build writes.
  const out = missing.length ? String(missing[0]).split(/[\\/]/).slice(-2, -1)[0] || "entry" : "entry";
  return (
    `${pkg} ${out} missing (` +
    (missing.length ? `${missing.slice(0, 2).join(", ")} ${missing.length > 1 ? "do" : "does"} not exist` : "its entry does not resolve") +
    (dir && !dir.startsWith("..") ? `; \`npm run build --workspace ${dir}\` builds it` : "; its build writes it") +
    ")"
  );
}

/**
 * What the recording owes the environment, cause by cause: `{ total, causes }`
 * with each cause `{ key, fixed, failed, kept, delivered }` - the ids that
 * failed on it, the ids whose earlier observation was kept over a failure on it
 * (record.mjs `__environment`), and which failed ids the delivered suite
 * asserts. `landed`, when given, narrows the rows to the proposals on disk.
 */
export function environmentFailures(doc, repoRoot, { delivered = null, landed = null } = {}) {
  const rows = (doc?.rows ?? []).filter((r) => !landed || landed.has(String(r?.id)));
  const byKey = new Map();
  const at = (key) => {
    if (!byKey.has(key)) byKey.set(key, { key, failed: [], kept: [], delivered: [] });
    return byKey.get(key);
  };
  for (const r of rows) {
    const cause = environmentCause(r, repoRoot);
    if (cause) {
      const c = at(cause.key);
      c.failed.push(String(r.id));
      if (delivered?.has(String(r.id))) c.delivered.push(String(r.id));
    } else if (r?.__environment?.cause) {
      at(r.__environment.cause).kept.push(String(r.id));
    }
  }
  const causes = [...byKey.values()].map((c) => ({ ...c, fixed: environmentFixed(c.key, repoRoot) }));
  return { total: rows.length, causes };
}

/**
 * The environment defect the recording carries, or null:
 * `{ sentence, keys, rows, total, delivered }`. See the section above.
 */
export function environmentDefect(doc, repoRoot, opts = {}) {
  const { total, causes } = environmentFailures(doc, repoRoot, opts);
  const broken = causes.filter((c) => !c.fixed);
  if (!broken.length) return null;
  const ids = new Set(broken.flatMap((c) => [...c.failed, ...c.kept]));
  const kept = new Set(broken.flatMap((c) => c.kept));
  const delivered = new Set(broken.flatMap((c) => c.delivered));
  const mass = ids.size >= ENV_MASS_ROWS || (total > 0 && ids.size / total >= ENV_MASS_SHARE);
  if (!mass && !delivered.size) return null;
  const sentence =
    `the environment is not set up: ${broken.map((c) => environmentWhat(c.key, repoRoot)).join("; ")} - ` +
    `${ids.size} of ${total} recorded row(s) failed to arrange on it` +
    (kept.size ? ` (${kept.size} keep the observation recorded before it, until they can be recorded again)` : "") +
    (delivered.size ? `, ${delivered.size} of them asserted by the delivered suite` : "") +
    ". A harness failure is not the subject's behaviour: set the environment up and those rows are recorded again";
  return { sentence, keys: broken.map((c) => c.key), rows: ids.size, total, delivered: delivered.size };
}
