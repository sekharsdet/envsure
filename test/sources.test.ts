import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { SOURCES } from "../src/sources/index.js";
import { flyTomlEnvKeys, parseNames } from "../src/sources/names.js";
import type { Options, SourceContext } from "../src/sources/types.js";
import { type MockServer, startMockServer, VALUE } from "./mock/server.mjs";

let mock: MockServer;
let dir: string;
const warnings: string[] = [];

beforeAll(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), "envsure-sources-"));
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (env: Record<string, string | undefined> = {}): SourceContext => ({
  // Real runs pass the whole process env; without PATH, macOS cannot find `node` for the command source.
  env: { ...process.env, ...mock.env, ...env },
  cwd: dir,
  fetch,
  exec: (cmd, args, o) => spawnSync(cmd, args ?? [], { ...o, encoding: "utf8" }) as ReturnType<SourceContext["exec"]>,
  warn: (m) => warnings.push(m),
});
const names = async (type: string, opts: Options, env?: Record<string, string | undefined>) =>
  [...(await SOURCES[type].fetchNames(opts, ctx(env)))].sort();
const fails = async (type: string, opts: Options, env?: Record<string, string | undefined>) => {
  try {
    await SOURCES[type].fetchNames(opts, ctx(env));
  } catch (err) {
    const msg = (err as Error).message;
    expect(msg).not.toContain(VALUE);
    return msg;
  }
  throw new Error(`${type} did not fail`);
};

describe("hosting platforms", () => {
  it("vercel: partial pages are reported, not silently truncated", async () => {
    warnings.length = 0;
    expect(await names("vercel", { project: "web-partial", team: "team_123" })).toEqual(["VC_PROD"]);
    expect(warnings).toEqual(["vercel web-partial (production): Vercel returned a partial page; results may be incomplete"]);
  });
  it("vercel: custom environments by slug", async () => {
    expect(await names("vercel", { project: "web", team: "team_123", customEnvironment: "staging" })).toEqual(["VC_CUSTOM_STAGING"]);
    expect(await fails("vercel", { project: "web", team: "team_123", customEnvironment: "qa" }))
      .toMatch(/no custom environment "qa" \(have: staging\)/);
  });
  it("vercel: filters by target and drops other branches", async () => {
    expect(await names("vercel", { project: "web", team: "team_123" })).toEqual(["VC_BOTH", "VC_PROD", "VC_STRING_TARGET"]);
    expect(await names("vercel", { project: "web", team: "team_123", target: "preview" })).toEqual(["VC_BOTH", "VC_PREVIEW"]);
    expect(await names("vercel", { project: "web", team: "team_123", target: "preview", gitBranch: "feature-x" }))
      .toEqual(["VC_BOTH", "VC_BRANCH_ONLY", "VC_PREVIEW"]);
  });
  it("vercel: missing and wrong tokens", async () => {
    expect(await fails("vercel", { project: "web" }, { VERCEL_TOKEN: undefined })).toMatch(/no credentials; set VERCEL_TOKEN/);
    expect(await fails("vercel", { project: "web", team: "team_123" }, { VERCEL_TOKEN: "nope" })).toMatch(/HTTP 401 .* check VERCEL_TOKEN/);
    expect(await fails("vercel", { project: "nope", team: "team_123" })).toMatch(/HTTP 404/);
  });
  it("tokenEnv selects another variable", async () => {
    expect(await names("vercel", { project: "web", team: "team_123", tokenEnv: "MY_VERCEL" },
      { VERCEL_TOKEN: undefined, MY_VERCEL: mock.env.VERCEL_TOKEN })).toContain("VC_PROD");
    expect(await fails("vercel", { project: "web", tokenEnv: "MY_VERCEL" })).toMatch(/set MY_VERCEL/);
  });
  it("render: cursor pagination over 101 vars plus env groups linked to the service", async () => {
    const service = await names("render", { service: "srv-1" });
    expect(service).toHaveLength(103); // 101 service vars + evg-1 + evg-2 (linked); evg-3 is not linked
    expect(service).toContain("RND_VAR_100");
    expect(service).toContain("RND_LINKED_VAR");
    expect(await names("render", { service: "srv-1", linkedEnvGroups: false })).toHaveLength(101);
    expect(await names("render", { envGroups: ["evg-1"] })).toEqual(["RND_GROUP_VAR"]);
    expect(await fails("render", {})).toMatch(/set `service` and\/or `envGroups`/);
  });
  it("netlify: contexts", async () => {
    expect(await names("netlify", { account: "acct", site: "site-1" })).toEqual(["NETLIFY_ALL", "NETLIFY_PROD"]);
    expect(await names("netlify", { account: "acct", site: "site-1", context: "deploy-preview" })).toEqual(["NETLIFY_ALL", "NETLIFY_PREVIEW"]);
    expect(await names("netlify", { account: "acct", site: "site-1", context: "branch:staging" })).toEqual(["NETLIFY_ALL", "NETLIFY_BRANCH_STAGING"]);
  });
  it("heroku: config var keys, retries 429, reports 5xx", async () => {
    expect(await names("heroku", { app: "hk-app" })).toEqual(["DATABASE_URL", "HEROKU_VAR"]);
    expect(await names("heroku", { app: "flaky" })).toEqual(["DATABASE_URL", "HEROKU_VAR"]);
    expect(await fails("heroku", { app: "down" })).toMatch(/HTTP 503/);
  });
  it("railway: account token, project token, GraphQL errors", async () => {
    const o = { project: "rw-proj", environment: "rw-env", service: "rw-svc" };
    expect(await names("railway", o)).toEqual(["RW_DB_URL", "RW_SERVICE_VAR"]);
    expect(await names("railway", o, { RAILWAY_API_TOKEN: undefined, RAILWAY_TOKEN: "railway-project-mock-token" }))
      .toEqual(["RW_DB_URL", "RW_SERVICE_VAR"]);
    expect(await fails("railway", { ...o, project: "x" })).toMatch(/Project not found/);
  });
  it("fly: secrets API (Bearer and FlyV1 tokens) plus fly.toml [env]", async () => {
    writeFileSync(join(dir, "fly.toml"), 'app = "x"\n\n[env]\n  PRIMARY_REGION = "iad"\n  LOG_LEVEL = "info"\n\n[http_service]\n  internal_port = 8080\n');
    expect(await names("fly", { app: "fly-app", config: "fly.toml" })).toEqual(["FLYAPP_SECRET", "LOG_LEVEL", "PRIMARY_REGION"]);
    expect(await names("fly", { app: "fly-app" }, { FLY_API_TOKEN: "FlyV1 fly-mock-token" })).toEqual(["FLYAPP_SECRET"]);
    expect(await fails("fly", { app: "fly-app", config: "missing.toml" })).toMatch(/cannot read missing.toml/);
  });
  it("cloudflare: worker bindings and pages deployments", async () => {
    expect(await names("cloudflare", { account: "cf-acct", worker: "worker-1" })).toEqual(["CF_WORKER_JSON", "CF_WORKER_SECRET", "CF_WORKER_VAR"]);
    expect(await names("cloudflare", { account: "cf-acct", pages: "pages-1" })).toEqual(["PAGES_PROD_VAR", "PAGES_SHARED"]);
    expect(await names("cloudflare", { account: "cf-acct", pages: "pages-1", deployment: "preview" })).toEqual(["PAGES_PREVIEW_VAR"]);
    expect(await fails("cloudflare", { account: "cf-acct" })).toMatch(/exactly one of `worker` or `pages`/);
  });
  it("digitalocean: app-level plus one component", async () => {
    expect(await names("digitalocean", { app: "do-app", component: "api" })).toEqual(["DO_API_VAR", "DO_APP_VAR"]);
    expect(await names("digitalocean", { app: "do-app" })).toEqual(["DO_API_VAR", "DO_APP_VAR", "DO_WORKER_VAR"]);
  });
  it("doppler", async () => {
    expect(await names("doppler", { project: "dp", config: "prd" })).toEqual(["DOPPLER_VAR"]);
  });
});

describe("clouds", () => {
  it("aws-ssm: one level vs recursive, paginated, name relative to path", async () => {
    expect(await names("aws-ssm", { path: "/web/prod/" })).toEqual(["SSM_API_KEY", "SSM_DB_URL"]);
    expect(await names("aws-ssm", { path: "/web/prod", recursive: true })).toEqual(["SSM_API_KEY", "SSM_DB_URL", "SSM_NESTED"]);
  });
  it("aws-secretsmanager: exact prefix enforced locally", async () => {
    expect(await names("aws-secretsmanager", { prefix: "web/prod/" })).toEqual(["SM_JWT_SECRET", "SM_STRIPE_KEY"]);
  });
  it("aws: region and credential errors", async () => {
    expect(await fails("aws-ssm", { path: "/web/prod" }, { AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined })).toMatch(/set `region`/);
    expect(await fails("aws-ssm", { path: "/web/prod" }, { AWS_ACCESS_KEY_ID: "WRONG" })).toMatch(/aws-ssm \/web\/prod: HTTP 401/);
  });
  it("gcp: secret manager pages + prefix, cloud run env", async () => {
    expect(await names("gcp-secret-manager", { project: "gproj" })).toEqual(["GCP_SECRET_A", "app_GCP_PREFIXED"]);
    expect(await names("gcp-secret-manager", { project: "gproj", prefix: "app_" })).toEqual(["GCP_PREFIXED"]);
    expect(await names("gcp-cloud-run", { project: "gproj", region: "us-central1", service: "run-svc" })).toEqual(["RUN_SECRET_REF", "RUN_VAR"]);
  });
  it("gcp: falls back to gcloud, with a clear error when absent", async () => {
    expect(await fails("gcp-secret-manager", { project: "gproj" }, { GOOGLE_OAUTH_ACCESS_TOKEN: undefined, PATH: "" }))
      .toMatch(/set GOOGLE_OAUTH_ACCESS_TOKEN or CLOUDSDK_AUTH_ACCESS_TOKEN or log in with `gcloud`/);
  });
  it("azure: key vault nextLink + kebab names, app service settings and slots", async () => {
    expect(await names("azure-keyvault", { vault: "kv-test" })).toEqual(["AZURE_KV_VAR", "SECOND_PAGE_SECRET"]);
    const o = { subscription: "sub", resourceGroup: "rg", app: "as-app" };
    expect(await names("azure-appservice", o)).toEqual(["AS_VAR", "WEBSITE_NODE_DEFAULT_VERSION"]);
    expect(await names("azure-appservice", { ...o, slot: "staging" })).toEqual(["AS_SLOT_VAR"]);
  });
});

describe("local sources", () => {
  it("command: names per line, JSON, dotenv; failures do not echo stderr", async () => {
    expect(await names("command", { run: "node -e \"console.log('A_ONE\\nB_TWO=secret')\"" })).toEqual(["A_ONE", "B_TWO"]);
    expect(await names("command", { run: "node -e \"console.log(JSON.stringify([{name:'K8S_A'},'K8S_B']))\"" })).toEqual(["K8S_A", "K8S_B"]);
    // The value is assembled at runtime so it only appears on stderr, not in the command text.
    const [a, b] = [VALUE.slice(0, 5), VALUE.slice(5)];
    const msg = await fails("command", { run: `node -e "console.error('${a}' + '${b}'); process.exit(3)"` });
    expect(msg).toMatch(/exited with 3/);
  });
  it("file: reads names from the repo", async () => {
    writeFileSync(join(dir, "prod.names"), "# names\nFILE_A\nexport FILE_B=x\n");
    expect(await names("file", { path: "prod.names" })).toEqual(["FILE_A", "FILE_B"]);
  });
  it("parseNames formats", () => {
    expect([...parseNames('{"A":1,"B":2}')]).toEqual(["A", "B"]);
    expect([...parseNames("A: x\n// c\n\nB\n")]).toEqual(["A", "B"]);
    expect([...parseNames("[not json\nC=1")]).toEqual(["C"]);
  });
  it("flyTomlEnvKeys ignores other tables", () => {
    expect([...flyTomlEnvKeys('[env]\nA = "1"\n[build]\nB = "x"\n[ env ]\n"C" = "2"')]).toEqual(["A", "C"]);
  });
});

describe("no values leak", () => {
  it("never returns a value as a name", async () => {
    const all = [
      await names("vercel", { project: "web", team: "team_123" }),
      await names("render", { service: "srv-1", envGroups: ["evg-1"] }),
      await names("heroku", { app: "hk-app" }),
      await names("cloudflare", { account: "cf-acct", worker: "worker-1" }),
      await names("azure-appservice", { subscription: "sub", resourceGroup: "rg", app: "as-app" }),
    ].flat();
    expect(all.some((n) => n.includes(VALUE))).toBe(false);
    expect(warnings.join("")).not.toContain(VALUE);
  });
});

describe("sources config", () => {
  it("parses both entry styles", () => {
    const c = parseConfig(`
environments: [staging, production]
sources:
  production:
    - vercel: { project: web, target: production }
    - type: aws-ssm
      path: /web/prod
  staging:
    - github: {}
`);
    expect(c.sources.production).toEqual([
      { type: "vercel", options: { project: "web", target: "production" } },
      { type: "aws-ssm", options: { path: "/web/prod" } },
    ]);
    expect(c.sources.staging).toEqual([{ type: "github", options: {} }]);
  });
  it.each([
    ["sources: { prod: [{ vercel: { project: x } }] }\nenvironments: [production]", /"prod" is not listed/],
    ["environments: [p]\nsources: { p: [{ nope: {} }] }", /unknown source "nope"/],
    ["environments: [p]\nsources: { p: [{ vercel: {} }] }", /vercel needs "project"/],
    ["environments: [p]\nsources: { p: [{ vercel: { project: x, token: y } }] }", /unknown option "token"/],
    ["environments: [p]\nsources: { p: [] }", /non-empty list/],
    ["environments: [p]\nsources: { p: [{ vercel: { project: x }, render: {} }] }", /exactly one source type/],
    ["environments: [p]\nsources: [a]", /must map environment names/],
    ["environments: [p\n", /invalid YAML/],
  ])("rejects %j", (text, err) => {
    expect(() => parseConfig(text)).toThrow(err);
  });
  it("normalizes Windows-style excludePaths", () => {
    expect(parseConfig("excludePaths: ['.\\vendor\\', 'gen\\out/']").excludePaths).toEqual(["vendor/", "gen/out/"]);
  });
});
