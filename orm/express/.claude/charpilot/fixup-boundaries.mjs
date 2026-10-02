#!/usr/bin/env node
/**
 * Stage 3 bookkeeping — NOT a content generator.
 *
 * Two mechanical jobs only:
 *   1. drop boundary answers that are out of scope for a proposal's path
 *   2. fill TYPE-ONLY imports, whose answer is genuinely mechanical ("not a
 *      call — a type"), from an explicit allowlist
 *
 * Anything else missing is REPORTED, never invented. A real outbound call needs
 * a real answer, and a script guessing one would be exactly the fabrication the
 * validator exists to catch.
 *
 *   node .claude/charpilot/fixup-boundaries.mjs [--write]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PROPOSALS_DIR, SCAN_JSON } from "./config.mjs";

const WRITE = process.argv.includes("--write");

// Symbols imported for their TYPE only. Each is verified by grep: the name never
// appears in a call or `new` position anywhere in src.
const TYPE_ONLY = new Set([
  "ApiKey", "LangfuseKeys", "CachedPromptData", "UsageMetadata", "Prisma",
  "Provider", "CacheKeys", "AnthropicToolResponse", "LlmRequestPayloadV1",
  "LlmRequestPayloadV3", "LlmRequestPayloadV4", "TokenUsage", "UsageRecorder",
  "DefaultModelKey", "OpenAIKeys", "AnthropicApiKeys", "VertexAIKeys", "GoogleKeys",
]);

const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
const byId = new Map(scan.functions.map((f) => [f.id, f]));

let dropped = 0;
let filled = 0;
const unanswered = [];

for (const file of readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"))) {
  const path = join(PROPOSALS_DIR, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  let touched = false;

  for (const p of doc.proposals ?? []) {
    const fn = byId.get(p.functionId);
    if (!fn) continue;
    const driver = p.via ? byId.get(p.via) : undefined;

    const inScope = new Set(
      (p.via
        ? scan.functions.filter((x) => {
            if (x.id === fn.id || x.id === p.via) return true;
            const ds = x.via ? (x.via.drivers ?? [x.via.driver]).filter(Boolean) : [];
            return x.file === fn.file && ds.includes(p.via);
          })
        : [fn]
      ).flatMap((x) => x.boundaries.map((b) => b.symbol))
    );

    p.boundaries ??= {};
    for (const key of Object.keys(p.boundaries)) {
      if (!inScope.has(key)) {
        delete p.boundaries[key];
        dropped += 1;
        touched = true;
      }
    }

    const required = driver ? [...fn.boundaries, ...driver.boundaries] : fn.boundaries;
    for (const b of required) {
      if (b.symbol in p.boundaries) continue;
      if (TYPE_ONLY.has(b.symbol)) {
        p.boundaries[b.symbol] = {
          behaviour: "not a call — imported for its type only",
          from: {
            arm: p.covers[0],
            evidence: `${fn.file}:${fn.line}`,
            reading: `${b.symbol} is imported from ${b.module} and used in type position, so there is nothing for stage 4 to answer`,
          },
        };
        filled += 1;
        touched = true;
      } else {
        unanswered.push(`${file} :: ${p.id} :: ${b.symbol} (${b.module})`);
      }
    }
  }

  if (touched && WRITE) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

process.stdout.write(
  `${WRITE ? "applied" : "dry run"}: dropped ${dropped} out-of-scope answers, filled ${filled} type-only answers\n`
);
if (unanswered.length) {
  process.stdout.write(`\n${unanswered.length} real boundaries still need a hand-written answer:\n`);
  for (const u of unanswered) process.stdout.write(`  ${u}\n`);
}
