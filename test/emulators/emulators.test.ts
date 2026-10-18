// Connectors against real API emulators, started by CI (.github/workflows/ci.yml, job `emulators`):
//   MOTO_URL           moto server (AWS SSM + Secrets Manager: real SigV4, real protocol, real paging)
//   LOWKEY_VAULT_URL   Lowkey Vault (Azure Key Vault REST API, self-signed TLS)
//   E2E_KUBECTL=1      a kind cluster, used through the `command` source
// Each suite is skipped when its emulator is not available.
import { spawnSync } from "node:child_process";
import { CreateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { SOURCES } from "../../src/sources/index.js";
import type { Options, SourceContext } from "../../src/sources/types.js";

const VALUE = "emulator-secret-value-91c2";
const ctx = (env: Record<string, string | undefined>): SourceContext => ({
  env: { ...process.env, ...env },
  cwd: process.cwd(),
  fetch,
  exec: (cmd, args, o) => spawnSync(cmd, args ?? [], { ...o, encoding: "utf8" }) as ReturnType<SourceContext["exec"]>,
  warn: () => {},
});
const names = async (type: string, opts: Options, env: Record<string, string | undefined>) =>
  [...(await SOURCES[type].fetchNames(opts, ctx(env)))].sort();

const MOTO = process.env.MOTO_URL;
describe.skipIf(!MOTO)("AWS via moto", () => {
  const aws = { region: "us-east-1", endpoint: MOTO!, credentials: { accessKeyId: "AKIDMOTO", secretAccessKey: "moto" } };
  const env = {
    ENVSURE_AWS_SSM_API_URL: MOTO, ENVSURE_AWS_SECRETSMANAGER_API_URL: MOTO,
    AWS_ACCESS_KEY_ID: "AKIDMOTO", AWS_SECRET_ACCESS_KEY: "moto", AWS_REGION: "us-east-1",
  };
  // 60 parameters at one level, so DescribeParameters (MaxResults 50) must page.
  const flat = Array.from({ length: 60 }, (_, i) => `SSM_VAR_${String(i).padStart(2, "0")}`);

  it("seeds parameters and secrets", async () => {
    const ssm = new SSMClient(aws);
    for (const n of flat) await ssm.send(new PutParameterCommand({ Name: `/app/prod/${n}`, Value: VALUE, Type: "SecureString", Overwrite: true }));
    await ssm.send(new PutParameterCommand({ Name: "/app/prod/nested/SSM_NESTED", Value: VALUE, Type: "String", Overwrite: true }));
    await ssm.send(new PutParameterCommand({ Name: "/app/staging/SSM_STAGING", Value: VALUE, Type: "String", Overwrite: true }));
    const sm = new SecretsManagerClient(aws);
    for (const n of ["app/prod/SM_STRIPE_KEY", "app/prod/SM_JWT", "app/production-old/SM_OLD", "other/SM_OTHER"]) {
      await sm.send(new CreateSecretCommand({ Name: n, SecretString: VALUE })).catch((e) => {
        if (e.name !== "ResourceExistsException") throw e;
      });
    }
  }, 120_000);

  it("aws-ssm: one level, paginated past 50", async () => {
    expect(await names("aws-ssm", { path: "/app/prod" }, env)).toEqual(flat);
  }, 60_000);
  it("aws-ssm: recursive", async () => {
    const all = await names("aws-ssm", { path: "/app/prod/", recursive: true }, env);
    expect(all).toHaveLength(61);
    expect(all).toContain("SSM_NESTED");
  }, 60_000);
  it("aws-secretsmanager: exact prefix", async () => {
    expect(await names("aws-secretsmanager", { prefix: "app/prod/" }, env)).toEqual(["SM_JWT", "SM_STRIPE_KEY"]);
  }, 60_000);
  it("aws: values never come back", async () => {
    const all = [...await names("aws-ssm", { path: "/app/prod", recursive: true }, env), ...await names("aws-secretsmanager", {}, env)];
    expect(all.join(",")).not.toContain(VALUE);
  }, 60_000);
});

const VAULT = process.env.LOWKEY_VAULT_URL;
describe.skipIf(!VAULT)("Azure Key Vault via Lowkey Vault", () => {
  const env = { ENVSURE_AZURE_KEYVAULT_API_URL: VAULT, AZURE_KEYVAULT_TOKEN: "lowkey-ignores-the-value" };
  // 30 secrets, so the 25-per-page listing must follow nextLink.
  const secrets = Array.from({ length: 30 }, (_, i) => `kv-secret-${String(i).padStart(2, "0")}`);

  it("seeds secrets", async () => {
    for (const s of [...secrets, "db-url"]) {
      const res = await fetch(`${VAULT}/secrets/${s}?api-version=7.4`, {
        method: "PUT",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ value: VALUE }),
      });
      expect(res.status, s).toBe(200);
    }
  }, 120_000);

  it("lists every secret across pages, kebab-case mapped to ENV_STYLE", async () => {
    const found = await names("azure-keyvault", { vault: "ignored-when-url-overridden" }, env);
    expect(found).toHaveLength(31);
    expect(found).toContain("DB_URL");
    expect(found).toContain("KV_SECRET_29");
    expect(found.join(",")).not.toContain(VALUE);
  }, 60_000);
});

describe.skipIf(!process.env.E2E_KUBECTL)("Kubernetes via kind + command source", () => {
  it("reads secret keys from a real cluster", async () => {
    const kubectl = (...a: string[]) => {
      const r = spawnSync("kubectl", a, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    kubectl("delete", "secret", "web", "--ignore-not-found");
    kubectl("create", "secret", "generic", "web", `--from-literal=K8S_DB_URL=${VALUE}`, `--from-literal=K8S_API_KEY=${VALUE}`);
    const found = await names("command", { run: "kubectl get secret web -o jsonpath={.data}" }, {});
    expect(found).toEqual(["K8S_API_KEY", "K8S_DB_URL"]);
  }, 120_000);
});
