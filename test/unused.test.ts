import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_SCOPE } from "../src/check.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { findUnused, repoWords } from "../src/unused.js";

const config = { ...DEFAULT_CONFIG, environments: ["staging", "production"], unusedIgnore: ["LEGACY_*"] };
const inv = {
  shared: new Set(["REPO_USED", "REPO_UNUSED", "ORG_SECRET"]),
  org: new Set(["ORG_SECRET"]),
  environments: new Map([["staging", new Set(["STAGING_UNUSED", "STAGING_USED"])]]),
};

describe("findUnused", () => {
  it("reports configured names that appear nowhere, per environment", () => {
    const runtime = new Map([["production", new Set(["PROD_USED", "PROD_UNUSED", "NEXTAUTH_SECRET", "LEGACY_FLAG", "VERCEL_URL", "REPO_UNUSED"])]]);
    const used = new Set(["REPO_USED", "STAGING_USED", "PROD_USED"]);
    expect(findUnused(config, inv, runtime, used)).toEqual({
      [REPO_SCOPE]: ["REPO_UNUSED"], // reported once, not again under production
      staging: ["STAGING_UNUSED"],
      production: ["PROD_UNUSED"], // implicit (NEXTAUTH_SECRET), unusedIgnore, platform names and org values skipped
    });
  });

  it("returns nothing when everything is used", () => {
    expect(findUnused(config, { shared: new Set(["A"]), environments: new Map() }, new Map(), new Set(["A"]))).toEqual({});
  });
});

describe("repoWords", () => {
  it("collects words from any text file and skips binaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "envsure-words-"));
    try {
      writeFileSync(join(dir, "Dockerfile"), "ARG BUILD_TOKEN\nRUN echo $BUILD_TOKEN");
      writeFileSync(join(dir, "deploy.sh"), 'curl -H "x: ${DEPLOY_HOOK}"');
      writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0, 0x41, 0x42, 0x43, 0x44]));
      const words = repoWords(dir, ["Dockerfile", "deploy.sh", "logo.png", "missing.txt"]);
      expect(words.has("BUILD_TOKEN")).toBe(true);
      expect(words.has("DEPLOY_HOOK")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
