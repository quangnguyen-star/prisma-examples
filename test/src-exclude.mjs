// Copied from this repo's own vitest coverage.exclude by charpilot install.
// It must MIRROR that list: leaving it empty makes the scan count arms
// istanbul was never asked to instrument (measured: ast 367 vs istanbul 365).
// This repo keeps its TypeScript at the repo root rather than under src/.
export const SRC_DIR = ".";
export const SRC_EXCLUDE = [];
export const TYPE_ONLY_DIRS = [];
