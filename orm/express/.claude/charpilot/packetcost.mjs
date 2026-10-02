#!/usr/bin/env node
/**
 * packetcost — what ONE packet costs ONE worker, measured, end to end.
 *
 *   node tools/packetcost.mjs --repo <path>                        # plan only: select, price, dispatch nothing
 *   node tools/packetcost.mjs --packets <dir> --plan               # brief census of any packet directory
 *   node tools/packetcost.mjs --repo <path> --run --only packet-41
 *   node tools/packetcost.mjs --repo <path> --run --limit 2 --spread
 *   node tools/packetcost.mjs --repo <path> --run --only packet-41 --keep
 *   node tools/packetcost.mjs --repo <path> --run --only packet-06 --packet-overlay <dir> --arm pregen
 *   node tools/packetcost.mjs --rows                               # every row this tool has ever recorded
 *
 * WHY THIS EXISTS. Every cost figure this project quotes about a packet is a
 * DIVISION, not a measurement. `prompts/worklist-prompt-derive.md` says so in
 * its own words:
 *
 * QUOTES nodejs/prompts/worklist-prompt-derive.md: "Both are divisions of a round total, not measured per-packet costs: nothing has ever timed one packet"
 *
 * — and the figure being divided is four minutes, not the nine this docblock
 * used to quote:
 *
 * QUOTES nodejs/prompts/worklist-prompt-derive.md: "A packet costs a worker about"
 *
 * (the prompt's own number, "**4 minutes of BUSY time**", is 135.5
 * worker-minutes over 33 packets in run `20260919T092410Z` round 1; the
 * markdown emphasis is why the marker above stops where it does). The nine
 * came from an earlier round total over a smaller packet count and has been
 * wrong here for as long as this tool has existed.
 *
 * `packetlog.mjs`'s `packetDistribution` says the same thing from the other
 * side, in a field called `missing`:
 *
 * QUOTES nodejs/tools/packetlog.mjs: "no packet DEALT row carries seconds, child turns or cache-read tokens"
 *
 * Round sizing, the straggler trigger, `handover.mjs`'s deal and every budget
 * printed at a worker rest on that division. This tool is where the three
 * absent fields come from. It does not edit `packetlog.mjs` and does not write
 * into its log: that file is the ROUND's account and this is a bench, and a
 * bench row in a round's log is a measurement claiming a provenance it does not
 * have. It writes its own rows, in the same append-only jsonl shape, under
 * `out/packetcost/`.
 *
 * WHAT IT MEASURES, per packet, which is the set that turns "first-pass yield"
 * from an inference into a measurement:
 *
 *     packet id, item count, brief bytes, source bytes, wall seconds, turns,
 *     billed USD, cache-read tokens, files written, proposal rows landed,
 *     sides claimed, sides that VALIDATED, and every validation fault verbatim.
 *
 * "Sides that validated" is the one that costs something to get right, and it
 * is why this tool runs the real `propose.mjs` and the real `validate.mjs`
 * rather than counting what the agent said it did. A row `validate.mjs` refuses
 * is QUARANTINED — it stays on disk and stops speaking for its side — and
 * `ledger.mjs` counts a side accounted from `reaches` alone, so a claimed side
 * that did not validate is not a visible extra row, it is invisible coverage.
 * The quarantine arithmetic is `steps/derive.mjs`'s and is IMPORTED from it
 * (`validateFaults`, `flatProposals`, `quarantineRows`, `proposedSides`), never
 * copied: a second opinion about which rows a fault condemns is a second first-
 * pass-yield number, and the two would disagree on exactly the runs that matter.
 *
 * WHAT IT IS A SIBLING OF, AND WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   `fleetprobe`   one or two packets per SHAPE, per repo, to find where the
 *                  fleet breaks. It clones over the network and runs two npm
 *                  installs per repo before an agent sees anything, because it
 *                  has to reach stages past the walk. Its `agentOutcome` — the
 *                  reading of `claude --print --output-format stream-json` — is
 *                  imported here rather than rewritten.
 *   `packetcost`   ONE packet, against artifacts ALREADY ON DISK. No clone, no
 *                  install, no container, no walk. Six repos under
 *                  `qode-knowledge/repos/<svc>/.claude/charpilot/out/` carry a
 *                  finished `scan.json`, `worklist.json` and, for the ones that
 *                  got that far, a whole dealt round in
 *                  `out/worklist-decisions.packets/`. The expensive half of
 *                  fleetprobe is the half this does not need: the question here
 *                  is not "does this repo run" but "what does one brief cost".
 *
 * IT NEVER WRITES INTO THE TARGET REPO. The repo is read-only evidence — some
 * of these checkouts are the only copy of a run's artifacts — so each packet
 * gets a SANDBOX: every top-level entry of the repo symlinked (src, test,
 * node_modules, package.json, CLAUDE.md), `.claude/charpilot` COPIED without
 * its `out/` and `proposals/`, `out/` rebuilt as symlinks to the real
 * artifacts, and `proposals/` and `charpilot-answers/` created EMPTY. The copy
 * and not a symlink for the pack itself is not tidiness: node resolves symlinks
 * in ESM, so `import.meta.url` inside a symlinked `config.mjs` reports the REAL
 * path and `PILOT_DIR`, `OUT_DIR` and `PROPOSALS_DIR` would all resolve back
 * into the live repo — the tool would validate against, and write into, the
 * checkout it was supposed to leave alone. A sandbox measured 2.5 MB on
 * notification-ms, against the 339 MB its `node_modules` alone would have cost
 * to copy. An empty `proposals/` is also what makes the yield number mean anything:
 * `validate.mjs` judges the whole directory, and notification-ms's real one
 * already holds 30 proposal files from the run these packets came out of.
 *
 * DISPATCH COSTS REAL MONEY, SO IT IS NEVER THE DEFAULT. `--plan` is what you
 * get when you do not say `--run`, and it is the whole selection and the whole
 * price with nothing spawned. `--run` dispatches ONE packet unless `--limit`
 * says otherwise, and a `--limit` above `DISPATCH_CEILING` is refused by name
 * rather than clamped — fleetprobe's own discipline, for fleetprobe's own
 * reason: a tool that quietly does less than it was asked produces a number
 * nobody can reconcile with the command that produced it.
 *
 * THE HYPOTHESIS IT WAS BUILT TO TEST, stated so a run that refutes it is still
 * a result: that packet cost is a function of BRIEF BYTES rather than of side
 * count or source size, and that tracy-worker's 43% first-pass yield against
 * location-ms's 100% is brief size and not repo difficulty. The row carries
 * `briefBytes`, `sourceBytes` and `sidesDealt` side by side for exactly that
 * reason, and `--rows` prints them together. Nothing here decides the answer;
 * `secondsPerBriefKB` is reported and acted on nowhere, for the reason
 * `packetlog.mjs` gives about its own p95: a trigger built on four rows is a
 * constant wearing a measurement's name.
 *
 * THE BRIEF CENSUS IS FREE AND NEEDS NO REPO. `--packets <dir> --plan` reads
 * any directory of packet files — a fixture, a container's scratch copy — and
 * reports bytes, items, sides and, per packet, how many of those bytes are
 * BYTE-IDENTICAL REPETITION across its own items. That last number is the one
 * worth the census, and it is counted PER `context` KEY rather than per item,
 * because the repetition is not uniform: on
 * `tests/fixtures/packet-tracy-worker-02.json` — 623,306 bytes, 37 items —
 * 100,906 bytes are copies, of which 36,828 are four blocks byte-identical in
 * all 37 items (`stage4`, `vocabulary`, `packet`, `limits`), 40,261 are
 * `context.owner` repeating in five groups, and 23,817 are `context.boundaries`
 * repeating in thirty. `packet.shared` already lifts blocks out of items; this
 * is what it did not catch, and the split says which of it a wider `shared`
 * could take and which of it wants a different fix.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// THE READING OF `claude --print --output-format stream-json`, imported from the
// tool that owns it. `agentOutcome` already knows that the LAST `result` record
// is the only one carrying totals, that an unparseable line is the CLI's own
// diagnostic and not a failure, and that zero billable cost with an error is
// `no-work` rather than the repo's fault. A second reader here would disagree
// with fleetprobe about what a dead gateway looks like.
import { agentOutcome, renderPrompt } from "./fleetprobe.mjs";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_SELF = resolve(PILOT_DIR, "..", "..");
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

/** Where a repo keeps a dealt round, when `handover` got that far. */
export const PACKETS_SUBDIR = join(".claude", "charpilot", "out", "worklist-decisions.packets");
/** This tool's own log. Not `packetlog.mjs`'s — see the docblock. */
export const ROWS_DIR = resolve(OUT_DIR, "packetcost");

/**
 * The most packets one `--run` may dispatch, and why a ceiling rather than a
 * default. A packet is an agent turn against a 30-KB-to-600-KB brief; four of
 * them is a measurement and forty is a run nobody sanctioned. fleetprobe's own
 * `notification-ms` figure — $27.21 for 16 sides — is the arithmetic this
 * protects against doing by accident.
 */
export const DISPATCH_CEILING = 4;

/** The bound on one worker, in minutes. `handover.mjs` gives a container worker 30. */
const TURN_MINUTES = Number(arg("--turn-minutes", "30"));
/** `CHARACTERIZE_MAX_TURNS` in `char/agent.py`, taken rather than invented. */
const MAX_TURNS = Math.max(1, Number(arg("--max-turns", process.env.CHARACTERIZE_MAX_TURNS ?? "40")));
const SETTINGS = resolve(arg("--settings", join(REPO_ROOT_SELF, "docker", "settings.json")));
const PROMPTS = resolve(arg("--prompts", join(PILOT_DIR, "..", "prompts")));

const log = (s) => process.stdout.write(`${s}\n`);

/**
 * THE QUARANTINE ARITHMETIC, LOADED LATE AND ON PURPOSE.
 *
 * `steps/derive.mjs` owns `validateFaults`, `flatProposals`, `quarantineRows`
 * and `proposedSides`, and they are the reason this tool can say "sides that
 * validated" rather than "sides the agent claimed". They cannot be STATIC
 * imports here: derive imports `config.mjs`, which resolves one repo from the
 * CWD and REFUSES a directory that is not a package root — and `nodejs/` is not
 * one, because it has no `src/`. A static import therefore kills this tool
 * before its first line, which is exactly what `node tools/fleetshapes.mjs`
 * does from that directory.
 *
 * So they are imported after a sandbox exists, with `CHARPILOT_SELF_ROOT`
 * pointed at it — a real package root, built from the target repo's own
 * `package.json` and `src/`. The module-scope constants config bakes from that
 * first sandbox are never read: every function used here takes the directory it
 * works on as an argument. An operator who has already set the variable keeps
 * their value.
 */
let JOIN = null;
export async function loadJoin(packageRoot) {
  if (JOIN) return JOIN;
  process.env.CHARPILOT_SELF_ROOT = process.env.CHARPILOT_SELF_ROOT || packageRoot;
  const derive = await import("./steps/derive.mjs");
  JOIN = {
    validateFaults: derive.validateFaults,
    flatProposals: derive.flatProposals,
    quarantineRows: derive.quarantineRows,
    proposedSides: derive.proposedSides,
    declaredSides: derive.declaredSides,
    // The ONE conversion between the `armId\0side` key the join is built on and
    // the `armId [side]` id the packet roster is written in. Importing it is
    // what makes `rosterClosed` comparable with the roster at all: a local
    // reimplementation of this two-line function was the first version's bug,
    // and it reported 0 of 1 closed for a packet whose only side had validated.
    answeredSideIds: derive.answeredSideIds,
  };
  return JOIN;
}

/* ------------------------------------------------------------ the brief, measured */

/**
 * What one packet FILE is, in the numbers the hypothesis is about.
 *
 * `briefBytes` is the file on disk and nothing else — not a re-serialisation,
 * because the worker is handed those bytes and a reformat would measure this
 * tool's `JSON.stringify` instead of the brief. `sourceBytes` is the file the
 * reading plan names FIRST, which is where the function is declared; it is the
 * same definition `packetlog.mjs` uses for `contextBytes`, so the two logs can
 * be read against each other.
 *
 * `repeatedBytes` is the measurement that motivated the census: how many of the
 * brief's bytes are BYTE-IDENTICAL repetition of one item's `context` block in
 * another's. It is counted in the file's own formatting, so it is a share of
 * `briefBytes` and not of some canonical form.
 */
export function packetFacts(path, { root = null } = {}) {
  const raw = readFileSync(path, "utf8");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { name: basename(path), path, briefBytes: Buffer.byteLength(raw), unreadable: String(e?.message ?? e) };
  }
  const packet = doc.packet ?? {};
  const items = doc.pending ?? [];
  const source = packet.file ?? null;
  let sourceBytes = null;
  if (root && source) {
    try {
      sourceBytes = statSync(resolve(root, source)).size;
    } catch {
      // A source the checkout no longer holds is a null, never a zero: zero is a
      // file that exists and is empty, and the two want opposite conclusions.
    }
  }
  return {
    name: basename(path),
    path,
    packet: packet.id ?? null,
    functionId: packet.functionId ?? null,
    file: source,
    briefBytes: Buffer.byteLength(raw),
    items: items.length,
    sidesDealt: (packet.sides ?? []).length,
    kinds: [...new Set(items.map((i) => i.kind).filter(Boolean))].sort(),
    sharedBytes: packet.shared === undefined ? null : Buffer.byteLength(JSON.stringify(packet.shared, null, 2)),
    repeatedBytes: repetitionBytes(doc),
    sourceBytes,
    unreadable: null,
  };
}

/**
 * How many bytes of a packet's items are byte-identical repetition of each other.
 *
 * Per `context` key, because that is the granularity `packet.shared` already
 * lifts at: a key whose value is the same string in N items costs N-1 copies of
 * it. Counted in `indent: 2`, which is the formatting the packet writer uses and
 * the formatting the file on disk is in.
 *
 * It is a LOWER BOUND on what a shared block could remove and is not a proposal
 * to remove it — a key identical across the items of one packet may still differ
 * between packets, and this says nothing about that.
 */
export function repetitionBytes(doc) {
  const items = (doc?.pending ?? []).filter((i) => i && typeof i.context === "object" && i.context);
  if (items.length < 2) return 0;
  const keys = new Set();
  for (const i of items) for (const k of Object.keys(i.context)) keys.add(k);
  let total = 0;
  for (const k of keys) {
    const counts = new Map();
    for (const i of items) {
      if (!(k in i.context)) continue;
      const text = JSON.stringify(i.context[k], null, 2);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    for (const [text, n] of counts) if (n > 1) total += Buffer.byteLength(text) * (n - 1);
  }
  return total;
}

/** Every packet file in a directory, in name order, with its facts. */
export function censusPackets(dir, { root = null } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => packetFacts(join(dir, f), { root }));
}

/**
 * One census, summed, in the shape the measurement in the brief was stated in.
 *
 * `median` is the LOWER of the two middle values on an even count, and it is
 * named `median` rather than `p50` because `packetlog.mjs`'s `percentile` uses
 * nearest rank and returns the upper one. The two differ by one packet on any
 * even census and that difference has already been quoted as a fact, so this
 * reports both rather than picking a side.
 */
export function censusTotals(facts) {
  const sizes = facts.map((f) => f.briefBytes).sort((a, b) => a - b);
  const mid = (xs) => {
    if (!xs.length) return null;
    const i = xs.length / 2;
    return xs.length % 2 ? xs[(xs.length - 1) / 2] : { lower: xs[i - 1], upper: xs[i], mean: Math.round((xs[i - 1] + xs[i]) / 2) };
  };
  const items = facts.reduce((n, f) => n + (f.items ?? 0), 0);
  const bytes = sizes.reduce((n, b) => n + b, 0);
  return {
    packets: facts.length,
    items,
    sides: facts.reduce((n, f) => n + (f.sidesDealt ?? 0), 0),
    totalBytes: bytes,
    medianBytes: mid(sizes),
    maxBytes: sizes.at(-1) ?? null,
    bytesPerItem: items ? Math.floor(bytes / items) : null,
    repeatedBytes: facts.reduce((n, f) => n + (f.repeatedBytes ?? 0), 0),
  };
}

/* ---------------------------------------------------------------- selection */

/**
 * Which packets this invocation is about, and a REFUSAL when the answer would
 * be "more than you asked for".
 *
 * Three rules, and the third is the one that costs money if it is wrong:
 *
 *   `--only a,b`  names files exactly. A name that is not there is a refusal,
 *                 never a silent skip: a typo that selects nothing looks
 *                 identical to a repo with no packets.
 *   `--spread`    takes the SMALLEST and the LARGEST brief, which is the pair
 *                 the brief-size hypothesis is actually about. On its own it
 *                 implies `--limit 2`.
 *   `--limit n`   default 1. Over `DISPATCH_CEILING` it refuses by name rather
 *                 than clamping, so the command and the row always agree.
 *
 * Packets with no source file — `submission` items, which are last round's
 * refusals re-asked — are excluded from an unnamed selection and included when
 * named, because they measure a different thing (a fault to fix, not a function
 * to read) and would otherwise be what a `--limit 1` picked on notification-ms.
 */
export function chooseSelection(facts, { only = null, limit = 1, spread = false } = {}) {
  const usable = facts.filter((f) => !f.unreadable);
  if (only && only.length) {
    const byName = new Map(usable.map((f) => [f.name, f]));
    const alsoStem = new Map(usable.map((f) => [f.name.replace(/\.json$/, ""), f]));
    const chosen = [];
    for (const want of only) {
      const hit = byName.get(want) ?? alsoStem.get(want.replace(/\.json$/, ""));
      if (!hit) {
        return { chosen: [], refusal: `--only names ${JSON.stringify(want)}, which is not a packet in this directory. It holds ${usable.length}: ${usable.map((f) => f.name).join(", ")}` };
      }
      if (!chosen.includes(hit)) chosen.push(hit);
    }
    // THE CEILING APPLIES TO `--only` TOO. Naming the packets is being explicit
    // about WHICH, never about HOW MANY, and a twenty-name `--only` is the same
    // bill as `--limit 20`.
    if (chosen.length > DISPATCH_CEILING) {
      return { chosen: [], refusal: `--only names ${chosen.length} packets, above this tool's ceiling of ${DISPATCH_CEILING}. Naming them is being explicit about which, not about how many; run them ${DISPATCH_CEILING} at a time.` };
    }
    return { chosen, refusal: null, why: `--only: ${chosen.map((c) => c.name).join(", ")}` };
  }
  const readable = usable.filter((f) => f.file);
  if (!readable.length) {
    return { chosen: [], refusal: `every packet here is a re-asked submission with no source file of its own. Name one with --only if that is what you meant to measure.` };
  }
  const bySize = [...readable].sort((a, b) => a.briefBytes - b.briefBytes);
  if (spread) {
    const chosen = bySize.length === 1 ? [bySize[0]] : [bySize[0], bySize.at(-1)];
    return { chosen, refusal: null, why: `--spread: the smallest brief (${chosen[0].briefBytes} B) and the largest (${chosen.at(-1).briefBytes} B)` };
  }
  const want = Math.max(1, Math.trunc(limit));
  if (want > DISPATCH_CEILING) {
    return { chosen: [], refusal: `--limit ${want} is above this tool's ceiling of ${DISPATCH_CEILING}. One packet is one agent turn against a whole brief; fleetprobe measured $27.21 for one repo's 16 sides. Raise the ceiling in the source and say why, or run it ${DISPATCH_CEILING} at a time.` };
  }
  // Largest first, which is `handover.mjs`'s own launch order: the packet most
  // likely to be the round's straggler is the one worth timing first.
  const chosen = [...readable].sort((a, b) => b.briefBytes - a.briefBytes).slice(0, want);
  return { chosen, refusal: null, why: `--limit ${want}, largest brief first` };
}

/**
 * Whether anything is spawned, said out loud before anything is.
 *
 * A separate function from `chooseSelection` because the two answer different
 * questions and only one of them spends money. `--plan` and the absence of
 * `--run` are the same state on purpose: a tool whose default is to dispatch is
 * one wrong flag away from a bill.
 */
export function dispatchGate({ run = false, chosen = [], turnMinutes = TURN_MINUTES } = {}) {
  if (!run) {
    return { dispatch: false, why: "no --run: this is a plan. Nothing is spawned, nothing is billed.", worstCaseMinutes: chosen.length * turnMinutes };
  }
  if (!chosen.length) return { dispatch: false, why: "nothing selected", worstCaseMinutes: 0 };
  return {
    dispatch: true,
    why: `--run: ${chosen.length} packet(s), one agent turn each, bounded at ${turnMinutes} min`,
    worstCaseMinutes: chosen.length * turnMinutes,
  };
}

/* ------------------------------------------------------------- the sandbox */

/** Entries of the target repo this tool never links, and why each one. */
const NEVER_LINK = new Set([
  ".claude", // rebuilt below: the pack is COPIED, `out/` is relinked, proposals start empty
  ".git", // a worker with a git dir is a worker that can commit into the evidence
  "charpilot-answers", // the previous round's answers would be counted as this one's
  "coverage-charpilot", // stage 6's output; nothing here reads it and it is large
]);

/**
 * What a sandbox for one packet is made of, as data, so a test can assert that
 * nothing in it writes into the repo.
 *
 * Returns `{ links, copy, relink, create }`. `links` are symlinks into the
 * target, `copy` is the pack (see the docblock: ESM resolves symlinks, so a
 * symlinked `config.mjs` would resolve `PROPOSALS_DIR` back into the live
 * repo), `relink` is every artifact in the real `out/`, and `create` is the two
 * directories that must start EMPTY for the yield number to mean anything.
 */
export function sandboxPlan(repo, dest) {
  const links = readdirSync(repo)
    .filter((e) => !NEVER_LINK.has(e))
    .sort()
    .map((e) => ({ from: join(repo, e), to: join(dest, e) }));
  const pack = join(repo, ".claude", "charpilot");
  const copy = existsSync(pack)
    ? readdirSync(pack)
        .filter((e) => e !== "out" && e !== "proposals")
        .sort()
        .map((e) => ({ from: join(pack, e), to: join(dest, ".claude", "charpilot", e) }))
    : [];
  const skills = join(repo, ".claude", "skills");
  if (existsSync(skills)) links.push({ from: skills, to: join(dest, ".claude", "skills") });
  const out = join(pack, "out");
  const relink = existsSync(out)
    ? readdirSync(out)
        .sort()
        .map((e) => ({ from: join(out, e), to: join(dest, ".claude", "charpilot", "out", e) }))
    : [];
  return {
    links,
    copy,
    relink,
    create: [join(dest, ".claude", "charpilot", "proposals"), join(dest, "charpilot-answers")],
  };
}

/**
 * SWAP ONE PACKET FILE IN THE SANDBOX FOR A LOCAL ONE, WHICH IS HOW A SECOND
 * ARM IS MEASURED AT ALL.
 *
 * `out/worklist-decisions.packets` arrives in the sandbox as a SYMLINK to the
 * real directory, and `measureOne` always points the worker at the sandbox
 * path — so `--packets <dir>` can census another directory but cannot change
 * what the worker reads. An overlay replaces that one symlink with a real
 * directory: every packet relinked as it was, and the named ones copied from
 * the overlay instead.
 *
 * It exists for plan 19's D66 experiment — brief as-is against brief with a
 * pre-filled candidate, same packet, same prompt, one variable — and it is
 * inert unless `--packet-overlay` is given. Nothing is written into the target
 * either way: the overlay is read, the sandbox is written.
 *
 * Returns the names it replaced, so a row can say which arm it is and a
 * measurement is never silently the control.
 */
export function applyOverlay(sandbox, overlayDir) {
  const link = join(sandbox, PACKETS_SUBDIR);
  if (!overlayDir || !existsSync(overlayDir)) return [];
  const real = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : link;
  const swapped = [];
  rmSync(link, { recursive: true, force: true });
  mkdirSync(link, { recursive: true });
  for (const name of readdirSync(real).sort()) {
    const over = join(overlayDir, name);
    if (existsSync(over)) {
      cpSync(over, join(link, name));
      swapped.push(name);
    } else {
      symlinkSync(join(real, name), join(link, name), "file");
    }
  }
  return swapped;
}

/**
 * A destination that is inside the target, or the other way round, is refused
 * before anything is deleted.
 *
 * `buildSandbox` opens with an `rmSync(dest, { recursive: true, force: true })`
 * so a second run is not a merge of the first. A `--work` that landed inside
 * the checkout would make that line delete a repo whose artifacts are, for
 * three of these six services, the only copy anybody has.
 */
export function refuseOverlap(repo, dest) {
  const a = resolve(repo);
  const b = resolve(dest);
  if (b === a || b.startsWith(`${a}/`)) return `--work would put the sandbox inside ${a}, and building one starts by deleting it. Point --work somewhere else.`;
  if (a.startsWith(`${b}/`)) return `--work is a parent of ${a}, and building a sandbox starts by deleting that directory. Point --work somewhere else.`;
  return null;
}

function buildSandbox(repo, dest) {
  const no = refuseOverlap(repo, dest);
  if (no) throw new Error(no);
  rmSync(dest, { recursive: true, force: true });
  const plan = sandboxPlan(repo, dest);
  mkdirSync(join(dest, ".claude", "charpilot", "out"), { recursive: true });
  for (const c of plan.create) mkdirSync(c, { recursive: true });
  for (const { from, to } of plan.copy) cpSync(from, to, { recursive: true, dereference: true });
  for (const { from, to } of [...plan.links, ...plan.relink]) {
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to, lstatSync(from).isDirectory() ? "dir" : "file");
  }
  return plan;
}

/* -------------------------------------------------------------- the prompt */

/**
 * The prompt one worker gets, and an honest account of which half is verbatim.
 *
 * VERBATIM: the whole of `prompts/worklist-prompt-derive.md`, rendered through
 * `fleetprobe.renderPrompt`, which applies `char/prompts.py`'s four
 * substitutions. That file is the standing instruction set for this stage —
 * what a submission is, what may not be written, the note cache, the rule about
 * expected values — and it is what a container worker is working under, because
 * the parent turn is working under it when it hands the packet on.
 *
 * RECONSTRUCTED: the envelope, four lines of ADDRESSING. There is no worker
 * template on disk to copy: in a container the parent composes it when it
 * spawns the worker, so nothing here can be byte-exact and pretending otherwise
 * would be the paraphrase this tool exists not to be. Every sentence in it is
 * lifted from the two places that already say it — the derive prompt's "Hand a
 * worker the one packet file and it has the whole job" and "Name a file after
 * the packet it answers" — so the envelope adds an address and no judgement.
 * The rendered bytes are written beside the row, so a reader can check.
 */
export function workerPrompt({ body, template, target, skill, packetFile, answersDir, packetName }) {
  const envelope = [
    "You are ONE WORKER in a stage-3 derive round, and your whole job is the one",
    "packet file below. It carries every item you answer and names nothing outside",
    "itself, so you need no index, no second packet and no script.",
    "",
    `- your packet: \`${packetFile}\``,
    `- your answers: \`${answersDir}/\``,
    `- name your submission after the packet it answers: \`${packetName}\``,
    "",
    "Read the packet file. Answer every item in it by writing into the answers",
    "directory above. Then stop, and say which sides you answered and which you",
    "left, with the reason. Do not fan out: you are the worker.",
    "",
    "The standing instructions for this stage follow, unchanged.",
    "",
    "---",
    "",
  ].join("\n");
  return envelope + renderPrompt({ template, body, target, skill });
}

/** The skill name out of the pack's own frontmatter, so the prompt names one that exists. */
export function skillName(pilotDir = PILOT_DIR) {
  const md = join(pilotDir, "..", "skill", "charpilot", "SKILL.md");
  if (!existsSync(md)) throw new Error(`the nodejs pack has no SKILL.md at ${md}, so the prompt cannot name a procedure`);
  const m = readFileSync(md, "utf8").match(/^name:[ \t]*(\S+)/m);
  if (!m) throw new Error(`${md} has no \`name:\` in its frontmatter, so the prompt cannot name it`);
  return m[1];
}

/* -------------------------------------------------------- the answer census */

/**
 * What landed in `charpilot-answers/`, and which of the three shapes each file
 * is. The shapes are the derive prompt's own — a proposal, a declaration, or a
 * note — and a file that is more than one of them, or none, is its own outcome
 * rather than a crash: that is exactly the thing worth counting.
 */
export function classifyAnswers(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const bytes = statSync(path).size;
      let doc;
      try {
        doc = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        return { name, path, bytes, shape: "unreadable", why: String(e?.message ?? e), rows: 0 };
      }
      const shapes = ["proposals", "declarations", "notes"].filter((k) => Array.isArray(doc?.[k]));
      if (shapes.length !== 1) {
        return { name, path, bytes, shape: shapes.length ? "mixed" : "none", why: `carries ${shapes.length ? shapes.join(" + ") : "no recognised key"}`, rows: 0 };
      }
      return { name, path, bytes, shape: shapes[0], why: null, rows: doc[shapes[0]].length };
    });
}

/** Every side a packet's roster holds, as `armId [side]`, which is `derive.sideId`'s key. */
export function rosterSides(packetPath) {
  const doc = JSON.parse(readFileSync(packetPath, "utf8"));
  return (doc.packet?.sides ?? []).map(String);
}

/**
 * Which arm has which side labels, built from the worklist the packets came out
 * of. `derive.mjs` builds the same two lines in a private `labelIndex`; it is
 * not exported, and this is the one place it is repeated rather than imported.
 */
export function labelsByArmFrom(worklistJson) {
  const worklist = JSON.parse(readFileSync(worklistJson, "utf8"));
  return new Map((worklist.items ?? []).map((i) => [i.armId, new Set([...(i.sides ?? []), ...(i.uncoveredSides ?? [])])]));
}

/**
 * First-pass yield for one packet, from the two side sets the run produced.
 *
 * `claimed` is every side some landed row's `reaches` names. `validated` is the
 * same set computed with the quarantine applied, which is what `ledger.mjs`
 * would count. The difference is the failure this measures: a claimed side that
 * did not validate reads as coverage and produces no test.
 */
export function yieldOf({ claimed = [], validated = [], roster = [] } = {}) {
  const v = new Set(validated);
  const inRoster = new Set(roster);
  return {
    sidesClaimed: claimed.length,
    sidesValidated: validated.length,
    firstPassYield: claimed.length ? validated.length / claimed.length : null,
    rosterSides: roster.length,
    rosterClosed: [...inRoster].filter((s) => v.has(s)).length,
    rosterYield: roster.length ? [...inRoster].filter((s) => v.has(s)).length / roster.length : null,
    overClaimed: claimed.filter((s) => !inRoster.has(s)).length,
  };
}

/* ------------------------------------------------------------------- the log */

/** One row, appended. Same append-only jsonl discipline as `packetlog.mjs`. */
export function recordRow(row, { dir = ROWS_DIR } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`);
  } catch {
    // Reported by its absence, which is the honest result: a measurement that
    // could not be written is a number nobody should have.
  }
  return row;
}

/** Every row this tool has ever recorded, oldest first, surviving a torn last line. */
export function readRows({ dir = ROWS_DIR } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // One torn line does not erase the log.
      }
    }
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * The two axes the hypothesis is about, over every row on disk.
 *
 * REPORTED AND ACTED ON NOWHERE, for `packetlog.mjs`'s own stated reason: a
 * trigger built on four rows is a constant wearing a measurement's name. The
 * correlation is Pearson's over the rows that carry both numbers, and it is
 * null below three rows rather than 1.0 over two.
 */
export function rowSummary(rows) {
  const done = rows.filter((r) => Number.isFinite(r.seconds) && Number.isFinite(r.briefBytes));
  const corr = (xs, ys) => {
    if (xs.length < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  };
  const secs = done.map((r) => r.seconds);
  const claimed = rows.reduce((n, r) => n + (r.sidesClaimed ?? 0), 0);
  const validated = rows.reduce((n, r) => n + (r.sidesValidated ?? 0), 0);
  return {
    rows: rows.length,
    measured: done.length,
    medianSeconds: secs.length ? [...secs].sort((a, b) => a - b)[Math.floor((secs.length - 1) / 2)] : null,
    secondsPerBriefKB: done.length ? done.reduce((n, r) => n + r.seconds / (r.briefBytes / 1024), 0) / done.length : null,
    sidesClaimed: claimed,
    sidesValidated: validated,
    firstPassYield: claimed ? validated / claimed : null,
    corrSecondsBriefBytes: corr(done.map((r) => r.briefBytes), secs),
    corrSecondsSides: corr(
      done.filter((r) => Number.isFinite(r.sidesDealt)).map((r) => r.sidesDealt),
      done.filter((r) => Number.isFinite(r.sidesDealt)).map((r) => r.seconds)
    ),
    corrSecondsSourceBytes: corr(
      done.filter((r) => Number.isFinite(r.sourceBytes)).map((r) => r.sourceBytes),
      done.filter((r) => Number.isFinite(r.sourceBytes)).map((r) => r.seconds)
    ),
  };
}

/* ----------------------------------------------------------------- the run */

/**
 * The environment the measured worker runs under, and the four things stripped
 * from it.
 *
 *   CHARPILOT_*                 the host's own pipeline settings. `fleetwalk`'s
 *                               `walkEnv` strips these for the same reason: a
 *                               shard, a batch size or a probe selector left in
 *                               the shell changes what the worker is handed.
 *   CLAUDE_CODE_* / CLAUDECODE  the SESSION this tool is itself running inside.
 *                               A child that inherits `CLAUDE_CODE_SESSION_ID`,
 *                               `CLAUDE_CODE_MESSAGING_SOCKET` and
 *                               `CLAUDE_CODE_ENTRYPOINT` is not a fresh
 *                               `--print` worker, it is a continuation of the
 *                               measuring session — which is not what a
 *                               container worker is, and is therefore not what
 *                               the seconds on the row would be about.
 *   CLAUDE_EFFORT / CLAUDE_PID  the same, from the host harness.
 *
 * Two are put BACK, because `char/agent.py` and `entrypoint.py` both set them
 * and a worker without them is a different worker: an unbounded wait for
 * background subagents (the 600000 ms default killed four mid-write) and the
 * measured concurrency ceiling.
 */
export function workerEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("CHARPILOT_")) continue;
    if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || k === "CLAUDE_EFFORT" || k === "CLAUDE_PID") continue;
    env[k] = v;
  }
  env.NO_COLOR = "1";
  env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "0";
  env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = base.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? "8";
  return env;
}

/** Every child, with the buffer a stream-json transcript needs. */
const child = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
    env: { ...process.env, NO_COLOR: "1", ...(opts.env ?? {}) },
  });

/**
 * One agent turn, spawned the way `char/agent.py` and `fleetprobe` spawn it —
 * same flags, same permission file, same turn ceiling, stdin as the prompt FILE
 * rather than a pipe (`--add-dir` is variadic, so a positional prompt is read as
 * one more directory).
 *
 * The clock is around THIS and nothing else. It is the number the whole tool
 * exists for, so it must not include building the sandbox, rendering the prompt
 * or running the validator.
 */
function oneTurn(dir, promptPath, env) {
  if (!existsSync(SETTINGS)) {
    throw new Error(
      `${SETTINGS} is missing, and it is the agent's permission allowlist. Without it every Bash call the agent ` +
        `makes is refused with no approver present, and the turn ends reporting success having done nothing.`
    );
  }
  const fd = openSync(promptPath, "r");
  const started = Date.now();
  try {
    const r = spawnSync(
      "claude",
      ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--settings", SETTINGS, "--max-turns", String(MAX_TURNS), "--add-dir", dir],
      { cwd: dir, env: { ...env, NO_COLOR: "1" }, stdio: [fd, "pipe", "pipe"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: TURN_MINUTES * 60_000 }
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    const timedOut = r.error?.code === "ETIMEDOUT";
    const outcome = agentOutcome({ stdout: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, status: r.status, timedOut });
    if (outcome.state === "timed-out") outcome.reason = `the turn hit the ${TURN_MINUTES} min bound`;
    return { ...outcome, seconds, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    closeSync(fd);
  }
}

/**
 * The usage totals off the terminating `result` record, or nulls.
 *
 * A second pass over the same stream that `agentOutcome` reads, and not a
 * widening of it: that function answers "did the turn work", deliberately
 * returns only `state`, `turns` and `usd`, and is shared with fleetprobe, whose
 * rows would change shape if it grew a usage block. `cacheReadTokens` is the
 * field `packetlog.mjs` names as missing per packet, and it is the one number
 * here that says how much of the brief was paid for twice.
 */
export function usageOf(stdout) {
  let last = null;
  for (const line of String(stdout).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const doc = JSON.parse(t);
      if (doc?.type === "result") last = doc;
    } catch {
      continue;
    }
  }
  const u = last?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheCreationTokens: u.cache_creation_input_tokens ?? null,
    durationMs: last?.duration_ms ?? null,
    durationApiMs: last?.duration_api_ms ?? null,
  };
}

/**
 * Materialise one submission by running the tool that owns its format.
 *
 * A TOOL THE CHECKOUT DOES NOT HAVE IS A FINDING, NOT A CRASH. These artifacts
 * are frozen — notification-ms's pack was installed on 18 Sep and predates
 * `notes.mjs` — so a worker following the CURRENT prompt submits a note shape
 * the FROZEN pack has no writer for. The first run of this tool hit exactly
 * that and recorded a `MODULE_NOT_FOUND` stack as if the note were malformed.
 * It is reported as `not-installed` instead, because the two want opposite
 * responses: one is the agent's error and the other is the bench's.
 */
function materialiseAnswer(sandbox, answer) {
  const pilot = join(sandbox, ".claude", "charpilot");
  const owner = { proposals: "propose.mjs", notes: "notes.mjs", declarations: "blocked.mjs" }[answer.shape];
  if (owner && !existsSync(join(pilot, owner))) {
    return { tool: owner, status: null, notInstalled: true, stdout: "", stderr: `${owner} is not in this checkout's pack, so a ${answer.shape} submission cannot be materialised against it. The artifacts are frozen at the run that produced them; the shape is the current prompt's.` };
  }
  if (answer.shape === "proposals") {
    const r = child(process.execPath, [join(pilot, "propose.mjs"), "--from", answer.path, "--name", answer.name, "--replace", "--json"], { cwd: sandbox });
    return { tool: "propose.mjs", status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  if (answer.shape === "notes") {
    const r = child(process.execPath, [join(pilot, "notes.mjs"), "--submission", answer.path, "--round", "1"], { cwd: sandbox });
    return { tool: "notes.mjs", status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  if (answer.shape === "declarations") {
    // One call per entry, which is `blocked.mjs`'s interface. `derive.mjs` owns
    // the argv shape (`blockedArgv`), but it takes the step's own checked fields
    // and this has only the submitted document, so the flags are built from the
    // eight field names the prompt prints.
    const doc = JSON.parse(readFileSync(answer.path, "utf8"));
    const runs = [];
    for (const e of doc.declarations ?? []) {
      const argvFor = [join(pilot, "blocked.mjs"), "--arm", String(e.arm ?? ""), "--side", [].concat(e.side ?? []).join(","), "--category", String(e.category ?? ""), "--killer", String(e.killer ?? ""), "--proof", String(e.proof ?? "")];
      for (const [k, v] of [["--fix", e.fix], ["--heading", e.heading], ["--why", e.why]]) if (v) argvFor.push(k, String(v));
      const r = child(process.execPath, [...argvFor, "--json"], { cwd: sandbox });
      runs.push({ tool: "blocked.mjs", status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
    }
    return runs.length === 1 ? runs[0] : { tool: "blocked.mjs", status: runs.some((r) => r.status !== 0) ? 1 : 0, stdout: runs.map((r) => r.stdout).join(""), stderr: runs.map((r) => r.stderr).join("") };
  }
  return { tool: null, status: null, stdout: "", stderr: `no tool owns the shape ${JSON.stringify(answer.shape)}` };
}

/** One packet, measured end to end. */
async function measureOne(repo, fact, { work, keep, overlay = null, arm = "control" }) {
  const sandbox = join(work, fact.name.replace(/\.json$/, ""));
  buildSandbox(repo, sandbox);
  const swapped = applyOverlay(sandbox, overlay);
  const { validateFaults, flatProposals, quarantineRows, proposedSides, declaredSides, answeredSideIds } = await loadJoin(sandbox);
  const packetFile = join(sandbox, PACKETS_SUBDIR, fact.name);
  const answersDir = join(sandbox, "charpilot-answers");
  const template = "worklist-prompt-derive.md";
  const promptText = workerPrompt({
    body: readFileSync(join(PROMPTS, template), "utf8"),
    template,
    target: sandbox,
    skill: skillName(),
    packetFile,
    answersDir,
    packetName: fact.name,
  });
  const promptPath = join(sandbox, "worker-prompt.md");
  writeFileSync(promptPath, promptText);

  log(`  ${fact.name}  ${fact.briefBytes} B brief · ${fact.items} item(s) · ${fact.sidesDealt} side(s) · ${fact.file ?? "no source"}`);
  const turn = oneTurn(sandbox, promptPath, workerEnv());
  log(`    turn: ${turn.state} · ${turn.seconds}s · ${turn.turns ?? "?"} turns · $${typeof turn.usd === "number" ? turn.usd.toFixed(4) : "?"}${turn.reason ? ` · ${turn.reason}` : ""}`);

  const answers = classifyAnswers(answersDir);
  const materialised = answers.map((a) => ({ file: a.name, shape: a.shape, ...materialiseAnswer(sandbox, a) }));

  const proposalsDir = join(sandbox, ".claude", "charpilot", "proposals");
  const validate = child(process.execPath, [join(sandbox, ".claude", "charpilot", "validate.mjs")], { cwd: sandbox });
  const faults = validateFaults(validate);
  const rows = flatProposals(proposalsDir);
  const { held, unplaced } = quarantineRows(faults, rows);
  const labels = labelsByArmFrom(join(sandbox, ".claude", "charpilot", "out", "worklist.json"));
  const declared = declaredSides(proposalsDir, labels);
  // CLAIMED is every side an answer names; VALIDATED is the same set with the
  // quarantine applied. A declaration is in both: `blocked.mjs` refuses at the
  // door rather than being quarantined later, so an entry that landed is an
  // entry that stands.
  const claimed = [...answeredSideIds({ proposed: proposedSides(proposalsDir, labels), declared })];
  const validated = [...answeredSideIds({ proposed: proposedSides(proposalsDir, labels, held), declared })];
  const roster = rosterSides(packetFile);

  const row = {
    at: Date.now(),
    // WHICH ARM, ON THE ROW. A measurement whose arm lives only in the command
    // that produced it is a row nobody can reconcile six weeks later.
    arm,
    overlaid: swapped.includes(fact.name),
    repo: basename(repo),
    packetFile: fact.name,
    packet: fact.packet,
    functionId: fact.functionId,
    file: fact.file,
    items: fact.items,
    sidesDealt: fact.sidesDealt,
    briefBytes: fact.briefBytes,
    repeatedBytes: fact.repeatedBytes,
    sourceBytes: fact.sourceBytes,
    seconds: turn.seconds,
    turns: turn.turns,
    usd: turn.usd,
    state: turn.state,
    reason: turn.reason ?? null,
    ...usageOf(turn.stdout),
    filesWritten: answers.length,
    answerBytes: answers.reduce((n, a) => n + a.bytes, 0),
    answerShapes: answers.map((a) => a.shape),
    proposalRowsLanded: rows.length,
    ...yieldOf({ claimed, validated, roster }),
    validateExit: validate.status,
    faults: faults.map((f) => f.line),
    faultsUnplaced: unplaced.length,
    materialiseFailures: materialised
      .filter((m) => m.status !== 0)
      .map((m) => ({ file: m.file, tool: m.tool, why: m.notInstalled ? "not-installed" : "refused", said: (m.stderr || m.stdout).trim().split("\n").slice(-4).join(" | ") })),
    sandbox: keep ? sandbox : null,
  };
  writeFileSync(join(sandbox, "packetcost-row.json"), `${JSON.stringify({ ...row, validateStdout: validate.stdout, answers, materialised }, null, 2)}\n`);
  recordRow(row);
  log(`    landed: ${row.filesWritten} file(s), ${row.proposalRowsLanded} row(s) · claimed ${row.sidesClaimed} · validated ${row.sidesValidated} · roster ${row.rosterClosed}/${row.rosterSides} · faults ${faults.length}`);
  for (const f of faults.slice(0, 6)) log(`      ${f}`);
  if (!keep) rmSync(sandbox, { recursive: true, force: true });
  return row;
}

/* ------------------------------------------------------------------- main */

function printCensus(facts, dir) {
  const t = censusTotals(facts);
  log(`${dir}`);
  log(`  packets ${t.packets} · items ${t.items} · sides ${t.sides} · ${t.totalBytes} B (${Math.round(t.totalBytes / 1024)} KB)`);
  const m = t.medianBytes;
  log(`  median ${m && typeof m === "object" ? `${m.lower} B (upper middle ${m.upper}, mean ${m.mean})` : m} · max ${t.maxBytes} B · per item ${t.bytesPerItem} B`);
  log(`  byte-identical repetition across items: ${t.repeatedBytes} B (${t.totalBytes ? Math.round((100 * t.repeatedBytes) / t.totalBytes) : 0}% of the brief)`);
  log("");
  for (const f of facts) {
    if (f.unreadable) {
      log(`  ${f.name.padEnd(16)} ${String(f.briefBytes).padStart(8)} B  UNREADABLE: ${f.unreadable}`);
      continue;
    }
    log(
      `  ${f.name.padEnd(16)} ${String(f.briefBytes).padStart(8)} B  items ${String(f.items).padStart(2)}  sides ${String(f.sidesDealt).padStart(2)}  ` +
        `repeat ${String(f.repeatedBytes).padStart(7)} B  src ${f.sourceBytes === null ? "—".padStart(7) : String(f.sourceBytes).padStart(7)}  ${f.kinds.join(",") || "-"}  ${f.file ?? ""}`
    );
  }
  return t;
}

async function main() {
  if (flag("--rows")) {
    const rows = readRows();
    const s = rowSummary(rows);
    if (flag("--json")) {
      log(JSON.stringify({ summary: s, rows }, null, 2));
      return;
    }
    log(`${rows.length} measured packet(s) in ${ROWS_DIR}`);
    for (const r of rows) {
      log(
        `  ${r.repo}/${r.packetFile}  ${String(r.briefBytes).padStart(7)} B  ${String(r.seconds).padStart(5)}s  ${String(r.turns ?? "?").padStart(3)} turns  ` +
          // Printed to four places and STORED raw. The row is the measurement;
          // this line is for a person, and `$1.5423945000000001` is a float
          // artefact reading as precision nobody has.
          `$${typeof r.usd === "number" ? r.usd.toFixed(4) : "?"}  claimed ${r.sidesClaimed} validated ${r.sidesValidated}  cacheRead ${r.cacheReadTokens ?? "?"}`
      );
    }
    log("");
    log(JSON.stringify(s, null, 2));
    return;
  }

  const repo = arg("--repo", "") ? resolve(arg("--repo")) : null;
  const packetsDir = arg("--packets", "") ? resolve(arg("--packets")) : repo ? join(repo, PACKETS_SUBDIR) : null;
  if (!packetsDir) {
    process.stderr.write(
      "✗ packetcost: name what to measure.\n" +
        "  --repo <path>      a checkout whose .claude/charpilot/out holds a dealt round\n" +
        "  --packets <dir>    any directory of packet files (census only, no repo needed)\n"
    );
    process.exit(2);
  }
  if (!existsSync(packetsDir)) {
    process.stderr.write(`✗ packetcost: ${packetsDir} does not exist. A repo whose run never reached \`handover\` has no packets to measure.\n`);
    process.exit(2);
  }

  const facts = censusPackets(packetsDir, { root: repo });
  const totals = printCensus(facts, packetsDir);

  const only = arg("--only", "") ? arg("--only").split(",").map((s) => s.trim()).filter(Boolean) : null;
  const { chosen, refusal, why } = chooseSelection(facts, { only, limit: Number(arg("--limit", "1")), spread: flag("--spread") });
  log("");
  if (refusal) {
    process.stderr.write(`✗ packetcost: ${refusal}\n`);
    process.exit(2);
  }
  log(`selection — ${why}`);
  for (const c of chosen) log(`  ${c.name}  ${c.briefBytes} B  ${c.items} item(s)  ${c.sidesDealt} side(s)  ${c.file ?? ""}`);

  const gate = dispatchGate({ run: flag("--run"), chosen });
  log("");
  log(`dispatch — ${gate.why}`);
  log(`  worst case ${gate.worstCaseMinutes} min of agent time at the ${TURN_MINUTES} min bound, ${MAX_TURNS} turns each`);
  if (!gate.dispatch) {
    if (flag("--json")) log(JSON.stringify({ packetsDir, totals, facts, chosen: chosen.map((c) => c.name), gate }, null, 2));
    return;
  }
  if (!repo) {
    process.stderr.write("✗ packetcost: --run needs --repo. A packet directory on its own has no source to read and no validator to answer to.\n");
    process.exit(2);
  }

  const work = resolve(arg("--work", join(OUT_DIR, "packetcost-work")));
  mkdirSync(work, { recursive: true });
  const overlay = arg("--packet-overlay", "") ? resolve(arg("--packet-overlay")) : null;
  if (overlay && !existsSync(overlay)) {
    process.stderr.write(`✗ packetcost: --packet-overlay ${overlay} does not exist. An overlay that is not there is a control run wearing a second arm's name.\n`);
    process.exit(2);
  }
  const arm = arg("--arm", overlay ? "overlay" : "control");
  if (overlay) log(`overlay — ${overlay}, arm ${JSON.stringify(arm)}`);
  log("");
  const rows = [];
  for (const fact of chosen) rows.push(await measureOne(repo, fact, { work, keep: flag("--keep"), overlay, arm }));
  log("");
  log(JSON.stringify(rowSummary(rows), null, 2));
  log(`rows appended to ${ROWS_DIR}`);
}

if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
// `.catch` and not a top-level `await`: a top-level await makes this an ASYNC
// MODULE, and the tests import it for its pure halves. A rejection that only
// printed a stack would also lose the sentence the refusal was written as.
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`✗ packetcost: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
