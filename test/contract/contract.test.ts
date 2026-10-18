// Contract tests: run every connector against the mock, then check each HTTP exchange against the
// platform's official, published API description (downloaded fresh in CI every week).
// Catches wrong paths, undeclared query parameters, and connectors that read fields the real API
// does not document. Needs network access for the spec downloads.
import { spawnSync } from "node:child_process";
import { buildClientSchema, getIntrospectionQuery, parse, validate } from "graphql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOURCES } from "../../src/sources/index.js";
import { RAILWAY_QUERY } from "../../src/sources/platforms.js";
import type { Options, SourceContext } from "../../src/sources/types.js";
import { type MockServer, startMockServer } from "../mock/server.mjs";
import { loadContract, type SpecName } from "./specs.js";

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockServer();
});
afterAll(() => mock.close());

const ctx = (): SourceContext => ({
  env: { ...process.env, ...mock.env },
  cwd: process.cwd(),
  fetch,
  exec: (cmd, args, o) => spawnSync(cmd, args ?? [], { ...o, encoding: "utf8" }) as ReturnType<SourceContext["exec"]>,
  warn: () => {},
});

/** Connector calls to make per spec; each must succeed against the mock. */
const SCENARIOS: Record<SpecName, [type: string, opts: Options][]> = {
  vercel: [
    ["vercel", { project: "web", team: "team_123" }],
    ["vercel", { project: "web", team: "team_123", target: "preview" }],
    ["vercel", { project: "web", team: "team_123", customEnvironment: "staging" }],
  ],
  render: [["render", { service: "srv-1", envGroups: ["evg-1"] }]],
  netlify: [["netlify", { account: "acct", site: "site-1", context: "branch:staging" }]],
  heroku: [["heroku", { app: "hk-app" }]],
  fly: [["fly", { app: "fly-app" }]],
  cloudflare: [["cloudflare", { account: "cf-acct", worker: "worker-1" }], ["cloudflare", { account: "cf-acct", pages: "pages-1" }]],
  digitalocean: [["digitalocean", { app: "do-app", component: "api" }]],
  "gcp-secret-manager": [["gcp-secret-manager", { project: "gproj" }]],
  "gcp-cloud-run": [["gcp-cloud-run", { project: "gproj", region: "us-central1", service: "run-svc" }]],
  "azure-keyvault": [["azure-keyvault", { vault: "kv-test" }]],
  "azure-appservice": [
    ["azure-appservice", { subscription: "sub", resourceGroup: "rg", app: "as-app" }],
    ["azure-appservice", { subscription: "sub", resourceGroup: "rg", app: "as-app", slot: "staging" }],
  ],
};

/** Query parameters that are legitimate but live outside the operation's own definition. */
const EXTRA_QUERY: Partial<Record<SpecName, string[]>> = {
  // Azure declares api-version in a shared file; $skiptoken arrives inside the server's nextLink.
  "azure-keyvault": ["api-version", "$skiptoken"],
};

/**
 * Fields the connectors read that a platform documents elsewhere but leaves out of its OpenAPI file.
 * Each entry needs a citation; anything else undocumented fails the test.
 */
const KNOWN_SPEC_GAPS: Partial<Record<SpecName, string[]>> = {
  // App-level envs: "A list of environment variables made available to all components in the app."
  // https://docs.digitalocean.com/products/app-platform/reference/app-spec/ (absent from app_spec in the OpenAPI file)
  digitalocean: ["response field /app/spec/envs is not documented (GET /v2/apps/{id})"],
};

describe.each(Object.keys(SCENARIOS) as SpecName[])("%s matches its official API description", (name) => {
  it("every request and response conforms", async () => {
    const contract = await loadContract(name);
    const start = mock.requests.length;
    for (const [type, opts] of SCENARIOS[name]) await SOURCES[type].fetchNames(opts, ctx());
    const exchanges = mock.requests.slice(start).filter((r) => r.path.startsWith(`/${name}/`));
    expect(exchanges.length).toBeGreaterThan(0);
    const problems = exchanges.flatMap((ex) =>
      contract.check({ ...ex, path: ex.path.slice(name.length + 1), query: ex.query.filter((q) => !EXTRA_QUERY[name]?.includes(q)) }));
    const gaps = KNOWN_SPEC_GAPS[name] ?? [];
    expect(problems.filter((p) => !gaps.includes(p))).toEqual([]);
  }, 300_000);
});

describe("railway", () => {
  it("the variables query is valid against Railway's live GraphQL schema", async () => {
    const res = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    expect(res.ok).toBe(true);
    const { data } = (await res.json()) as { data: Parameters<typeof buildClientSchema>[0] };
    // assumeValid: Railway's schema trips graphql-js's own schema rules (deprecations on interfaces),
    // which says nothing about whether our query is valid against it.
    const errors = validate(buildClientSchema(data, { assumeValid: true }), parse(RAILWAY_QUERY));
    expect(errors.map((e) => e.message)).toEqual([]);
  }, 120_000);
});
