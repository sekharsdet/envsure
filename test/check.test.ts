import { describe, expect, it } from "vitest";
import { check, REPO_SCOPE } from "../src/check.js";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.js";
import { lintDotenv } from "../src/dotenv.js";
import type { EnvRef } from "../src/scan.js";

const ref = (name: string, kind: EnvRef["kind"] = "code"): EnvRef => ({ name, file: "src/x.ts", line: 1, kind });

describe("check", () => {
  const inv = {
    shared: new Set(["SHARED"]),
    environments: new Map([
      ["staging", new Set(["STRIPE_WEBHOOK_SECRET", "ONLY_STAGING"])],
      ["production", new Set(["STRIPE_WEBHOOK_SECRET"])],
    ]),
  };
  const config = { ...DEFAULT_CONFIG, environments: ["staging", "production"] };

  it("reports names missing from some environments", () => {
    const f = check([ref("SHARED"), ref("STRIPE_WEBHOOK_SECRET"), ref("ONLY_STAGING"), ref("NOWHERE")], inv, config);
    expect(f.map((x) => [x.name, x.missingIn, x.presentIn])).toEqual([
      ["NOWHERE", ["staging", "production"], []],
      ["ONLY_STAGING", ["production"], ["staging"]],
    ]);
  });

  it("skips ignored, platform and GITHUB_TOKEN names", () => {
    const f = check(
      [ref("PORT"), ref("GITHUB_SHA"), ref("GITHUB_TOKEN", "workflow-secret"), ref("CUSTOM")],
      inv,
      { ...config, ignore: ["CUSTOM"] },
    );
    expect(f).toEqual([]);
  });

  it("falls back to repository scope without environments and lists where it exists", () => {
    const f = check([ref("ONLY_STAGING")], inv, DEFAULT_CONFIG);
    expect(f[0].missingIn).toEqual([REPO_SCOPE]);
    expect(f[0].presentIn).toEqual(["staging"]);
  });

  it("scopes workflow references to the job's environment", () => {
    const wf = (name: string, environment: string | null): EnvRef => ({ ...ref(name, "workflow-secret"), environment });
    const f = check(
      [wf("ONLY_STAGING", "staging"), wf("STRIPE_WEBHOOK_SECRET", null), wf("SHARED", null)],
      inv,
      config,
    );
    expect(f.map((x) => [x.name, x.missingIn, x.presentIn])).toEqual([
      ["STRIPE_WEBHOOK_SECRET", [REPO_SCOPE], ["staging", "production"]],
    ]);
  });

  it("groups references by name", () => {
    const f = check([ref("NOWHERE"), { ...ref("NOWHERE"), line: 9 }], inv, config);
    expect(f).toHaveLength(1);
    expect(f[0].refs).toHaveLength(2);
  });
});

describe("parseConfig", () => {
  it("parses yaml and validates lists", () => {
    expect(parseConfig("environments: [staging, production]\nignore: [FOO_*]").environments).toEqual(["staging", "production"]);
    expect(() => parseConfig("ignore: FOO")).toThrow(/list of strings/);
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });
});

describe("lintDotenv", () => {
  it("flags empty and placeholder values", () => {
    const issues = lintDotenv(".env.production", "STRIPE_SECRET_KEY=\nA=sk_test_your_key_here\nB=\"your_api_key_here\"\nC=real\n");
    expect(issues.map((i) => [i.key, i.problem])).toEqual([
      ["STRIPE_SECRET_KEY", "empty"],
      ["A", "placeholder"],
      ["B", "placeholder"],
    ]);
  });

  it("flags quoted values for docker env files", () => {
    expect(lintDotenv("app.env", "A=\"x\"\nB=y", true).map((i) => i.problem)).toEqual(["quoted-for-docker"]);
  });
});
