/**
 * D77 - A FULL PASS OVER THE CORPUS IS GIVEN TIME FOR THE CORPUS IT RUNS.
 *
 * How it worked before: coverage.mjs and cigate.mjs spawned vitest over the
 * whole characterization corpus with a fixed `timeout: 30 * 60_000`. qode-ptp-ms
 * run 20260929T042904Z re-recorded every row on its CI Node (D54), so all 408
 * spec files were new: cigate's full pass took 26 of its 30 minutes (08:44 ->
 * 09:10) and measure's, the same suite under istanbul with per-file chunks,
 * ran past 30 and was killed - `spawnSync /opt/node/20/bin/node ETIMEDOUT`,
 * no coverage.json, and the walk ended on a tool failure with every row
 * recorded and the gate green.
 *
 * The limit now scales with the number of spec files the pass runs:
 * PER_SPEC_MS each, never under the old 30 minutes, never over CEILING_MS.
 * 12 s a file is about 3x cigate's measured 3.8 s (26 min / 408) - measure
 * runs the same files under coverage, so it is slower but not 3x slower.
 * `CHARPILOT_SUITE_TIMEOUT_MIN` overrides it outright, for a repo whose suite
 * is known to need more.
 */
export const FLOOR_MS = 30 * 60_000;
export const PER_SPEC_MS = 12_000;
export const CEILING_MS = 180 * 60_000;
export const OVERRIDE_ENV = "CHARPILOT_SUITE_TIMEOUT_MIN";

/** The time a vitest pass over `specs` spec files is allowed, in ms. */
export function suiteTimeoutMs(specs, raw = process.env[OVERRIDE_ENV]) {
  const set = Number(String(raw ?? "").trim());
  if (String(raw ?? "").trim() !== "" && Number.isFinite(set) && set > 0) return Math.round(set * 60_000);
  const n = Number.isFinite(specs) && specs > 0 ? specs : 0;
  return Math.min(CEILING_MS, Math.max(FLOOR_MS, n * PER_SPEC_MS));
}

/** How a pass that ran out of time says so: the limit, and how to raise it. */
export function timedOutLine(ms, specs) {
  return `ran past its ${Math.round(ms / 60_000)}-min limit over ${specs} spec file(s) ` +
    `(${Math.round(PER_SPEC_MS / 1000)} s a file, at least ${FLOOR_MS / 60_000} min; ${OVERRIDE_ENV} raises it)`;
}
