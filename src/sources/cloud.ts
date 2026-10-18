// AWS, Google Cloud and Azure. All list calls used here return names only, except Cloud Run
// and App Service, whose values are dropped on receipt.
import { DescribeParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ListSecretsCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
import { apiBase, bearer, cliToken, pageGuard, requestJson, timeoutMs } from "./http.js";
import { fromKebab, stripPath } from "./names.js";
import { type Options, type SourceContext, type SourceDef, SourceError, str } from "./types.js";

function awsConfig(type: string, o: Options, ctx: SourceContext) {
  const region = str(o, "region") ?? ctx.env.AWS_REGION ?? ctx.env.AWS_DEFAULT_REGION;
  if (!region) throw new SourceError(`${type}: set \`region\` or AWS_REGION`);
  const profile = str(o, "profile");
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = ctx.env;
  // Otherwise the SDK's default chain: env, shared config/SSO, web identity (GitHub OIDC), ECS/EC2 roles.
  const credentials = profile ? fromIni({ profile })
    : accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, sessionToken }
    : undefined;
  const endpoint = ctx.env[`ENVSURE_${type.toUpperCase().replace(/-/g, "_")}_API_URL`];
  // Same per-request limit as every other source, so a stalled endpoint cannot hang the job.
  const requestHandler = { connectionTimeout: 10_000, requestTimeout: timeoutMs(ctx.env) };
  return { region, maxAttempts: 3, requestHandler, ...(credentials ? { credentials } : {}), ...(endpoint ? { endpoint } : {}) };
}

function awsError(label: string, err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === "CredentialsProviderError") {
    return new SourceError(`${label}: no AWS credentials (env vars, profile, SSO or OIDC role)`);
  }
  const status = e.$metadata?.httpStatusCode ? `HTTP ${e.$metadata.httpStatusCode} ` : "";
  return new SourceError(`${label}: ${status}${e.name ?? "error"}${e.message ? `: ${e.message}` : ""}`);
}

export const awsSsm: SourceDef = {
  required: ["path"],
  optional: ["region", "profile", "recursive"],
  label: (o) => `aws-ssm ${str(o, "path")}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const path = str(o, "path")!;
    const client = new SSMClient(awsConfig("aws-ssm", o, ctx));
    const names = new Set<string>();
    let NextToken: string | undefined;
    const next = pageGuard(label);
    try {
      do {
        const res = await client.send(new DescribeParametersCommand({
          ParameterFilters: [{ Key: "Path", Option: o.recursive ? "Recursive" : "OneLevel", Values: [path.replace(/\/+$/, "") || "/"] }],
          MaxResults: 50,
          NextToken,
        }));
        for (const p of res.Parameters ?? []) if (p.Name) names.add(stripPath(p.Name, path));
        NextToken = next(res.NextToken);
      } while (NextToken);
    } catch (err) {
      throw awsError(label, err);
    } finally {
      client.destroy();
    }
    return names;
  },
};

export const awsSecretsManager: SourceDef = {
  required: [],
  optional: ["prefix", "region", "profile"],
  label: (o) => `aws-secretsmanager ${str(o, "prefix") ?? "(all)"}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const prefix = str(o, "prefix") ?? "";
    const client = new SecretsManagerClient(awsConfig("aws-secretsmanager", o, ctx));
    const names = new Set<string>();
    let NextToken: string | undefined;
    const next = pageGuard(label);
    try {
      do {
        const res = await client.send(new ListSecretsCommand({
          ...(prefix ? { Filters: [{ Key: "name", Values: [prefix] }] } : {}),
          MaxResults: 100,
          NextToken,
        }));
        // The name filter is a prefix match on words; re-check the exact prefix locally.
        for (const s of res.SecretList ?? []) if (s.Name?.startsWith(prefix)) names.add(stripPath(s.Name, prefix));
        NextToken = next(res.NextToken);
      } while (NextToken);
    } catch (err) {
      throw awsError(label, err);
    } finally {
      client.destroy();
    }
    return names;
  },
};

const gcpToken = (label: string, o: Options, ctx: SourceContext) =>
  cliToken(label, o, ctx, ["GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN"],
    { cmd: "gcloud", args: ["auth", "print-access-token"] });

export const gcpSecretManager: SourceDef = {
  required: ["project"],
  optional: ["prefix", "tokenEnv"],
  label: (o) => `gcp-secret-manager ${str(o, "project")}${str(o, "prefix") ? `/${str(o, "prefix")}` : ""}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = gcpToken(label, o, ctx);
    const prefix = str(o, "prefix") ?? "";
    const base = apiBase("gcp-secret-manager", "https://secretmanager.googleapis.com", ctx);
    const names = new Set<string>();
    let pageToken: string | undefined;
    const next = pageGuard(label);
    do {
      const url = `${base}/v1/projects/${encodeURIComponent(str(o, "project")!)}/secrets?pageSize=250` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const body = await requestJson(ctx, label, url, { headers: bearer(t.value), tokenName: t.name });
      for (const s of (body.secrets ?? []) as { name: string }[]) {
        const short = stripPath(s.name);
        if (short.startsWith(prefix)) names.add(short.slice(prefix.length));
      }
      pageToken = next(body.nextPageToken);
    } while (pageToken);
    return names;
  },
};

export const gcpCloudRun: SourceDef = {
  required: ["project", "region", "service"],
  optional: ["tokenEnv"],
  label: (o) => `gcp-cloud-run ${str(o, "service")} (${str(o, "region")})`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = gcpToken(label, o, ctx);
    const base = apiBase("gcp-cloud-run", "https://run.googleapis.com", ctx);
    const body = await requestJson(ctx, label,
      `${base}/v2/projects/${encodeURIComponent(str(o, "project")!)}/locations/${encodeURIComponent(str(o, "region")!)}/services/${encodeURIComponent(str(o, "service")!)}`,
      { headers: bearer(t.value), tokenName: t.name });
    const names = new Set<string>();
    for (const c of (body.template?.containers ?? []) as { env?: { name: string }[] }[]) {
      for (const e of c.env ?? []) names.add(e.name);
    }
    return names;
  },
};

const azureToken = (label: string, o: Options, ctx: SourceContext, envName: string, resource: string) =>
  cliToken(label, o, ctx, [envName],
    { cmd: "az", args: ["account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"] });

export const azureKeyVault: SourceDef = {
  required: ["vault"],
  optional: ["tokenEnv"],
  label: (o) => `azure-keyvault ${str(o, "vault")}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const vault = str(o, "vault")!;
    // The vault name becomes part of the host the token is sent to.
    if (!/^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/.test(vault)) {
      throw new SourceError(`${label}: vault must be a Key Vault name (3-24 letters, digits and dashes)`);
    }
    const t = azureToken(label, o, ctx, "AZURE_KEYVAULT_TOKEN", "https://vault.azure.net");
    const base = apiBase("azure-keyvault", `https://${vault}.vault.azure.net`, ctx);
    const origin = new URL(base).origin;
    const names = new Set<string>();
    let url: string | undefined = `${base}/secrets?api-version=7.4&maxresults=25`;
    for (let page = 0; url; page++) {
      if (page >= 1000) throw new SourceError(`${label}: stopped after 1000 pages`);
      const body = await requestJson(ctx, label, url, { headers: bearer(t.value), tokenName: t.name });
      // Key Vault names cannot contain "_": `db-url` is the convention for DB_URL.
      for (const s of (body.value ?? []) as { id: string }[]) names.add(fromKebab(stripPath(s.id)));
      url = body.nextLink || undefined;
      // The bearer token must never follow a server-provided link to another host.
      if (url && new URL(url).origin !== origin) throw new SourceError(`${label}: nextLink points to a different host; refusing to follow`);
    }
    return names;
  },
};

export const azureAppService: SourceDef = {
  required: ["subscription", "resourceGroup", "app"],
  optional: ["slot", "tokenEnv"],
  label: (o) => `azure-appservice ${str(o, "app")}${str(o, "slot") ? `/${str(o, "slot")}` : ""}`,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const t = azureToken(label, o, ctx, "AZURE_MANAGEMENT_TOKEN", "https://management.azure.com/");
    const base = apiBase("azure-appservice", "https://management.azure.com", ctx);
    const slot = str(o, "slot");
    const site = `/subscriptions/${encodeURIComponent(str(o, "subscription")!)}/resourceGroups/${encodeURIComponent(str(o, "resourceGroup")!)}` +
      `/providers/Microsoft.Web/sites/${encodeURIComponent(str(o, "app")!)}${slot ? `/slots/${encodeURIComponent(slot)}` : ""}`;
    const body = await requestJson(ctx, label, `${base}${site}/config/appsettings/list?api-version=2023-12-01`,
      { method: "POST", headers: bearer(t.value), tokenName: t.name });
    return new Set(Object.keys(body.properties ?? {}));
  },
};
