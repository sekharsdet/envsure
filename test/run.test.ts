import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { collectRefs, environmentsToFetch } from "../src/run.js";
import type { EnvRef } from "../src/scan.js";

describe("environmentsToFetch", () => {
  it("adds literal workflow job environments to the configured ones", () => {
    const refs: EnvRef[] = [
      { name: "A", file: "w.yml", line: 1, kind: "workflow-secret", environment: "preview" },
      { name: "B", file: "w.yml", line: 2, kind: "workflow-secret", environment: null },
      { name: "C", file: "w.yml", line: 3, kind: "workflow-secret", environment: "staging" },
      { name: "D", file: "a.ts", line: 1, kind: "code" },
    ];
    expect(environmentsToFetch({ ...DEFAULT_CONFIG, environments: ["staging"] }, refs)).toEqual(["staging", "preview"]);
  });
});

describe("collectRefs", () => {
  it("scans files with non-ASCII paths in a diff", () => {
    const dir = mkdtempSync(join(tmpdir(), "envsure-test-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.quotepath=on", ...args], { cwd: dir });
    try {
      git("init", "-q", "-b", "main");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
      writeFileSync(join(dir, "ünï.ts"), "process.env.UNICODE_VAR;\n");
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add");
      expect(collectRefs(dir, DEFAULT_CONFIG, "HEAD~1").refs.map((r) => r.name)).toEqual(["UNICODE_VAR"]);
      expect(collectRefs(dir, DEFAULT_CONFIG).refs.map((r) => r.name)).toEqual(["UNICODE_VAR"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
