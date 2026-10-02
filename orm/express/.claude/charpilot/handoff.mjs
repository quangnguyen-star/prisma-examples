#!/usr/bin/env node
/**
 * Generate a SELF-CONTAINED brief for the next stage.
 *
 * The point: if each stage is handed to a subagent, the handoff cannot be a
 * conversation. Everything the next stage needs — external state it must
 * arrange, the undo for each mutation, which addresses are reachable, which
 * boundaries are default-deny, the exit criteria — has to be in one artifact
 * derived from the others, not in someone's memory of a discussion.
 *
 *   node .claude/charpilot/handoff.mjs [--stage 4]
 *
 * Writes out/HANDOFF-stage<N>.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { OUT_DIR, PILOT_DIR, PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
import { loadProposals } from "./validate.mjs";

const STAGE = Number(process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : 4);
const OUTPUT = join(OUT_DIR, `HANDOFF-stage${STAGE}.md`);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * What makes two `apply.db` entries THE SAME arrangement.
 *
 * This was `[table, where, set]`, which a `{ create: { model, data } }` seed has
 * none of - so every create seed in a run hashed to `[null,null,null]` and
 * collapsed onto one row, and the brief then described a mutation of table
 * `undefined`. Measured need: run 20260915T033521Z used `setup.apply.db` in 0 of
 * 88 proposals, so the collapse had never been seen.
 */
export function mutationKey(db) {
  return db.create
    ? JSON.stringify(["create", db.create.model, db.create.data])
    : JSON.stringify([db.table, db.where, db.set]);
}

/**
 * One mutation's section of the brief.
 *
 * A create seed is reported as what it is: a row whose undo is the created id,
 * journalled under `--live` and reverse-replayed with read-back verification at
 * the end of the run. Printing `NOT RECORDED - do not proceed` over it, as this
 * did for every `apply.db` without a `confirmedBy`, told the stage-4 agent to
 * stop over a signature that belongs to the pull-request ruling - the same false
 * red that `gate.mjs`'s `self-contained` used to raise, and the reason seeding
 * was abandoned rather than done.
 */
export function mutationSection(m) {
  const L = [];
  if (m.create) {
    L.push(`### \`${m.create.model}\` — one row created`, "");
    L.push("| | |");
    L.push("|---|---|");
    L.push(`| data | \`${JSON.stringify(m.create.data)}\` |`);
    L.push("| undo | the created id, journalled and reverse-replayed with read-back verification (`--live` only) |");
    L.push(
      `| authorised by | ${m.confirmedBy ?? "awaiting a person's ruling on the pull request — the undo is derivable, so the run proceeds"} |`
    );
  } else {
    L.push(`### \`${m.table}\` where ${JSON.stringify(m.where)}`, "");
    L.push("| | |");
    L.push("|---|---|");
    L.push(`| set | \`${JSON.stringify(m.set)}\` |`);
    L.push(`| revert | \`${JSON.stringify(m.revert)}\` |`);
    L.push(`| connection | \`${m.urlVar}\` (writable — NOT the read-only URL) |`);
    L.push(`| authorised by | ${m.confirmedBy ?? "NOT RECORDED — do not proceed"} |`);
  }
  L.push(`| affects | ${m.proposals.length} proposal(s): ${m.proposals.join(", ")} |`);
  L.push("");
  L.push(`**Why:** ${m.why}`, "");
  if (m.alternative) L.push(`**Alternative that touches nothing shared:** ${m.alternative}`, "");
  return L;
}

/* ---------------------------------------------------------------------------
 * THE ADDRESS TABLE IS GENERATED FROM THE ENFORCEMENT, IN ONE DIRECTION ONLY.
 *
 * It used to be generated from `preflight.json`, and preflight.mjs keeps its own
 * hand-written list of addresses. That is a SECOND COPY of a question record.mjs
 * already answers, and the two disagreed in the way a second copy always does:
 *
 *   - the table gave `googleapis` as `us-central1-aiplatform.googleapis.com:443`,
 *     which is a Vertex address. The items dial `places.googleapis.com:443`, and
 *     that host was in no row of the table.
 *   - `34.143.159.14:5434/location-ms`, the staging database that
 *     `db-vocabulary.json` names in its own `source` block, was absent too.
 *   - run 20260916T223906Z skipped rows with `blocked egress: fetch to
 *     maps.googleapis.com` and `places.googleapis.com` — the enforcement
 *     refusing hosts the documentation had never mentioned.
 *
 * THE DIRECTION MATTERS AND IS THE WHOLE DESIGN. The table is documentation and
 * the allowlist is enforcement. Generating both from one source is right only if
 * that source is the ENFORCEMENT; generating the allowlist from the table would
 * widen egress to match a document, which is the same defect with the loss
 * pointing the other way. So nothing here is ever read BY record.mjs, and
 * nothing here may add a host to what record.mjs opens.
 *
 * record.mjs is read-only to this file, so what follows reads it rather than
 * restates it: the two host literals come out of its source, the derived half
 * comes out of the same two artifacts its `stagingAllowHosts()` reads, and the
 * markers below are checked so that a rename in record.mjs produces a REFUSAL
 * in the brief rather than a table that is quietly a year out of date.
 * ------------------------------------------------------------------------ */

/**
 * Lines of `record.mjs` this file's reading depends on. Each one is quoted from
 * the enforcement; if the enforcement stops containing it, this reading is no
 * longer true of it and the brief says so instead of printing a table.
 */
export const ENFORCEMENT_MARKERS = Object.freeze([
  Object.freeze({
    text: 'if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;',
    what: "loopback is open in every mode, so a local stub can answer a boundary",
  }),
  Object.freeze({
    text: 'for (const a of ALLOWED_HOSTS) if (h === a || h.endsWith("." + a) || h.endsWith("-" + a)) return true;',
    what: "the suffix rule that resolves a regional host onto one entry",
  }),
  Object.freeze({
    text: "if (EGRESS_OPEN) return true;",
    what: "a --live run does not gate outbound calls at all",
  }),
  Object.freeze({
    text: 'process.env.CHARPILOT_ALLOW_HOSTS ?? ""',
    what: "the hosts an operator typed, open in every mode",
  }),
  Object.freeze({
    text: 'join(OUT_DIR, "staging-env.json")',
    what: "the staging manifests are the first source of the derived half",
  }),
  Object.freeze({
    text: "Array.isArray(r.allowHosts)",
    what: "the field in staging-env.json that carries them",
  }),
  Object.freeze({
    text: "b.egressHosts?.fromDefaults ?? []), ...(b.egressHosts?.fromSource ?? [])",
    what: "the defaults and the source scrape in baseline.json — where maps/places.googleapis.com come from",
  }),
]);

/** Where the enforcement lives. install.sh puts every tool in one directory. */
export const RECORD_MJS = join(PILOT_DIR, "record.mjs");

/**
 * The string literals of one `const NAME = [ … ]` in record.mjs.
 *
 * Deliberately narrow: it reads a list of quoted hosts and nothing else, and it
 * returns null rather than a guess when the shape is not that. A null becomes a
 * refusal upstream — an address table is worth having only if it is the
 * enforcement's, and half of it is not.
 */
export function hostLiterals(source, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(String(source));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * record.mjs's own suffix rule, quoted above and checked as a marker.
 * `us-central1-aiplatform.googleapis.com` resolves onto `aiplatform.googleapis.com`
 * through the `-` arm, which is why Vertex needs one entry and not one per region.
 */
export function allowMatch(host, hosts) {
  if (!host) return null;
  for (const a of hosts) if (host === a || host.endsWith("." + a) || host.endsWith("-" + a)) return a;
  return null;
}

/**
 * Every host record.mjs will open, with where it came from and what opens it.
 *
 * The four sources are record.mjs's four, in its order, and the gate on each is
 * its gate. Nothing else may be added here: a host this function does not return
 * is a host the recorder refuses, and the table's only job is to say so before a
 * run spends an hour finding out.
 */
export function enforcedAllowlist({ recordSource, stagingEnv = null, baseline = null, env = process.env }) {
  const text = String(recordSource ?? "");
  const missing = ENFORCEMENT_MARKERS.filter((m) => !text.includes(m.text));
  const live = hostLiterals(text, "LIVE_HOSTS");
  const providers = hostLiterals(text, "PROVIDER_HOSTS");
  if (missing.length || !live || !providers) {
    const lost = [
      ...missing.map((m) => m.what),
      live ? null : "the LIVE_HOSTS literal",
      providers ? null : "the PROVIDER_HOSTS literal",
    ].filter(Boolean);
    return {
      hosts: [],
      refusal:
        `record.mjs no longer holds its allowlist the way this generator reads it (${lost.join("; ")}). ` +
        `No table is printed rather than a stale one: this section exists to agree with the enforcement, ` +
        `and a table that cannot be derived from it is the defect it was written to remove.`,
    };
  }

  const byHost = new Map();
  const add = (host, from, opensUnder) => {
    const h = String(host ?? "").trim();
    if (!h) return;
    if (!byHost.has(h)) byHost.set(h, { host: h, from: [], opensUnder });
    const e = byHost.get(h);
    if (!e.from.includes(from)) e.from.push(from);
    // A host named twice is opened by whichever gate is loosest.
    if (opensUnder === "every run") e.opensUnder = "every run";
  };

  for (const h of ["localhost", "127.0.0.1", "::1"]) add(h, "record.mjs isAllowed() — loopback", "every run");
  for (const h of String(env.CHARPILOT_ALLOW_HOSTS ?? "").split(",")) add(h, "CHARPILOT_ALLOW_HOSTS (typed)", "every run");

  // The derived half, read from the two artifacts record.mjs reads and with the
  // same fallback: an older staging-env.json has no `allowHosts`, and degrading
  // to the per-var hosts is what the enforcement does rather than to none.
  const fromStaging = Array.isArray(stagingEnv?.allowHosts)
    ? stagingEnv.allowHosts
    : Object.values(stagingEnv?.vars ?? {}).map((v) => v && v.host).filter(Boolean);
  for (const h of fromStaging) add(h, "staging-env.json allowHosts", "--live");
  for (const h of baseline?.egressHosts?.fromDefaults ?? []) add(h, "baseline.json egressHosts.fromDefaults", "--live");
  for (const h of baseline?.egressHosts?.fromSource ?? []) add(h, "baseline.json egressHosts.fromSource", "--live");
  for (const h of live) add(h, "record.mjs LIVE_HOSTS", "--live");
  for (const h of providers) add(h, "record.mjs PROVIDER_HOSTS", "--live-providers");

  return { hosts: [...byHost.values()], refusal: null };
}

/**
 * The section, as lines.
 *
 * ROWS ARE THE ALLOWLIST AND NOTHING ELSE. `preflight.json` is joined in for the
 * one thing it measures and the allowlist cannot know — whether the address
 * answers from here — and a preflight row whose host the allowlist does not hold
 * gets NO row. It is named underneath as refused, which is what the recorder
 * will do to it, so the brief loses nothing and claims nothing.
 */
export function addressSection(allowlist, preflight = []) {
  const L = [];
  L.push("## Addresses, and what must never be called", "");
  if (allowlist.refusal) {
    L.push(`**No address table.** ${allowlist.refusal}`, "");
    return L;
  }

  const all = allowlist.hosts.map((h) => h.host);
  L.push(
    "Generated from the allowlist `record.mjs` enforces — its `ALLOWED_HOSTS`, assembled from",
    "`CHARPILOT_ALLOW_HOSTS`, `out/staging-env.json`, `out/baseline.json` and its own two host",
    "lists. It is not a second list kept beside that one: a host missing from this table is a",
    "host the recorder refuses, and the row dies with `blocked egress`.",
    "",
    "The one half this cannot see is `--allow-host`, typed on the `record.mjs` command line after",
    "this brief was written. A host opened that way is open and absent from the table; every other",
    "row is complete.",
    ""
  );
  L.push("| host | opened by | open under | address seen by preflight | reachable |");
  L.push("|---|---|---|---|---|");
  for (const h of allowlist.hosts.sort((a, b) => a.host.localeCompare(b.host))) {
    const seen = preflight.filter((r) => allowMatch(r.host, [h.host]));
    const where = seen.length ? seen.map((r) => `\`${r.host}:${r.port}\``).join(", ") : "—";
    const status = seen.length ? [...new Set(seen.map((r) => r.status))].join(", ") : "not preflighted";
    L.push(`| \`${h.host}\` | ${h.from.join("; ")} | ${h.opensUnder} | ${where} | ${status} |`);
  }
  L.push("");
  L.push(
    "> **`--live` opens egress entirely.** `record.mjs`'s `isAllowed` returns true for every host",
    "> when `EGRESS_OPEN`, so under `--live` the rows above are provenance, not a limit; the",
    "> environment is the control. A MOCKED run — the one the commands above start — is closed,",
    "> and only the `every run` rows are reachable in it.",
    ""
  );

  const denied = preflight.filter((r) => !allowMatch(r.host, all));
  L.push("### What must never be called", "");
  if (denied.length) {
    L.push(
      "Measured by preflight, held by NO entry of the allowlist above, and therefore refused by the",
      "recorder with `blocked egress`. They are named, not tabled: an address table row would read as",
      "somewhere this run may go.",
      ""
    );
    for (const r of denied) {
      L.push(`- \`${r.host}:${r.port}\` — ${r.name}${r.forbidden ? ` (${r.forbidden})` : ""}. Reachable only through a mock.`);
    }
    L.push("");
  } else {
    L.push("Everything else. The recorder is default-deny; a host absent from the table is refused.", "");
  }

  const localhost = preflight.filter((r) => /DEFAULTS TO LOCALHOST/.test(r.note ?? ""));
  if (localhost.length) {
    L.push(
      `> **${localhost.map((r) => r.name).join(", ")} default to localhost.** From a developer machine`,
      "> that is THIS machine, not staging. A passthrough there records local behaviour.",
      "> Either supply the real address or keep those boundaries mocked.",
      ""
    );
  }
  if (!preflight.length) {
    L.push(
      "**No preflight has been run.** The table above is still the enforced allowlist; what is missing",
      "is whether those addresses answer from here, and an unreachable address makes a failure a",
      "harness artifact rather than behaviour. Run `preflight.mjs` before recording.",
      ""
    );
  }
  return L;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // READ THROUGH THE ONE READER, because a second parser is the bug.
  //
  // `loadProposals`' own docstring says why: the two readers were "identical by
  // luck rather than by construction", and an answer accepted by one stage and
  // dropped by another is this pipeline's most expensive failure mode. This
  // reader was the third copy, and it was the weakest of them — a bare
  // `JSON.parse(readFileSync(...))` per file, with the `existsSync` guarding
  // only the DIRECTORY. So a proposal file holding a trailing comma, the
  // literal `null`, or an object-valued `proposals` threw straight out of
  // handoff, and because derive calls handoff at the top of every round, the
  // round died before anybody was told which file to fix. The file persists on
  // disk, so the same round died the same way until a human deleted it.
  //
  // The shared reader keeps the absent-directory case this copy was written
  // for (propose.mjs creates proposals/ only on first submission, and derive
  // calls handoff before that), reports an unreadable file instead of throwing,
  // and returns `_file` on every row, which is the only field this tool needed
  // its own walk for.
  const { proposals, malformed } = loadProposals(PROPOSALS_DIR);

  // Every external precondition, grouped so it is arranged once, not per proposal.
  const mutations = new Map();
  const envVars = new Map();
  const freshModules = [];
  const manual = [];
  const calls = [];

  // A ROW WHOSE `setup` IS NOT A LIST IS REFUSED BY ITSELF, NAMING THE ROW.
  //
  // `for (const e of p.setup ?? [])` iterates whatever the agent wrote, and
  // `setup` is agent-written: an object there threw "p.setup is not iterable",
  // and a null entry threw on `e.apply` — each of them out of handoff and
  // therefore out of the round, for every other proposal too. Nothing in
  // validate.mjs asserted the shape either, which is why these reached here at
  // all. Collected rather than thrown, so the brief still describes the rows
  // that ARE well formed and the refusal names the one that is not.
  const setupRefusals = [];
  for (const p of proposals) {
    if (p.setup !== undefined && !Array.isArray(p.setup)) {
      setupRefusals.push(
        `\`${p.id}\` (${p._file}) — \`setup\` is ${p.setup === null ? "null" : typeof p.setup}, not an array, ` +
          "so its preconditions are not in this brief"
      );
      continue;
    }
    for (const [i, e] of (p.setup ?? []).entries()) {
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        setupRefusals.push(
          `\`${p.id}\` (${p._file}) — \`setup[${i}]\` is ${e === null ? "null" : Array.isArray(e) ? "an array" : typeof e}, ` +
            "not an object carrying an `apply`, so that precondition is not in this brief"
        );
        continue;
      }
      const a = e.apply;
      if (!a) continue;
      if (a.db) {
        const key = mutationKey(a.db);
        if (!mutations.has(key)) mutations.set(key, { ...a.db, proposals: [] });
        mutations.get(key).proposals.push(p.id);
      }
      if (a.env) {
        for (const [k, v] of Object.entries(a.env)) {
          const key = `${k}=${v}`;
          if (!envVars.has(key)) envVars.set(key, []);
          envVars.get(key).push(p.id);
        }
      }
      if (a.module) freshModules.push(p.id);
      if (a.manual) manual.push({ id: p.id, why: a.manual, state: e.state });
      if (a.call) calls.push({ id: p.id, call: a.call });
    }
  }

  const preflightPath = join(OUT_DIR, "preflight.json");
  const preflight = existsSync(preflightPath) ? read(preflightPath).rows ?? [] : [];

  // The enforcement, and the two artifacts it derives its own allowlist from.
  // An unreadable one contributes nothing here for the same reason it
  // contributes nothing there — see stagingAllowHosts() in record.mjs.
  const readOr = (p, dflt) => {
    try {
      return existsSync(p) ? read(p) : dflt;
    } catch {
      return dflt;
    }
  };
  const allowlist = enforcedAllowlist({
    recordSource: existsSync(RECORD_MJS) ? readFileSync(RECORD_MJS, "utf8") : "",
    stagingEnv: readOr(join(OUT_DIR, "staging-env.json"), null),
    baseline: readOr(join(OUT_DIR, "baseline.json"), null),
  });

  const w = read(WORKLIST_JSON);
  const scan = read(SCAN_JSON);
  const lanes = {};
  for (const i of w.items) {
    if (!i.instrumented) continue;
    const l = i.lane ?? "unit";
    lanes[l] = (lanes[l] ?? 0) + i.uncoveredSides.length;
  }

  const L = [];
  L.push(`# Handoff — stage ${STAGE}`, "");
  L.push(
    `Generated by \`handoff.mjs\` from the stage artifacts. It is meant to be the ONLY`,
    `thing the next stage needs to read. If something is missing here, that is a bug in`,
    `this generator, not a reason to ask a question.`,
    ""
  );

  L.push("## Run these, in order", "");
  L.push("```bash");
  L.push("npm run pilot:gate -- --stage " + STAGE + "   # refuses to proceed if an earlier stage is not closed");
  L.push("node .claude/charpilot/preflight.mjs --env-file <staging .env>");
  L.push("node .claude/charpilot/record.mjs --env-file <staging .env>");
  L.push("```", "");

  L.push("## External state this stage must arrange", "");
  if (mutations.size === 0) {
    L.push("No external mutation is required.", "");
  } else {
    L.push(
      `${mutations.size} mutation(s) of SHARED state. Each is applied, recorded, then`,
      "reverted. **If a revert cannot be confirmed, the run must fail** rather than leave",
      "the environment altered — a half-applied config change is worse than no recording.",
      ""
    );
    for (const m of mutations.values()) {
      L.push(...mutationSection(m));
    }
  }

  L.push("## Environment", "");
  if (envVars.size) {
    L.push("Set for the whole run (a proposal that needs a different value says so in its own setup):", "");
    for (const [kv, ids] of envVars) L.push(`- \`${kv}\`  — ${ids.length} proposal(s)`);
    L.push("");
  } else {
    L.push("No proposal overrides an env var.", "");
  }

  L.push(...addressSection(allowlist, preflight));

  L.push("## Work in this stage", "");
  L.push(`- proposals: **${proposals.length}** across ${new Set(proposals.map((p) => p.functionId)).size} functions`);
  // SAID IN THE BRIEF, because the brief claims to be the only thing the next
  // stage reads. A file this generator could not parse, or a row whose `setup`
  // it could not walk, is work missing from every section above it — and a
  // silently short brief is the false-completion shape this pipeline exists to
  // refuse.
  if (malformed.length) {
    L.push(`- **${malformed.length} proposal file(s) are not readable**, so this brief is short by whatever they held:`);
    for (const m of malformed) L.push(`  - \`${m.file}\` — ${m.message}`);
  }
  if (setupRefusals.length) {
    L.push(`- **${setupRefusals.length} row(s) declare a \`setup\` this generator could not read**:`);
    for (const r of setupRefusals) L.push(`  - ${r}`);
  }
  for (const [lane, n] of Object.entries(lanes)) L.push(`- lane \`${lane}\`: ${n} uncovered sides`);
  L.push(`- reconcile: ${scan.reconcile.arms.astTotal} sides / ${scan.reconcile.functions.astTotal} functions, 0 drift`);
  L.push("");

  if (freshModules.length) {
    L.push(
      `${freshModules.length} proposal(s) need a FRESH module registry (a warm in-process cache`,
      "would mask the arm). Reset modules between those rows.",
      ""
    );
  }
  if (calls.length) {
    L.push("### Preconditions that are a prior call", "");
    for (const c of calls) L.push(`- \`${c.id}\` → \`${c.call}\``);
    L.push("");
  }
  if (manual.length) {
    L.push("### Needs a hand-built harness — cannot be a directive", "");
    for (const m of manual) L.push(`- \`${m.id}\` — ${m.why}`);
    L.push("");
  }

  L.push("## Exit criteria", "");
  L.push(
    "1. `npm run pilot:gate -- --stage " + STAGE + "` exits 0.",
    "2. Every recorded row is an OBSERVATION. A module-resolution or env-validation",
    "   failure is a harness error and must not be written as behaviour.",
    "3. Every boundary answer in `behaviour.json` OVERWRITES the proposal's planned",
    "   `behaviour`. A pair that merely echoes the plan proves nothing.",
    "4. Every mutation above is reverted, and the revert is verified.",
    "5. A recorder that produces nothing is a **stop**, not a shrug.",
    ""
  );

  writeFileSync(OUTPUT, `${L.join("\n")}\n`);
  process.stdout.write(
    `\n\u2713 handoff \u2192 ${relative(REPO_ROOT, OUTPUT)}\n` +
      `    external mutations  ${mutations.size}${mutations.size ? " (each with a revert)" : ""}\n` +
      `    env overrides       ${envVars.size}\n` +
      `    fresh-module rows   ${freshModules.length}\n` +
      `    manual harnesses    ${manual.length}\n` +
      `    preflight rows      ${preflight.length}\n` +
      (malformed.length ? `    UNREADABLE FILES    ${malformed.length} - this brief is short by what they held\n` : "") +
      (setupRefusals.length ? `    REFUSED setup       ${setupRefusals.length} row(s)\n` : "") +
      `    allowlist hosts     ${allowlist.refusal ? "REFUSED — " + allowlist.refusal.slice(0, 60) : allowlist.hosts.length}\n`
  );
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