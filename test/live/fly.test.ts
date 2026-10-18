// Live check against Fly.io, run by CI on every OS when the FLY_E2E_TOKEN secret is available
// (a deploy token scoped to one throwaway app with staged dummy secrets; never on fork PRs).
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SOURCES } from "../../src/sources/index.js";
import type { SourceContext } from "../../src/sources/types.js";

const token = process.env.FLY_E2E_TOKEN;
const app = process.env.FLY_E2E_APP;
const ctx = (env: Record<string, string | undefined>): SourceContext => ({
  env: { ...process.env, ...env },
  cwd: process.cwd(),
  fetch,
  exec: (cmd, args, o) => spawnSync(cmd, args ?? [], { ...o, encoding: "utf8" }) as ReturnType<SourceContext["exec"]>,
  warn: () => {},
});

describe.skipIf(!token || !app)("Fly.io (live)", () => {
  it("lists the app's secret names with a scoped deploy token", async () => {
    const found = await SOURCES.fly.fetchNames({ app: app! }, ctx({ FLY_API_TOKEN: token }));
    expect([...found]).toContain("E2E_FLY_SECRET");
  }, 60_000);

  it("rejects a bad token with a hint", async () => {
    await expect(SOURCES.fly.fetchNames({ app: app! }, ctx({ FLY_API_TOKEN: "bad" })))
      .rejects.toThrow(/HTTP 401 .*FLY_API_TOKEN/);
  }, 60_000);

  it("a token scoped to one app cannot read another", async () => {
    await expect(SOURCES.fly.fetchNames({ app: "envsure-not-this-app" }, ctx({ FLY_API_TOKEN: token })))
      .rejects.toThrow(/HTTP (401|403|404)/);
  }, 60_000);
});
