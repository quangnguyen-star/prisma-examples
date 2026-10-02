#!/usr/bin/env node
/**
 * Stage 8's durable half - turn a mutation run into a record.
 *
 * A stryker run mutates source in a sandbox, runs the suite, and reverts. If
 * every mutant dies, the console prints a score and the run leaves NOTHING: no
 * diff, no artifact a reviewer sees, no evidence it ever happened. That is the
 * same failure shape stage 7 had before it became a gate check - a decision
 * that lived in a conversation.
 *
 * So three things are recorded, and each is reviewable:
 *
 *   1. `reports/stryker-incremental.json` is COMMITTED. A new survivor appears
 *      as a diff on a line, attributable in `git log`.
 *   2. `thresholds.break` in stryker.conf.json makes a score regression a
 *      non-zero exit rather than a number someone has to notice.
 *   3. This script writes a `mutant:` field back into each proposals/BLOCKED.md
 *      entry, so a suppression's audit result is in the same file as its proof.
 *
 * Stryker does not read `istanbul ignore`; it mutates the source text. So it
 * still generates mutants on the sides directives removed from the coverage
 * denominator - the only check in this pipeline that still looks at them.
 *
 * BUT NOT the way it first appears, and the first version of this script had
 * the rule backwards. "A killed mutant on a suppressed line falsifies the
 * suppression" is FALSE. Measured on `requestQueue.middleware.ts:39`,
 * `if (!item) continue`, whose `then` side is dead:
 *
 *   Killed     ConditionalExpression -> "true"    forces `continue` on EVERY item
 *   Survived   ConditionalExpression -> "false"   forces the condition to what it always is
 *
 * Forcing a condition INTO its dead direction changes behaviour and dies
 * whether or not the side is reachable. The kill says nothing. The SURVIVOR is
 * the evidence, and which mutant carries it depends on which side is dead:
 *
 *   dead `then`  ->  `-> false` must SURVIVE. If it is killed, some test takes the then.
 *   dead `else`  ->  `-> true`  must SURVIVE. If it is killed, some test takes the else.
 *
 * So the verdict is direction-aware, read from the entry's own `side:` field,
 * and only `if` branches can be audited this way at all. A `binary-expr`,
 * `cond-expr` or `default-arg` arm has no such pair - `langfuse.service.ts:13`,
 * a default argument, produced ZERO mutants - and is reported as unauditable
 * rather than guessed at.
 *
 *   node .claude/charpilot/mutants.mjs [--report <file>] [--write]
 *
 * Exit 1 if any mutant at a suppressed line was killed. `--write` updates
 * BLOCKED.md; without it the script only reports.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { REPO_ROOT } from "./config.mjs";
import { priced } from "./suppressions.mjs";

const ARGV = process.argv.slice(2);
const REPORT = join(
  REPO_ROOT,
  ARGV.includes("--report") ? ARGV[ARGV.indexOf("--report") + 1] : "reports/mutation/mutation.json"
);
const WRITE = ARGV.includes("--write");
const BLOCKED_MD = join(REPO_ROOT, ".claude/charpilot/proposals/BLOCKED.md");

/** Flatten the mutation-testing-elements report into one row per mutant. */
function mutants() {
  if (!existsSync(REPORT)) return { error: `${REPORT} missing - run \`npx stryker run\` first` };
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const rows = [];
  for (const [file, f] of Object.entries(report.files ?? {})) {
    for (const m of f.mutants ?? []) {
      rows.push({
        file,
        line: m.location?.start?.line,
        mutator: m.mutatorName,
        status: m.status,
        replacement: m.replacement,
      });
    }
  }
  return { rows, version: report.thresholds ? report.schemaVersion : undefined };
}

/**
 * The lines a directive actually took sides from - nothing wider.
 *
 * The first version of this used "everything between this directive and the
 * next one in the file", which for a file with a single directive is the rest
 * of the file. It reported four falsifications on mutants dozens of lines away
 * from the suppressed statement: a `BlockStatement -> {}` at
 * langfuse.service.ts:15 has nothing to do with the default argument at :13.
 * A verdict this loud has to be exact, so the audit reads the per-line side
 * counts `suppressions.mjs` measured and looks at those lines only.
 */
function suppressedRanges() {
  return priced().rows.map((r) => ({ ...r, auditLines: new Set((r.lines ?? []).map((l) => l.line)) }));
}

function main() {
  const { rows, error } = mutants();
  if (error) {
    process.stdout.write(`\n  ! ${error}\n`);
    process.exit(2);
  }
  const ranges = suppressedRanges();

  // one verdict per directive, from the mutants inside its range
  const verdicts = [];
  for (const r of ranges) {
    const mine = rows.filter((m) => m.file === r.file && r.auditLines.has(m.line));
    if (!mine.length) continue; // that file was not in this run's `mutate` slice
    const killed = mine.filter((m) => m.status === "Killed");
    const survived = mine.filter((m) => m.status === "Survived");
    const noCov = mine.filter((m) => m.status === "NoCoverage");
    verdicts.push({ ...r, mutants: mine.length, mutants_all: mine, killed, survived, noCov });
  }

  process.stdout.write(`\nstage 8 - suppression audit (${rows.length} mutants in this run)\n\n`);
  if (!verdicts.length) {
    process.stdout.write("  no directive fell inside this run's mutate slice\n");
    return;
  }
  process.stdout.write(
    `  ${"directive".padEnd(46)}${"sides".padStart(5)}${"mut".padStart(5)}${"kill".padStart(5)}${"surv".padStart(5)}${"nocov".padStart(6)}  verdict\n`
  );
  const falsified = [];
  for (const v of verdicts.sort((a, b) => b.mutants - a.mutants)) {
    // The mutant that forces the condition AWAY from its dead side. If the side
    // really cannot run, forcing the condition to the value it always has
    // changes nothing and the mutant survives. A KILL there means some test
    // does take the dead side.
    // Which forced value would leave behaviour unchanged if the side is dead.
    //
    // The first version matched only "then" and "else" and so reported the
    // COMMONEST case as unauditable: `whenFalse` is 14 of the 31 entries -
    // a cond-expr's else arm, which has exactly the same witness pair as an
    // if's. `whenTrue` is its mirror. Everything else - a binary-expr operand
    // recorded as `null`, `0`, `""` or `false`, or a prose sentence - genuinely
    // has no condition to force, and stays unauditable.
    const side = v.entry?.side;
    const want =
      side === "then" || side === "whenTrue"
        ? "false"
        : side === "else" || side === "whenFalse"
          ? "true"
          : null;
    const witness = want
      ? v.mutants_all.find((m) => m.mutator === "ConditionalExpression" && m.replacement === want)
      : undefined;
    const bad = Boolean(want && witness && witness.status === "Killed");
    if (bad) falsified.push({ ...v, witness, want });
    const verdict = bad
      ? `FALSIFIED - forcing the condition to ${want} was KILLED, so a test takes the ${side}`
      : v.sides === 0
        ? "inert directive, nothing suppressed"
        : !want
          ? `not auditable by mutation (${side ?? "no side"} - no condition pair)`
          : witness
            ? `consistent with dead (-> ${want} survived)`
            : `no witness mutant generated`;
    process.stdout.write(
      `  ${`${v.file}:${v.line}`.padEnd(46)}${String(v.sides).padStart(5)}${String(v.mutants).padStart(5)}` +
        `${String(v.killed.length).padStart(5)}${String(v.survived.length).padStart(5)}${String(v.noCov.length).padStart(6)}  ${verdict}\n`
    );
  }

  if (WRITE) {
    let md = readFileSync(BLOCKED_MD, "utf8");
    const stamp = new Date().toISOString().slice(0, 10);
    let written = 0;
    md = md.replace(/```blocked\n([\s\S]*?)```/g, (whole, body) => {
      const arm = body.match(/^arm:\s*(\S+)/m)?.[1];
      if (!arm) return whole;
      const file = arm.split("#")[0];
      const armLine = Number(arm.split("#")[1]?.split(":")[0]);
      const v = verdicts.find((x) => x.file === file && x.auditLines.has(armLine));
      if (!v) return whole;
      const side = v.entry?.side;
      const want =
        side === "then" || side === "whenTrue"
          ? "false"
          : side === "else" || side === "whenFalse"
            ? "true"
            : null;
      const witness = want
        ? v.mutants_all.find((m) => m.mutator === "ConditionalExpression" && m.replacement === want)
        : undefined;
      const status = !want
        ? "not auditable by mutation - no condition pair for this arm kind"
        : !witness
          ? "no witness mutant generated"
          : witness.status === "Killed"
            ? `FALSIFIED - forcing the condition to ${want} was killed`
            : `consistent with dead - forcing the condition to ${want} survived`;
      const line = `mutant: ${status} (${v.killed.length}k/${v.survived.length}s/${v.noCov.length}n, stryker ${stamp})`;
      written += 1;
      const next = /^mutant:/m.test(body)
        ? body.replace(/^mutant:.*$/m, line)
        : body.replace(/^(killer:.*)$/m, `$1\n${line}`);
      return "```blocked\n" + next + "```";
    });
    writeFileSync(BLOCKED_MD, md);
    process.stdout.write(`\n  wrote a mutant: line into ${written} BLOCKED.md entr${written === 1 ? "y" : "ies"}\n`);
  } else {
    process.stdout.write(`\n  (--write records these into proposals/BLOCKED.md)\n`);
  }

  if (falsified.length) {
    process.stdout.write(`\n  FAIL - ${falsified.length} suppression(s) falsified by a killed mutant:\n`);
    for (const v of falsified) {
      process.stdout.write(
        `      ${v.file}:${v.witness.line}  forcing the condition to ${v.want} was KILLED, but the entry says the ${v.entry.side} is dead\n`
      );
    }
    process.stdout.write(`\n  Retract the entry and write the test. Do not re-argue it.\n`);
    process.exit(1);
  }
  process.stdout.write(`\n  OK - no auditable suppression was contradicted in this slice\n`);
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