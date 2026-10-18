// A local stand-in for every platform API EnvSure talks to, shaped after each platform's docs.
// Every response that carries values carries VALUE, so tests can assert values never leak.
// Run directly (`node test/mock/server.mjs`) to print `ENVSURE_*_API_URL=...` lines and serve until killed.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const VALUE = "mock-secret-value-7f3a";
export const TOKENS = {
  github: "gh-mock-token",
  vercel: "vercel-mock-token",
  render: "render-mock-token",
  netlify: "netlify-mock-token",
  heroku: "heroku-mock-token",
  railway: "railway-mock-token",
  railwayProject: "railway-project-mock-token",
  fly: "fly-mock-token",
  cloudflare: "cf-mock-token",
  digitalocean: "do-mock-token",
  doppler: "doppler-mock-token",
  gcp: "gcp-mock-token",
  azureKv: "azure-kv-mock-token",
  azureMgmt: "azure-mgmt-mock-token",
};

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const githubData = {
  shared: ["GH_SHARED"],
  environments: { staging: ["GH_STAGING_ONLY"], production: [] },
};

function routes(base) {
  const bearer = (req, token) => req.headers.authorization === `Bearer ${token}`;
  /** [method, pattern, auth check, handler(match, url, req, body) -> [status, body]] */
  return [
    // ---- GitHub
    // Any owner/repo, so the Action can run against the mock from a real workflow.
    ["GET", /^\/github\/repos\/[^/]+\/[^/]+\/actions\/(secrets|variables)$/, (q) => bearer(q, TOKENS.github), (m) => {
      const key = m[1];
      const items = githubData.shared.map((name) => ({ name, ...(key === "variables" ? { value: VALUE } : {}) }));
      return [200, { total_count: items.length, [key]: items }];
    }],
    ["GET", /^\/github\/repos\/[^/]+\/[^/]+\/actions\/organization-(secrets|variables)$/, (q) => bearer(q, TOKENS.github), () => [404, {}]],
    ["GET", /^\/github\/repos\/[^/]+\/[^/]+\/environments\/([^/]+)\/(secrets|variables)$/, (q) => bearer(q, TOKENS.github), (m) => {
      const names = githubData.environments[decodeURIComponent(m[1])];
      if (!names) return [404, {}];
      const items = m[2] === "secrets" ? names.map((name) => ({ name })) : [];
      return [200, { total_count: items.length, [m[2]]: items }];
    }],

    // ---- Vercel: the documented `{ envs, hiddenProductionEnvCount }` and `{ envs, pagination }` shapes
    ["GET", /^\/vercel\/v10\/projects\/(web|web-partial)\/env$/, (q) => bearer(q, TOKENS.vercel), (m, url) => {
      if (url.searchParams.get("teamId") !== "team_123") return [403, {}];
      const env = (key, target, extra = {}) => ({ key, target, type: "encrypted", value: VALUE, securityIssues: [], ...extra });
      if (m[1] === "web-partial") {
        return [200, { envs: [env("VC_PROD", ["production"])], pagination: { count: 1, next: 1700000000000, prev: null } }];
      }
      return [200, {
        envs: [
          env("VC_PROD", ["production"]),
          env("VC_PREVIEW", ["preview"]),
          env("VC_BOTH", ["production", "preview", "development"]),
          env("VC_BRANCH_ONLY", ["preview"], { gitBranch: "feature-x" }),
          env("VC_STRING_TARGET", "production"),
          env("VC_CUSTOM_STAGING", [], { customEnvironmentIds: ["env_staging123"] }),
        ],
        hiddenProductionEnvCount: 0,
      }];
    }],
    ["GET", /^\/vercel\/v9\/projects\/web\/custom-environments$/, (q) => bearer(q, TOKENS.vercel), () =>
      [200, { accountLimit: { total: 12 }, environments: [{ id: "env_staging123", slug: "staging", type: "preview" }] }]],

    // ---- Render: 101 service vars over two cursor pages + an env group
    ["GET", /^\/render\/v1\/services\/srv-1\/env-vars$/, (q) => bearer(q, TOKENS.render), (_m, url) => {
      const all = Array.from({ length: 101 }, (_, i) => `RND_VAR_${String(i).padStart(3, "0")}`);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      return [200, all.slice(start, start + limit).map((key) => ({ envVar: { key, value: VALUE }, cursor: key }))];
    }],
    ["GET", /^\/render\/v1\/env-groups\/(evg-1|evg-2)$/, (q) => bearer(q, TOKENS.render), (m) =>
      [200, { id: m[1], name: m[1], envVars: [{ key: m[1] === "evg-1" ? "RND_GROUP_VAR" : "RND_LINKED_VAR", value: VALUE }] }]],
    // Env group list: evg-1 and evg-2 are linked to srv-1, evg-3 is not.
    ["GET", /^\/render\/v1\/env-groups$/, (q) => bearer(q, TOKENS.render), () => {
      const link = { id: "srv-1", name: "web", type: "web" };
      const g = (id, links) => ({ id, name: id, ownerId: "tea-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", serviceLinks: links });
      return [200, [g("evg-1", [link]), g("evg-2", [link]), g("evg-3", [])]];
    }],

    // ---- Netlify
    ["GET", /^\/netlify\/api\/v1\/accounts\/acct\/env$/, (q) => bearer(q, TOKENS.netlify), (_m, url) => {
      if (url.searchParams.get("site_id") !== "site-1") return [200, []];
      const v = (key, ...values) => ({ key, scopes: ["builds", "functions", "runtime"], values: values.map(([context, p]) =>
        ({ id: key, value: VALUE, context, ...(p ? { context_parameter: p } : {}) })) });
      return [200, [
        v("NETLIFY_ALL", ["all"]),
        v("NETLIFY_PROD", ["production"]),
        v("NETLIFY_PREVIEW", ["deploy-preview"]),
        v("NETLIFY_BRANCH_STAGING", ["branch", "staging"]),
      ]];
    }],

    // ---- Heroku (+ flaky / down apps for retry handling)
    ["GET", /^\/heroku\/apps\/(hk-app|flaky|down)\/config-vars$/, (q) =>
      bearer(q, TOKENS.heroku) && q.headers.accept === "application/vnd.heroku+json; version=3", (m) => {
      if (m[1] === "down") return [503, {}];
      if (m[1] === "flaky" && flaky.count++ % 2 === 0) return [429, {}];
      return [200, { HEROKU_VAR: VALUE, DATABASE_URL: VALUE }];
    }],

    // ---- Railway GraphQL
    ["POST", /^\/railway\/graphql\/v2$/, (q) => bearer(q, TOKENS.railway) || q.headers["project-access-token"] === TOKENS.railwayProject,
      (_m, _url, _req, body) => {
        const { p, e, s } = JSON.parse(body).variables ?? {};
        if (p !== "rw-proj" || e !== "rw-env") return [200, { data: null, errors: [{ message: "Project not found" }] }];
        return [200, { data: { variables: s === "rw-svc" ? { RW_SERVICE_VAR: VALUE, RW_DB_URL: VALUE } : { RW_SHARED_ONLY: VALUE } } }];
      }],

    // ---- Fly Machines API (shape verified against the live API)
    ["GET", /^\/fly\/v1\/apps\/fly-app\/secrets$/, (q) => [`Bearer ${TOKENS.fly}`, `FlyV1 ${TOKENS.fly}`].includes(q.headers.authorization), () =>
      [200, { secrets: [{ name: "FLYAPP_SECRET", digest: "bba1695ffb995d73", created_at: "2026-01-01T00:00:00Z" }] }]],

    // ---- Cloudflare
    ["GET", /^\/cloudflare\/client\/v4\/accounts\/cf-acct\/workers\/scripts\/worker-1\/settings$/, (q) => bearer(q, TOKENS.cloudflare), () =>
      [200, { success: true, result: { bindings: [
        { type: "secret_text", name: "CF_WORKER_SECRET" },
        { type: "plain_text", name: "CF_WORKER_VAR", text: VALUE },
        { type: "json", name: "CF_WORKER_JSON", json: { v: VALUE } },
        { type: "kv_namespace", name: "CF_KV_BINDING", namespace_id: "x" },
      ] } }]],
    ["GET", /^\/cloudflare\/client\/v4\/accounts\/cf-acct\/pages\/projects\/pages-1$/, (q) => bearer(q, TOKENS.cloudflare), () =>
      [200, { success: true, result: { deployment_configs: {
        production: { env_vars: { PAGES_PROD_VAR: { type: "secret_text" }, PAGES_SHARED: { type: "plain_text", value: VALUE } } },
        preview: { env_vars: { PAGES_PREVIEW_VAR: { type: "plain_text", value: VALUE } } },
      } } }]],

    // ---- DigitalOcean App Platform
    ["GET", /^\/digitalocean\/v2\/apps\/do-app$/, (q) => bearer(q, TOKENS.digitalocean), () =>
      [200, { app: { spec: {
        envs: [{ key: "DO_APP_VAR", value: VALUE, scope: "RUN_AND_BUILD_TIME" }],
        services: [{ name: "api", envs: [{ key: "DO_API_VAR", value: VALUE, type: "SECRET" }] }],
        workers: [{ name: "worker", envs: [{ key: "DO_WORKER_VAR", value: VALUE }] }],
      } } }]],

    // ---- Doppler
    ["GET", /^\/doppler\/v3\/configs\/config\/secrets\/names$/, (q) => bearer(q, TOKENS.doppler), (_m, url) =>
      url.searchParams.get("project") === "dp" && url.searchParams.get("config") === "prd"
        ? [200, { names: ["DOPPLER_VAR"], success: true }] : [404, {}]],

    // ---- GCP Secret Manager (two pages) and Cloud Run
    ["GET", /^\/gcp-secret-manager\/v1\/projects\/gproj\/secrets$/, (q) => bearer(q, TOKENS.gcp), (_m, url) =>
      url.searchParams.get("pageToken") === "p2"
        ? [200, { secrets: [{ name: "projects/123/secrets/app_GCP_PREFIXED" }] }]
        : [200, { secrets: [{ name: "projects/123/secrets/GCP_SECRET_A" }], nextPageToken: "p2" }]],
    ["GET", /^\/gcp-cloud-run\/v2\/projects\/gproj\/locations\/us-central1\/services\/run-svc$/, (q) => bearer(q, TOKENS.gcp), () =>
      [200, { template: { containers: [{ env: [
        { name: "RUN_VAR", value: VALUE },
        { name: "RUN_SECRET_REF", valueSource: { secretKeyRef: { secret: "s", version: "latest" } } },
      ] }] } }]],

    // ---- Azure Key Vault (nextLink paging) and App Service
    ["GET", /^\/azure-keyvault\/secrets$/, (q) => bearer(q, TOKENS.azureKv), (_m, url) =>
      url.searchParams.get("$skiptoken") === "2"
        ? [200, { value: [{ id: `${base}/azure-keyvault/secrets/second-page-secret` }] }]
        : [200, { value: [{ id: `${base}/azure-keyvault/secrets/azure-kv-var` }],
            nextLink: `${base}/azure-keyvault/secrets?api-version=7.4&$skiptoken=2` }]],
    ["POST", /^\/azure-appservice\/subscriptions\/sub\/resourceGroups\/rg\/providers\/Microsoft\.Web\/sites\/as-app(\/slots\/staging)?\/config\/appsettings\/list$/,
      (q) => bearer(q, TOKENS.azureMgmt), (m) =>
        [200, { properties: m[1] ? { AS_SLOT_VAR: VALUE } : { AS_VAR: VALUE, WEBSITE_NODE_DEFAULT_VERSION: VALUE } }]],

    // ---- AWS (JSON 1.1 over POST /, dispatched by X-Amz-Target)
    ["POST", /^\/aws(-ssm|-secretsmanager)\/?$/, (q) => /^AWS4-HMAC-SHA256 Credential=AKIDMOCK\//.test(q.headers.authorization ?? ""),
      (_m, _url, req, body) => {
        const target = req.headers["x-amz-target"];
        const input = JSON.parse(body || "{}");
        if (target === "AmazonSSM.DescribeParameters") {
          const path = input.ParameterFilters?.[0]?.Values?.[0];
          const recursive = input.ParameterFilters?.[0]?.Option === "Recursive";
          const all = ["/web/prod/SSM_DB_URL", "/web/prod/SSM_API_KEY", "/web/prod/nested/SSM_NESTED", "/web/staging/SSM_STAGING"];
          const matches = all.filter((n) => n.startsWith(`${path}/`) && (recursive || !n.slice(path.length + 1).includes("/")));
          const page = input.NextToken === "t2" ? matches.slice(1) : matches.slice(0, 1);
          return [200, { Parameters: page.map((Name) => ({ Name, Type: "SecureString", Version: 1 })),
            ...(input.NextToken !== "t2" && matches.length > 1 ? { NextToken: "t2" } : {}) }];
        }
        if (target === "secretsmanager.ListSecrets") {
          const prefix = input.Filters?.[0]?.Values?.[0] ?? "";
          const all = ["web/prod/SM_STRIPE_KEY", "web/prod/SM_JWT_SECRET", "web/production-old/SM_OLD", "other/SM_OTHER"];
          // Like AWS, the name filter is looser than an exact prefix.
          const matches = all.filter((n) => n.startsWith(prefix.replace(/\/$/, "")));
          return [200, { SecretList: matches.map((Name) => ({ Name, ARN: `arn:aws:secretsmanager:us-east-1:1:secret:${Name}` })) }];
        }
        return [400, { __type: "UnknownOperationException" }];
      }],
  ];
}

const flaky = { count: 0 };

export function startMockServer(port = 0) {
  let base = "";
  let table = [];
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, base);
      // Full exchange, so contract tests can check each one against the platform's official spec.
      const exchange = { method: req.method, path: url.pathname, query: [...url.searchParams.keys()], headers: req.headers, requestBody: body };
      requests.push(exchange);
      const reply = (status, payload) => {
        Object.assign(exchange, { status, response: payload });
        json(res, status, payload);
      };
      for (const [method, re, auth, handler] of table) {
        const m = re.exec(url.pathname);
        if (!m || method !== req.method) continue;
        if (!auth(req)) return reply(401, { message: "Bad credentials" });
        const [status, payload] = handler(m, url, req, body);
        return reply(status, payload);
      }
      reply(404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      table = routes(base);
      resolve({ base, requests, env: mockEnv(base), close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Env vars pointing every connector at the mock, with matching credentials. */
export function mockEnv(base) {
  const urls = Object.fromEntries(["github", "vercel", "render", "netlify", "heroku", "railway", "fly", "cloudflare",
    "digitalocean", "doppler", "gcp-secret-manager", "gcp-cloud-run", "azure-keyvault", "azure-appservice", "aws-ssm",
    "aws-secretsmanager"].map((t) => [`ENVSURE_${t.toUpperCase().replace(/-/g, "_")}_API_URL`, `${base}/${t}`]));
  return {
    ...urls,
    VERCEL_TOKEN: TOKENS.vercel,
    RENDER_API_KEY: TOKENS.render,
    NETLIFY_AUTH_TOKEN: TOKENS.netlify,
    HEROKU_API_KEY: TOKENS.heroku,
    RAILWAY_API_TOKEN: TOKENS.railway,
    FLY_API_TOKEN: TOKENS.fly,
    CLOUDFLARE_API_TOKEN: TOKENS.cloudflare,
    DIGITALOCEAN_ACCESS_TOKEN: TOKENS.digitalocean,
    DOPPLER_TOKEN: TOKENS.doppler,
    GOOGLE_OAUTH_ACCESS_TOKEN: TOKENS.gcp,
    AZURE_KEYVAULT_TOKEN: TOKENS.azureKv,
    AZURE_MANAGEMENT_TOKEN: TOKENS.azureMgmt,
    AWS_ACCESS_KEY_ID: "AKIDMOCK",
    AWS_SECRET_ACCESS_KEY: "mock-aws-secret",
    AWS_REGION: "us-east-1",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { base, env } = await startMockServer(Number(process.argv[2] ?? 0));
  for (const [k, v] of Object.entries(env)) if (k.startsWith("ENVSURE_")) console.log(`${k}=${v}`);
  console.log(`MOCK_BASE=${base}`);
}
