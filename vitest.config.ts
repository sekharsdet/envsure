import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several tests spawn git or node; on a busy machine (e.g. right after `npm ci`) 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
