// Runs the built dist/cli.js and dist/action.js (what ships) against the mock platform server.
// Requires `npm run build` first; CI runs it on Windows, macOS and Linux.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockServer, startMockServer, TOKENS, VALUE } from "../mock/server.mjs";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const ACTION = fileURLToPath(new URL("../../dist/action.js", import.meta.url));
let mock: MockServer;
let repo: string;

const CONFIG = `
environments: [staging, production]
sources:
  production:
    - vercel: { project: web, team: team_123 }
    - render: { service: srv-1, envGroups: [evg-1] }
    - netlify: { account: acct, site: site-1 }
    - heroku: { app: hk-app }
    - railway: { project: rw-proj, environment: rw-env, service: rw-svc }
    - fly: { app: fly-app, config: fly.toml }
    - cloudflare: { account: cf-acct, worker: worker-1 }
    - digitalocean: { app: do-app, component: api }
    - doppler: { project: dp, config: prd }
    - aws-ssm: { path: /web/prod, region: us-east-1 }
    - aws-secretsmanager: { prefix: web/prod/ }
    - gcp-secret-manager: { project: gproj }
    - gcp-cloud-run: { project: gproj, region: us-central1, service: run-svc }
    - azure-keyvault: { vault: kv }
    - azure-appservice: { subscription: sub, resourceGroup: rg, app: as-app }
    - command: { run: "node -e \\"console.log('CMD_VAR')\\"" }
    - file: { path: deploy/names.txt }
  staging:
    - github: {}
`;

/** One reference per source type. */
const PRODUCTION_NAMES = [
  "VC_PROD", "RND_VAR_100", "RND_GROUP_VAR", "NETLIFY_PROD", "HEROKU_VAR", "RW_SERVICE_VAR", "FLYAPP_SECRET",
  "LOG_LEVEL", "CF_WORKER_SECRET", "DO_API_VAR", "DOPPLER_VAR", "SSM_DB_URL", "SM_STRIPE_KEY", "GCP_SECRET_A", "RUN_VAR",
  "AZURE_KV_VAR", "AS_VAR", "CMD_VAR", "FILE_VAR",
];

function write(file: string, text: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
}

type Env = Record<string, string | undefined>;
function spawnNode(script: string, args: string[], env: Env) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...mock.env, ...env })) if (v !== undefined) merged[k] = v;
  // Async: the mock server lives in this process, so the event loop must keep running.
  return new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [script, ...args], { cwd: repo, env: merged }, (err, stdout, stderr) =>
      done({ status: err ? (typeof err.code === "number" ? err.code : 2) : 0, stdout, stderr }));
  });
}
const cli = (args: string[], env: Env = {}) => spawnNode(CLI, args, { GITHUB_TOKEN: TOKENS.github, ENVSURE_TOKEN: "", ...env });
const json = (r: { stdout: string }) => JSON.parse(r.stdout);
const args = ["--repo", "o/r", "--base", "main", "--format", "json"];
type F = { name: string; missingIn: string[]; presentIn: string[]; refs: { file: string }[] };

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing: run `npm run build` first");
  mock = await startMockServer();
  repo = mkdtempSync(join(tmpdir(), "envsure-int-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  write(".github/envsure.yml", CONFIG);
  write(".github/envsure-github-only.yml", "environments: [staging, production]\n");
  write("fly.toml", '[env]\nLOG_LEVEL = "info"\n');
  write("deploy/names.txt", "FILE_VAR\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "pr");
  write("src/app.ts", [
    ...PRODUCTION_NAMES.map((n) => `process.env.${n};`),
    "process.env.NOWHERE_VAR;",
    "process.env.GH_STAGING_ONLY;",
    "process.env.GH_SHARED;",
    "",
  ].join("\n"));
  write(".github/workflows/ci.yml", "jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.VC_PROD }} ${{ secrets.GH_SHARED }}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "pr");
}, 60_000);

afterAll(async () => {
  await mock?.close();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("dist/cli.js with every source type", () => {
  it("checks each environment against its own sources", async () => {
    const r = await cli(args);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(1);
    const out = json(r);
    const byName = Object.fromEntries((out.findings as F[]).map((f) =>
      [f.name, { missingIn: [...f.missingIn].sort(), presentIn: [...f.presentIn].sort() }]));
    // Production names come from the platforms, so they are missing only in staging (GitHub).
    for (const n of PRODUCTION_NAMES) {
      // VC_PROD is also used as ${{ secrets.VC_PROD }} in a job without environment: repo level too.
      const missingIn = n === "VC_PROD" ? ["(repository)", "staging"] : ["staging"];
      expect(byName[n], n).toEqual({ missingIn, presentIn: ["production"] });
    }
    expect(byName.NOWHERE_VAR).toEqual({ missingIn: ["production", "staging"], presentIn: [] });
    expect(byName.GH_STAGING_ONLY).toEqual({ missingIn: ["production"], presentIn: ["staging"] });
    // GH_SHARED is a GitHub repo secret: available to staging (github source) but not a production runtime var.
    expect(byName.GH_SHARED).toEqual({ missingIn: ["production"], presentIn: ["staging"] });
    expect(Object.keys(byName).sort()).toEqual([...PRODUCTION_NAMES, "NOWHERE_VAR", "GH_STAGING_ONLY", "GH_SHARED"].sort());
    expect(out.sourcesChecked.production).toHaveLength(17);
  }, 60_000);

  it("workflow refs are always checked against GitHub", async () => {
    const out = json(await cli(args));
    const vercelProd = (out.findings as F[]).find((f) => f.name === "VC_PROD")!;
    expect(vercelProd.refs.some((x) => x.file === ".github/workflows/ci.yml")).toBe(true);
    expect(vercelProd.missingIn).toContain("(repository)");
    expect((out.findings as F[]).find((f) => f.name === "GH_SHARED")!.refs.some((x) => x.file.endsWith("ci.yml"))).toBe(false);
  }, 60_000);

  it("never prints a secret value", async () => {
    const outputs = await Promise.all([
      cli(args), cli(["--repo", "o/r", "--base", "main"]), cli(["--repo", "o/r", "--base", "main", "--format", "markdown"]),
    ]);
    for (const r of outputs) expect(r.stdout + r.stderr).not.toContain(VALUE);
  }, 60_000);

  it("text and markdown name the sources checked", async () => {
    const text = await cli(["--repo", "o/r", "--base", "main"]);
    expect(text.stdout).toContain("(production checked against: vercel web (production), render srv-1");
    const md = await cli(["--repo", "o/r", "--base", "main", "--format", "markdown"]);
    expect(md.stdout).toContain("`production` → vercel web (production)");
  }, 60_000);

  it("without sources behaves as GitHub-only", async () => {
    const out = json(await cli([...args, "--config", ".github/envsure-github-only.yml"]));
    expect((out.findings as F[]).find((f) => f.name === "VC_PROD")!.missingIn.sort()).toEqual(["(repository)", "production", "staging"]);
  }, 60_000);

  it("a missing credential fails with exit 2 and names the variable", async () => {
    const r = await cli(args, { RENDER_API_KEY: undefined });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("render srv-1: no credentials; set RENDER_API_KEY");
  }, 60_000);

  it("reports every failing source at once", async () => {
    const r = await cli(args, { VERCEL_TOKEN: "wrong", HEROKU_API_KEY: "wrong" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/vercel web \(production\): HTTP 401/);
    expect(r.stderr).toMatch(/heroku hk-app: HTTP 401/);
    expect(r.stderr).not.toContain(VALUE);
  }, 60_000);

  it("needs no GitHub token when every environment uses platform sources and no workflow refs are scanned", async () => {
    const cfg = "environments: [production]\nsources:\n  production:\n    - heroku: { app: hk-app }\n";
    write(".github/envsure-nogh.yml", cfg + "excludePaths: [.github/]\n");
    const noGh = { GITHUB_TOKEN: "", GITHUB_REPOSITORY: "" };
    const r = await cli(["--base", "main", "--format", "json", "--config", ".github/envsure-nogh.yml"], noGh);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(1);
    const names = (json(r).findings as F[]).map((f) => f.name);
    expect(names).toContain("NOWHERE_VAR");
    expect(names).not.toContain("HEROKU_VAR");

    // A changed workflow brings GitHub back in.
    write(".github/envsure-nogh.yml", cfg);
    const r2 = await cli(["--base", "main", "--config", ".github/envsure-nogh.yml"], noGh);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/need --repo and \$GITHUB_TOKEN/);
  }, 60_000);

  it("--offline never contacts a source", async () => {
    const before = mock.requests.length;
    const r = await cli(["--offline", "--base", "main"], { GITHUB_TOKEN: "", VERCEL_TOKEN: undefined });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("NOWHERE_VAR");
    expect(mock.requests.length).toBe(before);
  }, 60_000);
});

describe("dist/action.js", () => {
  it("reads the config from the PR base, so a PR cannot swap in its own sources", async () => {
    const base = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();
    const tmp = mkdtempSync(join(tmpdir(), "envsure-action-"));
    const summary = join(tmp, "summary.md");
    const eventPath = join(tmp, "event.json");
    writeFileSync(summary, "");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 1, base: { sha: base } } }));
    // Simulate a PR that rewrites the config to run its own command with the platform tokens.
    write(".github/envsure.yml",
      "environments: [production]\nsources:\n  production:\n    - command: { run: \"node -e \\\"console.log('PR_SNEAKY')\\\"\" }\n");
    try {
      const r = await spawnNode(ACTION, [], {
        INPUT_TOKEN: TOKENS.github, GITHUB_REPOSITORY: "o/r", GITHUB_WORKSPACE: repo,
        GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summary,
      });
      const text = readFileSync(summary, "utf8");
      expect(r.status).toBe(1);
      expect(text).toContain("`VC_PROD`");
      expect(text).toContain("`production` → vercel web (production)");
      expect(text + r.stdout).not.toContain("PR_SNEAKY");
      expect(text + r.stdout).not.toContain(VALUE);
    } finally {
      write(".github/envsure.yml", CONFIG);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
