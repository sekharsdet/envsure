import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github.js";

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(url);
    if (!(path in routes)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("GitHubClient.inventory", () => {
  it("collects names across scopes and drops variable values", async () => {
    const b = "/repos/o/r";
    const { impl } = fakeFetch({
      [`${b}/actions/secrets`]: { total_count: 1, secrets: [{ name: "REPO_SECRET" }] },
      [`${b}/actions/organization-secrets`]: { total_count: 1, secrets: [{ name: "ORG_SECRET" }] },
      [`${b}/actions/variables`]: { total_count: 1, variables: [{ name: "REPO_VAR", value: "v" }] },
      [`${b}/actions/organization-variables`]: { total_count: 0, variables: [] },
      [`${b}/environments/production/secrets`]: { total_count: 1, secrets: [{ name: "PROD_SECRET" }] },
      [`${b}/environments/production/variables`]: { total_count: 1, variables: [{ name: "PROD_VAR", value: "v" }] },
    });
    const inv = await new GitHubClient("t", "https://api.test", impl).inventory("o", "r", ["production", "missing-env"]);
    expect([...inv.shared].sort()).toEqual(["ORG_SECRET", "REPO_SECRET", "REPO_VAR"]);
    expect([...inv.environments.get("production")!].sort()).toEqual(["PROD_SECRET", "PROD_VAR"]);
    expect([...inv.environments.get("missing-env")!]).toEqual([]);
    expect(JSON.stringify([...inv.shared, ...inv.environments.get("production")!])).not.toContain('"v"');
  });

  it("paginates", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ name: `S${i}` }));
    let n = 0;
    const impl = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/actions/secrets")) {
        n++;
        const p = Number(u.searchParams.get("page"));
        return new Response(JSON.stringify({ total_count: 101, secrets: p === 1 ? page : [{ name: "LAST" }] }));
      }
      return new Response(JSON.stringify({ total_count: 0, secrets: [], variables: [] }));
    }) as unknown as typeof fetch;
    const inv = await new GitHubClient("t", "https://api.test", impl).inventory("o", "r", []);
    expect(n).toBe(2);
    expect(inv.shared.has("LAST")).toBe(true);
  });

  it("surfaces auth errors", async () => {
    const impl = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(new GitHubClient("t", "https://api.test", impl).inventory("o", "r", [])).rejects.toThrow(/403/);
  });
});
