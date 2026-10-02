/**
 * preflight — what this machine can actually reach, and what it must never
 * call. Written down BEFORE anything records, because a failure against an
 * address this box cannot resolve is a harness failure, and recording it as
 * behaviour is the worst outcome available.
 *
 * This file also carries the runner the other five mechanical steps use. The
 * six of them do the same thing — spawn one charpilot tool, and read the answer
 * back off the disk rather than out of the tool's own report — and the runner
 * lives here, in the first step that needed it, rather than in six copies. Six
 * copies is not hypothetical in this toolset: eight copies of the 36 scripts
 * existed at once and baseline.mjs was one commit ahead in six of them, which is
 * why config.mjs stopped deriving the repo from where the tools sit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { OUT_DIR, SAFETY_MARKER, SELF_REPO_ROOT } from "../config.mjs";

export const NAME = "preflight";

/**
 * Where preflight.mjs writes, fixed at preflight.mjs:30. config.mjs exports the
 * other five steps' artifacts (BASELINE_JSON, SCAN_JSON, WORKLIST_JSON,
 * STAGING_REPORT) and not this one, so it is spelled out here against OUT_DIR
 * rather than re-derived from a string in two places.
 */
export const PREFLIGHT_JSON = resolve(OUT_DIR, "preflight.json");

/**
 * The tools, which live with the PIPELINE and not with the tree being measured.
 *
 * The walk hands each step `repo` — config.mjs's REPO_ROOT, i.e.
 * CHARPILOT_TARGET_ROOT when one is set. On every ordinary run that is the same
 * directory as SELF_REPO_ROOT. On a benchmark run against a foreign checkout it
 * is not, and the foreign checkout holds no tools and must never be written
 * into: OUT_DIR is derived from SELF_ROOT for exactly that reason, so the
 * scripts that fill OUT_DIR are resolved and run from there too.
 */
const PILOT_DIR = resolve(SELF_REPO_ROOT, ".claude", "charpilot");

/** Relative to the pipeline's own root, which is what the log lines quote. */
export const here = (path) => relative(SELF_REPO_ROOT, path) || path;

/**
 * Short enough for one log line, and still the part that says what broke.
 *
 * NOTHING HERE MAY END IN A COLON — D50. A status that ends in `:` is one that
 * was cut where its reason began, and four runs across three repos logged
 * `providervocab.mjs exited 1 — ✗ Invalid \`prisma.$queryRawUnsafe()\`
 * invocation:` twenty-seven times without ever saying what was invalid. The
 * tool that did it is fixed at source (providervocab.mjs `failureLine`), but the
 * rule belongs HERE as well, where the log line is actually made: this is the
 * one funnel every child tool's stderr passes through, and the next tool to
 * truncate itself at a header should not be able to put that line in the log
 * either. A trailing colon is a promise of a line that is not coming.
 *
 * WHAT THE 600 IS PROTECTING — D62, and it is not the terminal. This line is
 * carried in THREE places and the smallest of them is the one that sets the
 * number:
 *
 *   the run log       one jsonl event per line in `docker/runs/<stamp>/`. A
 *                     child tool's stderr is unbounded — a vitest report, a
 *                     stack, or `record.mjs`'s 24-symbol policy list — and one
 *                     event holding a megabyte makes the log unreadable in the
 *                     medium a person actually reads it in.
 *   the walk's refusal `workflow.mjs` quotes `did` back verbatim when a step
 *                     ran and is still unsatisfied.
 *   THE BRIEF         and this is the binding one. `steps/measure.mjs:item()`
 *                     puts this exact string into a `pending` question, which
 *                     `workflow.pendingJson` writes into
 *                     `worklist-decisions.json`. The brief's budget is 25,000
 *                     bytes and the headroom is TENS of bytes, not hundreds —
 *                     `handover.one-packet-one-file` prints the measurement on
 *                     every run and asserts it, which is where to read it. It
 *                     is deliberately not repeated here: this line has carried
 *                     "TEN bytes, median 24,990 B" since plan 17 corrected
 *                     plan 16's 80, and by 2026-09-20 the same harness on the
 *                     same fixture read 24,930 B and 70 bytes. The number
 *                     moves whenever a packet header does; the conclusion does
 *                     not. An unbounded tool tail in a question is a brief
 *                     that does not fit, and a brief that does not fit is a
 *                     round nobody can answer.
 *
 * SO IT IS TRUNCATED, AND D62 IS THAT IT WAS TRUNCATED MID-WORD. Run
 * `20260919T092410Z` logged `record: record.mjs exited 1 — …·   Thos…` — 631
 * characters ending in the first four letters of "Those", which is where the
 * sentence that would have said what the policy list MEANT began. The cut is
 * now taken at the last whitespace inside the budget, and any separator debris
 * (`·`) or colon left at that edge goes with it — a `…` after half a word reads
 * as a corrupted line, and a `…` after a whole one reads as what it is.
 *
 * A TOKEN LONGER THAN THE WHOLE BUDGET still gets a hard cut, because there is
 * no boundary to take and a line that vanished entirely would be worse than one
 * that ends mid-identifier. That is the one case where mid-word survives, and
 * it is the case where mid-word is the honest answer.
 */
// EXPORTED so the truncation can be asserted directly. It is the one funnel
// every child tool's stderr passes through and it now carries two rules (D50's
// colon and D62's boundary); a rule that can only be exercised by spawning a
// tool that prints 600 characters is a rule nobody re-checks.
export function tail(text, lines = 4, chars = 600) {
  const kept = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join(" · ")
    .replace(/:$/, "");
  if (kept.length <= chars) return kept;
  // One character past the budget, so a cut that lands exactly ON a space keeps
  // the whole word before it rather than treating that word as split.
  const window = kept.slice(0, chars + 1);
  // Greedy to the LAST whitespace in the window; `[0].length` is the index just
  // past it. No whitespace at all means one unbroken token, and the hard cut is
  // what is left.
  const boundary = /^[\s\S]*\s/.exec(window)?.[0].length ?? 0;
  const cut = boundary > 0 ? window.slice(0, boundary) : kept.slice(0, chars);
  // The same rule as the `:` above, applied at the new edge: a truncation that
  // stops on a separator or a colon is a promise of a line that is not coming.
  return `${cut.replace(/[\s·:]+$/u, "")}…`;
}

/**
 * Spawn one charpilot tool, and report in one line what came of it.
 *
 * `{ ok, line, status }`, never a throw. A tool that exits non-zero has not surprised
 * anybody — a red suite, an unresolved environment and a stale arm id are the
 * three things these tools are FOR — and raising it as an exception turns an
 * expected answer into a stack trace that names a spawn rather than the step
 * that stopped. So it comes back as a `did` line, which the walk prints and
 * then quotes verbatim in its reason when the step answers `satisfied` false:
 * the tool's own stderr ends up in the refusal, next to the name of the step.
 *
 * stdout is read as a fallback because armids.mjs exits 1 with its entire
 * diagnosis on stdout: dropping it would leave "exited 1" and nothing else.
 *
 * `status` IS THE EXIT CODE, AND IT IS NOT THE SAME FACT AS `ok`. Two of these
 * tools reserve a particular non-zero code for a particular recoverable state —
 * worklist.mjs exits 3 for "stage 3 is past its budget with proposals
 * unrecorded", which is a state `record` clears — and a step that had to
 * recognise it could only read `line`, which is the tool's stderr tail and
 * therefore prose. A step routing on prose breaks the moment the prose is
 * reworded. So the number is carried alongside it: 0 when the tool ran, the
 * exit code when it did not, and null when it was killed by a signal (where
 * there is no code, and `err.status` is null for that reason).
 *
 * `nodeArgs` go to node, before the script: a heap size, never a tool flag.
 *
 * OUT OF MEMORY IS SAID AS SUCH (D72), with `oom: true`. V8 dies of it by
 * SIGABRT, and the last lines of its stderr are a native stack trace, so the
 * tail read "killed by SIGABRT — 12: 0x… [node]" and named neither the heap
 * nor the limit. The line now leads with both and quotes V8's FATAL line.
 */
export function runTool(tool, args = [], { nodeArgs = [] } = {}) {
  const script = resolve(PILOT_DIR, `${tool}.mjs`);
  if (!existsSync(script)) {
    // Not a `did` line: nothing was done, and claiming otherwise would put a
    // sentence in the walk's reason that reads like work. Said on stderr, where
    // the walk's own refusals are printed.
    process.stderr.write(
      `✗ ${script} is not installed, so the ${tool} step could not run.\n` +
        `  Install the pipeline into this repo first (bash tools/install.sh <repo>).\n`
    );
    return { ok: false, line: null, status: null };
  }
  try {
    execFileSync(process.execPath, [...nodeArgs, script, ...args], {
      // config.mjs resolves the repo from the CWD and fixes every path at
      // import, so a tool spawned from anywhere else writes its artifacts into
      // a directory nothing else reads.
      cwd: SELF_REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // scan.mjs prints a per-file table over a whole service; the default 1 MB
      // truncates it into an ENOBUFS that reads as a tool failure.
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, line: `ran ${tool}.mjs${args.length ? ` ${args.join(" ")}` : ""}`, status: 0 };
  } catch (err) {
    let why = tail(`${err.stderr ?? ""}`) || tail(`${err.stdout ?? ""}`) || err.message;
    // FIX PLAN 1, RULE 2: a safety refusal is never tailed away. record.mjs
    // prints its guard's SAFETY_MARKER line and then its policy notes, so
    // the last four lines hid it and the walk read a production-database
    // refusal as an ordinary tool failure to bank and deliver. The refusal
    // line leads the reason whenever the tool printed one.
    const refusal = `${err.stderr ?? ""}\n${err.stdout ?? ""}`
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes(SAFETY_MARKER));
    if (refusal && !why.includes(refusal)) why = `${refusal} · ${why}`;
    const how = err.status === null || err.status === undefined ? `killed by ${err.signal ?? "an unknown signal"}` : `exited ${err.status}`;
    const fatal = `${err.stderr ?? ""}`.split("\n").find((l) => l.includes("JavaScript heap out of memory"));
    if (fatal) {
      const heap = nodeArgs.find((a) => a.startsWith("--max-old-space-size=")) ?? "node's default heap limit";
      return { ok: false, line: `${tool}.mjs ran out of memory at ${heap} (${how}) — ${fatal.trim()}`, status: err.status ?? null, oom: true };
    }
    return { ok: false, line: `${tool}.mjs ${how} — ${why}`, status: err.status ?? null };
  }
}

/**
 * Run tools in order, stopping at the first one that fails.
 *
 * Carrying on would run the second tool against the first one's absent output,
 * and its failure would then be the one reported — one stage downstream of its
 * cause, which is the shape install.sh's own prerequisites block exists to
 * avoid.
 */
export function runTools(tools, wrote = null) {
  const did = [];
  let ok = true;
  // A tool is its name, or [name, args] for one that takes flags (D86: `armids --fix`).
  for (const tool of tools) {
    const outcome = Array.isArray(tool) ? runTool(tool[0], tool[1] ?? []) : runTool(tool);
    if (outcome.line) did.push(outcome.line);
    if (!outcome.ok) {
      ok = false;
      break;
    }
  }
  // Named from the disk rather than from the tool's own claim to have written
  // it, which is the same rule `satisfied` follows one function down.
  if (ok && wrote && existsSync(wrote)) did.push(`wrote ${here(wrote)}`);
  return { did, pending: [], metrics: {} };
}

/** Nothing runs before preflight, so there is nothing for it to be blocked on. */
export function precondition(_repo) {
  return null;
}

/** THE DISK, not a state file: the artifact is either there or the step is not done. */
export function satisfied(_repo) {
  if (!existsSync(PREFLIGHT_JSON)) return false;

  // PREFLIGHT RUNS FIRST, AND HALF ITS PROBE LIST DOES NOT EXIST YET.
  //
  // ORDER puts `preflight` ahead of `stagingenv` and `baseline`, deliberately:
  // nothing should run before the environment has been checked. But preflight's
  // probe list is `enforcedAllowlist()`, and the derived half of that list is
  // read out of out/baseline.json and out/staging-env.json - which stage 1 has
  // not written on a first walk. That is where maps.googleapis.com and
  // places.googleapis.com live, the two hosts run 20260916T223906Z actually
  // dialled, so the first artifact reports them `not preflighted`.
  //
  // THE OBVIOUS CONDITION IS WRONG AND IT KILLED RUN 20260917T070417Z IN ROUND 1.
  // "Not satisfied while a source was missing" is false on the FIRST walk for
  // ever: preflight runs, writes its artifact, and the sources it wants are
  // written by steps that come after it - so the walk exits 1 with `ran ... and
  // is still not satisfied, and it asked no question`, which is the one shape
  // workflow.mjs cannot route to anybody.
  //
  // The re-probe is worth asking for only when the artifact is STALE against a
  // world that has since changed: the source was absent when preflight wrote,
  // and it is on disk now. On a first walk nothing has changed yet, so this
  // answers true and the walk moves on; on the next round stage 1 has written
  // them and the probe runs again against the list the recorder enforces. An
  // older artifact with no `probeList` block predates this and is left alone.
  try {
    const doc = JSON.parse(readFileSync(PREFLIGHT_JSON, "utf8"));
    const sources = doc?.probeList?.sources;
    if (!sources || typeof sources !== "object") return true;
    const nowOnDisk = (name) => existsSync(join(OUT_DIR, name.replace(/^out\//, "")));
    return !Object.entries(sources).some(([name, present]) => present === false && nowOnDisk(name));
  } catch {
    // Unreadable is not "done" - runTools will overwrite it.
    return false;
  }
}

export function run(_repo) {
  return runTools(["preflight"], PREFLIGHT_JSON);
}
