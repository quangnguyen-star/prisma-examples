/**
 * The stock `@vitest/coverage-istanbul` module, with the provider it builds
 * wrapped by coveragechunks.mjs `keepChunks` - which says why. Everything the
 * worker calls (`takeCoverage`, `startCoverage`) is istanbul's own.
 *
 * Resolved from the target repo's node_modules, like every other vitest import
 * under .claude/charpilot/: install.sh pins @vitest/coverage-istanbul to the
 * repo's exact vitest.
 */
import istanbul from "@vitest/coverage-istanbul";

import { keepChunks } from "./coveragechunks.mjs";

export default {
  ...istanbul,
  async getProvider() {
    return keepChunks(await istanbul.getProvider());
  },
};
