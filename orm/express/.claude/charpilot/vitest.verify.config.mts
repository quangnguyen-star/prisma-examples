import { defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.mts";

// Runs ONLY the generated entry-verification spec. Separate config because the
// root config deliberately excludes scripts/**, and because this run must not
// produce coverage or touch the pilot's recorded numbers.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: [],
    include: [".claude/charpilot/out/entry-verify.test.ts"],
    coverage: { enabled: false },
    testTimeout: 120_000,
  },
});
