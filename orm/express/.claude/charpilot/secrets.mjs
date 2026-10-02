#!/usr/bin/env node
/**
 * Does any recorded artifact contain a credential.
 *
 * This exists because one did. location-ms's `out/behaviour.json` held its real
 * `GOOGLE_API_KEY` verbatim inside an `X-Goog-Api-Key` header in
 * `boundaryCalls` - 34 non-placeholder tokens across 14 rows - in a directory
 * that repo's git did not ignore, so a single `git add .claude` would have
 * committed a working key. The stage-4 skill asserted the recorder redacted
 * such fields; it did not, and nothing checked.
 *
 * So redaction now happens in `snap()`, and this is the check that says whether
 * it held. A control that is claimed and not measured is the failure mode this
 * whole pilot exists to remove, and it applied to the pilot's own tooling.
 *
 * Two independent tests, because either alone is too weak:
 *
 *   by KEY    a credential-shaped key whose value is not the redaction marker.
 *             This is the precise one - it catches a real secret under
 *             `authorization` regardless of what the value looks like.
 *   by VALUE  a high-entropy token or a known provider prefix anywhere in the
 *             artifact. Imprecise on purpose: it is the backstop for a secret
 *             that arrived under a key nobody thought of.
 *
 * A finding is printed with its ROW and its KEY PATH and never with the value,
 * which is the same rule the rest of the pipeline follows.
 *
 *   node .claude/charpilot/secrets.mjs
 *   node .claude/charpilot/secrets.mjs --dir .claude/charpilot/out
 *
 * Exits non-zero on any finding, so it can gate.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const DIR = resolve(arg("--dir", OUT_DIR));

/** Same key set the recorder redacts by, so the two cannot drift apart. */
export const CREDENTIAL_KEY =
  /^(?:x-)?(?:api[-_]?key|apikey|goog-api-key|authorization|auth|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|passphrase|credential|private[-_]?key|client[-_]?secret|signing[-_]?secret|webhook|hook|dsn|connection[-_]?string|database[-_]?url|session|cookie|set-cookie)$/i;

/**
 * Provider prefixes worth naming, and a generic entropy test.
 *
 * The prefixes are the cheap certainties. The entropy test is deliberately
 * loose and then filtered hard below, because the alternative - no value-side
 * check at all - is how the original exposure survived: the key was
 * `X-Goog-Api-Key`, which no key list at the time contained.
 */
export const KNOWN_PREFIX =
  /\b(?:AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/;

/** A hook URL is a secret even though it looks like an ordinary link. */
export const SECRET_URL = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]{10,}/;

/**
 * Anything the pipeline itself puts in an artifact, which must never be read as
 * a secret. Without this the check cries wolf on its own seeded values and gets
 * ignored - the failure mode of the --overwrite projection.
 */
export const OURS = /charpilot|placeholder|redacted|example|dummy|synthetic|00000000-0000|test[-_]?key|not[-_]?a[-_]?real/i;

/**
 * Keys whose values are NAMES, never secrets.
 *
 * The first version of this check reported 7,243 findings, and almost all of
 * them were `boundaryCalls[].symbol` - function names like
 * getLangfuseWithKeyTraceV1, which is 26 characters of mixed case and passes
 * any entropy test you can write. A check that cries wolf is worth nothing: it
 * is the exact failure of the --overwrite projection that nearly stopped an
 * agent mid-rung. So the identifier-shaped positions are excluded by name.
 */
const NAME_KEY = /^(?:symbol|id|armId|functionId|file|name|functionName|module|imported|kind|via|shape|stage|why|reason|source|labels|sides|uncoveredSides|rationale|behaviour|reading|evidence|note|notes|title|plain|detail)$/;

/** A camelCase or PascalCase identifier is not a secret, whatever its entropy. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

export const looksHighEntropy = (s) => {
  if (typeof s !== "string" || s.length < 24 || OURS.test(s)) return false;
  // A path, a sentence or a URL is long without being a secret.
  if (/\s|\/|\\|\.(ts|js|mjs|json|md)\b/.test(s)) return false;
  // An identifier reads as high-entropy and is not a secret. A real key has
  // digits or symbols interleaved unpredictably; getLangfuseWithKeyTraceV1 does
  // not, and neither does any other name in a call list.
  if (IDENTIFIER.test(s) && !/\d{4,}/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(s)).length;
  if (classes < 3) return false;
  const distinct = new Set(s).size;
  return distinct / s.length > 0.45;
};

/**
 * Is this env VARIABLE credential-shaped - by its name, or by its value.
 *
 * Same patterns as above and no second set, which is the whole point: a
 * detector that exists twice drifts, and the one that drifts is the one nobody
 * is looking at. Three reuses, in the order they earn their keep:
 *
 *   name      CREDENTIAL_KEY is anchored for a JSON key (`authorization`), and
 *             an env var is a COMPOUND (`OUTLOOK_CLIENT_SECRET`). So the name
 *             is split on `_`/`-` and every contiguous run of segments is
 *             offered to the same regex: `CLIENT_SECRET` matches
 *             `client[-_]?secret`, and the bare `SECRET` segment matches
 *             `secret`. Nothing new is being recognised - the same list is
 *             simply asked about the parts of a name it was written for.
 *   embedded  a connection string is a `k=v;k=v` value, and the credential is
 *             one of its own keys (`...;accesskey=...`). So each assignment's
 *             NAME goes through CREDENTIAL_KEY too. This is what recognises
 *             email-centralization-ms's EMAIL_CONNECTION, which no name-side
 *             or entropy test reaches: the value has slashes, so
 *             looksHighEntropy() correctly declines it.
 *   value     KNOWN_PREFIX, SECRET_URL and looksHighEntropy, unchanged.
 *
 * Returns `null`, or a REASON. It never returns any part of the value, and no
 * caller may add one: the whole output of this is a name, a location and a
 * sentence.
 */
const NAME_SEGMENTS = (name) => {
  const parts = name.split(/[-_]/).filter(Boolean);
  const runs = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j <= parts.length; j++) runs.push(parts.slice(i, j).join("_"));
  }
  return runs;
};

const EMBEDDED_ASSIGNMENT = /([A-Za-z][A-Za-z0-9_-]{1,30})\s*=\s*[^;&\s]{8,}/g;

export function credentialShaped(name, value) {
  // A boolean or a number is not a credential, whatever the name says. Same
  // rule stagingenv.mjs's classify() had to learn about addresses: it called
  // MAX_QUEUE_SIZE 2000 `public`, and the tally then read as "seven things are
  // reachable" when one was. Here the name-side test alone calls
  // VERIFY_API_KEY_ENABLE=false a credential, because `API_KEY` is one of its
  // segments - and a list with an obvious wrong entry at the top is a list
  // people stop reading.
  const inert = typeof value === "string" && /^\s*(true|false|\d+(\.\d+)?)\s*$/i.test(value);
  if (!inert && NAME_SEGMENTS(String(name)).some((run) => CREDENTIAL_KEY.test(run))) {
    return "the NAME is credential-shaped by the recorder's own key list";
  }
  if (typeof value !== "string" || value === "" || inert) return null;
  if (OURS.test(value)) return null;
  for (const m of value.matchAll(EMBEDDED_ASSIGNMENT)) {
    if (CREDENTIAL_KEY.test(m[1])) return `the value carries a credential-shaped assignment (\`${m[1]}=\`)`;
  }
  if (KNOWN_PREFIX.test(value)) return "the value has a known provider key prefix";
  if (SECRET_URL.test(value)) return "the value is a webhook URL, which is itself the credential";
  if (looksHighEntropy(value)) return "the value is a high-entropy token";
  return null;
}

function walk(node, path, findings) {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    if (KNOWN_PREFIX.test(node)) findings.push({ path, why: "a known provider key prefix" });
    else if (SECRET_URL.test(node)) findings.push({ path, why: "a webhook URL, which is itself the credential" });
    else if (looksHighEntropy(node)) findings.push({ path, why: `a high-entropy ${node.length}-char token` });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, findings));
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    const here = path ? `${path}.${k}` : k;
    // A key whose value is a NAME or SOURCE TEXT is never a secret, and
    // walking it is how a scanner starts crying wolf: it flagged
    // `iso2Result.country?.name` - a side label lifted verbatim from source -
    // as a 24-char high-entropy token. A long identifier is not a credential,
    // and the next real finding gets ignored once the list is full of them.
    if (NAME_KEY.test(k)) continue;
    if (CREDENTIAL_KEY.test(k)) {
      // Redacted is the pass condition. Anything else under such a key is a
      // finding whatever it looks like - that is the point of the key test.
      const redacted = v !== null && typeof v === "object" && "$redacted" in v;
      const inert = typeof v === "string" && (OURS.test(v) || v === "<redacted>" || v === "");
      if (!redacted && !inert) findings.push({ path: here, why: `a credential-shaped key that is not redacted` });
      continue;
    }
    walk(v, here, findings);
  }
}

function artifacts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

function main() {
  const files = artifacts(DIR);
  const w = (s) => process.stdout.write(s);
  w(`\nsecret scan — ${files.length} artifact(s) in ${relative(REPO_ROOT, DIR) || "."}\n\n`);

  let total = 0;
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const findings = [];
    // Rows are walked individually so a finding names the row that produced it,
    // which is what makes it repairable: the proposal for that row has to
    // answer the boundary with a placeholder instead.
    if (Array.isArray(doc.rows)) {
      for (const row of doc.rows) walk(row, `row[${row.id ?? "?"}]`, findings);
    } else {
      walk(doc, "", findings);
    }
    if (!findings.length) continue;
    total += findings.length;
    w(`  ✗ ${relative(REPO_ROOT, file)} — ${findings.length} finding(s)\n`);
    const seen = new Set();
    for (const f of findings) {
      const row = f.path.slice(0, f.path.indexOf("]") + 1);
      const key = `${row}|${f.why}`;
      if (seen.has(key)) continue;
      seen.add(key);
      w(`      ${f.path}\n        ${f.why}\n`);
      if (seen.size >= 12) {
        w(`      … ${findings.length - 12} more finding(s) in this file\n`);
        break;
      }
    }
  }

  if (!total) {
    w(`  ✓ no credential-shaped value in any recorded artifact\n`);
    w(`\n  Redaction happens in snap(), so a value reaching an artifact means a key\n`);
    w(`  the redactor does not know about. Add it there, not here.\n\n`);
    return;
  }

  w(
    `\n  ${total} finding(s). NOTHING IS PRINTED BUT THE KEY PATH - do not paste a value\n` +
      `  into a report, a commit message or a chat.\n\n` +
      `  What to do, in order:\n` +
      `    1. Confirm the artifact is not tracked: git check-ignore <file>. If it is not\n` +
      `       ignored, add .claude/charpilot/out/ to .git/info/exclude BEFORE anything else.\n` +
      `    2. Add the offending key to CREDENTIAL_KEY in record.mjs and exec.mjs.\n` +
      `    3. Re-record. Redaction is not retroactive - the old artifact still holds it.\n` +
      `    4. If the value was ever committed or pushed, it is burned: rotate it.\n\n`
  );
  process.exitCode = 1;
}

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
