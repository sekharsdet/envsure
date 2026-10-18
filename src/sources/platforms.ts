// Hosting platforms reached over plain HTTPS. Every response is reduced to names immediately.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiBase, bearer, requestJson, requireToken } from "./http.js";
import { flyTomlEnvKeys } from "./names.js";
import { type SourceDef, SourceError, str } from "./types.js";

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return s ? `?${s}` : "";
};

export const vercel: SourceDef = {
  required: ["project"],
  optional: ["target", "team", "gitBranch", "tokenEnv"],
  label: (o) => `vercel ${str(o, "project")} (${str(o, "target") ?? "production"})`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = requireToken(label, o, ctx, ["VERCEL_TOKEN"]);
    const target = str(o, "target") ?? "production";
    const branch = str(o, "gitBranch");
    const team = str(o, "team");
    const base = apiBase("vercel", "https://api.vercel.com", ctx);
    const names = new Set<string>();
    // The official spec declares no paging parameter for this endpoint, so it is read in one request.
    const body = await requestJson(ctx, label,
      `${base}/v10/projects/${encodeURIComponent(str(o, "project")!)}/env` +
        q(team?.startsWith("team_") ? { teamId: team } : { slug: team }),
      { headers: bearer(t.value), tokenName: t.name });
    const envs = Array.isArray(body) ? body : (body.envs ?? [body]);
    for (const e of envs as { key?: string; target?: string | string[]; gitBranch?: string }[]) {
      if (!e?.key) continue;
      const targets = Array.isArray(e.target) ? e.target : e.target ? [e.target] : [];
      // Branch-specific preview vars only apply to that branch.
      if (targets.includes(target) && (!e.gitBranch || e.gitBranch === branch)) names.add(e.key);
    }
    if (body.hiddenProductionEnvCount > 0 && target === "production") {
      ctx.warn(`${label}: token cannot see ${body.hiddenProductionEnvCount} production variable(s); results may be incomplete`);
    }
    if (body.pagination?.next) ctx.warn(`${label}: Vercel returned a partial page; results may be incomplete`);
    return names;
  },
};

export const render: SourceDef = {
  required: [],
  optional: ["service", "envGroups", "tokenEnv"],
  label: (o) => `render ${str(o, "service") ?? (o.envGroups as string[] | undefined)?.join(",") ?? ""}`.trim(),
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const service = str(o, "service");
    const groups = (o.envGroups as string[] | undefined) ?? [];
    if (!service && !groups.length) throw new SourceError("render: set `service` and/or `envGroups`");
    const t = requireToken(label, o, ctx, ["RENDER_API_KEY"]);
    const base = apiBase("render", "https://api.render.com", ctx);
    const init = { headers: bearer(t.value), tokenName: t.name };
    const names = new Set<string>();
    if (service) {
      let cursor: string | undefined;
      for (;;) {
        const page = (await requestJson(ctx, label,
          `${base}/v1/services/${encodeURIComponent(service)}/env-vars${q({ limit: "100", cursor })}`, init)) as
          { envVar: { key: string }; cursor: string }[];
        for (const item of page) names.add(item.envVar.key);
        if (page.length < 100) break;
        cursor = page[page.length - 1].cursor;
      }
    }
    for (const g of groups) {
      const body = await requestJson(ctx, label, `${base}/v1/env-groups/${encodeURIComponent(g)}`, init);
      for (const v of (body.envVars ?? []) as { key: string }[]) names.add(v.key);
    }
    return names;
  },
};

export const netlify: SourceDef = {
  required: ["account", "site"],
  optional: ["context", "tokenEnv"],
  label: (o) => `netlify ${str(o, "site")} (${str(o, "context") ?? "production"})`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = requireToken(label, o, ctx, ["NETLIFY_AUTH_TOKEN"]);
    const context = str(o, "context") ?? "production";
    const branch = context.startsWith("branch:") ? context.slice("branch:".length) : undefined;
    const base = apiBase("netlify", "https://api.netlify.com", ctx);
    const vars = (await requestJson(ctx, label,
      `${base}/api/v1/accounts/${encodeURIComponent(str(o, "account")!)}/env${q({ site_id: str(o, "site") })}`,
      { headers: bearer(t.value), tokenName: t.name })) as
      { key: string; values?: { context: string; context_parameter?: string }[] }[];
    const applies = (v: { context: string; context_parameter?: string }) =>
      v.context === "all" || v.context === context ||
      (branch !== undefined && ((v.context === "branch" && v.context_parameter === branch) || v.context === "branch-deploy"));
    return new Set(vars.filter((v) => (v.values ?? []).some(applies)).map((v) => v.key));
  },
};

export const heroku: SourceDef = {
  required: ["app"],
  optional: ["tokenEnv"],
  label: (o) => `heroku ${str(o, "app")}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = requireToken(label, o, ctx, ["HEROKU_API_KEY"]);
    const body = await requestJson(ctx, label,
      `${apiBase("heroku", "https://api.heroku.com", ctx)}/apps/${encodeURIComponent(str(o, "app")!)}/config-vars`,
      { headers: { ...bearer(t.value), Accept: "application/vnd.heroku+json; version=3" }, tokenName: t.name });
    return new Set(Object.keys(body ?? {}));
  },
};

/** Validated against Railway's public GraphQL schema by test/contract. */
export const RAILWAY_QUERY =
  "query($p: String!, $e: String!, $s: String) { variables(projectId: $p, environmentId: $e, serviceId: $s) }";

export const railway: SourceDef = {
  required: ["project", "environment"],
  optional: ["service", "tokenEnv"],
  label: (o) => `railway ${str(o, "service") ?? str(o, "project")} (${str(o, "environment")})`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    // RAILWAY_TOKEN is a project token (Project-Access-Token header); RAILWAY_API_TOKEN an account/team token.
    const t = requireToken(label, o, ctx, ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (t.name === "RAILWAY_TOKEN") headers["Project-Access-Token"] = t.value;
    else Object.assign(headers, bearer(t.value));
    const body = await requestJson(ctx, label, `${apiBase("railway", "https://backboard.railway.com", ctx)}/graphql/v2`, {
      method: "POST",
      headers,
      tokenName: t.name,
      body: JSON.stringify({
        query: RAILWAY_QUERY,
        variables: { p: str(o, "project"), e: str(o, "environment"), s: str(o, "service") ?? null },
      }),
    });
    if (body.errors?.length) {
      throw new SourceError(`${label}: ${body.errors.map((e: { message: string }) => e.message).join("; ")}`);
    }
    return new Set(Object.keys(body.data?.variables ?? {}));
  },
};

export const fly: SourceDef = {
  required: ["app"],
  optional: ["config", "tokenEnv"],
  label: (o) => `fly ${str(o, "app")}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = requireToken(label, o, ctx, ["FLY_API_TOKEN", "FLY_ACCESS_TOKEN"]);
    // Deploy/org tokens are "FlyV1 fm2_..." and are sent as-is; personal tokens use Bearer.
    const auth = t.value.startsWith("FlyV1 ") ? t.value : `Bearer ${t.value}`;
    const body = await requestJson(ctx, label,
      `${apiBase("fly", "https://api.machines.dev", ctx)}/v1/apps/${encodeURIComponent(str(o, "app")!)}/secrets`,
      { headers: { Authorization: auth }, tokenName: t.name });
    const names = new Set<string>(((body.secrets ?? []) as { name: string }[]).map((s) => s.name));
    const config = str(o, "config");
    if (config) {
      let text: string;
      try {
        text = readFileSync(join(ctx.cwd, config), "utf8");
      } catch {
        throw new SourceError(`${label}: cannot read ${config}`);
      }
      for (const k of flyTomlEnvKeys(text)) names.add(k);
    }
    return names;
  },
};

export const cloudflare: SourceDef = {
  required: ["account"],
  optional: ["worker", "pages", "deployment", "tokenEnv"],
  label: (o) => `cloudflare ${str(o, "worker") ?? `${str(o, "pages")} (${str(o, "deployment") ?? "production"})`}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const worker = str(o, "worker");
    const pages = str(o, "pages");
    if (!worker === !pages) throw new SourceError("cloudflare: set exactly one of `worker` or `pages`");
    const t = requireToken(label, o, ctx, ["CLOUDFLARE_API_TOKEN"]);
    const base = `${apiBase("cloudflare", "https://api.cloudflare.com", ctx)}/client/v4/accounts/${encodeURIComponent(str(o, "account")!)}`;
    const init = { headers: bearer(t.value), tokenName: t.name };
    if (worker) {
      const body = await requestJson(ctx, label, `${base}/workers/scripts/${encodeURIComponent(worker)}/settings`, init);
      const kinds = new Set(["secret_text", "plain_text", "json"]);
      return new Set(((body.result?.bindings ?? []) as { type: string; name: string }[])
        .filter((b) => kinds.has(b.type)).map((b) => b.name));
    }
    const body = await requestJson(ctx, label, `${base}/pages/projects/${encodeURIComponent(pages!)}`, init);
    const deployment = str(o, "deployment") ?? "production";
    return new Set(Object.keys(body.result?.deployment_configs?.[deployment]?.env_vars ?? {}));
  },
};

export const digitalocean: SourceDef = {
  required: ["app"],
  optional: ["component", "tokenEnv"],
  label: (o) => `digitalocean ${str(o, "app")}${str(o, "component") ? `/${str(o, "component")}` : ""}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = requireToken(label, o, ctx, ["DIGITALOCEAN_ACCESS_TOKEN", "DIGITALOCEAN_TOKEN"]);
    const body = await requestJson(ctx, label,
      `${apiBase("digitalocean", "https://api.digitalocean.com", ctx)}/v2/apps/${encodeURIComponent(str(o, "app")!)}`,
      { headers: bearer(t.value), tokenName: t.name });
    type Env = { key: string };
    const spec = body.app?.spec ?? {};
    const names = new Set<string>(((spec.envs ?? []) as Env[]).map((e) => e.key)); // app-level: every component
    const component = str(o, "component");
    for (const kind of ["services", "workers", "jobs", "static_sites", "functions"]) {
      for (const c of (spec[kind] ?? []) as { name: string; envs?: Env[] }[]) {
        if (!component || c.name === component) for (const e of c.envs ?? []) names.add(e.key);
      }
    }
    return names;
  },
};

export const doppler: SourceDef = {
  required: [],
  optional: ["project", "config", "tokenEnv"],
  label: (o) => `doppler ${[str(o, "project"), str(o, "config")].filter(Boolean).join("/") || "(token scope)"}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = requireToken(label, o, ctx, ["DOPPLER_TOKEN"]);
    const body = await requestJson(ctx, label,
      `${apiBase("doppler", "https://api.doppler.com", ctx)}/v3/configs/config/secrets/names` +
        q({ project: str(o, "project"), config: str(o, "config") }),
      { headers: bearer(t.value), tokenName: t.name });
    return new Set<string>(body.names ?? []);
  },
};
