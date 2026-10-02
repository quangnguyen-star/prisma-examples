import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

import baseConfig from "../../vitest.config.mts";
import { replayAliases } from "./resolution.mjs";

// cigate's RE-CHECK: the repo's own config, with the recording's resolution and
// NOTHING else changed.
//
// cigate runs the corpus under the repo's own config (what `npm test` runs). A
// test red there is re-run here before it is withheld: green here means the one
// thing this config changes - how modules resolve - is what made it red, which
// is a config gap of this pipeline's, not a red test. That is only a proof if
// resolution IS the one difference. The re-check used to run under the
// coverage config, which also drops the repo's setupFiles, sets its own
// timeouts and loads the recorded env - so a test the repo's own setup file
// makes red (a real CI red) passed there, was called a config gap, and was
// shipped red (verifier, fix round 1, `probes/host-setup.ts`).
//
// Same merge as the corpus config and the coverage config (resolution.mjs):
// the host's aliases over the pipeline's floor. Setup files, include, env,
// timeouts, pool: all the repo's.
//
// install.sh rewrites `../../vitest.config.mts` to the repo's own base name.
// Fail closed on a config that is not a plain object. A function-form or
// Promise config (`defineConfig(() => ({...}))`) spreads to `{}`, which drops
// the repo's setupFiles - exactly the difference this file exists to remove -
// so a real CI red would pass here and be called a config gap (integration
// verifier F1). Throwing makes the re-check fail, so cigate keeps the withhold
// and says `config-gap-unchecked`.
if (baseConfig === null || typeof baseConfig !== "object" || typeof (baseConfig as any).then === "function") {
  throw new Error(
    `charpilot re-check: the repo's vitest config exports a ${typeof baseConfig === "function" ? "function" : "non-object"} config, ` +
      "which cannot be merged without losing its settings; the re-check does not run and the withhold stands",
  );
}

export default defineConfig({
  ...baseConfig,
  resolve: { ...baseConfig.resolve, alias: replayAliases(baseConfig.resolve?.alias, resolve(__dirname, "..", "..")) },
});
