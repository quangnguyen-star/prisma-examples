#!/usr/bin/env node
/**
 * The open-gap register, printed.
 *
 * "How many are open" was asked repeatedly during the pilot and answered from
 * prose every time, which is how the same document ended up quoting 1518 and
 * 1505 as one number. So the register is an artifact - `gaps.json` - and this
 * prints it. Quote this, never a paragraph.
 *
 *   node .claude/charpilot/gaps.mjs [--stage 4] [--person] [--closed]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./config.mjs";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
/** Wrap to 96 columns so a plain line reads as a sentence, not a wall. */
function wrap(text, indent, label = "") {
  const width = 96 - indent.length;
  const words = String(text ?? "").split(/\s+/);
  const lines = [];
  let line = label;
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim() !== label.trim()) {
      lines.push(line);
      line = " ".repeat(label.length) + w;
    } else {
      line += (line && line !== label ? " " : "") + w;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

const doc = JSON.parse(readFileSync(join(REPO_ROOT, ".claude/charpilot/gaps.json"), "utf8"));

const stage = arg("--stage", null);
let gaps = doc.gaps;
if (stage) gaps = gaps.filter((g) => g.stage === String(stage));
if (ARGV.includes("--person")) gaps = gaps.filter((g) => g.owner === "person");

const byStage = new Map();
for (const g of doc.gaps) byStage.set(g.stage, (byStage.get(g.stage) ?? 0) + 1);
const person = doc.gaps.filter((g) => g.owner === "person");

const out = process.stdout;
out.write(`\nopen gaps - register updated ${doc.updatedAt}\n\n`);
for (const g of gaps) {
  out.write(`  ${g.id.padEnd(6)}${`stage ${g.stage}`.padEnd(12)}${g.owner === "person" ? "PERSON  " : "        "}${g.title}\n`);
  // The plain line first, and never optional. The register's first version was
  // dense enough that every entry had to be explained again in conversation,
  // which means the register was not doing its job. If an entry cannot be said
  // plainly it is not understood well enough to be worked.
  out.write(`${wrap(g.plain, "        ")}\n`);
  out.write(`${wrap(g.detail, "          ", "detail: ")}\n`);
  out.write(`${wrap(g.needs, "          ", "needs:  ")}\n\n`);
}

if (ARGV.includes("--closed")) {
  out.write(`closed this session (${doc.closedThisSession.length})\n\n`);
  for (const c of doc.closedThisSession) {
    out.write(`  ${c.id.padEnd(6)}${`stage ${c.stage}`.padEnd(12)}${c.title}\n`);
    out.write(`${wrap(c.plain, "        ")}\n`);
    out.write(`${wrap(c.detail, "          ", "detail: ")}\n\n`);
  }
}

const order = ["cross", "1", "2", "3", "4", "5", "6", "7", "8"];
const spread = order
  .filter((s) => byStage.has(s))
  .map((s) => `${s === "cross" ? "cross-cutting" : `stage ${s}`} ${byStage.get(s)}`)
  .join(" · ");
out.write(`  ${doc.gaps.length} open · ${person.length} need a person's ruling · ${doc.closedThisSession.length} closed this session\n`);
out.write(`  ${spread}\n\n`);
out.write(`  A cross-cutting gap is one no single stage can close. The freshness guard\n`);
out.write(`  used to be the one producing the others - an artifact older than the src it\n`);
out.write(`  describes, read as fact by every stage downstream. It exists now\n`);
out.write(`  (\`npm run pilot:freshness\`), so what is left is the artifacts it names.\n\n`);
