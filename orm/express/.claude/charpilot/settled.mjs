#!/usr/bin/env node
/**
 * WOULD A WALK NOW BANK ANYTHING, asked without walking.
 *
 *   node .claude/charpilot/settled.mjs      prints { settled, unsettled }; exit 0 when settled
 *
 * docker/char/packs/nodejs.py skips the walk after a turn that changed nothing
 * the walk reads (item 1, docs/speed/README.md). A turn that changed nothing is
 * not enough on its own: the walk before it may have left work for the next
 * one. `derive` materialises answers AFTER the banking visits, and until D65
 * its proposals were recorded by the next walk (sourcing-ms, 26 September:
 * round 1's turn was empty, and round 2's walk still spent 476 seconds
 * recording what round 1's walk had materialised). The walk now banks them
 * before it hands over (workflow.mjs, D65), so this should find them banked;
 * it is still asked, because a banking visit can fail or be held, and `repair`
 * can withdraw a claim and leave the recording stale (D53). So before it skips, the pack asks this: every step in
 * BANKS answers `satisfied` from the disk, as its banking visit would, and one
 * that does not is named.
 *
 * A TOOL, NOT A WALK FLAG. It runs nothing and writes nothing; the walk's own
 * business on disk is the handover and its digest (steps.never-repair-a-tools-
 * output), and a settled-state file the walk wrote would be a second one.
 */
import { BANK_WALK_ENV, VISIT_ENV } from "./incremental.mjs";
import { BANKS, ORDER, loadStep as loadStepFromDisk } from "./steps/index.mjs";
import { REPO_ROOT } from "./config.mjs";

export async function settled({ loadStep = loadStepFromDisk, order = ORDER, repo = REPO_ROOT, env = process.env } = {}) {
  // Asked as the banking visit asks it: that is the visit a skipped walk
  // would have made, and the one a partial gate may serve.
  env[BANK_WALK_ENV] = "";
  env[VISIT_ENV] = "banking";
  const unsettled = [];
  for (const name of BANKS.filter((b) => order.includes(b))) {
    try {
      const step = await loadStep(name);
      if (!(await step.satisfied(repo))) unsettled.push(name);
    } catch (err) {
      unsettled.push(`${name} (satisfied() threw: ${err?.message ?? err})`);
    }
  }
  return { settled: unsettled.length === 0, unsettled };
}

if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  const said = await settled();
  process.stdout.write(`${JSON.stringify(said)}\n`);
  process.exit(said.settled ? 0 : 1);
}
