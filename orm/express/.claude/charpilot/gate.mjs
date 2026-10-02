#!/usr/bin/env node
/**
 * One command, one verdict.
 *
 * This exists because of how the pilot actually went: stage 3 was declared
 * finished three times, and each time a person had to ask where a number came
 * from before the gap surfaced. Ten rounds of question-and-answer per service
 * does not scale, and it is the single thing that stops this becoming a skill.
 *
 * So every question that mattered is now a CHECK with an exit code, and the
 * answer to "is it done" is this script's output rather than a conversation.
 *
 *   node .claude/charpilot/gate.mjs [--stage 3]
 *
 * Exit 0 means the stage is genuinely closed. Anything else prints the exact
 * next action - not a percentage to interpret.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This directory, so the parse check finds the tools rather than the target. */
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

import { BASELINE_JSON, CORPUS_REL, SRC_EXCLUDE_REL, CONFIG_DIR, PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
import { all as freshnessAll, check as freshnessOf } from "./freshness.mjs";
import { integrity } from "./emitted-integrity.mjs";
import { priced } from "./suppressions.mjs";
import { declaredMode, rateVerdict, sameMode } from "./targets.mjs";
import { envNames } from "./envfile.mjs";

const ARGV = process.argv.slice(2);
// EVERY CHECK, UNLESS ONE IS ASKED FOR. This defaulted to 3, and the filter is
// `(c.stage ?? 3) <= STAGE`, so `npm run pilot:gate` - the command every skill
// prescribes and the only one package.json offers - ran 17 of 29 checks and
// silently skipped 12: every check that inspects recorded behaviour, emitted
// tests, measured coverage, the rate, suppressions or mutation. Both checks
// added to catch the defects that cost the most this week were among them, so
// neither had ever executed on any run.
//
// A gate that hides its own checks by default reports a pass it did not earn.
// `--stage N` still narrows it, for a run genuinely stopped part-way.
// The batch a run may derive before it owes a verdict. Codex's read of the same
// logs suggested 5-10; 20 is the conservative end of that, because the cost of
// this check being too strict is an extra loop and the cost of it being too
// loose is the 162-minute discovery it exists to prevent.
const BATCH = Number(process.env.CHARPILOT_BATCH ?? 10);

/**
 * The furthest stage this run has EVIDENCE of reaching.
 *
 * Neither constant was right. `3`, the old default, hid eleven checks - every
 * one that inspects recorded behaviour, emitted tests, measured coverage, the
 * rate, suppressions or mutation - so `npm run pilot:gate` reported a pass it
 * had not earned, and the two checks added this week to catch the costliest
 * defects had never executed on any run.
 *
 * `8` was worse in the other direction, and I shipped it for an hour. It runs
 * checks for stages the run has not got to: `reachability` wants a preflight a
 * mocked run never performs, and the last successful run's own report records it
 * failing for exactly that reason. A gate that fails a healthy run teaches the
 * next reader to pass `--tolerance` and stop reading it.
 *
 * So the ceiling comes from the artifacts. A run that recorded has reached 4; one
 * with an emitted suite, 5; with coverage, 6. Each stage is claimed only by the
 * file that stage writes, so a check runs exactly when the thing it inspects
 * exists — and a stage that did not happen is skipped as not-yet rather than
 * failed as broken. `--stage N` still overrides, in either direction.
 */
function reachedStage() {
  const out = join(REPO_ROOT, ".claude/charpilot/out");
  const has = (f) => existsSync(join(out, f));
  // Highest first: the newest artifact is the furthest the run got.
  if (has("mutants.json")) return 8;
  if (has("dead-exports.json") && has("coverage.json")) return 7;
  if (has("coverage.json")) return 6;
  if (existsSync(join(REPO_ROOT, CORPUS_REL))) return 5;
  if (has("behaviour.json") || has("behaviour-live.json")) return 4;
  if (existsSync(PROPOSALS_DIR)) return 3;
  if (has("scan.json")) return 2;
  return 1;
}

const STAGE = Number(ARGV.includes("--stage") ? ARGV[ARGV.indexOf("--stage") + 1] : reachedStage());

const INERT =
  /^not (a )?call|^not constructed|^not read|^not matched|^not reached|^no call|type only|imported for its type/i;

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Read an artifact, or refuse because it is stale.
 *
 * A separate `freshness` check is not enough on its own: it sits in the list
 * beside a dozen others, and every check that CONSUMES a stale artifact still
 * prints its own verdict as though the artifact were current. That is how the
 * ratchet came to print a GREEN result against a pre-suppression denominator
 * of 1460 - the number was real, the artifact it came from described a `src/`
 * that no longer existed, and nothing in that check's own output said so.
 *
 * So a check that reads an artifact refuses in its own voice. Returns
 * `{ stale }` for the caller to hand straight back, or `{ doc }`.
 */
function readIfFresh(file, dir) {
  const r = freshnessOf(file, dir ? { dir } : undefined);
  if (r.state === "missing") return { stale: { pass: false, detail: `out/${file} does not exist yet` } };
  if (r.state !== "fresh") {
    return { stale: { pass: false, detail: `out/${file} is ${r.state}: ${r.reason} — this check would report a number describing a src/ that no longer exists` } };
  }
  const doc = read(join(REPO_ROOT, dir ?? ".claude/charpilot/out", file));
  // FRESH IS NOT THE SAME AS MINE. `freshnessOf` asks whether the artifact
  // describes the current src/; it cannot ask whether it describes the current
  // MODE. Run 20260915T111158Z-live recorded live, deleted the live recording
  // mid-run and continued mocked, and every check downstream read the mocked
  // corpus and reported it as the live run's result. An artifact stamped with
  // another mode is not stale - it is about a different question.
  const m = sameMode(doc, `out/${file}`);
  if (!m.ok) return { stale: { pass: false, detail: m.error } };
  return { doc };
}

/**
 * How many claiming proposals may exist given how many have been judged.
 *
 * Exported and pure so the rule can be tested as the arithmetic it is, rather
 * than by matching the prose of the comment above it - which is how the first
 * test for this was written, and it broke on every rewording.
 *
 * The allowance GROWS with the evidence: `BATCH` rows ahead of what has been
 * judged, never more. It therefore never tightens as work proceeds and cannot
 * refuse a run mid-loop; it refuses only running further ahead of the evidence
 * than one batch.
 */
export function batchAllowance(judged, batch = BATCH) {
  return judged + batch;
}

/**
 * The proposals a verdict has actually been issued for.
 *
 * Counted by ROW, from stage 6's own three lists, because "claims verdicted" is
 * not "proposals judged": one proposal can carry several `reaches` entries, so
 * a claim count overstates how much of the work list has been through the loop.
 * `unmeasurable` counts too - a row the measurement could not judge has still
 * been through 4 → 5 → 6, and the author has an answer about it.
 *
 * Absent coverage.json is zero rather than an error: on a repo where stage 6 has
 * never run, nothing has been judged, which is exactly what the caller needs to
 * hear.
 */
function verdictedProposals() {
  const cov = join(REPO_ROOT, ".claude/charpilot/out", "coverage.json");
  if (!existsSync(cov)) return new Set();
  try {
    const doc = read(cov);
    const ids = new Set();
    for (const list of [doc.verified, doc.falseClaims, doc.unmeasurable]) {
      for (const row of list ?? []) if (row?.id) ids.add(row.id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Every proposal in PROPOSALS_DIR, or `null` when the directory does not exist.
 *
 * On a repo where stage 3 has not started there is no proposals directory, and
 * two checks reported that as a raw `ENOENT: ... scandir '.../proposals'`. An
 * onboarding run reads its first gate output as the instructions for what to do
 * next, so a stack-shaped string where a next action belongs is a defect in the
 * gate rather than in the repo.
 */
function allProposals() {
  if (!existsSync(PROPOSALS_DIR)) return null;
  return readdirSync(PROPOSALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => read(join(PROPOSALS_DIR, f)).proposals ?? []);
}

/**
 * The `self-contained` verdict over a list of proposals - everything that check
 * asks of the proposals themselves, with the HANDOFF staleness test (a question
 * about files) left to the caller. Exported so the rule below can be tested on
 * proposal objects rather than on a checked-out proposals directory.
 *
 * REVERSIBILITY, not a signature, is what makes a write against staging safe,
 * and the two shapes of `apply.db` earn it differently. record.mjs states the
 * governing principle in its own words (record.mjs:1488):
 *
 *   "Writes against staging are permitted, and what makes that safe is not
 *    refusal but REVERSIBILITY: every mutation is journalled with what is
 *    needed to undo it, and the journal is replayed in reverse at the end of
 *    the run. A write nobody can undo is the one thing still refused."
 *
 * `{ create: { model, data }, why }` is the only shape record.mjs executes
 * (record.mjs:605 refuses every other one). Its undo is DERIVABLE - the created
 * id - and under --live it is journalled and reverse-replayed with read-back
 * verification, so it carries neither a `revert` nor a `confirmedBy`, and this
 * check demanded both.
 *
 * What that cost, measured on run 20260915T033521Z (location-ms): `setup.apply.db`
 * was used in 0 of 88 proposals, while 25 of 25 `prisma.cachedLocation.findUnique`
 * and 3 of 3 `prisma.country.findFirst` calls returned empty - so the row-found
 * side never ran and every claim aimed at it came back `path-not-taken`, 92 FALSE
 * claims in one file. Seeding correctly turned this check red, and the stage-3
 * skill forbids clearing it ("`confirmedBy` is a person's signature on the seed -
 * leave it for the ruling, do not sign it"), so under a stage-3 clock already over
 * budget, NOT seeding was the only move that produced no failure the agent was
 * told not to fix.
 *
 * `confirmedBy` belongs to the ruling a person makes when reviewing the pull
 * request. It is not a precondition for stage 3 deriving an input, and a
 * create-form seed that is journalled and reverse-replayed does not need a
 * signature in order to RUN. Every other shape still does - they have no
 * derivable undo, which is exactly why record.mjs refuses them.
 */
export function setupVerdict(proposals) {
  const problems = [];
  let mutations = 0;
  let awaitingRuling = 0;
  for (const p of proposals) {
    for (const e of p.setup ?? []) {
      // A `manual` apply over prose that plainly describes a DB mutation is a
      // DOWNGRADE - the directive and its revert have been lost. This check
      // previously validated only the mutations that existed, so deleting
      // them made it pass vacuously. That is worse than having no check.
      const prose = e.state ?? "";
      const looksLikeDbWrite = /\brow\b[^.]*\b(enable|disabled?)\b|\b(set|flip|toggle)\b[^.]*\brow\b|\benable = (true|false)\b/i.test(prose);
      if (looksLikeDbWrite && !e.apply?.db) {
        problems.push(`${p.id}: prose describes a database mutation but apply is ${Object.keys(e.apply ?? {}).join("/") || "missing"} — the revert has been lost`);
        continue;
      }
      const db = e.apply?.db;
      if (!db) continue;
      mutations += 1;
      if (db.create !== undefined) {
        // The undo is the created id, journalled and reverse-replayed. What is
        // outstanding is a person's ruling, not a missing field, so it is
        // counted and reported rather than failed.
        awaitingRuling += 1;
      } else {
        // A shared-state mutation with no derivable undo leaves the environment
        // altered, so this shape still has to carry its own.
        if (!db.revert) problems.push(`${p.id}: db mutation with no revert`);
        if (!db.confirmedBy) problems.push(`${p.id}: db mutation with no recorded authorisation`);
      }
      // True of both shapes: a mutation aimed at the read-only URL var is aimed
      // at the wrong connection, whatever its undo looks like.
      if (db.urlVar && /READ_ONLY/i.test(db.urlVar)) problems.push(`${p.id}: mutation aimed at a read-only URL`);
    }
  }
  return { problems, mutations, awaitingRuling };
}

/** Prisma's raw-SQL escape hatches: not a model, so no `create` seed can target one. */
const RAW_SQL = new Set(["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);

const EMPTY_LITERAL = /^(null|undefined|\[\s*\]|\{\s*\}|\{\s*count\s*:\s*0\s*\}|0|false)$/;
const DECLARED_READ = /([A-Za-z_$][\w$]*)\s*:\s*(?:\(\)\s*=>\s*Promise\.resolve\(|\{\s*resolves\s*:\s*)/g;

/**
 * Which DB reads a proposal declared a NON-EMPTY answer for.
 *
 * Read off `mock.build`, which is an expression string, so this is a scan and
 * not a parse. That is acceptable here and only here: nothing about the
 * PASS/FAIL verdict depends on it. The verdict comes from
 * `falseClaimsAtRecordTime`, which is exact. This only chooses which sentence
 * the refusal prints, so a read it fails to recognise costs specificity and
 * never correctness - the row is still refused, just with less advice.
 */
export function declaredNonEmptyReads(build) {
  const out = new Set();
  const text = String(build ?? "");
  for (const m of text.matchAll(DECLARED_READ)) {
    const name = m[1];
    let depth = 0;
    let j = m.index + m[0].length;
    const from = j;
    while (j < text.length) {
      const c = text[j];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === "," && depth === 0) break;
      j += 1;
    }
    const payload = text.slice(from, j).trim();
    if (payload && !EMPTY_LITERAL.test(payload)) out.add(name);
  }
  return out;
}

/**
 * THE ROWS THAT RECORDED THE SIDE THEY WERE TRYING TO LEAVE BEHIND.
 *
 * `record.mjs` already knows. It computes the same verdict stage 6 does, three
 * stages earlier, against real evidence rather than a guess, and writes it to
 * `falseClaimsAtRecordTime` - 119 claims over 56 rows on run 20260915T033521Z.
 * Then it prints them and exits 0, and its own comment says why:
 *
 *   "Deliberately not a non-zero exit and deliberately not a dropped row. The
 *    pair is a real observation; what is wrong is the ARM it is filed under,
 *    and that is a stage-3 input to repair. Stage 6 still fails on these -
 *    this is the same finding, ~30 minutes earlier."
 *
 * The first half is right and stays: the observation IS real, and dropping the
 * row would throw away work that cost money. The second half is the drop-off -
 * it routes the failure to a stage three hours downstream on the strength of a
 * check somewhere else, which is the shape §6 forbids and the same shape as
 * `claimsFalse` being computed by stage 6 and then discarded by `report.mjs`.
 *
 * So the RECORDER keeps recording and the GATE refuses.
 *
 * WHY THIS IS NOT THE STAGE-3 STATIC CHECK THAT WAS ASKED FOR. It cannot be.
 * Measured over all 88 proposals of that run (`gate.record-time-claims.test.mjs`
 * carries the table): the best static rule - "declares a non-empty prisma
 * answer and has no `setup.apply.db`" - scores 36 true positives against 6
 * FALSE positives out of only 13 legitimate rows. The proof that no static rule
 * can do better is a matched pair: `findBestCityInCountry-no-cities-on-country`
 * and `findBestCityInCountry-second-city-does-not-beat-first` have the same
 * subject, the same `via`, the same boundary symbol and a non-empty `$queryRaw`
 * declaration each; one is false and one verifies. What separates them is which
 * side of an arm inside the helper the empty-DB path happens to take - the
 * thing being measured. A refusal that cuts 46% of the good rows is worse than
 * none.
 *
 * WHICH ROUTE THE AUTHOR HAS TO PICK is read off evidence, never guessed: the
 * reads the proposal DECLARED non-empty, intersected with the reads that came
 * back empty from the real database. On that run the three populations are 2,
 * 18 and 36 - so seeding fixes two rows, and telling the other 54 to write a
 * seed would be sending them to do something that cannot work.
 */
export function recordTimeClaimVerdict(doc, proposals = []) {
  // ABSENT IS NOT ZERO. `?? []` here read a recording written before this field
  // existed as "0 claims false" and the check passed, affirmatively, printing a
  // verified count it had not verified. A missing field means the recorder did
  // not judge these claims; an empty array means it judged them and found none.
  // The first is unmeasured and must refuse, the second is a pass.
  if (!Array.isArray(doc?.falseClaimsAtRecordTime)) {
    return {
      unmeasured:
        "the recording carries no `falseClaimsAtRecordTime` — it predates the record-time " +
        "verdict, so nothing judged whether any row reached the side it named. Re-record with " +
        "the current record.mjs rather than reading its absence as zero",
    };
  }
  const wrong = doc.falseClaimsAtRecordTime;
  const rows = new Map((doc?.rows ?? []).map((r) => [r.id, r]));
  const declared = new Map(
    proposals.map((p) => [p.id, declaredNonEmptyReads(((p.boundaries ?? {}).prisma ?? {}).mock?.build)])
  );

  const byRow = new Map();
  for (const f of wrong) {
    const e = byRow.get(f.id) ?? { id: f.id, claims: [], starved: [], route: "input" };
    e.claims.push(`${f.armId} "${f.side}"`);
    byRow.set(f.id, e);
  }

  for (const e of byRow.values()) {
    const wanted = declared.get(e.id) ?? new Set();
    const starved = new Set();
    for (const c of rows.get(e.id)?.boundaryCalls ?? []) {
      const symbol = String(c.symbol ?? "");
      if (!symbol.startsWith("prisma.")) continue;
      const r = c.returned;
      // EMPTY, and the proposal asked for something. A read that returned a
      // value did not starve this row, and a read the proposal declared empty
      // ANYWAY - every one of these rows declares `cachedLocation.findUnique`
      // as null, because it wants a cache miss - is working as intended.
      // Naming either would send the author to fix the wrong boundary, which is
      // the defect this whole file exists to prevent.
      if (!(r === null || r === undefined || (Array.isArray(r) && r.length === 0))) continue;
      const method = symbol.split(".").pop();
      if (!wanted.has(method)) continue;
      starved.add(method);
    }
    e.starved = [...starved];
    // `seed` only when a `create` seed could actually satisfy the starved read.
    // `setup.apply.db` creates a row in a NAMED MODEL; it cannot steer a
    // `$queryRaw` similarity scan over whatever staging holds, so those rows are
    // told so rather than sent to write a seed that will not work.
    e.route = starved.size === 0 ? "input" : [...starved].every((m) => RAW_SQL.has(m)) ? "raw" : "seed";
  }

  const list = [...byRow.values()];
  return {
    rows: list,
    claims: wrong.length,
    seed: list.filter((r) => r.route === "seed"),
    raw: list.filter((r) => r.route === "raw"),
    input: list.filter((r) => r.route === "input"),
  };
}

function runScript(file) {
  try {
    return { ok: true, out: execFileSync("node", [join(".claude/charpilot", file)], { cwd: REPO_ROOT, encoding: "utf8" }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * Each check is one question a person had to ask during the pilot, turned into
 * something with an exit code. `question` is the literal thing that was asked;
 * `fix` is the next action, so nobody has to interpret a percentage.
 */
const CHECKS = [
  {
    id: "tools-parse",
    question: "does every tool in this directory still LOAD?",
    run: () => {
      // This check exists because ONE mistake caused four separate breakages in
      // a single session: record.mjs builds the test harness as a template
      // literal, so a backtick anywhere inside it - including inside a comment -
      // ends the string and the whole file stops parsing. Every time, the tool
      // was already committed or already launched before anyone noticed,
      // because nothing between writing and running looked at the file.
      //
      // node --check is the whole test. It costs milliseconds and it is the
      // difference between a syntax error found here and a run that reports
      // "0 recorded, 366 pending" for a reason unrelated to any proposal.
      // IMPORT, not --check. A parse check misses a missing import, because an
      // undefined binding is a runtime error - and that is exactly what the
      // first version of this check waved through: 23 tools referencing a
      // `fileURLToPath` they never imported, all of them parsing cleanly and
      // all of them throwing on the first line of real work. Every tool here
      // now guards its own main() on import.meta.main, so importing one is
      // side-effect free and this check can afford to actually load it.
      const broken = [];
      let parsedOnly = 0;
      for (const f of readdirSync(TOOL_DIR).filter((f) => f.endsWith(".mjs")).sort()) {
        const src = readFileSync(join(TOOL_DIR, f), "utf8");
        // A tool whose whole body is top-level statements cannot be imported
        // without running it, and benchguard.mjs is one - it is a runner, so
        // importing it is never useful anyway. Those get the weaker parse check
        // and are COUNTED, so the gate never implies more than it verified.
        // A TOP-LEVEL export, anchored. `src.includes("export ")` matched the
        // word inside a comment, so verify.mjs - which has no export at all -
        // was classified importable and therefore RUN by this check.
        const importable = src.includes("if (import.meta.main)") || /^export /m.test(src);
        const cmd = importable
          ? ["--input-type=module", "-e", `await import(${JSON.stringify(join(TOOL_DIR, f))});`]
          : ["--check", join(TOOL_DIR, f)];
        if (!importable) parsedOnly += 1;
        try {
          execFileSync(process.execPath, cmd, { stdio: "pipe", timeout: 30_000 });
        } catch (e) {
          const msg =
            String(e.stderr ?? e.message)
              .split("\n")
              .find((l) => /Error|error/.test(l)) ?? "failed to load";
          broken.push(`${f}: ${msg.trim().slice(0, 120)}`);
        }
      }
      if (broken.length) return { pass: false, detail: broken.slice(0, 3).join(" · ") };
      const total = readdirSync(TOOL_DIR).filter((f) => f.endsWith(".mjs")).length;
      return {
        pass: true,
        detail: `${total - parsedOnly} tool(s) load${parsedOnly ? `, ${parsedOnly} parse only (top-level script)` : ""}`,
      };
    },
    fix: "node --check .claude/charpilot/<file>.mjs - and if it is record.mjs, look for a bare backtick inside the harness template literal",
  },
  {
    id: "artifacts",
    question: "are the stage 1/2 artifacts present and from this commit?",
    run: () => {
      for (const [name, path] of [["baseline", BASELINE_JSON], ["scan", SCAN_JSON], ["worklist", WORKLIST_JSON]]) {
        if (!existsSync(path)) return { pass: false, detail: `${name}.json missing` };
      }
      const baseline = read(BASELINE_JSON);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (baseline.environment?.gitSha && baseline.environment.gitSha !== head) {
        return { pass: false, detail: `baseline was recorded at ${baseline.environment.gitSha.slice(0, 8)}, HEAD is ${head.slice(0, 8)}` };
      }
      return { pass: true, detail: `baseline at ${head.slice(0, 8)}` };
    },
    fix: "npm run pilot:baseline && npm run pilot:scan && npm run pilot:worklist",
  },
  {
    id: "src-exclude",
    stage: 1,
    question: "does test/src-exclude.mjs still mirror the host's own coverage.exclude?",
    run: () => {
      const path = join(REPO_ROOT, SRC_EXCLUDE_REL);
      if (!existsSync(path)) return { pass: false, detail: `${SRC_EXCLUDE_REL} is missing - the installer writes it` };
      const host = ["vitest.config.mts", "vitest.config.ts", "vite.config.mts", "vite.config.ts"]
        .map((f) => join(REPO_ROOT, f))
        .find((p) => existsSync(p));
      if (!host) return { pass: false, detail: "no vitest/vite config to mirror" };
      // The exclude INSIDE the coverage block, not the first one in the file.
      //
      // A vitest config usually carries `test.exclude` (which test FILES to
      // skip) before `test.coverage.exclude` (which SOURCE files to leave out
      // of the denominator), and only the second one is the mirror. Taking the
      // first is what install.sh does, and on this repo that is
      // `[...configDefaults.exclude, ".claude/**", "scripts/**"]` - no concrete
      // .ts path in it, so the derived list comes out EMPTY, which the
      // generated file's own header names as the failure: the scan then counts
      // arms istanbul was never asked to instrument.
      const hostText = readFileSync(host, "utf8");
      const covAt = hostText.search(/coverage\s*:\s*\{/);
      const region = covAt === -1 ? hostText : hostText.slice(covAt);
      const m = region.match(/exclude:\s*\[([^\]]*)\]/);
      // Every entry, not only the concrete .ts paths. istanbul globs this list,
      // config.mjs globs it too, and install.sh copies it verbatim - so a
      // filter here made a correctly mirrored glob read as "here and not
      // excluded by the host".
      const want = m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map((q) => q[1]) : [];
      const have = [...(readFileSync(path, "utf8").match(/SRC_EXCLUDE\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((q) => q[1]);
      const missing = want.filter((v) => !have.includes(v));
      const extra = have.filter((v) => !want.includes(v));
      // Its own header says it MUST mirror that list, and until now nothing
      // checked. It is derived once at install and never revisited, so it goes
      // stale the moment the host's coverage config changes or the branch moves
      // - and the failure is phantom arms: the scan counts arms istanbul was
      // never asked to instrument, they cannot join to anything, and the
      // worklist refuses with a number that looks like a join defect.
      // Measured on profile-centralized: `src/index.ts` was excluded by the
      // host and absent here, producing 4 unjoinable arms in that one file;
      // adding it took unjoined from 4 to 0.
      if (missing.length || extra.length) {
        return {
          pass: false,
          failingItems: [...missing, ...extra],
          detail:
            (missing.length ? `${missing.length} excluded by ${host.split("/").pop()} and NOT here: ${missing.join(", ")}` : "") +
            (missing.length && extra.length ? " · " : "") +
            (extra.length ? `${extra.length} here and not excluded by the host: ${extra.join(", ")}` : ""),
        };
      }
      return { pass: true, detail: `${have.length} path(s), mirrored from ${host.split("/").pop()}` };
    },
    fix: "make SRC_EXCLUDE in test/src-exclude.mjs equal the host config's coverage.exclude, entry for entry and globs included, then re-run npm run pilot:scan - a path the host excludes and this file does not becomes an arm istanbul never instrumented, which can never join",
  },
  {
    id: "staging-env",
    stage: 1,
    question: "did stage 1 resolve the deployed environment, or is stage 4 running on the ambient shell?",
    run: () => {
      // The defect this check exists for: both skills said stage 1 resolved
      // staging into out/staging-env.json, nothing in the flow ran the tool
      // that writes it, and no check demanded it. Six repos had the artifact
      // because somebody ran the tool by hand; a fresh onboarding had none, and
      // every recorded row then carried `envProvenance: "process-env-only"` —
      // the shell that happened to be open. config.mjs then made a `--live`
      // run REQUIRE this artifact to corroborate the database triple, so the
      // documented flow did not create the input its own safety guard demands.
      //
      // It is an ERROR and not a warning, for the reason the router skill
      // gives about attribution: an address stage 1 never resolved surfaces at
      // stage 4 as a row failure, and a row failure is worked as a stage-3
      // defect. The genuine per-target GAPS are reported as failingItems, so
      // they are ruled in decisions.json and reprinted every run rather than
      // downgraded to a line nobody reads.
      if (!existsSync(BASELINE_JSON)) return { pass: false, detail: "baseline.json missing" };
      const se = read(BASELINE_JSON).stagingEnv;
      if (!se) {
        return {
          pass: false,
          detail: "out/baseline.json records no stagingEnv — this baseline was written before stage 1 resolved the environment at all",
        };
      }
      const report = join(REPO_ROOT, ".claude/charpilot/out/staging-env.json");
      if (se.state !== "skipped" && !existsSync(report)) {
        return { pass: false, detail: `baseline records stagingEnv "${se.state}" and out/staging-env.json does not exist — the two disagree` };
      }
      // Each state is one failing ITEM, so a target whose gap is real can be
      // ruled without turning the whole check green for the next repo.
      if (se.state === "skipped") {
        return { pass: false, detail: "resolution was skipped with --no-staging-env — recorded, but stage 4 then has no resolved address for anything" };
      }
      if (se.state === "iac-not-found") {
        return { pass: false, detail: "no qode-iac checkout found — pass --iac <path> or set CHARPILOT_IAC. Nothing else can supply a deployed address" };
      }
      if (se.state === "no-service-name") {
        return { pass: false, detail: "the target's service name could not be derived from package.json or its directory — pass --service <manifest prefix>" };
      }
      if (se.state === "no-manifest") {
        return { pass: false, detail: `no ConfigMap or Secret named ${se.service} in manifests/*/${se.namespace} — either the manifest prefix differs (pass --service) or this service is not deployed there` };
      }
      if (se.state === "resolved-no-database") {
        // A REAL GAP, and the one the brief names. profile-centralized has no
        // DATABASE_URL in any staging manifest, so there is nothing to resolve
        // it from and no default may stand in for it. That is a qode-iac gap,
        // reported here for a person to rule — not papered over, and not
        // something more stage-4 work can fix.
        return {
          pass: false,
          detail: `${se.vars} var(s) resolved from ${se.sources.length} manifest(s), and DATABASE_URL is in NONE of them — a qode-iac gap. A --live run cannot assert a triple it was never given`,
        };
      }
      const scopes = Object.entries(se.scopes ?? {}).map(([k, n]) => `${k} ${n}`).join(" · ");
      return {
        pass: true,
        detail: `${se.vars} var(s) from ${se.sources.length} manifest(s) for ${se.service}/${se.namespace} · ${scopes} · DATABASE_URL from ${se.databaseUrl?.from}`,
      };
    },
    fix: "npm run pilot:baseline resolves it as part of stage 1 (add -- --iac <qode-iac> if it is not beside the target). It reads committed YAML only - no kubectl, no DNS, no TCP probe - so it costs nothing and cannot fail for a reason the network owns. Until it has run, out/staging.env has nothing independent vouching for it and record.mjs --live refuses; and every row records envProvenance process-env-only, which means the shell, not staging",
  },
  {
    id: "env-defaults",
    stage: 1,
    question: "which of the target's env vars would be filled from a source literal instead of from resolved staging?",
    run: () => {
      // REPORTS, and deliberately does not fail. The defaults themselves are
      // ruled: the repo owner has said twice that they are intended and
      // staying, the fleet is internal, and the qode-iac manifests are the
      // source of truth in production - so the fallback never activates where
      // it matters. Failing on them would put this gate permanently red on
      // every repo in the fleet, and the router skill's own lesson is that a
      // check which cries wolf is the one nobody reads when it is finally
      // right (the secret scanner's first version: 7,243 findings, almost all
      // function names).
      //
      // What it is FOR is provenance, and it is stage 1's own diagnostic on
      // whether its resolution was complete. During recording there is no
      // production to be the source of truth: vitest.record.config.mts sets
      // `setupFiles: []`, so a row's env is --env-file or the ambient shell
      // and nothing else. A var that defaults cannot fail loudly when the
      // resolution misses it, so a row that LOOKS configured may have been
      // answered by a source literal - and the pair's inputs are then
      // untraceable. Same idiom as `progress`: a number reprinted every run,
      // not a blocker.
      if (!existsSync(BASELINE_JSON)) return { pass: false, detail: "baseline.json missing" };
      const e = read(BASELINE_JSON).envDefaults;
      if (!e) return { pass: false, detail: "out/baseline.json records no envDefaults — re-run npm run pilot:baseline" };
      if (!e.file) return { pass: true, detail: e.note ?? "no env schema in this target" };
      const un = e.notCoveredByResolvedEnv ?? [];
      const shaped = un.filter((v) => v.credentialShaped);
      if (!un.length) {
        return { pass: true, detail: `${e.file} · ${e.withDefault} of ${e.declared} var(s) default, and the resolved environment covers all of them` };
      }
      return {
        pass: true,
        detail:
          `${e.file} · ${e.withDefault} of ${e.declared} var(s) default · ${un.length} NOT covered by the resolved environment` +
          (shaped.length ? ` (${shaped.length} credential-shaped)` : "") +
          ` — a gap there is filled silently rather than failing: ${un.slice(0, 4).map((v) => v.name).join(", ")}${un.length > 4 ? `, +${un.length - 4}` : ""}` +
          ` — not a failure, but each one is a recorded input whose provenance is the source file`,
      };
    },
    fix: "close them where the deployed config can: a var present in the staging ConfigMap or Secret is resolved by stage 1 and its default is then never consulted during recording. What is left is the honest list of values a row takes from a source literal - name them in the write-up rather than implying the row saw staging. Never quote a value; this check reports a NAME and a location only",
  },
  {
    id: "freshness",
    stage: 1,
    question: "does every artifact describe the src/ that is on disk right now?",
    run: () => {
      const { src, results } = freshnessAll();
      const bad = results.filter((r) => r.state === "stale" || r.state === "unreadable");
      if (bad.length) {
        return { pass: false, detail: `${bad.length} stale: ${bad.map((r) => r.file).join(", ")} — newest src/ file is ${src.file}` };
      }
      const missing = results.filter((r) => r.state === "missing");
      return {
        pass: true,
        detail: `${results.length - missing.length} artifact(s) newer than src/${missing.length ? ` · ${missing.length} not produced yet` : ""}`,
      };
    },
    fix: "npm run pilot:freshness names the artifact and the command that rebuilds it. This check exists because every wrong number in this pilot had the same shape: an artifact describing a src/ older than the one on disk, trusted by the stage downstream of it. out/baseline.json froze at 1460 and the reconcile then reported five drifting files that were really measuring the artifact's age. A comment-only edit counts - it moves every line-based arm id below it, so `stale` is the correct verdict even when no logic changed",
  },
  {
    id: "suite-green",
    question: "was the baseline recorded over a green suite?",
    run: () => {
      const b = read(BASELINE_JSON);
      // Three states. `no-spec-files` is not a red suite and must not read as
      // one: there was nothing that could have failed, and a greenfield
      // baseline is a legitimate "before" - it is exactly what the ratchet
      // ratchets against. It is spelled out rather than ticked silently,
      // because "0/0 tests" beside a green mark is how a check that measured
      // nothing reads as success.
      if (b.suite?.state === "no-spec-files") {
        return { pass: true, detail: "NO SPEC FILE — nothing ran, nothing failed; the denominator comes from coverage.all" };
      }
      // A red suite whose coverage was recorded is the repo's suite as it
      // stands, and a note in the result (tool backlog: qode-backend) - not a
      // failed gate. The failing files are named in the detail.
      // Red because of charpilot (redsuite.mjs) is a pipeline defect, and fails.
      if (b.suite?.state === "red" && b.suite.owner === "pipeline") {
        return { pass: false, detail: `RED because of charpilot, not the repo: ${String(b.suite.pipelineDefect ?? "").slice(0, 400)}` };
      }
      if (b.suite?.state === "red" && b.coverage?.totals) {
        return { pass: true, detail: `RED, noted: ${b.suite.passed}/${b.suite.tests} tests passed; ${b.suite.failedFiles} file(s) failed (${(b.suite.failures ?? []).join(", ")}) - the baseline is the suite as it stands` };
      }
      return b.suite?.green
        ? { pass: true, detail: `${b.suite.passed}/${b.suite.tests} tests` }
        : { pass: false, detail: `${b.suite?.failed ?? "?"} failing` };
    },
    fix: "fix the suite, then re-run npm run pilot:baseline",
  },
  {
    id: "reconcile",
    question: "does the AST arm model still match the istanbul denominator?",
    run: () => {
      const r = read(SCAN_JSON).reconcile ?? {};
      // The identity has THREE terms, not two: ast == istanbul + suppressed.
      // The scan's ts-morph walk switches on SyntaxKind only and has no notion
      // of an `istanbul ignore` directive, so it keeps counting an arm istanbul
      // has dropped. Reading the raw delta as drift is what made a bookkeeping
      // difference look like a broken model - three times, in three different
      // write-ups. Subtract the measured third term before judging.
      const { total: suppressed, totalFunctions: suppressedFns, error, fnError } = priced();
      const armsDelta = (r.arms?.astTotal ?? 0) - (r.arms?.istanbulTotal ?? 0);
      const armsClosed = suppressed !== undefined && !error && armsDelta === suppressed;
      // FUNCTIONS have the same three terms. `istanbul ignore next` DELETES the
      // fnMap entry rather than marking it skipped - probed on
      // istanbul-lib-instrument 6.0.3 - so a function-level directive moves
      // this line exactly as a statement-level one moves the arms line.
      // Requiring `filesWithDrift === 0` here asked the scan to be wrong by the
      // suppressed count, which is not a model error anyone can fix.
      const fnDelta = (r.functions?.astTotal ?? 0) - (r.functions?.istanbulTotal ?? 0);
      const fnClosed = suppressedFns !== undefined && !fnError && fnDelta === suppressedFns;

      if (!armsClosed) {
        const gap = armsDelta - (suppressed ?? 0);
        return {
          pass: false,
          detail: error
            ? `arms delta ${armsDelta}, and the suppressed term could not be measured: ${error}`
            : `arms ast ${r.arms?.astTotal} − suppressed ${suppressed} = ${(r.arms?.astTotal ?? 0) - suppressed}, istanbul says ${r.arms?.istanbulTotal} — ${gap > 0 ? "+" : ""}${gap} unexplained`,
        };
      }
      if (!fnClosed) {
        const gap = fnDelta - (suppressedFns ?? 0);
        return {
          pass: false,
          detail: fnError
            ? `arms close exactly; functions delta ${fnDelta}, and the suppressed term could not be measured: ${fnError}`
            : `arms close exactly (ast ${r.arms?.astTotal} − suppressed ${suppressed} = istanbul ${r.arms?.istanbulTotal}); ` +
              `FUNCTIONS ast ${r.functions?.astTotal} − suppressed ${suppressedFns} = ${(r.functions?.astTotal ?? 0) - suppressedFns}, ` +
              `istanbul says ${r.functions?.istanbulTotal} — ${gap > 0 ? "+" : ""}${gap} unexplained across ${r.functions?.filesWithDrift?.length ?? 0} file(s)`,
        };
      }
      return {
        pass: true,
        detail:
          `arms ast ${r.arms?.astTotal} − suppressed ${suppressed} = istanbul ${r.arms?.istanbulTotal} · ` +
          `functions ast ${r.functions?.astTotal} − suppressed ${suppressedFns} = istanbul ${r.functions?.istanbulTotal}`,
      };
    },
    fix: "npm run pilot:scan prints the per-file drift and `npm run pilot:suppressions` prints both suppressed terms. Compare them BEFORE calling it a model error: on this repo the 58-arm drift fell across exactly the 5 files holding directives, and the directive count ranked with the delta. BOTH lines carry three terms - `istanbul ignore` deletes an fnMap entry as readily as a branch location - so a residual here is what is left AFTER the directives are priced, and that residual is real and undiagnosed. Do not close it by loosening a threshold, because the drift is the only thing that noticed",
  },
  {
    id: "arm-ids",
    stage: 2,
    question: "does every arm reference in every input artifact name a live arm?",
    run: () => {
      const ledger = join(REPO_ROOT, ".claude/charpilot/out/armids.json");
      if (!existsSync(ledger)) return { pass: false, detail: "no id ledger — run `npm run pilot:scan`" };
      const r = runScript("armids.mjs");
      const input = r.out.match(/(\d+) stale reference\(s\) in INPUT/);
      const repairable = r.out.match(/(\d+) reference\(s\)/);
      const l = read(ledger);
      if (input) {
        return { pass: false, detail: `${input[1]} stale reference(s) in proposals — a proposal pointing at nothing reads exactly like a covered arm` };
      }
      // A repairable count is not a failure: it is a shift the ledger can undo.
      // It IS a failure to leave it unrepaired, because every later stage joins
      // on the id.
      if (repairable && /repairable by stableId/.test(r.out)) {
        return { pass: false, detail: `${repairable[1]} reference(s) shifted and are repairable — run \`npm run pilot:armids:fix\`` };
      }
      return { pass: true, detail: `${l.totals.arms} arm(s), ${l.totals.distinctStableIds} distinct stableId(s), 0 stale in input artifacts` };
    },
    fix: "npm run pilot:armids:fix — an armId is `file#line:kind:index`, so any edit above an arm moves it and every artifact naming it is silently wrong. The content-addressed stableId in out/armids.json makes the repair a lookup: stale armId -> stableId (previous ledger) -> current armId. A reference the lookup cannot resolve means the arm's own text changed, which is a real code change and needs re-deriving, not rewriting",
  },
  {
    id: "dead-exports",
    stage: 2,
    question: "is stage 3 about to write inputs for code nothing calls?",
    run: () => {
      const doc = join(REPO_ROOT, ".claude/charpilot/out/dead-exports.json");
      if (!existsSync(doc)) {
        return { pass: false, detail: "no dead-export scan — run `npm run pilot:deadcode` BEFORE deriving inputs" };
      }
      if (statSync(doc).mtimeMs < statSync(SCAN_JSON).mtimeMs) {
        return { pass: false, detail: "dead-exports.json is older than scan.json — it describes a different src" };
      }
      const d = read(doc);
      const byId = new Map(d.dead.map((x) => [`${x.file}:${x.line}:${x.name}`, x]));
      const byName = new Map(d.dead.map((x) => [`${x.file}:${x.name}`, x]));
      const hits = [];
      // The scan can exist before any proposal does; on such a repo the answer
      // is the scan's own totals, not an ENOENT.
      for (const f of (existsSync(PROPOSALS_DIR) ? readdirSync(PROPOSALS_DIR) : []).filter((n) => n.endsWith(".json"))) {
        for (const pr of read(join(PROPOSALS_DIR, f)).proposals ?? []) {
          const id = pr.functionId;
          if (!id) continue;
          const parts = id.split(":");
          const name = parts[parts.length - 1];
          const file = parts[0];
          const dead = byId.get(id) ?? byName.get(`${file}:${name}`);
          if (dead) hits.push({ file: f, proposal: pr.id, name, sides: dead.branchSides, tests: dead.referencedOnlyByTests });
        }
      }
      if (hits.length) {
        const names = [...new Set(hits.map((h) => h.name))];
        return {
          pass: false,
          detail: `${hits.length} proposal(s) target ${names.length} dead export(s): ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}`,
        };
      }
      // THE TWO COUNTS, SEPARATELY. They are two different decisions with two
      // different blast radii, and printing only the total invites one to be
      // taken for the other. Deleting a GENERATED characterization test for a
      // dead export is stage 2b, mechanical, and costs nothing now that the
      // side leaves the denominator with it. Deleting the repo's OWN
      // pre-existing test is a change to somebody else's suite, and this
      // pipeline does not make it.
      const testsOnly = d.totals.deadOnlyReferencedByTests ?? 0;
      return {
        pass: true,
        detail:
          `${d.totals.deadExports} dead export(s) holding ${d.totals.branchSidesInsideThem} side(s) · ` +
          `${testsOnly} of them kept alive ONLY by the repo's pre-existing tests (do not delete those here) · ` +
          `denominator ${d.totals.denominator} → ${d.totals.correctedDenominator} · 0 proposals target one`,
      };
    },
    fix: "npm run pilot:deadcode, then delete the proposals it names. Dead EXPORTS are answerable statically and this scan must run BEFORE stage 3 derives anything - skipping it cost 28 of 336 cases written against code nothing calls. An input for a dead export is not a covered side: it is a test pinning behaviour that no caller can ever observe, and it makes the export look live to the next reader. `referencedOnlyByTests` is the giveaway - the only thing referencing it is the test written for it. This is separate from stage 7's dead BRANCHES inside live functions, which cannot be settled statically",
  },
  {
    id: "units",
    question: "how many functions, how many branches? (are the units stated?)",
    run: () => {
      const s = read(SCAN_JSON);
      const w = read(WORKLIST_JSON);
      const entries = w.summary?.functionEntryUnits;
      if (entries === undefined) return { pass: false, detail: "worklist reports no function-entry units" };
      return {
        pass: true,
        detail: `${s.totals.functions} functions · ${s.reconcile.arms.astTotal} sides · ${entries} never-invoked entries`,
      };
    },
    fix: "npm run pilot:worklist (function-entry units were added after 77 functions were found invisible)",
  },
  {
    id: "drivers",
    question: "is anything still reported as undriveable 'by design'?",
    run: () => {
      const s = read(SCAN_JSON);
      const stuck = s.functions.filter((f) => f.via && ["unresolved", "needs-seam", "at-import", "chain"].includes(f.via.kind));
      return stuck.length
        ? { pass: false, detail: `${stuck.length} functions unresolved, e.g. ${stuck[0].id}` }
        : { pass: true, detail: "every no-own-entry function has a driver or a named trigger" };
    },
    fix: "npm run pilot:scan — the driver pass resolves callers, chains, members and triggers",
  },
  {
    id: "validate",
    question: "did u fix stage 3? (does every proposal pass its own gate?)",
    run: () => {
      const r = runScript("validate.mjs");
      // A count this check could not READ is not a count. Both of these
      // defaulted to -1, so a fresh repo with no proposals directory printed
      // "-1 errors, -1 warnings" — a number nobody can act on, in a check whose
      // whole job is to replace a conversation with a figure. Refuse in the
      // check's own voice instead, and say what the script actually said.
      const errsRaw = (r.out.match(/errors\s+(\d+)/) ?? [])[1];
      const warnsRaw = (r.out.match(/warnings\s+(\d+)/) ?? [])[1];
      if (errsRaw === undefined || warnsRaw === undefined) {
        return {
          pass: false,
          detail: `validate.mjs printed no error/warning counts — ${r.ok ? "it ran and reported neither" : "it failed"}: ${(r.out.trim().split("\n").pop() ?? "no output").slice(0, 140)}`,
        };
      }
      const errs = Number(errsRaw);
      const warns = Number(warnsRaw);
      return errs === 0 && warns === 0
        ? { pass: true, detail: "0 errors, 0 warnings" }
        : { pass: false, detail: `${errs} errors, ${warns} warnings` };
    },
    fix: "node .claude/charpilot/validate.mjs and work the list",
  },
  {
    id: "first-loop-closed",
    // Stage 3, so it is reached by `npm run pilot:gate` on the stage the
    // deriving happens in - the only stage where the answer is still cheap.
    question: "has any input been through record, emit and measure yet?",
    // WHY A COUNT OF PROPOSALS IS NOT PROGRESS UNTIL ONE HAS BEEN JUDGED.
    //
    // Measured across three runs: the baseline derived for 99.9 minutes before
    // its first recording (53% of the run), the live run for 130.8 (54%). Both
    // wrote the whole work list before anything tested whether a single input
    // reached the side it named.
    //
    // What that costs is not the derivation; it is the REWORK. 20260915T111114Z
    // finished with 55 of 144 claims judged false, in two clusters, discovered
    // at minute 162 of 176 - too late for the loop to repair any of it, so it
    // re-measured the same number three times and stopped.
    //
    // And recording early is not enough on its own: that run's first recording
    // was at minute 15.4 and it still ended 38% false, because a recording is
    // an observation and a CLAIM is what gets verdicted. So this asks for a
    // verdict, not for a recording.
    run: () => {
      const proposals = allProposals();
      if (proposals === null) return { pass: true, detail: "stage 3 has not started — nothing to judge yet" };

      // Rows that make a claim at all. A proposal with no `reaches` is a
      // recording someone wanted, not an aimed input, and asking it to be
      // verdicted would refuse work that is already correct.
      const claiming = proposals.filter((p) => Object.keys(p.reaches ?? {}).length);

      // A MOVING WINDOW, NOT A ONE-TIME GATE.
      //
      // The first version of this asked only that SOME claim had been verdicted,
      // and was therefore satisfied permanently by the twenty-first proposal. A
      // run could close the loop once and then derive another 230 rows blind,
      // which is the behaviour it was written to stop: 20260915T111114Z's 55
      // false claims would still have passed it, because its first verdict
      // arrived long before its last proposal.
      //
      // So the allowance GROWS with the feedback. Derive `BATCH` rows ahead of
      // what has been judged, never more. At 0 verdicted that is the first 20;
      // at 60 verdicted it is 80. The rule never tightens as work proceeds, so
      // it cannot refuse a run mid-loop - it only refuses running further ahead
      // of the evidence than one batch.
      const judged = verdictedProposals();
      const allowed = batchAllowance(judged.size);
      if (claiming.length <= allowed) {
        return {
          pass: true,
          detail: judged.size
            ? `${claiming.length} claiming proposal(s), ${judged.size} judged — within ${BATCH} of the evidence`
            : `${claiming.length} claiming proposal(s), at or under the first ${BATCH}-row batch`,
        };
      }
      return {
        pass: false,
        detail:
          `${claiming.length} claiming proposal(s) but only ${judged.size} judged — ${claiming.length - allowed} ` +
          `row(s) beyond the ${BATCH}-row batch, so that many inputs are not known to reach the sides they name. ` +
          `The baseline derived for 99.9 minutes before its first recording, and one run finished 55 of 144 claims ` +
          `false, found at minute 162 of 176 with no budget left to repair them`,
      };
    },
    fix:
      `derive a batch of ${BATCH} or fewer, then close the loop on it before writing more: ` +
      "npm run pilot:record && npm run pilot:emit && npm run pilot:coverage. " +
      "Read `claimsFalse` in out/coverage.json and repair those inputs before the next batch — a wrong " +
      "assumption about what reaches an arm is cheap at 20 rows and unrepairable at 250",
  },
  {
    id: "ledger",
    question: "of the uncovered sides, how many have an input and how many a reason?",
    run: () => {
      const r = runScript("ledger.mjs");
      const raw = (re) => (r.out.match(re) ?? [])[1];
      const unRaw = raw(/UNACCOUNTED\s+(\d+)/);
      // Same reason as `validate`: "-1 sides have neither an input nor a reason"
      // is a sentence that reads like a finding and is not one.
      if (unRaw === undefined) {
        return {
          pass: false,
          detail: `ledger.mjs printed no UNACCOUNTED count — ${r.ok ? "it ran and reported none" : "it failed"}: ${(r.out.trim().split("\n").pop() ?? "no output").slice(0, 140)}`,
        };
      }
      const un = Number(unRaw);
      const inp = Number(raw(/with an input\s+(\d+)/) ?? 0);
      const rsn = Number(raw(/with a reason\s+(\d+)/) ?? 0);
      return un === 0
        ? { pass: true, detail: `${inp} with an input · ${rsn} with a reason · 0 unaccounted` }
        : { pass: false, detail: `${un} sides have neither an input nor a reason` };
    },
    fix: "node .claude/charpilot/ledger.mjs — every listed side needs a proposal or a fenced BLOCKED entry",
  },
  {
    id: "executable",
    question: "is the output a program, or still a document?",
    run: () => {
      const proposals = allProposals();
      if (proposals === null) return { pass: false, detail: "no proposals directory — stage 3 has not started" };
      let argsBad = 0;
      let bndBad = 0;
      let setupBad = 0;
      for (const p of proposals) {
        for (const a of p.args ?? []) if (a?.construct && a.build === undefined) argsBad += 1;
        for (const b of Object.values(p.boundaries ?? {})) {
          if (!INERT.test(b?.behaviour ?? "") && b?.mock === undefined) bndBad += 1;
        }
        for (const e of p.setup ?? []) if (e?.apply === undefined) setupBad += 1;
      }
      const total = argsBad + bndBad + setupBad;
      return total === 0
        ? { pass: true, detail: `${proposals.length} proposals, every field executable` }
        : { pass: false, detail: `${argsBad} args · ${bndBad} boundaries · ${setupBad} setup entries are prose only` };
    },
    fix: "node .claude/charpilot/migrate-executable.mjs --write, then hand-write what it reports",
  },
  {
    id: "self-contained",
    question: "if this stage were handed to a subagent, is the brief complete?",
    run: () => {
      const proposals = allProposals();
      if (proposals === null) return { pass: false, detail: "no proposals directory — stage 3 has not started" };

      const { problems, mutations, awaitingRuling } = setupVerdict(proposals);

      // Staleness, same class of bug as a check reading an old behaviour.json.
      const handoff = join(REPO_ROOT, ".claude/charpilot/out/HANDOFF-stage4.md");
      if (!existsSync(handoff)) {
        problems.push("no HANDOFF artifact — run npm run pilot:handoff");
      } else {
        const hoTime = statSync(handoff).mtimeMs;
        const times = readdirSync(PROPOSALS_DIR).map((f) => statSync(join(PROPOSALS_DIR, f)).mtimeMs);
        // A CHECK THAT COMPARED NOTHING USED TO PASS.
        //
        // `Math.max()` of an empty list is `-Infinity`, so on an empty
        // proposals directory `newest > hoTime` is false and this staleness
        // check reported success having looked at no file at all. A check that
        // silently passes when it could not run is worse than one that fails:
        // it is the "green gate over an unasked question" this whole tool
        // exists to refuse, and it is exactly how a stale HANDOFF — the brief
        // the next stage is told is the only thing it needs to read — would
        // have survived a gate run.
        if (times.length === 0) {
          problems.push("no proposals to compare the HANDOFF against — nothing was checked for staleness");
        } else if (Math.max(...times) > hoTime) {
          problems.push("HANDOFF is older than the proposals it describes");
        }
      }

      const signed = mutations - awaitingRuling;
      const seeds = awaitingRuling
        ? `${awaitingRuling} create-form seed(s) journalled and reverse-replayed, \`confirmedBy\` awaiting a person's ruling on the pull request`
        : "";
      const detail = [
        `${mutations} shared-state mutation(s)`,
        signed ? `${signed} with a revert and an authorisation` : "",
        seeds,
      ]
        .filter(Boolean)
        .join(" · ");

      return problems.length
        ? {
            pass: false,
            detail: problems.slice(0, 3).join(" · ") + (problems.length > 3 ? ` · +${problems.length - 3}` : ""),
            // A check's own `run()` may override the static `fix` (main spreads
            // the result after the check), and this one has to: the old line
            // told EVERY apply.db to carry a `revert`, a `confirmedBy` and a
            // writable `urlVar`, which is the six-key shape record.mjs:605
            // refuses outright. Printed underneath a create-form seed it
            // instructs the agent to break the only shape that runs.
            fix: problems.some((s) => /db mutation with no|read-only URL|revert has been lost/.test(s))
              ? "give every NON-create `apply.db` a `revert`, a `confirmedBy` and a writable `urlVar` — a `{ create: { model, data }, why }` seed needs none of them (record.mjs journals the created id and reverse-replays it; `confirmedBy` is the reviewer's ruling, not a precondition) — then npm run pilot:handoff"
              : "npm run pilot:handoff — the HANDOFF must be newer than the proposals it describes",
          }
        : { pass: true, detail };
    },
    fix: "npm run pilot:handoff — and give every NON-create `apply.db` a `revert`, a `confirmedBy` and a writable `urlVar`",
  },
  {
    id: "reachability",
    stage: 4,
    question: "did u setup for all downstream calls to hit staging?",
    run: () => {
      // A MOCKED RUN HAS NO DOWNSTREAM TO REACH, so asking whether it set one up
      // is a question about a different run. This check asks whether staging is
      // addressable; under CHARPILOT_MODE=mocked every boundary is answered by a
      // double and preflight is not performed, so it failed on "no preflight has
      // been run" - which is true, correct, and not a defect.
      //
      // It went unnoticed because the stage default hid this check entirely. The
      // moment that default was fixed, every mocked run would have failed a gate
      // it had passed the day before - and a gate that fails a healthy run
      // teaches the next reader to stop reading it.
      const mode = declaredMode().mode;
      if (mode === "mocked") {
        return { pass: true, detail: "mocked — every boundary is answered by a double, so there is no staging to reach" };
      }
      // AND AN UNDECLARED RUN CANNOT BE JUDGED. 20260915T050314Z, the last
      // successful run, declared no mode and performed no preflight, and was
      // healthy. Failing it here would fail the run this whole gate was tuned
      // against.
      if (!mode) {
        return { pass: true, detail: "no CHARPILOT_MODE declared — whether staging had to be reachable is not knowable, so this is not judged" };
      }
      const path = join(REPO_ROOT, ".claude/charpilot/out/preflight.json");
      if (!existsSync(path)) {
        return {
          pass: false,
          detail: mode === "live"
            ? "CHARPILOT_MODE=live and no preflight has been run — stage 4 would record against addresses nobody checked"
            : "no preflight has been run, and no mode is declared, so this cannot be skipped as mocked either",
        };
      }
      const rows = read(path).rows ?? [];
      const wrong = rows.filter((r) => /DEFAULTS TO LOCALHOST/.test(r.note ?? ""));
      const unreachable = rows.filter((r) => r.status === "unreachable" || r.status === "unresolvable");
      const broken = [...new Set([...wrong, ...unreachable].map((r) => r.name))];
      if (broken.length) {
        return {
          pass: false,
          failingItems: broken,
          detail: `${broken.join(", ")} not reachable as staging${wrong.length ? " (localhost default = THIS machine)" : ""}`,
        };
      }
      return { pass: true, detail: `${rows.filter((r) => r.status === "reachable").length} reachable · ${rows.filter((r) => r.status === "forbidden").length} default-deny` };
    },
    fix: "node .claude/charpilot/preflight.mjs --env-file <staging .env>; supply the missing addresses or keep those boundaries mocked",
  },
  {
    id: "recorded-coverage",
    stage: 4,
    question: "did we actually record everything, or only the easy part?",
    run: () => {
      const { stale, doc } = readIfFresh("behaviour.json");
      if (stale) return stale;
      const total = doc.totals?.proposals ?? 0;
      const recorded = doc.totals?.recorded ?? 0;
      // `pending` and `unrunnable` are not the same failure and must not print
      // as one number. Pending means the run stopped early - rerun it. Unrunnable
      // means a harness has to be built. Reporting the sum let an unfinished run
      // read as a completed classification.
      const pending = doc.totals?.pending ?? 0;
      const unrunnable = doc.totals?.unrunnable ?? 0;
      const blocked = doc.totals?.blockedEgress ?? 0;
      const skipped = doc.totals?.notRecorded ?? doc.totals?.skipped ?? 0;
      // This check used to demand `skipped === 0`, which it can NEVER reach: a
      // proposal driven by a framework trigger, or needing a hand-built
      // arrangement, has a legitimate written reason and will never be a
      // recorded row. So the check sat permanently red on a condition no work
      // could satisfy - and a permanently red check is one everybody learns to
      // scroll past. That is the exact failure the hard-coded coverage
      // thresholds in this repo already demonstrate.
      //
      // The honest question is the ledger's: is every proposal EITHER recorded
      // OR carrying a reason, with nothing unaccounted? Plus two conditions a
      // written reason must not be allowed to excuse:
      //
      //   pending > 0        the run did not finish. Not a reason, a rerun.
      //   blocked egress     the proposal reaches a default-deny endpoint it
      //                      never declared a boundary for. That is a stage-3
      //                      DEFECT with a written reason - repairable, so it
      //                      must stay red until the boundary is declared. A
      //                      reason being written does not make it acceptable.
      const reasons = {};
      const unreasoned = [];
      for (const s of doc.skipped ?? []) {
        if (!s.reason || !String(s.reason).trim()) { unreasoned.push(s.id); continue; }
        const key = String(s.reason).replace(/ (src|export)\/?.*$/, "").replace(/:.*$/, "");
        reasons[key] = (reasons[key] ?? 0) + 1;
      }
      const accounted = recorded + blocked + unrunnable;
      const structural = unrunnable;
      const composition =
        `${recorded}/${total} recorded · ${structural} with a structural reason` +
        (blocked ? ` · ${blocked} blocked egress` : "") +
        (pending ? ` · ${pending} pending` : "");

      const problems = [];
      if (accounted !== total) problems.push(`accounting does not close: ${recorded}+${blocked}+${unrunnable} = ${accounted}, not ${total}`);
      if (unreasoned.length) problems.push(`${unreasoned.length} not-recorded proposal(s) carry no reason: ${unreasoned.slice(0, 3).join(", ")}`);
      if (pending) problems.push(`${pending} pending — the run did not finish, so this is a rerun, not a reason`);
      if (blocked) problems.push(`${blocked} reach a default-deny endpoint with NO boundary declared — a stage-3 defect, repairable`);

      if (!problems.length) {
        return {
          pass: true,
          detail:
            `${composition} · 0 unaccounted — every proposal is recorded or has a reason, and no reason is repairable`,
        };
      }
      return {
        pass: false,
        detail:
          `${composition} — ` + problems.join(" · ") +
          ` — reasons: ` +
          Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${n} ${r}`).join(" · "),
      };
    },
    // This `fix` line described a recorder that could not apply mocks, setup or
    // drivers. It can now, and the line stayed - so the gate was printing a
    // next action that had already been done. What is left is two different
    // things: rows needing a hand-built harness, and rows whose proposal never
    // declared a boundary for an endpoint it reaches.
    fix:
      "two separate jobs: (1) the `need a harness` rows want a hand-built arrangement — 15 of them set a private instance field, and their `setup.apply` is strictly weaker than the `setup.state` they claim, so injecting the field alone records a DIFFERENT arm; (2) the `blocked egress` rows are a stage-3 defect — the proposal reaches a default-deny endpoint it declared no boundary for, so add the boundary rather than opening the endpoint",
  },
    {
    id: "reaches-at-record-time",
    stage: 4,
    question: "did any row record the side it was trying to leave behind?",
    // THE ILLEGAL FOURTH PATH, closed. Three outcomes are legal for a side that
    // needs a database row: seed it (`setup.apply.db`), block it (a fenced
    // BLOCKED.md entry with a sourced reason), or be refused. The fourth - the
    // one run 20260915T033521Z took 119 times - is to record the "not found"
    // side silently and let stage 6 call it false, three hours later.
    //
    // Nothing read `falseClaimsAtRecordTime`. It was computed, written to the
    // artifact, printed, and then the run continued to emit, measure and loop.
    run: () => {
      // The LIVE recording when the run is live. `behaviour.json` is the mocked
      // corpus, and judging a live run by it is the same defect coverage.mjs's
      // BEHAVIOUR_FOR_RUN note describes - the file exists, the mtime is
      // recent, and the rows are of the other mode.
      const mode = declaredMode().mode;
      const wantsLive = mode === "live";
      const file = wantsLive ? "behaviour-live.json" : "behaviour.json";
      if (wantsLive && !existsSync(join(REPO_ROOT, ".claude/charpilot/out", file))) {
        return { pass: false, detail: `CHARPILOT_MODE=live but out/${file} does not exist — stage 4 has not recorded against staging` };
      }
      const { stale, doc } = readIfFresh(file);
      if (stale) return stale;
      // The proposals, because which of the two legal routes a row has to take
      // is decided by what it DECLARED against what the database returned - not
      // by the recording alone, and not by a guess.
      const v = recordTimeClaimVerdict(doc, allProposals() ?? []);
      if (v.unmeasured) return { pass: false, detail: v.unmeasured };
      if (!v.claims) {
        return { pass: true, detail: `${doc.totals?.claimsVerified ?? 0} claim(s) verified at record time, 0 false — out/${file}` };
      }
      const name = (r) =>
        `${r.id} (${r.claims[0]}${r.claims.length > 1 ? ` +${r.claims.length - 1}` : ""}` +
        `${r.starved.length ? ` · declared ${r.starved.join(", ")} non-empty, the database returned empty` : ""})`;
      return {
        pass: false,
        detail:
          `${v.claims} claim(s) across ${v.rows.length} row(s) are FALSE at RECORD time — each froze a different arm under its label · ` +
          `${v.seed.length} starved by a model read a \`create\` seed can fill, ` +
          `${v.raw.length} by raw SQL no \`create\` seed can steer, ` +
          `${v.input.length} not starved at all — the input does not select the side it claims · ` +
          [...v.seed, ...v.raw, ...v.input].slice(0, 4).map(name).join(" · "),
      };
    },
    fix: "each row has exactly three legal endings and this check refuses the fourth. (1) A side that needs a row: add `setup.apply.db { create: { model, data }, why }` — under --live it is journalled and reverse-replayed, and `self-contained` asks a create seed for no revert and no confirmedBy. (2) A side no input can reach: a fenced BLOCKED.md entry with a category and a sourced `proof`; it is accounted, not covered, and the denominator is untouched. (3) Neither: the input is wrong — repair the arm or the side it names. Rows listed as starved by RAW SQL are the hard case: `setup.apply.db` creates a row in a named model and cannot steer a `$queryRaw` similarity scan, so do NOT write a seed for those — either drive the subject directly with the data as an argument, or block the side. Rows with no empty DB read at all are not a seeding problem: the input simply does not select the side it claims",
  },
  {
    id: "toolset-sync",
    stage: 1,
    question: "does every install of this toolset match the source, or is some repo running an older copy?",
    // EVERY OTHER CHECK CARRIES ONE, AND THIS WAS THE ONLY ONE THAT DID NOT, so
    // the printer at the bottom of this file rendered `next:  undefined` for the
    // one failure that most needs a next step. The detail already names the
    // command; the reader should not have to find it in a sentence.
    fix: "npm run pilot:toolset -- --fix — it re-stamps every install from this source and REFUSES a locally-modified file rather than discarding the edit. A drifted install found under .stryker-tmp is a mutation sandbox, not an install: delete it.",
    // Drift was invisible for the whole life of this pipeline. install.sh wrote
    // INSTALLED.json with a sha per file and claimed toolset-integrity.mjs
    // verified it; that file did not exist, nothing read the manifest, and by
    // the time one was written 242 files had drifted across 14 installs - 11 of
    // 15 behind, two skill copies stale, and gate.mjs's own `validate` check
    // shelling out to a target's possibly-stale copy. A number measured with an
    // older toolset is not a number about this toolset.
    run: () => {
      const t = resolve(CONFIG_DIR, "toolset-integrity.mjs");
      if (!existsSync(t)) return { pass: true, detail: "toolset-integrity.mjs is not installed here - nothing to check against" };
      // execFileSync throws on a non-zero exit, and drift IS a non-zero exit, so
      // the payload is on the error rather than the return value.
      let raw;
      try {
        raw = execFileSync(process.execPath, [t, "--json"], { encoding: "utf8", cwd: REPO_ROOT });
      } catch (e) {
        raw = e.stdout ?? "";
      }
      let out;
      try {
        out = JSON.parse(raw);
      } catch {
        return { pass: true, detail: "toolset-integrity.mjs did not return JSON - cannot judge drift, so not failing on it" };
      }
      const bad = out.installs.filter((i) => i.behind.length + i.locallyModified.length + i.diverged.length + i.missing.length + i.unstamped.length > 0);
      if (!bad.length) return { pass: true, detail: `${out.installs.length} install(s) match the source, ${out.files} file(s) each` };
      return {
        pass: false,
        detail:
          `${out.drift} file(s) drifted across ${bad.length} of ${out.installs.length} install(s): ` +
          `${bad.slice(0, 4).map((i) => i.repo).join(", ")}${bad.length > 4 ? ` +${bad.length - 4}` : ""}. ` +
          `Resync with \`npm run pilot:toolset -- --fix\`; it refuses a locally-modified file rather than discarding an edit.`,
      };
    },
  },
{
    id: "generated-unedited",
    stage: 5,
    question: "has any generated test been hand-edited since it was emitted?",
    run: () => {
      const r = integrity();
      if (r.reason) return { pass: false, detail: r.reason };
      if (!r.ok) {
        return {
          pass: false,
          failingItems: r.problems.map((p) => p.file),
          // An edited generated file is this pipeline's committed `actual.json`:
          // an expected value nobody recorded, wearing the header that says one
          // did. Nothing else in the gate would notice it - every other check
          // reads the artifacts, and this reads the suite.
          detail: r.problems.map((p) => `${p.kind}: ${p.file}`).join(" · "),
        };
      }
      return { pass: true, detail: `${r.checked} generated file(s) unedited since ${r.emittedAt ?? "the last emit"}` };
    },
    fix: "node .claude/charpilot/emitted-integrity.mjs names the files. A failing generated test is a behaviour CHANGE — re-record the row and `npm run pilot:emit`; never edit the expected value until it passes. A test you meant to hand-write belongs outside test/characterization, where it stops claiming a run produced it",
  },
  {
    id: "progress",
    stage: 6,
    question: "what has each iteration of the loop actually bought?",
    run: () => {
      const path = join(REPO_ROOT, ".claude/charpilot/out/loop.json");
      if (!existsSync(path)) return { pass: false, detail: "no loop ledger — stage 6 has not measured this tree" };
      const rows = read(path).iterations ?? [];
      if (!rows.length) return { pass: false, detail: "loop ledger holds 0 iterations" };
      const last = rows[rows.length - 1];
      // A row that measured nothing is not a data point about progress. The
      // default `--specs` pointed at the recorder's throwaway directory, so a
      // bare `pilot:coverage` produced a row crediting characterization with 0
      // sides and 452 false claims - and a flat sequence of those rows would
      // have read as a stalled loop rather than as a measurement of the wrong
      // suite. Refuse the row instead of interpreting it.
      if (!last.specsMeasured) {
        return { pass: false, detail: `iteration ${last.n} measured ${last.specsMeasured ?? "an unrecorded number of"} spec file(s) in ${last.specs ?? "an unrecorded directory"} — the row describes no suite` };
      }
      if (last.hitByCharacterization === 0) {
        return {
          pass: false,
          detail: `iteration ${last.n} credits the characterization suite with 0 of ${last.sides} sides from ${last.specsMeasured} spec file(s) in ${last.specs} — measure the committed suite, not a stale generation`,
        };
      }
      const shape = rows.slice(-4).map((r) => (r.newSides === null ? "·" : `${r.newSides >= 0 ? "+" : ""}${r.newSides}`)).join(" ");
      // Two consecutive flat iterations. This is the ONE check whose subject is
      // the agent rather than the code: an unattended 3→4→5→6 loop asks the
      // agent to judge its own progress, and the pilot's account of what that
      // costs is exact - the recording lane stalled, no rule said what to do,
      // and 572 tests were written whose every value came from running the
      // agent's own suite, reported as success because no written rule had been
      // broken. A rule in the skill the agent reads cannot catch that. A row
      // written by coverage.mjs can.
      // A flat iteration is NOT a failure, and this used to say it was.
      //
      // The reasoning was that an unattended loop needs a stall signal, and the
      // incident behind it - a stalled recorder, 572 tests written from the
      // agent's own suite - is real. But that incident is caught DIRECTLY by
      // `no-echoed-plan` (0 rows invoked is a STOP) and by `reaches-verified` (a
      // claim the input never reached), and a coverage trend is a proxy for
      // both. Meanwhile a flat iteration is frequently correct: the sides that
      // remain may all be waiting on a stage-7 ruling. Measured here, it cried
      // wolf immediately - re-measuring an unchanged tree printed STALLED with
      // no work attempted, and a check that fires on a healthy loop is one
      // nobody reads when it is finally right.
      //
      // So the history is reported and the verdict is left to the checks that
      // fail on a defect rather than on a plateau.
      const flat = rows.filter((r) => r.newSides === 0);
      return {
        pass: true,
        detail:
          `iteration ${last.n} · ${shape} · ${last.hitByEither}/${last.sides} by either suite · ${last.stillUncovered} still uncovered` +
          (flat.length ? ` · ${flat.length} flat iteration(s) - not a failure, but ask whether another is worth its cost` : ""),
      };
    },
    fix: "Nothing here fails on a plateau. If the history is flat and sides remain, STOP and report what is left — do not widen the run, and never record a value from the suite's own output. The remaining sides are one of three things and each has its own exit: a repairable input (a false claim is a stage-3 defect, not a failed run), a side no input can reach (stage 7 — price the suppression, put it in decisions.json with a `by`), or an oracle limit (a function-entry or statement unit istanbul's branch map cannot verify, which is said plainly rather than verdicted)",
  },
  {
    id: "reaches-verified",
    stage: 6,
    question: "did the input actually reach the side it was written for?",
    run: () => {
      const { stale, doc } = readIfFresh("coverage.json");
      if (stale) return stale;
      const t = doc.totals ?? {};
      const f = t.claimsFalse ?? 0;
      if (!f) return { pass: true, detail: `${t.claimsVerified ?? 0} of ${t.claimsChecked ?? 0} claims verified against istanbul` };
      return {
        pass: false,
        detail:
          `${f} of ${t.claimsChecked} claims are FALSE — ${t.claimsFalseClosureNotInvoked ?? 0} closure-not-invoked, ` +
          `${t.claimsFalsePathNotTaken ?? 0} path-not-taken · ${t.claimsUnmeasurable ?? 0} unmeasurable`,
      };
    },
    fix: "a false claim means the stage-4 pair froze a DIFFERENT arm under this label. `closure-not-invoked`: the driver returns a function and the arm lives inside it, so the entry recipe has to CALL the returned closure. `path-not-taken`: a declared boundary short-circuits the path, or the input does not select the side it claims — repair the input, do not relabel the arm",
  },
  {
    id: "coverage-ratchet",
    stage: 6,
    question: "did the union of suite + characterization go up, and never down?",
    run: () => {
      const { stale, doc } = readIfFresh("coverage.json");
      if (stale) return stale;
      const t = doc.totals ?? {};
      const base = t.baselineSuiteCovered ?? null;
      const either = t.hitByEither ?? 0;
      const sides = t.sides ?? 0;
      // istanbul, not v8: the denominator is fixed by the source, so this
      // comparison is meaningful. Under v8 the denominator grows as tests are
      // added and a ratchet is impossible.
      if (base === null) return { pass: false, detail: "baseline records no branch total to ratchet against" };
      if (either < base) return { pass: false, detail: `union ${either} is BELOW the ${base} the suite already covered — a regression` };

      // All THREE unit kinds, not just branch sides. Functions and statements
      // were computed at stage 6 and printed, then dropped before the artifact
      // was written, so they could be driven, measured and silently lost. A
      // branch side being the only unit that survives a persistence boundary is
      // the same blind spot that made 26 functions invisible to the work list.
      const regressions = [];
      for (const [label, cov, was] of [
        ["function entries", t.functionsCovered, t.baselineFunctionsCovered],
        ["statements", t.statementsCovered, t.baselineStatementsCovered],
      ]) {
        if (cov === undefined || was === null || was === undefined) {
          regressions.push(`${label}: not recorded — re-run \`npm run pilot:coverage\` to get a ratchetable figure`);
        } else if (cov < was) {
          regressions.push(`${label}: ${cov} is BELOW the ${was} the suite already covered — a regression`);
        }
      }
      if (regressions.length) return { pass: false, detail: regressions.join(" · ") };

      return {
        pass: true,
        detail:
          `sides ${either}/${sides} (${sides ? ((either / sides) * 100).toFixed(2) : "0.00"}%), suite alone ${base}, +${either - base} · ` +
          `functions ${t.functionsCovered}/${t.functionsTotal} (was ${t.baselineFunctionsCovered}) · ` +
          `statements ${t.statementsCovered}/${t.statementsTotal} (was ${t.baselineStatementsCovered})`,
      };
    },
    fix: "re-run stage 5; if the union really fell, an input that used to reach a side no longer does",
  },
  {
    id: "rate-target",
    stage: 6,
    question: "did this run reach the rate its mode is held to?",
    // THE CHECK NOTHING WAS DOING. `coverage-ratchet` above asks whether the
    // union fell below what the pre-existing suite already covered - a
    // different question, and one that run 20260915T033521Z passed comfortably
    // at 65.9% because the existing suite covered less. A ratchet answers "did
    // it go down". This answers "did it get there", and without it a dispatch
    // that landed thirty points low exited 0 and opened a pull request.
    //
    // It reads the same `rateVerdict` report.mjs does, so the gate and
    // result.json cannot reach opposite verdicts on one artifact - the failure
    // that put `claimsFalse` in coverage.json and `succeeded` in result.json.
    //
    // It compares the LIVE-CODE rate and prints the raw pair beside it. A
    // compliant run deletes the characterization tests written for dead
    // exports, so it can never cover those sides, and a target on the raw rate
    // is one the pipeline's own stage-2b rule forbids reaching.
    run: () => {
      const { stale, doc } = readIfFresh("coverage.json");
      if (stale) return stale;
      const verdict = rateVerdict(doc.totals ?? null, doc.mode ?? null);
      // NOT A PASS AND NOT A SHORTFALL. A comparison that could not be made is
      // its own failure and says which input made it impossible - never a
      // fallback to a number that means something else.
      // UNJUDGEABLE IS NOT SHORT. A run that declared no mode has no target to
      // be held to - that is a fact about its provenance, not about its
      // coverage - so the rate is printed and the check passes. Over the 127
      // runs on record (nodejs/tests/fixtures/runs-on-record.json), 97 wrote a
      // result.json and only 10 declared a mode, so this is the common case
      // and not the edge one. This comment used to say "2 of the 3 real runs
      // on disk, the last successful one among them" - a count from when there
      // were three runs, and a "last successful" that names a stamp with no
      // directory anywhere; see `targets.mjs` for both. Failing these runs
      // would fail a gate they passed the day before.
      if (verdict.unjudgeable) {
        const raw = doc.totals?.sides
          ? ` — raw ${Math.round((doc.totals.hitByEither / doc.totals.sides) * 1000) / 10}% (${doc.totals.hitByEither}/${doc.totals.sides})`
          : "";
        return { pass: true, detail: `${verdict.unjudgeable}${raw}` };
      }
      if (verdict.error) return { pass: false, detail: verdict.error };
      return { pass: verdict.pass, detail: verdict.detail };
    },
    fix: "the target does not move. Either derive inputs for the live-code sides out/coverage.json lists in `stillUncovered`, or - for a side no input can reach - write the fenced BLOCKED.md entry stage 7 prices. If the mode is unstamped, set CHARPILOT_MODE=live or CHARPILOT_MODE=mocked and re-run `npm run pilot:coverage`; a rate is not comparable across modes, which is why runcmp.py refuses that comparison too. To change a target, edit DEFAULT_TARGETS in .claude/charpilot/targets.mjs and say what run justifies the new number, or set CHARPILOT_TARGET_BRANCHES_LIVE / _MOCKED for one run - it prints its own source so a threshold a person moved never reads as one the tool derived",
  },
  {
    id: "suppressions",
    stage: 7,
    question: "what did each `istanbul ignore` remove, and did a person rule it?",
    run: () => {
      const { rows, total, error } = priced();
      if (error) return { pass: false, detail: error };
      if (!rows.length) return { pass: true, detail: "no directives in src" };
      const unfit = rows.filter((r) => r.problems.length);
      // A directive is a standing claim that some sides cannot run. Three
      // things make it fit to be ruled, and all three were violated at least
      // once in this pilot: `-- @preserve` (esbuild strips the comment first,
      // so without it the ignore silently does nothing), the standing
      // instruction (or the next person deletes the comment and ships a live
      // unasserted branch), and a fenced BLOCKED.md entry (or the reason exists
      // only in a commit message).
      //
      // The count is deliberately loud. 33 directives took 50 sides out of the
      // denominator here, 36 of them exercised, and a percentage quoted without
      // that number is a different percentage.
      if (unfit.length) {
        return {
          pass: false,
          failingItems: unfit.map((r) => r.id),
          detail: `${unfit.length} of ${rows.length} directive(s) not fit to be ruled — ${total} side(s) suppressed in total`,
        };
      }
      const inert = rows.filter((r) => r.sides === 0);
      return {
        pass: true,
        detail:
          `${rows.length} directive(s) · ${total} side(s) out of the denominator` +
          (inert.length ? ` · ${inert.length} suppress NOTHING (check placement)` : ""),
      };
    },
    fix: "node .claude/charpilot/suppressions.mjs — every directive needs `-- @preserve`, the standing instruction, and a fenced BLOCKED.md entry. A directive that removes 0 sides is inert: either it is in the wrong place (a directive on an object property inside a call argument does nothing) or it guards code that was already out of the denominator. Once fit, rule it in decisions.json with the measured cost so the price is reprinted every run",
  },
  {
    id: "mutation",
    // STAGE 7, not 8. Stage 7 is where a person signs off and a number gets
    // published, and this is the only check on whether the recorded pairs
    // assert anything - so a branch percentage must not print green beside 22
    // other ticks while assertion strength is unmeasured. Measured on a freshly
    // onboarded repo: `gate --stage 7` printed 21 of 23 green and the run
    // reported 56.86% branch coverage with stryker never installed and this
    // check never selected, because the filter is `(c.stage ?? 3) <= STAGE`.
    // Installing stryker (install.sh does now) does not mean anyone ran it;
    // nothing demanded the run, and that absence is what this moves.
    stage: 7,
    question: "would the recorded pairs fail if someone changed the logic?",
    run: () => {
      const path = join(REPO_ROOT, "reports/mutation/mutation.json");
      if (!existsSync(path)) {
        // Say WHICH of the three it is, because the next action differs: no
        // runner installed, no config naming a slice, or a run that never
        // happened. `install.sh` now installs the runner and refuses if it
        // cannot, but it deliberately does not write stryker.conf.json - the
        // `mutate` list is the slice under test, which is a decision, and an
        // empty or guessed list produces a score for code nobody chose.
        const hasRunner = existsSync(join(REPO_ROOT, "node_modules/@stryker-mutator/core"));
        const hasConf = existsSync(join(REPO_ROOT, "stryker.conf.json"));
        return {
          pass: false,
          detail:
            "no mutation report — assertion strength is UNMEASURED, so no branch percentage here is known to be asserted on" +
            (!hasRunner ? " · @stryker-mutator/core is not installed (bash .claude/charpilot/install.sh <package-root>)" : "") +
            (hasRunner && !hasConf ? " · no stryker.conf.json naming the slice to mutate" : "") +
            (hasRunner && hasConf ? " · `npm run pilot:mutate` has not run for this tree" : ""),
        };
      }
      const report = read(path);
      const files = Object.entries(report.files ?? {});
      if (!files.length) return { pass: false, detail: "mutation report contains no files" };
      let killed = 0, survived = 0, noCov = 0, timeout = 0;
      const worst = [];
      for (const [file, f] of files) {
        let k = 0, sv = 0;
        for (const m of f.mutants ?? []) {
          if (m.status === "Killed") { killed += 1; k += 1; }
          else if (m.status === "Survived") { survived += 1; sv += 1; }
          else if (m.status === "NoCoverage") noCov += 1;
          else if (m.status === "Timeout") timeout += 1;
        }
        if (k + sv) worst.push({ file: file.replace(`${REPO_ROOT}/`, ""), score: (k / (k + sv)) * 100, sv });
      }
      // Stryker's OWN formula, so the gate and the runner cannot disagree about
      // the number the runner's threshold enforces:
      //   mutationScore = (killed + timeout) / (killed + timeout + survived + noCoverage)
      // The first version of this check used killed/(killed+survived), which on
      // the same report read 68.26% where stryker read 63.81% - and that 4.45
      // point gap was then misattributed to an improvement in the suite. Two
      // formulas over one report are not a before and an after.
      const scored = killed + timeout + survived + noCov;
      const score = scored ? ((killed + timeout) / scored) * 100 : 0;
      worst.sort((a, b) => a.score - b.score);
      // Everything else in this pipeline verifies the INPUTS are well formed.
      // This is the only check on the assertions, and it is the reason a 100%
      // branch figure is not the end: measured at 63.81% on a slice of files
      // sitting at exactly 100% branch coverage.
      const detail =
        `${score.toFixed(2)}% · ${killed} killed · ${survived} survived · ${noCov} no-coverage` +
        (timeout ? ` · ${timeout} timeout` : "") +
        (worst.length ? ` · weakest ${worst[0].file} ${worst[0].score.toFixed(0)}%` : "");
      // The threshold lives in stryker.conf.json so one number governs both the
      // runner's exit code and this check.
      const brk = existsSync(join(REPO_ROOT, "stryker.conf.json"))
        ? read(join(REPO_ROOT, "stryker.conf.json")).thresholds?.break ?? null
        : null;
      if (brk !== null && score < brk) return { pass: false, detail: `${detail} — below the break threshold of ${brk}` };
      return { pass: true, detail };
    },
    fix: "npm run pilot:mutate for the slice you changed, then `npm run pilot:mutants` to fold the verdicts into proposals/BLOCKED.md. A SURVIVOR is a line a test executes and nothing asserts on; an equivalent mutant (one that cannot change observable behaviour) is triage, not a gap. Raise the score by asserting more of what stage 4 already recorded — the call ledger before the return value — not by adding tests",
  },
  {
    id: "determinism",
    stage: 4,
    question: "does every recorded row say whether its value came out the same twice?",
    run: () => {
      const { stale, doc } = readIfFresh("behaviour.json");
      if (stale) return stale;
      const rows = doc.rows ?? [];
      if (!rows.length) return { pass: false, detail: "0 rows" };
      const missing = rows.filter((r) => !r.determinism);
      const unchecked = rows.filter((r) => r.determinism && r.determinism.compared === false);
      const unstable = rows.filter((r) => r.determinism?.compared && r.determinism.stable === false);
      if (missing.length) {
        return { pass: false, detail: `${missing.length} of ${rows.length} row(s) carry no determinism verdict — an absent field means the row was never checked, not that it is stable` };
      }
      if (unchecked.length) {
        return { pass: false, detail: `${unchecked.length} row(s) were not compared (absent from the second observation) — UNCHECKED, not stable` };
      }
      return {
        pass: true,
        detail: `${rows.length} row(s) verdicted · ${unstable.length} carry per-run identity, with the unstable paths named so stage 5 excludes exactly those`,
      };
    },
    fix: "npm run pilot:determinism -- --write. The verdict has to live ON the row: a side file can be skipped, can go stale against the recording it judges, and can only ever cover a subset - all three of which happened here (determinism.json was two days older than the behaviour.json it judged, and its `rowsCompared` counted rows that EXISTED rather than rows compared). An absent field is the signal that a row was never double-observed",
  },
  {
    id: "no-echoed-plan",
    stage: 4,
    question: "does any recorded pair merely echo the plan it was supposed to test?",
    run: () => {
      const { stale, doc } = readIfFresh("behaviour.json");
      if (stale) return stale;
      const harness = (doc.rows ?? []).filter((r) => r.harnessError).length;
      const recorded = (doc.rows ?? []).filter((r) => r.invoked).length;
      if (recorded === 0) return { pass: false, detail: "0 rows invoked — a stalled recorder is a STOP, not a shrug" };
      // A trustworthy value with an incomplete call list is neither a pass to
      // hide nor a failure to block on: the row is real, and stage 6 has to
      // know not to assert on its call list. So it is reported on the pass.
      const late = doc.totals?.egressAfterSettle ?? 0;
      const lateNote = late ? ` · ${late} row(s) had a fire-and-forget call refused AFTER settling — value is sound, call list is NOT complete` : "";
      return harness === 0
        ? { pass: true, detail: `${recorded} observed, 0 harness failures${lateNote}` }
        : { pass: false, detail: `${harness} rows failed in the harness, not the service — fix the harness before reading any of them` };
    },
    fix: "node .claude/charpilot/record.mjs — a module-resolution or env error is never behaviour",
  },
];

/**
 * A check has three outcomes, not two.
 *
 * `fail` means work is outstanding. `accepted` means a person ruled on it and
 * the ruling is recorded — a shared address that will not be supplied, a
 * provider with no staging row. Without this distinction the gate sits
 * permanently red on unmade decisions, and a permanently red gate is one nobody
 * runs. The coverage thresholds already in this repo are the cautionary example.
 *
 * An accepted item is still PRINTED every run, with its reason and who ruled.
 * That is the difference between recording a decision and hiding a failure.
 */
/**
 * What the artifacts say about a ruled item RIGHT NOW, in one line per item.
 * Only reads evidence that already exists; says so plainly when there is none.
 */
function currentEvidence(d) {
  if (d.check !== "reachability") return [];
  const path = join(REPO_ROOT, ".claude/charpilot/out/preflight.json");
  if (!existsSync(path)) return ["no preflight artifact to compare the reason against"];
  const rows = read(path).rows ?? [];
  const env = join(REPO_ROOT, ".claude/charpilot/out/staging.env");
  const envNames = existsSync(env)
    ? new Set(envNames(readFileSync(env, "utf8")))
    : new Set();
  const VAR = { redis: "REDIS_HOST", zipkin: "ZIPKIN_COLLECTOR_ENDPOINT", slack: "SLACK_HOOK" };
  return (d.items ?? [d.item]).filter(Boolean).map((item) => {
    const row = rows.find((r) => r.name === item);
    const v = VAR[item];
    const setBy = v ? (envNames.has(v) ? `staging.env DOES set ${v}` : `staging.env sets no ${v}`) : "no env var mapped";
    return `${item}: preflight says ${row?.status ?? "not probed"} \u00b7 ${setBy}`;
  });
}

function loadDecisions() {
  const path = join(REPO_ROOT, ".claude/charpilot/decisions.json");
  if (!existsSync(path)) return [];
  return read(path).decisions ?? [];
}

function main() {
  const checks = CHECKS.filter((c) => (c.stage ?? 3) <= STAGE);
  const decisions = loadDecisions();
  const results = [];
  for (const c of checks) {
    let r;
    try {
      r = c.run();
    } catch (err) {
      // A NON-ERROR THROW USED TO ESCAPE THE GATE FROM INSIDE ITS OWN CATCH.
      //
      // `err.message.slice` is a TypeError when what was thrown is a string, a
      // number, null, or an object with no `message` — and a TypeError raised
      // inside the handler is not caught by it, so the gate died with a stack
      // trace instead of reporting a failing check. The gate is the thing that
      // decides whether a stage is closed; it has to survive every one of its
      // own checks, including the ones that throw something unusual, or one bad
      // check takes the verdict on all the others with it.
      const detail = typeof err?.message === "string" ? err.message : String(err);
      r = { pass: false, detail: detail.slice(0, 160) };
    }
    // Item-level rulings. A check that fails on several items reports them, and
    // only the ruled ones are subtracted - a partial ruling must NOT turn the
    // whole check green, which crude substring matching would have done.
    const rulings = decisions.filter((d) => d.check === c.id);
    if (!r.pass && r.failingItems?.length) {
      const ruledItems = new Set(rulings.flatMap((d) => d.items ?? (d.item ? [d.item] : [])));
      const unruled = r.failingItems.filter((i) => !ruledItems.has(i));
      const applied = rulings.filter((d) => (d.items ?? [d.item]).some((i) => r.failingItems.includes(i)));
      if (unruled.length === 0) {
        results.push({ ...c, ...r, pass: false, ruling: applied[0], appliedRulings: applied, detail: `${r.failingItems.join(", ")} — all ruled` });
        continue;
      }
      results.push({ ...c, ...r, detail: `${unruled.join(", ")} unruled${applied.length ? ` (${applied.flatMap((d) => d.items ?? [d.item]).join(", ")} ruled)` : ""}` });
      continue;
    }
    const whole = rulings.find((d) => !d.item && !d.items);
    results.push({ ...c, ...r, ruling: !r.pass && whole ? whole : undefined });
  }

  const failed = results.filter((r) => !r.pass && !r.ruling);
  const accepted = results.filter((r) => r.ruling);

  // A ruling that matches no check is dead config, and dead config rots
  // silently. Report it rather than let decisions.json drift out of step.
  // Compare against EVERY check, not only the ones this stage runs. A stage-4
  // ruling seen from a stage-3 run names a check that exists, so calling it
  // dead config is a false alarm - and this one fired on all three reachability
  // rulings every stage-3 run. A gate that cries stale about valid config is a
  // gate people learn to scroll past, which is the failure mode the three
  // outcomes exist to avoid.
  const allIds = new Set(CHECKS.map((c) => c.id));
  const dangling = decisions.filter((d) => !allIds.has(d.check));
  process.stdout.write(`\ncharpilot gate — stage ${STAGE}\n\n`);
  for (const r of results) {
    const mark = r.pass ? "\u2713" : r.ruling ? "\u25cb" : "\u2717";
    process.stdout.write(`  ${mark} ${r.id.padEnd(Math.max(15, ...checks.map((c) => c.id.length)) + 1)}${r.detail}\n`);
    if (r.ruling) {
      for (const d of r.appliedRulings ?? [r.ruling]) {
        process.stdout.write(
          `      ruled: ${(d.items ?? [d.item]).join(", ")} \u2192 ${d.ruling} \u2014 ${d.why}\n` +
            `      by:    ${d.by}, ${d.on}\n`
        );
        // A ruling's CONCLUSION can stay right while the reason it gives goes
        // stale. Both the redis and zipkin rulings say staging's .env "sets no"
        // their host - it now sets both, and they are unreachable for a
        // different reason (cluster-internal DNS, unresolvable off-cluster).
        // Rewriting someone else's recorded words is not the fix; printing
        // today's evidence next to them is, so a reader compares instead of
        // trusting.
        for (const line of currentEvidence(d)) process.stdout.write(`      today: ${line}\n`);
      }
    } else if (!r.pass) {
      process.stdout.write(`      asked: "${r.question}"\n      next:  ${r.fix}\n`);
    }
  }

  const acceptedNote = accepted.length ? ` \u00b7 ${accepted.length} accepted by ruling` : "";
  process.stdout.write(
    failed.length === 0
      ? `\n\u2713 stage ${STAGE} is closed${acceptedNote}. Every question a reviewer had to ask during the pilot is a check above.\n`
      : `\n\u2717 ${failed.length} of ${results.length} checks failing${acceptedNote}. Work the "next" lines top-down.\n`
  );
  if (dangling.length) {
    process.stdout.write(
      `\n  \u26a0 ${dangling.length} entr${dangling.length === 1 ? "y" : "ies"} in decisions.json name${dangling.length === 1 ? "s" : ""} no check that runs at this stage:\n` +
        dangling.map((d) => `      "${d.check}" \u2014 ${d.item ?? "(no item)"}\n`).join("") +
        "    Either the check was renamed or the ruling is stale. A ruling for nothing\n" +
        "    suppresses nothing, but it reads as though something was decided.\n"
    );
  }
  if (accepted.length) {
    process.stdout.write(
      "\n  An accepted check is a recorded decision, not a fix. It is reprinted every run\n" +
        "  so it cannot quietly become the status quo. Remove the entry from\n" +
        "  .claude/charpilot/decisions.json to make it fail again.\n"
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead - which happened three
// times in one session: importing exec.mjs to read one function overwrote
// exec-rows.json, importing record.mjs to check it loaded started a 366-row
// recording, and importing diversity.mjs for its shape signature ran the whole
// census AND consumed the caller's own --json argument.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}