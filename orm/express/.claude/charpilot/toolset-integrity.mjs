/**
 * Which installs of this toolset have drifted, and how.
 *
 * install.sh has claimed since it was written that the copy is "verified by
 * toolset-integrity.mjs". That file did not exist. INSTALLED.json was written
 * with a sha per file and a source commit, and nothing ever read it - so every
 * drift audit this session was done by hand, and drift bit five separate times:
 *
 *   - 11 of 15 installs were behind the source and nobody knew until a fix
 *     round asked
 *   - two skill locations drifted because they are COPIES while the fleet's are
 *     symlinks, and only the copies can drift
 *   - an agent overwrote a target's validate.mjs with no snapshot
 *   - gate.mjs's `validate` check shells out to the TARGET's validate.mjs, so
 *     its number describes a possibly-stale copy rather than the toolset under
 *     test (C11)
 *   - a concurrent agent's before/after was contaminated by a copy moving
 *     underneath it
 *
 * The three-way comparison is the point. `target vs source` alone cannot tell
 * "the source moved on" from "somebody edited this copy", and those need
 * opposite responses: the first wants a reinstall, the second wants a look
 * before anything is overwritten. INSTALLED.json is the third leg that
 * separates them.
 *
 *   node .claude/charpilot/toolset-integrity.mjs [--root <dir>] [--fix] [--json]
 *
 * Exits 1 on drift so the gate can depend on it. --fix copies from source and
 * re-stamps INSTALLED.json; it REFUSES a locally-modified file unless
 * --overwrite-local is given, because silently discarding someone's edit is
 * how a fix gets lost.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const arg = (n, d) => (ARGV.includes(n) ? ARGV[ARGV.indexOf(n) + 1] : d);
const FIX = ARGV.includes("--fix");
const OVERWRITE_LOCAL = ARGV.includes("--overwrite-local");
const JSON_OUT = ARGV.includes("--json");
/** Where to look for installs. Default: the workspace this source lives in. */
const ROOT = resolve(arg("--root", resolve(HERE, "..", "..", "..", "..")));

/**
 * Am I the source, or an install of it?
 *
 * INSTALLED.json sits next to an installed copy and records the source it came
 * from. Without this check, running the tool inside a target made the TARGET the
 * reference and audited the whole fleet against it - and `--fix` from there
 * would have pushed a stale copy over every other install. A drift tool whose
 * own worst case is causing drift is not one to leave unlocked.
 *
 * An install audits only ITSELF, against the source its manifest names.
 */
const SELF_MANIFEST = join(HERE, "INSTALLED.json");
const AS_INSTALL = (() => {
  if (!existsSync(SELF_MANIFEST)) return null;
  try {
    const m = JSON.parse(readFileSync(SELF_MANIFEST, "utf8"));
    const src = m.source ? resolve(m.source) : null;
    return src && src !== HERE && existsSync(join(src, "config.mjs")) ? src : null;
  } catch {
    return null;
  }
})();

const sha = (p) => createHash("sha256").update(readFileSync(p, "utf8")).digest("hex");

/**
 * install.sh rewrites the base-config import to match the target's own file
 * (`vitest.config.ts` vs `.mts`), so a .mts tool in a target legitimately
 * differs from the source by exactly that line. Reporting it as unexplained
 * drift is a false positive, and --fix would break the target by "correcting"
 * it. Recognised by normalising that one import and comparing again.
 */
const BASE_IMPORT = /(from\s+["']\.\.\/\.\.\/vite(st)?\.config)\.[mc]?ts(["'])/g;
const shaNormalised = (p) => createHash("sha256").update(readFileSync(p, "utf8").replace(BASE_IMPORT, "$1.EXT$3")).digest("hex");

/** Every .mjs/.mts the source ships, which is exactly what install.sh copies. */
function sourceFiles() {
  return readdirSync(REF)
    // toolset-integrity.mjs is INCLUDED. Excluding it meant install.sh never
    // placed it in a target, so gate.mjs's toolset-sync check reported
    // "not installed here - nothing to check against" and passed on every
    // repo: a drift guard that could not detect drift. It is a toolset file
    // like any other and it syncs like one.
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".mts"))
    .sort();
}

/**
 * Installs, found by their own INSTALLED.json.
 *
 * Discovery rather than a registry: a registry is one more thing to keep in
 * sync, which is the problem this tool exists for. Walk is bounded and skips
 * the directories that make it expensive or meaningless.
 */
function findInstalls(root) {
  // `.stryker-tmp` holds a FULL COPY of the repo, `.claude/charpilot` included,
  // and a crashed or interrupted mutation run leaves it on disk. Walked, it
  // reads as another install of this toolset — and on a target whose only real
  // install is the one being checked, the sandbox becomes the ONLY install
  // found, so the gate reports drift against a directory nobody installed:
  //   ✗ toolset-sync  54 file(s) drifted across 1 of 1 install(s): sandbox-9aRSxB
  // Measured on location-ms after the stage-8 copyfile failure. The sandbox is
  // a copy by construction, so it can never be a thing to keep in sync.
  const skip = new Set(["node_modules", ".git", "dist", "coverage", "coverage-charpilot", ".treehouse", "out", "plugins", "marketplaces", ".stryker-tmp"]);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) continue;
      const p = join(dir, e.name);
      // Keyed on config.mjs, which every install has, NOT on INSTALLED.json.
      // Discovery used to require the manifest and therefore could not see the
      // four installs that have no manifest - including ai-centralization-fresh,
      // the most-used one. An install with no manifest is the case most in need
      // of reporting, so it must not be the case that disappears.
      if (existsSync(join(p, ".claude", "charpilot", "config.mjs"))) found.push(join(p, ".claude", "charpilot"));
      walk(p, depth + 1);
    }
  };
  if (existsSync(join(root, ".claude", "charpilot", "config.mjs"))) found.push(join(root, ".claude", "charpilot"));
  walk(root, 0);
  return [...new Set(found)].filter((d) => resolve(d) !== HERE).sort();
}

/** target vs source vs what-was-installed. The third leg is what makes this readable. */
function classify(dir, files) {
  // No manifest means no third leg, so `behind` and `locally-modified` cannot be
  // told apart - both just differ. Reported as `unstamped` rather than guessed,
  // because guessing is what would make --fix discard somebody's edit.
  const mp = join(dir, "INSTALLED.json");
  const manifest = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : { unstamped: true, files: null };
  const installed = manifest.files ?? null;
  const rows = [];
  for (const f of files) {
    const tp = join(dir, f);
    const src = sha(join(REF, f));
    if (!existsSync(tp)) {
      rows.push({ file: f, state: "missing" });
      continue;
    }
    const got = sha(tp);
    if (got === src) rows.push({ file: f, state: "in-sync" });
    else if (shaNormalised(tp) === shaNormalised(join(REF, f))) rows.push({ file: f, state: "install-rewrite" });
    else if (!installed) rows.push({ file: f, state: "unstamped-differs" });
    else if (got === installed[f]) rows.push({ file: f, state: "behind" });
    else if (installed[f] === src) rows.push({ file: f, state: "locally-modified" });
    else rows.push({ file: f, state: "diverged" });
  }
  const extra = readdirSync(dir)
    .filter((f) => (f.endsWith(".mjs") || f.endsWith(".mts")) && !files.includes(f))
    .map((f) => ({ file: f, state: "extra" }));
  return { manifest, rows: [...rows, ...extra] };
}

/** Skills drift only where they are copies. The fleet's are symlinks and cannot. */
function skillState(repoRoot) {
  const dir = join(repoRoot, ".claude", "skills");
  if (!existsSync(dir)) return { kind: "absent", drift: [] };
  const names = readdirSync(dir).filter((n) => existsSync(join(SKILLS_REF, n)));
  if (!names.length) return { kind: "none", drift: [] };
  const links = names.filter((n) => {
    try {
      return lstatSync(join(dir, n)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (links.length === names.length) return { kind: "symlink", drift: [] };
  const drift = names.filter((n) => {
    const a = join(dir, n, "SKILL.md");
    const b = join(SKILLS_REF, n, "SKILL.md");
    return existsSync(a) && existsSync(b) && sha(a) !== sha(b);
  });
  return { kind: links.length ? "mixed" : "copy", drift };
}

/** The reference to compare against: the source, or the source I was installed from. */
const REF = AS_INSTALL ?? HERE;
/**
 * The skills that sit beside the reference toolset. Two names, because the
 * source pack and an install lay out differently and both are legitimate:
 * `nodejs/skill/` in the source (matching the python and nextjs packs) and
 * `.claude/skills/` in a target repo, which is where Claude Code looks.
 * install.sh resolves the same pair; keep the two lists in step.
 */
const SKILLS_REF =
  [resolve(REF, "..", "skill"), resolve(REF, "..", "skills")].find((d) =>
    existsSync(join(d, "charpilot")),
  ) ?? resolve(REF, "..", "skills");
const files = sourceFiles();
/** An install checks only itself; the source checks every install it can find. */
const installs = AS_INSTALL ? [HERE] : findInstalls(ROOT);
const report = [];

for (const dir of installs) {
  const repoRoot = resolve(dir, "..", "..");
  const { manifest, rows } = classify(dir, files);
  const by = (s) => rows.filter((r) => r.state === s).map((r) => r.file);
  report.push({
    dir,
    repo: basename(repoRoot),
    sourceCommit: (manifest.sourceCommit ?? "").slice(0, 8),
    installedAt: manifest.installedAt,
    inSync: by("in-sync").length,
    behind: by("behind"),
    locallyModified: by("locally-modified"),
    diverged: by("diverged"),
    unstamped: by("unstamped-differs"),
    installRewrite: by("install-rewrite"),
    hasManifest: !manifest.unstamped,
    missing: by("missing"),
    extra: by("extra"),
    skills: skillState(repoRoot),
  });
}

const drift = (r) => r.behind.length + r.locallyModified.length + r.diverged.length + r.missing.length + r.unstamped.length + (r.skills.drift?.length ?? 0);

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ source: REF, self: HERE, mode: AS_INSTALL ? "install" : "source", files: files.length, drift: report.reduce((n, r) => n + drift(r), 0), installs: report }, null, 2)}\n`);
  process.exitCode = report.reduce((n, r) => n + drift(r), 0) > 0 ? 1 : 0;
} else {
  process.stdout.write(`\ntoolset integrity - ${files.length} file(s) ${AS_INSTALL ? `against ${REF}` : `in ${relative(ROOT, HERE) || HERE}`}\n`);
  process.stdout.write(AS_INSTALL ? `  checking THIS install only\n\n` : `  ${installs.length} install(s) under ${ROOT}\n\n`);
  for (const r of report) {
    const bad = drift(r);
    process.stdout.write(`  ${bad === 0 ? "✓" : "✗"} ${r.repo.padEnd(24)} ${String(r.inSync).padStart(2)}/${files.length} in sync   from ${r.sourceCommit}\n`);
    const line = (label, list) => list.length && process.stdout.write(`      ${label.padEnd(18)}${list.length}  ${list.slice(0, 6).join(" ")}${list.length > 6 ? ` +${list.length - 6}` : ""}\n`);
    if (!r.hasManifest) process.stdout.write(`      no INSTALLED.json  - cannot tell "behind" from "edited here"; reinstall to stamp it\n`);
    line("unstamped-differs", r.unstamped);
    line("behind", r.behind);
    line("locally-modified", r.locallyModified);
    line("diverged", r.diverged);
    line("missing", r.missing);
    line("extra", r.extra);
    if (r.installRewrite.length) process.stdout.write(`      install-rewrite   ${r.installRewrite.length}  (base-config import adapted by install.sh - expected, not drift)\n`);
    if (r.skills.kind === "copy" || r.skills.kind === "mixed") {
      process.stdout.write(`      skills            ${r.skills.kind}${r.skills.drift.length ? ` - ${r.skills.drift.length} drifted: ${r.skills.drift.join(" ")}` : " (in sync, but can drift)"}\n`);
    }
  }
}

let fixed = 0;
let refused = 0;
if (FIX) {
  for (const r of report) {
    // An unstamped difference is NOT resynced by default: with no manifest it is
    // indistinguishable from a local edit, and --fix must not discard one.
    const todo = [...r.behind, ...r.missing, ...r.diverged];
    const unstamped = r.unstamped;
    if (unstamped.length && !OVERWRITE_LOCAL) {
      refused += unstamped.length;
      process.stdout.write(`\n  ! ${r.repo}: ${unstamped.length} file(s) differ and there is no INSTALLED.json to say why - ${unstamped.slice(0, 6).join(" ")}\n`);
      process.stdout.write(`    Diff them first, then --overwrite-local to take the source version.\n`);
    }
    const local = r.locallyModified;
    if (local.length && !OVERWRITE_LOCAL) {
      refused += local.length;
      process.stdout.write(`\n  ! ${r.repo}: refusing ${local.length} locally-modified file(s) - ${local.join(" ")}\n`);
      process.stdout.write(`    These differ from BOTH the source and what was installed, so somebody edited this copy.\n`);
      process.stdout.write(`    Look before discarding: diff them against ${relative(ROOT, HERE) || HERE}, then re-run with --overwrite-local.\n`);
    }
    for (const f of [...todo, ...(OVERWRITE_LOCAL ? [...local, ...unstamped] : [])]) {
      copyFileSync(join(REF, f), join(r.dir, f));
      fixed += 1;
    }
    // Skill copies become symlinks, which is what makes the fleet's undriftable.
    if (r.skills.kind === "copy" || r.skills.kind === "mixed") {
      const dir = join(resolve(r.dir, "..", ".."), ".claude", "skills");
      for (const n of readdirSync(dir).filter((n) => existsSync(join(SKILLS_REF, n)))) {
        const p = join(dir, n);
        if (lstatSync(p).isSymbolicLink()) continue;
        rmSync(p, { recursive: true, force: true });
        symlinkSync(join(SKILLS_REF, n), p);
        fixed += 1;
      }
    }
    if (todo.length || (OVERWRITE_LOCAL && (local.length || unstamped.length)) || !r.hasManifest) {
      const mp2 = join(r.dir, "INSTALLED.json");
      const manifest = existsSync(mp2) ? JSON.parse(readFileSync(mp2, "utf8")) : { source: HERE };
      // Shas of what is ACTUALLY in the target, not of the source.
      //
      // Stamping source shas after refusing to copy some files made those files
      // read as "locally-modified" on the next run - the manifest claimed an
      // install that had not happened, which destroyed the very third leg that
      // tells "behind" from "edited here". A manifest must describe reality or
      // it is worse than no manifest.
      manifest.files = Object.fromEntries(files.filter((f) => existsSync(join(r.dir, f))).map((f) => [f, sha(join(r.dir, f))]));
      manifest.installedAt = new Date().toISOString();
      manifest.resyncedBy = "toolset-integrity.mjs";
      writeFileSync(join(r.dir, "INSTALLED.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  process.stdout.write(`\n  ${fixed} file(s) resynced${refused ? `, ${refused} refused as locally-modified` : ""}\n`);
}

const after = FIX ? installs.map((dir) => {
  const { manifest, rows } = classify(dir, files);
  const by = (st) => rows.filter((r) => r.state === st).map((r) => r.file);
  return {
    repo: basename(resolve(dir, "..", "..")),
    behind: by("behind"),
    locallyModified: by("locally-modified"),
    diverged: by("diverged"),
    missing: by("missing"),
    unstamped: by("unstamped-differs"),
    skills: skillState(resolve(dir, "..", "..")),
  };
}) : report;
// Re-measured, because the pre-fix figure printed after a --fix said 389 when
// 147 had just been resynced - a total that describes the state before the
// action it follows.
const total = after.reduce((n, r) => n + drift(r), 0);
const repos = after.filter((r) => drift(r) > 0).length;
// Guarded: --json wrote this summary after the JSON, so every consumer got
// "Extra data" and gate.mjs concluded the tool "did not return JSON" and
// PASSED. A machine-readable mode has to be machine-readable.
if (!JSON_OUT) {
  process.stdout.write(`\n${total === 0 ? "\u2713 every install matches the source" : `\u2717 ${total} file(s) still drifted across ${repos} install(s)`}${FIX ? " (re-measured after --fix)" : ""}\n`);
  if (!FIX && total > 0) process.stdout.write(`  resync with:  node ${relative(process.cwd(), join(HERE, "toolset-integrity.mjs"))} --fix\n\n`);
}
process.exitCode = total > 0 && !FIX ? 1 : 0;
