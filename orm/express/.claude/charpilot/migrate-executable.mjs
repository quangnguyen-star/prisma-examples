#!/usr/bin/env node
/**
 * Stage 3 repair - derive the executable siblings the recorder needs.
 *
 * Only converts prose whose meaning is UNAMBIGUOUS. Everything else is reported
 * for a human or an agent to write, never guessed: a mock invented from a vague
 * sentence would be exactly the fabrication this pipeline exists to prevent.
 *
 *   node .claude/charpilot/migrate-executable.mjs [--write]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PROPOSALS_DIR } from "./config.mjs";

const WRITE = process.argv.includes("--write");

const INERT =
  /^not (a )?call|^not constructed|^not read|^not matched|^not reached|^no call|type only|imported for its type/i;

const parses = (t) => {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${t});`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Each rule maps one prose shape to one directive. Order matters: the more
 * specific patterns run first.
 */
const RULES = [
  // inert -> nothing happens
  [INERT, () => ({ kind: "notCalled" })],

  // rejections / throws, with the value spelled out in the prose
  [/\b(rejects?|throws?)\b[^.]*?\bnew Error\((["'`])([\s\S]*?)\2\)/i,
   (m) => ({ kind: /throw/i.test(m[1]) ? "throws" : "rejects", build: `new Error(${JSON.stringify(m[3])})` })],
  [/\b(rejects?|throws?)\b[^.]*?\bplain string\s+(["'`])([\s\S]*?)\2/i,
   (m) => ({ kind: /throw/i.test(m[1]) ? "throws" : "rejects", value: m[3] })],
  [/\b(rejects?|throws?)\b[^.]*?\bplain object\s+(\{[\s\S]*?\})/i,
   (m) => (parses(m[2]) ? { kind: /throw/i.test(m[1]) ? "throws" : "rejects", build: m[2] } : undefined)],
  [/\b(rejects?)\b[^.]*?\bnew TypeError\((["'`])([\s\S]*?)\2\)/i,
   (m) => ({ kind: "rejects", build: `new TypeError(${JSON.stringify(m[3])})` })],

  // resolutions with a literal
  [/\bresolves?\b\s+(?:the\s+)?(?:empty\s+string|"")\b/i, () => ({ kind: "resolves", value: "" })],
  [/\bresolves?\b\s+(?:to\s+)?null\b/i, () => ({ kind: "resolves", value: null })],
  [/\bresolves?\b\s+(?:to\s+)?undefined\b/i, () => ({ kind: "resolves", build: "undefined" })],
  [/\bresolves?\b[^.]*?\bthe\s+(?:plain\s+)?string\s+(["'`])([\s\S]*?)\1/i,
   (m) => ({ kind: "resolves", value: m[2] })],
  [/\bresolves?\b\s+(\{[\s\S]*?\})\s*$/i, (m) => (parses(m[1]) ? { kind: "resolves", build: m[1] } : undefined)],
  [/\bresolves?\b\s+(\d+)\b/i, (m) => ({ kind: "resolves", value: Number(m[1]) })],
  [/\bresolves?\b\s+an?\s+empty\s+array\b/i, () => ({ kind: "resolves", build: "[]" })],

  // simple returns
  [/\breturns?\b\s+(?:the\s+)?(?:empty\s+string|"")\b/i, () => ({ kind: "returns", value: "" })],
  [/\breturns?\b\s+(?:to\s+)?null\b/i, () => ({ kind: "returns", value: null })],
  [/\breturns?\b\s+undefined\b/i, () => ({ kind: "returns", build: "undefined" })],
  [/\breturns?\b\s+(true|false)\b/i, (m) => ({ kind: "returns", value: m[1] === "true" })],
  [/\breturns?\b\s+(\d+)\b/i, (m) => ({ kind: "returns", value: Number(m[1]) })],
  [/\breturns?\b[^.]*?\bstring\s+(["'`])([\s\S]*?)\1/i, (m) => ({ kind: "returns", value: m[2] })],

  // schema parses cleanly -> let the real implementation run
  [/\bparses?\b[^;]*?\bsuccessfully\b/i, () => ({ kind: "passthrough" })],
  [/\bsafeParse\b[^;]*?\bsucceeds?\b/i, () => ({ kind: "passthrough" })],
  [/\bsafeParse\b[^;]*?\b(fails?|not reached)\b/i, () => ({ kind: "passthrough" })],
  [/\bpasses\b[^.]*\bthrough\b|\bruns the callback\b|\bruns the handler\b|\binvokes the callback\b/i,
   () => ({ kind: "passthrough" })],
  [/\bstartActiveSpan\b/i, () => ({ kind: "passthrough" })],
  [/\bmounted but not exercised\b|\bmounted\b[^.]*\bnot\b/i, () => ({ kind: "notCalled" })],

  // "called once with X", "warn called", "constructed once with X" - the call IS
  // the observation and the return value is irrelevant. This must run AFTER the
  // explicit-return rules above, so "called and returns Y" keeps its value.
  [/\b(called|constructed|invoked)\b/i, () => ({ kind: "spy" })],
  [/^(info|warn|error|debug|log)\b/i, () => ({ kind: "spy" })],

  // named doubles - the prose says WHICH double, the factory supplies it
  [/\breturns a fresh recorder\b/i, () => ({ kind: "returns", build: "doubles.usageRecorder()" })],
  [/\breturns a fixed uuid\b/i, () => ({ kind: "returns", build: "doubles.FIXED_UUID" })],
  [/\breturns a stable host\b/i, () => ({ kind: "returns", build: "doubles.FIXED_HOST" })],
  [/\bresolves \{ ?INSTANCE|\bresolves \{ instance/i,
   (m, behaviour) => ({
     kind: "resolves",
     build: `doubles.langfuseResolution({ provider: ${JSON.stringify(
       (behaviour.match(/provider is (\w+)/i) ?? [])[1] ?? "OPENAI"
     )} })`,
   })],
  [/\bresolves an? (?:\w+ )?api_key row\b/i,
   (m, behaviour) => {
     const provider = (behaviour.match(/provider (?:is )?(OPENAI|VERTEXAI|ANTHROPIC|NULL)/i) ?? [])[1];
     const arg = !provider || /null/i.test(provider) ? "null" : JSON.stringify(provider.toUpperCase());
     return { kind: "resolves", build: `doubles.apiKeyRow(${arg})` };
   }],
  [/\bresolves an executor function\b|\bresolves an? executor\b/i,
   () => ({ kind: "resolves", build: "doubles.executor()" })],
  [/\binstantiated\b|\bbuilds the app\b|\bmounted at\b|\bruns the closure\b|\bmaps "|\bresolves the executor's\b/i,
   () => ({ kind: "passthrough" })],
  [/\brecorded in order\b|\bis recorded\b|\bno error logged\b|\blines are recorded\b/i, () => ({ kind: "spy" })],

  // an env read is a value, not a call
  [/\breads? as\b|\bis its default\b|\bsupplies\b|\bread as configured\b|\bpassed through\b|\bsupplied\b/i,
   () => ({ kind: "value" })],
  [/\bnot a call\b|\bnot an invocation\b/i, () => ({ kind: "notCalled" })],
];

function deriveMock(behaviour) {
  if (typeof behaviour !== "string") return undefined;
  for (const [re, make] of RULES) {
    const m = behaviour.match(re);
    if (!m) continue;
    const out = make(m, behaviour);
    if (out) return out;
  }
  return undefined;
}

function deriveApply(state) {
  if (typeof state !== "string") return undefined;
  // "FOO=bar" / "FOO=bar and BAZ=qux"
  const pairs = [...state.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*("?)([^",;]*)\2/g)];
  if (pairs.length) {
    const env = {};
    for (const [, k, , v] of pairs) env[k] = v.trim();
    return { env };
  }
  if (/\bimport(ed)?\b[^.]*\bmodule\b|\bfresh module registry\b|\bmodule has been imported\b/i.test(state)) {
    return { module: "fresh" };
  }
  return undefined;
}

let mocks = 0;
let renames = 0;
let applies = 0;
let moved = 0;
const residue = { boundaries: [], construct: [], setup: [] };

for (const file of readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"))) {
  const path = join(PROPOSALS_DIR, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  let touched = false;

  for (const p of doc.proposals ?? []) {
    // 1. construct that already parses becomes build
    for (const a of p.args ?? []) {
      if (!a || typeof a !== "object" || a.build !== undefined) continue;
      if (a.construct && parses(a.construct)) {
        a.build = a.construct;
        renames += 1;
        touched = true;
      } else if (a.construct) {
        residue.construct.push(`${file} :: ${p.id} :: ${String(a.construct).slice(0, 70)}`);
      }
    }

    // 2. boundary prose that states its outcome becomes a mock
    for (const [sym, ans] of Object.entries(p.boundaries ?? {})) {
      if (!ans || typeof ans !== "object" || ans.mock !== undefined) continue;
      const mock = deriveMock(ans.behaviour);
      if (mock) {
        ans.mock = mock;
        mocks += 1;
        touched = true;
      } else if (!INERT.test(ans.behaviour ?? "")) {
        residue.boundaries.push(`${file} :: ${p.id} :: ${sym} :: ${String(ans.behaviour).slice(0, 80)}`);
      }
    }

    // 3. setup: env assignments and module freshness are mechanical; a setup
    //    entry describing a boundary outcome is a MISFILING and is reported, not
    //    silently relocated - which boundary symbol it belongs to is a judgement.
    for (const entry of p.setup ?? []) {
      if (!entry || typeof entry !== "object" || entry.apply !== undefined) continue;
      const apply = deriveApply(entry.state);
      if (apply) {
        entry.apply = apply;
        applies += 1;
        touched = true;
        continue;
      }
      if (/\b(rejects?|resolves?|throws?|returns)\b/i.test(entry.state ?? "")) {
        moved += 1;
        residue.setup.push(`${file} :: ${p.id} :: MISFILED BOUNDARY :: ${String(entry.state).slice(0, 80)}`);
      } else {
        residue.setup.push(`${file} :: ${p.id} :: ${String(entry.state).slice(0, 80)}`);
      }
    }
  }

  if (touched && WRITE) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

process.stdout.write(
  `\n${WRITE ? "applied" : "dry run"} - derived from unambiguous prose:\n` +
    `    boundary mocks    ${mocks}\n` +
    `    construct->build  ${renames}\n` +
    `    setup applies     ${applies}\n` +
    `\n  needs a hand-written directive:\n` +
    `    boundaries        ${residue.boundaries.length}\n` +
    `    construct (prose) ${residue.construct.length}\n` +
    `    setup             ${residue.setup.length}   (of which ${moved} are misfiled boundary answers)\n`
);

const sample = (label, rows) => {
  if (!rows.length) return;
  process.stdout.write(`\n  ${label}:\n`);
  for (const r of rows.slice(0, 6)) process.stdout.write(`    ${r}\n`);
};
sample("boundaries the prose does not pin down", residue.boundaries);
sample("construct values that are English", residue.construct);
sample("setup entries", residue.setup);
