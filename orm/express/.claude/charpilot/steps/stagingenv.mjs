/**
 * stagingenv — resolve the deployed environment ONCE, from the qode-iac
 * manifests, so stage 4 does not discover its addresses one failure at a time.
 *
 * WHAT `satisfied` ASKS, and why it is not just "the file is there".
 * stagingenv.mjs writes out/staging-env.json whatever it found and then sets a
 * non-zero exit for every state but `resolved` (stagingenv.mjs:698). So the
 * artifact exists after a run that resolved nothing, and a step that read only
 * its existence would report itself done, let the walk carry on, and hand stage
 * 4 an environment nobody resolved — which is how a run learns at minute 99
 * that everything it recorded was mocked, measured twice at 96.5% and 93.5%
 * against denied boundaries.
 *
 * So the file has to say it resolved. The two states that count are the two
 * baseline.mjs itself accepts before reading the report: `resolved`, and
 * `resolved-no-database` for a service whose manifests carry no DATABASE_URL.
 */
import { existsSync, readFileSync } from "node:fs";

import { isNoDatabase, STAGING_REPORT } from "../config.mjs";
import { check as freshnessOf } from "../freshness.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "stagingenv";

/** stagingenv.mjs:593-598 mints exactly these two out of a successful resolve. */
const RESOLVED = new Set(["resolved", "resolved-no-database"]);

/**
 * Nothing to be blocked on: where the manifests are is stagingenv.mjs's own
 * search, and it already refuses with the one instruction that fixes it (pass
 * --iac, or set CHARPILOT_IAC). Repeating that search here would put a second
 * copy of it in the pipeline, and the copies are what drift.
 */
export function precondition(_repo) {
  return null;
}

/**
 * A `no-manifest` the TOOL has already done everything about.
 *
 * stagingenv.mjs now tries the near names itself (`<name>-ms`, the package.json
 * name, the directory name) before it writes `no-manifest`, and records what it
 * tried in `manifestPrefix`. Past that point nothing an answering turn writes
 * reaches the tool - the walk spawns it with no arguments - so asking was a
 * round spent for nothing: company-enrich run 20260922T190516Z asked it 9 times.
 * The run goes on mocked (liveDecision already says so from this state), and
 * the gap is a NOTE in the result (see `notes` below) for a person, not a
 * question for the agent.
 *
 * A report WITHOUT `manifestPrefix` was written by a tool that did not search,
 * and is still asked.
 *
 * AND AN `iac-not-found` IN A RUN THAT ASKED FOR DOUBLES. The question exists so
 * a run that could have gone live does not learn at minute 99 that it was
 * mocked. A run configured CHARPILOT_MODE=mocked, or CHARPILOT_EXPECTED_DB=none
 * (which forces mocked), has already answered it: liveDecision reads the same
 * two settings first and returns mocked before it looks at this report, and the
 * stand-ins come from the repo's own schema (baseline.mjs refreshStandIns), not
 * from qode-iac. Asking anyway was a question no turn can settle without
 * inventing a checkout: the 2026-09-25 fleet dispatch asked it 14 rounds
 * running on all ten repos and never reached `baseline`.
 */
export function settledMocked(doc) {
  if (doc?.state === "no-manifest") {
    return Array.isArray(doc.manifestPrefix?.tried) && doc.manifestPrefix.tried.length > 0;
  }
  return doc?.state === "iac-not-found" && mockedByRequest();
}

/**
 * The two settings liveDecision (stagingenv.mjs) answers mocked from before it
 * reads anything - the operator's request, not something inferred from a report.
 */
export function mockedByRequest(env = process.env) {
  const mode = String(env.CHARPILOT_MODE ?? "").trim().toLowerCase();
  return mode === "mocked" || mode === "mock" || isNoDatabase(env.CHARPILOT_EXPECTED_DB);
}

/**
 * THE NOTE this step leaves in the result, asked on every visit - satisfied or
 * not - so it holds for as long as the report on disk says it. The walk writes
 * it to out/defects.json as `kind: "note"` (a step never writes an artifact),
 * and report.mjs lists it under `notes[]` without letting it decide the
 * status: no side is lost and the run goes on mocked.
 */
export function notes(_repo) {
  const doc = report();
  if (!settledMocked(doc)) return [];
  if (doc.state === "iac-not-found") {
    return [
      {
        id: `stagingenv:iac-not-found:${doc.serviceName ?? "unknown"}`,
        tool: "stagingenv.mjs",
        message:
          "no qode-iac checkout, and the run is mocked by request (CHARPILOT_MODE=mocked or CHARPILOT_EXPECTED_DB=none): " +
          "no deployed environment was resolved, the service boots on schema stand-ins, and every boundary is answered by a double",
      },
    ];
  }
  return [
    {
      id: `stagingenv:no-manifest:${doc.serviceName}`,
      tool: "stagingenv.mjs",
      message:
        `no ConfigMap or Secret for ${doc.serviceName} in ${doc.namespace ?? "staging"} under any name tried ` +
        `(${doc.manifestPrefix.tried.join(", ")}); the run records against doubles. ` +
        "Set CHARPILOT_SERVICE to the manifest prefix if the service is deployed under another name",
    },
  ];
}

/** The report this step resolved, or null when there is not a readable one. */
export function report() {
  if (!existsSync(STAGING_REPORT)) return null;
  try {
    return JSON.parse(readFileSync(STAGING_REPORT, "utf8"));
  } catch {
    // A truncated write from a killed run parses as nothing, and "nothing" is
    // not an environment. Re-running costs a manifest read; trusting it costs
    // every address stage 4 dials.
    return null;
  }
}

/** THE DISK. An unreadable, unresolved or STALE report is not a resolved environment. */
export function satisfied(_repo) {
  const doc = report();
  if (doc === null) return false;
  if (!RESOLVED.has(doc.state) && !settledMocked(doc)) return false;
  // FRESH, not merely resolved, and this was the whole of the predicate.
  //
  // `state: "resolved"` is true for ever once it is written: nothing in it
  // expires, so a staging-env.json resolved three weeks ago against manifests
  // that have since moved satisfies this step, `preflight` probes the hosts it
  // names, and stage 4 dials them. freshness.mjs TRACKS this artifact by name
  // and has since it was written — `{ file: "staging-env.json", stage: 1 }` —
  // and nothing but gate.mjs ever asked it, which is several rounds too late to
  // re-resolve anything. This is the same question `steps/baseline.mjs` asks of
  // its own artifact, for the reason run 20260918T040720Z gave: `already done`
  // answered from a stage-1 artifact recorded against a checkout at a
  // three-week-newer commit.
  //
  // It is answerable by running: `run` below re-resolves from the manifests and
  // rewrites the report, so a stale one costs a manifest read and not a round.
  return freshnessOf("staging-env.json").state === "fresh";
}

/* --------------------------------------------------------------------------
 * AN UNRESOLVED ENVIRONMENT IS A QUESTION WITH A NAME IN IT, AND THIS STEP USED
 * TO ASK NOTHING.
 *
 * WHAT IT USED TO DO. `run` was `runTools(["stagingenv"], STAGING_REPORT)`.
 * stagingenv.mjs writes its report WHATEVER it found and sets a non-zero exit
 * for every state but `resolved` (stagingenv.mjs:732), so on
 * `no-service-name`, `iac-not-found` or `no-manifest` the step reports the
 * tool's stderr tail in `did`, `satisfied` is false, and running again resolves
 * the same nothing from the same absent manifests. That is ORDER[1]: every
 * later step is behind it.
 *
 * WHAT THE TOOL ALREADY KNOWS AND NOBODY READ. Each of those three states is
 * written with a `findings` entry naming exactly what is missing and what to
 * pass — "no qode-iac checkout with a manifests/ directory … Pass --iac <path>
 * or set CHARPILOT_IAC" (stagingenv.mjs:368), "no ConfigMap or Secret named
 * <service> in manifests/*\/<ns> — either the manifest prefix differs from the
 * target's name (pass --service) or this service is not deployed to <ns>"
 * (stagingenv.mjs:633). All of it sits in out/staging-env.json, and the walk
 * printed a four-line stderr tail instead.
 *
 * A PENDING ITEM AND NOT A PRECONDITION. Every one of the three is settled by
 * something an answering turn can do — clone or point at qode-iac, name the
 * service, or write down that this service is not deployed to this namespace
 * and the round must be mocked. A precondition refusal writes no worklist by
 * design, because a precondition is for an inconsistency nobody can answer;
 * this is answerable, and the cost of refusing instead is the whole run.
 *
 * WHAT IS NOT DONE HERE: the step does not decide to carry on mocked. That
 * decision is `liveDecision`'s (stagingenv.mjs:804) and it is already made from
 * this report — "staging-env state is <state>" — and a step that quietly
 * proceeded would be how a run learns at minute 99 that everything it recorded
 * was mocked, measured twice at 96.5% and 93.5% against denied boundaries.
 * ------------------------------------------------------------------------ */
export function pendingFor(doc) {
  if (doc && (RESOLVED.has(doc.state) || settledMocked(doc))) return [];
  const state = doc?.state ?? "(no report on disk)";
  return [
    {
      id: `stagingenv:${state}`,
      kind: "environment",
      question:
        `the deployed environment could not be resolved from the qode-iac manifests — state \`${state}\`. ` +
        `Stage 4 dials the addresses this report resolves, so without it every boundary is answered by a double.`,
      context: {
        state,
        service: doc?.serviceName ?? doc?.service ?? null,
        namespace: doc?.namespace ?? null,
        iac: doc?.iac ?? null,
        // THE TOOL'S OWN SENTENCES, whole. Each state is written with the
        // finding that names the missing input and the flag that supplies it,
        // and a summary here would turn an instruction into a symptom.
        findings: doc?.findings ?? [],
        unverified: doc?.unverified ?? [],
        sources: doc?.sources ?? [],
        says:
          "Re-running this step resolves the same nothing from the same manifests, so it is asked rather than " +
          "refused. The three unresolved states each have their own move, and the `findings` above name which one " +
          "this is: `iac-not-found` wants a qode-iac checkout (pass --iac, or set CHARPILOT_IAC); " +
          "`no-service-name` wants the service named (--service), because nothing in package.json or the directory " +
          "name could be looked up; `no-manifest` means no ConfigMap or Secret by that name exists in that " +
          "namespace — either the manifest prefix differs from the target's name, or this service is not deployed " +
          "there at all. If it genuinely is not deployed, say so: this run then records against doubles, and a " +
          "mocked recording freezes the behaviour of denied boundaries, which protects nothing.",
      },
    },
  ];
}

export function run(_repo) {
  const did = [];
  const outcome = runTool("stagingenv");
  if (outcome.line) did.push(outcome.line);
  if (outcome.ok && existsSync(STAGING_REPORT)) did.push(`wrote ${here(STAGING_REPORT)}`);

  const doc = report();
  const pending = pendingFor(doc);
  if (settledMocked(doc)) {
    did.push(
      doc.state === "iac-not-found"
        ? "no qode-iac checkout, and the run is mocked by request - nothing to resolve; it is a note in the result, not asked"
        : `no manifest for ${doc.serviceName} under any name tried (${doc.manifestPrefix.tried.join(", ")}) - ` +
            `the run goes on mocked; it is a note in the result, not asked`
    );
  }
  if (pending.length) {
    did.push(
      `the environment is ${doc?.state ?? "not on disk"}, not resolved: ` +
        `${(doc?.findings ?? []).join(" · ") || "the report names no finding"}`
    );
  }
  return { did, pending, metrics: {} };
}
