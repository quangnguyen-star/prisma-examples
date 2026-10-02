/**
 * vocabulary — the values staging actually holds, so an input names a
 * country with rows behind it rather than a plausible one.
 *
 * TWO TOOLS, and neither of them is a gate. `dbvocab.mjs` reads the service's
 * own enums, flags and pricing rows out of a read-only staging database;
 * `providervocab.mjs` reads the outcomes this service already recorded into
 * `usage_log` — real error strings, real finish reasons, real null rates. Both
 * exist so `derive` can propose a value the database has rows for instead of a
 * plausible one, which is the fabrication this pipeline exists to prevent.
 *
 * WHAT `satisfied` ASKS, and why it is not "are both artifacts there".
 *
 * A HELP IS NOT A PREREQUISITE. `derive` works without either file — it reads
 * the source, it just has less vocabulary to draw on. So the only thing that
 * could make this step refuse is an environment that COULD have produced a
 * vocabulary and did not. A mocked run has no staging database at all
 * (dbvocab.mjs:61 refuses with exactly that sentence), and a `satisfied` that
 * demanded the artifact anyway would wedge every mocked run on a file nothing
 * in that run can create — one missing input turned into a stopped run rather
 * than a reported one.
 *
 * So: each tool is satisfied when its artifact is on disk OR when this
 * environment cannot give that tool its DSN. `run` says which of the two ran,
 * which were skipped, and why, because "vocabulary: ran nothing" is not a
 * diagnosis and a reader has to be able to tell a skipped probe from a silent
 * one.
 *
 * WHERE THE DSN COMES FROM, read off the two tools rather than assumed:
 *
 *   dbvocab.mjs:47-61        `--env-file <path>` (DATABASE_URL_READ_ONLY, then
 *                            DATABASE_URL), else $CHARPILOT_DB_URL, else
 *                            $DATABASE_URL_READ_ONLY
 *   providervocab.mjs:59-70  an env FILE ONLY, defaulting to out/staging.env.
 *                            It reads no environment variable, so a DSN that
 *                            exists only in the environment is a DSN this tool
 *                            cannot use, and saying so is not the same as
 *                            saying the run is broken.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OUT_DIR, STAGING_ENV } from "../config.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "vocabulary";

/** Where the two tools write, fixed at dbvocab.mjs:27 and providervocab.mjs:60. */
export const DB_VOCABULARY_JSON = resolve(OUT_DIR, "db-vocabulary.json");
export const PROVIDER_VOCAB_JSON = resolve(OUT_DIR, "provider-vocab.json");

/** The keys both tools look for inside an env file, in their own order. */
const FILE_KEYS = ["DATABASE_URL_READ_ONLY", "DATABASE_URL"];

/** The keys dbvocab.mjs:60 looks for in the environment, in its own order. */
const ENV_KEYS = ["CHARPILOT_DB_URL", "DATABASE_URL_READ_ONLY"];

/** The key in `out/staging.env` that carries a DSN, or null. */
export function dsnInFile(path = STAGING_ENV) {
  if (!existsSync(path)) return null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // An unreadable env file is an env file with no DSN in it. The tools would
    // reach the same conclusion one frame further in.
    return null;
  }
  for (const key of FILE_KEYS) {
    const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
    const value = line?.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
    if (value) return key;
  }
  return null;
}

/** The environment variable that carries a DSN, or null. */
export function dsnInEnv(env = process.env) {
  return ENV_KEYS.find((k) => env[k]?.trim()) ?? null;
}

/**
 * What this environment can ask each tool for, and what it cannot.
 *
 * ONE function, read by both `satisfied` and `run`, so the predicate and the
 * sentence printed beside it cannot come to disagree about which probe was
 * possible.
 *
 * `--env-file` is passed to dbvocab.mjs whenever out/staging.env carries a DSN,
 * even though dbvocab.mjs would also find $CHARPILOT_DB_URL on its own. The
 * reason is that providervocab.mjs can read nothing else: one file for both
 * means both probes describe the SAME database, and two halves of one
 * vocabulary read off two different databases is a worse artifact than half a
 * vocabulary.
 */
export function probes(env = process.env) {
  const inFile = dsnInFile();
  const inEnv = dsnInEnv(env);
  const fileSays = inFile ? `${here(STAGING_ENV)} carries ${inFile}` : null;

  return [
    {
      tool: "dbvocab",
      artifact: DB_VOCABULARY_JSON,
      args: inFile ? ["--env-file", STAGING_ENV] : [],
      why: fileSays ?? (inEnv ? `$${inEnv} is set` : null),
      cannot:
        `no read-only staging DSN — ${here(STAGING_ENV)} names none, and neither ` +
        `$${ENV_KEYS.join(" nor $")} is set. A mocked run legitimately has none; ` +
        `derive still works from source, with less vocabulary`,
    },
    {
      tool: "providervocab",
      artifact: PROVIDER_VOCAB_JSON,
      // No flag: out/staging.env is already its default (providervocab.mjs:59),
      // and passing it again would be a second place for that name to be true.
      args: [],
      why: fileSays,
      cannot:
        `providervocab.mjs reads an env FILE and no environment variable, and ` +
        `${here(STAGING_ENV)} is absent or names no DSN — so this run has no ` +
        `recorded provider outcomes to read, and derive proposes from source instead`,
    },
  ];
}

/**
 * WHAT AN EMPTY VOCABULARY SAYS, read off the artifact rather than guessed at.
 *
 * Both tools answer "there was nothing here to read" the same way — an
 * `{ empty: true, reason }` document on disk, exit 0 (dbvocab.mjs:660,
 * providervocab.mjs `emptyVocabulary`). `wrote out/provider-vocab.json` alone
 * would then be indistinguishable from a file holding 17,136 recorded calls,
 * which is exactly the confusion D49 lived in: for four days the log could not
 * say whether this service records provider usage or whether the probe fell
 * over, so nobody asked.
 *
 * Returns "" for a vocabulary that holds something, and for an unreadable or
 * unparseable file — the disk is the tool's business, and a step that refused
 * to describe a file it could not parse would be answering a question that
 * belongs one layer down.
 */
function emptyReason(artifact) {
  try {
    const doc = JSON.parse(readFileSync(artifact, "utf8"));
    return doc?.empty === true && typeof doc.reason === "string" && doc.reason ? ` — ${doc.reason}` : "";
  } catch {
    return "";
  }
}

/** Nothing to be blocked on: an absent vocabulary is an answer, not a blocker. */
export function precondition(_repo) {
  return null;
}

/**
 * OPTIONAL: this step runs, and the run does not depend on it succeeding.
 *
 * A vocabulary is a HELP for deriving inputs, not a gate in front of them.
 * Run 20260916T094420Z died here - providervocab.mjs could not resolve
 * @prisma/client in the target repo - and stopped a run that had just completed
 * six steps in one minute. Every service without an LLM usage table, every
 * ungenerated Prisma client and every momentary database blip would otherwise
 * have the power to spend a four-hour budget in one minute.
 *
 * `satisfied` still answers honestly, from the disk, so the log says whether
 * the vocabulary is actually there. The walk reads OPTIONAL and carries on.
 */
export const OPTIONAL = true;

/** THE DISK: every probe this environment could make has left its artifact. */
export function satisfied(_repo) {
  return probes().every((p) => p.why === null || existsSync(p.artifact));
}

export function run(_repo) {
  const did = [];

  // BOTH, and a failure in the first does not stop the second. `runTools` stops
  // at the first failure because there the second tool reads the first one's
  // output; these two read different tables of the same database and neither
  // needs the other's file. Skipping the provider probe because the database
  // probe failed would throw away vocabulary that was still available.
  for (const p of probes()) {
    if (p.why === null) {
      did.push(`skipped ${p.tool}.mjs — ${p.cannot}`);
      continue;
    }
    // AND THE CONVERSE OF THE PARAGRAPH ABOVE, which was unhandled: one probe
    // SUCCEEDING must not mean re-running it because the other is missing.
    // `satisfied` is all-or-nothing across both probes, so a run that has
    // db-vocabulary.json but no provider-vocabulary.json re-enters this loop
    // and spends dbvocab's remote queries again — measured at ~3 minutes per
    // round on qode-ptp-ms, every round, for a file already on disk.
    if (existsSync(p.artifact)) {
      did.push(`${p.tool}.mjs — ${here(p.artifact)} already on disk${emptyReason(p.artifact)}`);
      continue;
    }
    // Nothing is said BEFORE the spawn. `runTool` puts "ran dbvocab.mjs" in the
    // line when it ran and says nothing at all when the tool is not installed,
    // and a sentence added here would read like work on exactly that run.
    const outcome = runTool(p.tool, p.args);
    if (outcome.line) did.push(outcome.line);
    // Named from the disk rather than from the tool's claim to have written it.
    if (outcome.ok && existsSync(p.artifact)) did.push(`wrote ${here(p.artifact)}${emptyReason(p.artifact)}`);
  }

  return { did, pending: [], metrics: {} };
}
