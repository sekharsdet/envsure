#!/usr/bin/env node
// End-to-end test against real GitHub. Needs `gh` logged in with `repo` scope.
// Creates/reuses a private sandbox repo (default <you>/envcontract-e2e) holding dummy
// secrets/variables, opens a PR there, and runs dist/cli.js and dist/action.js against it.
// The gh token is only passed to the tools via env vars; it is never stored in the sandbox.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.E2E_DIST ? resolve(process.env.E2E_DIST) : join(ROOT, "dist"); // e.g. an older build
const CLI = join(DIST, "cli.js");
const ACTION = join(DIST, "action.js");
const BRANCH = "e2e-pr";
const DUMMY = "e2e-dummy-value";
const PAGED_VARS = 35; // > the 30-per-page variables endpoint, so page 2 is required

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}
const gh = (...args) => sh("gh", args).stdout.trim();
const ghOk = (...args) => sh("gh", args, { allowFail: true }).status === 0;

const token = gh("auth", "token");
const REPO = process.env.E2E_REPO ?? `${gh("api", "user", "-q", ".login")}/envcontract-e2e`;

// ---------- sandbox state ----------
const envFlag = (env) => (env ? ["--env", env] : []);
const setSecret = (name, env) => sh("gh", ["secret", "set", name, "--repo", REPO, "--body", DUMMY, ...envFlag(env)]);
const setVariable = (name, env) => sh("gh", ["variable", "set", name, "--repo", REPO, "--body", DUMMY, ...envFlag(env)]);
const deleteSecret = (name, env) =>
  sh("gh", ["secret", "delete", name, "--repo", REPO, ...envFlag(env)], { allowFail: true });
const pagedVar = (i) => `PAGED_VAR_${String(i).padStart(2, "0")}`;

function prepareSandbox() {
  if (!ghOk("repo", "view", REPO)) {
    gh("repo", "create", REPO, "--private", "--description", "Sandbox for envsure end-to-end tests (dummy secrets only)");
  }
  for (const env of ["staging", "production"]) gh("api", "-X", "PUT", `repos/${REPO}/environments/${env}`);
  // These must not exist: they exercise the "environment not found" path.
  for (const env of ["qa", "preview"]) ghOk("api", "-X", "DELETE", `repos/${REPO}/environments/${env}`);

  // Repository scope
  setSecret("SHARED_KEY");
  setVariable("REPO_VAR");
  const existing = new Set(JSON.parse(gh("variable", "list", "--repo", REPO, "--json", "name")).map((v) => v.name));
  for (let i = 1; i <= PAGED_VARS; i++) if (!existing.has(pagedVar(i))) setVariable(pagedVar(i));
  // Environment scope
  setSecret("STRIPE_KEY", "staging");
  setSecret("STAGING_ONLY", "staging");
  setVariable("FEATURE_FLAG", "staging");
  setVariable("FEATURE_FLAG", "production");
  setSecret("PROD_ONLY", "production");
  // Left over by an interrupted "clean case" run.
  deleteSecret("STRIPE_KEY", "production");
  deleteSecret("STRIPE_KEY");
}

function write(dir, file, text) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}
const lines = (...l) => l.join("\n") + "\n";

const BASE_FILES = {
  ".github/envsure.yml": lines(
    "environments: [staging, production]",
    "ignore: [SENTRY_*, LOCAL_ONLY]",
    "excludePaths: [node_modules/, dist/, vendored/]",
  ),
  "src/old.ts": lines("export const old = process.env.OLD_MISSING;", "export const keep = 1;"),
  "src/deleted.ts": lines("export const d = process.env.DELETED_VAR;"),
  "src/renamed-before.ts": lines("export const r = process.env.RENAMED_VAR;"),
  ".env.staging": lines("OLD_EMPTY="),
  // Config variants live on the base branch: the Action reads its config from the PR base.
  ".github/envsure-qa.yml": lines("environments: [staging, qa]", "excludePaths: [node_modules/, dist/, vendored/]"),
  ".github/envsure-bad.yml": lines("environments: production"),
  ".github/envsure-clean.yml": lines('ignore: ["*"]', "excludePaths: [.env]"),
};

const PR_FILES = {
  // Each name is on a fixed line; expectations below refer to these line numbers.
  "src/app.ts": lines(
    "export const shared = process.env.SHARED_KEY;", // 1 ok: repo secret
    "export const stripe = process.env.STRIPE_KEY;", // 2 staging only
    "export const nope = process.env.TOTALLY_MISSING;", // 3
    "export const mode = process.env.NODE_ENV;", // 4 default ignore
    'export const br = process.env["BRACKET_VAR"];', // 5
    "export const meta = import.meta.env.VITE_META;", // 6
    "export const bun = Bun.env.BUN_VAR;", // 7
    'export const deno = Deno.env.get("DENO_VAR");', // 8
    'export const { DESTRUCT_A, DESTRUCT_B: b = "x" } = process.env;', // 9
    "export const dyn = (name: string) => process.env[name];", // 10 dynamic: not detectable
    "export const lower = process.env.lowercase_var;", // 11 not an env-style name
    "export const rv = process.env.REPO_VAR;", // 12 ok: repo variable
    `export const paged = process.env.${pagedVar(PAGED_VARS)};`, // 13 ok only if pagination works
    "export const sentry = process.env.SENTRY_DSN;", // 14 config ignore (prefix)
    "export const local = process.env.LOCAL_ONLY;", // 15 config ignore (exact)
    "export const sha = process.env.GITHUB_SHA;", // 16 default ignore
    "export const so = process.env.STAGING_ONLY;", // 17 staging only
    "export const stripe2 = process.env.STRIPE_KEY;", // 18 second ref, same finding
  ),
  "app.py": lines(
    "import os",
    'flag = os.getenv("FEATURE_FLAG")', // 2 ok: both envs
    'a = os.environ["PY_BRACKET"]', // 3
    'b = os.environ.get("PY_GET")', // 4
  ),
  "main.go": lines("package main", 'import "os"', 'var a = os.Getenv("GO_VAR")', 'var b, _ = os.LookupEnv("GO_LOOKUP")'),
  "app.rb": lines('a = ENV["RB_VAR"]', 'b = ENV.fetch("RB_FETCH")'),
  "src/crlf.ts": "// windows line endings\r\nexport const c = process.env.CRLF_VAR;\r\n",
  "src/with space.ts": lines("export const s = process.env.SPACE_VAR;"),
  "src/ünïcode.ts": lines("export const u = process.env.UNICODE_VAR;"),
  "node_modules/pkg/index.js": lines("module.exports = process.env.NODE_MODULES_VAR;"),
  "vendored/lib.js": lines("module.exports = process.env.VENDORED_VAR;"),
  "dist/out.js": lines("module.exports = process.env.DIST_VAR;"),
  "README.md": lines("Set `process.env.IN_MARKDOWN`."),
  ".github/workflows/deploy.yml": lines(
    "name: deploy",
    "on: workflow_dispatch",
    "jobs:",
    "  build:", // 4 no environment: repo/org values only
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ${{ secrets.STRIPE_KEY }}", // 7 missing at repo level
    "      - run: echo ${{ secrets.GITHUB_TOKEN }} ${{ vars.REPO_VAR }}", // 8 ok
    "      - run: echo ${{ vars.FEATURE_FLAG }}", // 9 env-only variable: missing at repo level
    "  deploy-staging:",
    "    runs-on: ubuntu-latest",
    "    environment: staging",
    "    steps:",
    "      - run: echo ${{ secrets.STRIPE_KEY }} ${{ vars.FEATURE_FLAG }}", // 14 ok
    "  deploy-prod:",
    "    runs-on: ubuntu-latest",
    "    environment:",
    "      name: production",
    "      url: https://example.com",
    "    steps:",
    "      - run: echo ${{ secrets.PROD_ONLY }}", // 21 ok
    "      - run: echo ${{ secrets.STAGING_ONLY }}", // 22 missing in production
    "  deploy-dynamic:",
    "    runs-on: ubuntu-latest",
    "    environment: ${{ inputs.target }}", // expression: falls back to configured envs
    "    steps:",
    "      - run: echo ${{ secrets.DYN_SECRET }} ${{ secrets.SHARED_KEY }}", // 27
  ),
  ".github/workflows/other.yaml": lines(
    "on: push",
    "jobs:",
    "  x:",
    "    runs-on: ubuntu-latest",
    "    environment: preview", // 5 literal env that is not in the config and does not exist
    "    steps:",
    "      - run: echo ${{ vars.YAML_EXT_VAR }} ${{ secrets.SHARED_KEY }}", // 7
  ),
  ".github/workflows/broken.yml": lines("jobs: [unclosed", "  ${{ secrets.BROKEN_SECRET }}"),
  ".env.example": lines("SHARED_KEY=", "EXAMPLE_ONLY_VAR="),
  ".env.sample": lines("export SAMPLE_VAR=x"),
  ".env.template": lines("TEMPLATE_VAR="),
  ".env.production": lines(
    "STRIPE_KEY=", // 1 empty
    "API_KEY=sk_test_abc", // 2 placeholder
    "TOKEN=your_key_here", // 3 placeholder
    "GOOD=real-value-123", // 4 ok
    'QUOTED=""', // 5 empty
    "PASS=changeme", // 6 placeholder
    "X=<secret>", // 7 placeholder
  ),
  ".env": lines("EMPTY_ONE="),
  ".env.local": lines("FINE=abc123"),
  "src/fly.ts": lines(
    "export const a = process.env.E2E_FLY_SECRET;", // 1 staged Fly secret
    "export const b = process.env.E2E_FLYTOML_VAR;", // 2 fly.toml [env]
    "export const c = process.env.E2E_FLY_MISSING;", // 3 nowhere
  ),
  "fly.toml": lines('app = "x"', "", "[env]", '  E2E_FLYTOML_VAR = "1"', "", "[http_service]", "  internal_port = 8080"),
};

/** Rebuild main + the PR branch from scratch and return the clone dir and base sha. */
function pushFixtures() {
  const dir = mkdtempSync(join(tmpdir(), "envcontract-e2e-"));
  // Fixed dates keep commit SHAs stable across runs, so force-pushes are no-ops and the PR stays open.
  const date = "2026-01-01T00:00:00Z";
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const git = (...args) => sh("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, env }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${REPO}.git`);
  for (const [f, t] of Object.entries(BASE_FILES)) write(dir, f, t);
  git("add", "-A");
  git("commit", "-q", "-m", "e2e base");
  git("push", "-q", "-f", "origin", "main");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", BRANCH);
  for (const [f, t] of Object.entries(PR_FILES)) write(dir, f, t);
  write(dir, "src/old.ts", lines("export const old = process.env.OLD_MISSING;", "export const keep = process.env.MODIFIED_LINE_VAR;"));
  git("rm", "-q", "src/deleted.ts");
  git("mv", "src/renamed-before.ts", "src/renamed-after.ts");
  git("add", "-A", "-f");
  git("commit", "-q", "-m", "e2e changes");
  git("push", "-q", "-f", "origin", BRANCH);
  git("fetch", "-q", "origin");
  return { dir, base };
}

function ensurePr() {
  const existing = gh("pr", "list", "--repo", REPO, "--head", BRANCH, "--state", "open", "--json", "number", "-q", ".[0].number");
  if (existing) return Number(existing);
  const url = gh("pr", "create", "--repo", REPO, "--base", "main", "--head", BRANCH,
    "--title", "envsure e2e", "--body", "Fixture PR for envsure end-to-end tests.");
  return Number(url.split("/").pop());
}

// ---------- assertions ----------
let failures = 0;
let passes = 0;
const allOutput = [];
function expect(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}
function section(title) {
  console.log(`\n== ${title}`);
}

function runCli(dir, args, env = {}) {
  const r = sh(process.execPath, [CLI, ...args], {
    cwd: dir,
    allowFail: true,
    // ENVSURE_TOKEN="" also guards the regression where an empty value masked GITHUB_TOKEN.
    env: { ...process.env, GITHUB_TOKEN: token, ENVSURE_TOKEN: "", GITHUB_REPOSITORY: "", ...env },
  });
  allOutput.push(r.stdout, r.stderr);
  return r;
}
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { refs: [], findings: [], dotenvIssues: [], parseError: r.stdout + r.stderr };
  }
};

/** name -> { missingIn, presentIn, refs } with sorted lists, for order-independent comparison. */
function summarize(findings) {
  return Object.fromEntries(findings.map((f) => [f.name, {
    missingIn: [...f.missingIn].sort(),
    presentIn: [...f.presentIn].sort(),
    refs: f.refs.map((r) => `${r.file}:${r.line}`).sort(),
  }]));
}
const BOTH = ["production", "staging"];
const missingBoth = (...refs) => ({ missingIn: BOTH, presentIn: [], refs: refs.sort() });

const EXPECTED_PR_FINDINGS = {
  BRACKET_VAR: missingBoth("src/app.ts:5"),
  BROKEN_SECRET: missingBoth(".github/workflows/broken.yml:2"),
  BUN_VAR: missingBoth("src/app.ts:7"),
  CRLF_VAR: missingBoth("src/crlf.ts:2"),
  DENO_VAR: missingBoth("src/app.ts:8"),
  DESTRUCT_A: missingBoth("src/app.ts:9"),
  DESTRUCT_B: missingBoth("src/app.ts:9"),
  DYN_SECRET: missingBoth(".github/workflows/deploy.yml:27"),
  EXAMPLE_ONLY_VAR: missingBoth(".env.example:2"),
  FEATURE_FLAG: { missingIn: ["(repository)"], presentIn: BOTH, refs: [".github/workflows/deploy.yml:9"] },
  GO_LOOKUP: missingBoth("main.go:4"),
  GO_VAR: missingBoth("main.go:3"),
  MODIFIED_LINE_VAR: missingBoth("src/old.ts:2"),
  PY_BRACKET: missingBoth("app.py:3"),
  PY_GET: missingBoth("app.py:4"),
  RB_FETCH: missingBoth("app.rb:2"),
  RB_VAR: missingBoth("app.rb:1"),
  SAMPLE_VAR: missingBoth(".env.sample:1"),
  SPACE_VAR: missingBoth("src/with space.ts:1"),
  STAGING_ONLY: { missingIn: ["production"], presentIn: ["staging"], refs: [".github/workflows/deploy.yml:22", "src/app.ts:17"] },
  STRIPE_KEY: {
    missingIn: ["(repository)", "production"],
    presentIn: ["staging"],
    refs: [".github/workflows/deploy.yml:7", "src/app.ts:18", "src/app.ts:2"],
  },
  TEMPLATE_VAR: missingBoth(".env.template:1"),
  TOTALLY_MISSING: missingBoth("src/app.ts:3"),
  UNICODE_VAR: missingBoth("src/ünïcode.ts:1"),
  E2E_FLY_SECRET: missingBoth("src/fly.ts:1"),
  E2E_FLYTOML_VAR: missingBoth("src/fly.ts:2"),
  E2E_FLY_MISSING: missingBoth("src/fly.ts:3"),
  VITE_META: missingBoth("src/app.ts:6"),
  YAML_EXT_VAR: { missingIn: ["preview"], presentIn: [], refs: [".github/workflows/other.yaml:7"] },
};

const EXPECTED_PR_DOTENV = [
  ".env.production:1:empty",
  ".env.production:2:placeholder",
  ".env.production:3:placeholder",
  ".env.production:5:empty",
  ".env.production:6:placeholder",
  ".env.production:7:placeholder",
  ".env:1:empty",
].sort();
const dotenvKeys = (issues) => issues.map((i) => `${i.file}:${i.line}:${i.problem}`).sort();

function cliScenarios(dir) {
  const args = ["--repo", REPO, "--base", "origin/main"];
  const withConfig = (text, fn) => {
    const p = join(dir, ".github", "envsure.yml");
    const original = readFileSync(p);
    if (text === null) rmSync(p);
    else writeFileSync(p, text);
    try {
      return fn();
    } finally {
      writeFileSync(p, original);
    }
  };

  section("CLI: pull request diff, default config");
  let r = runCli(dir, [...args, "--format", "json"]);
  let out = json(r);
  expect("exit code 1", r.status, 1);
  const actual = summarize(out.findings);
  expect("finding names", Object.keys(actual).sort(), Object.keys(EXPECTED_PR_FINDINGS).sort());
  for (const [name, exp] of Object.entries(EXPECTED_PR_FINDINGS)) expect(`finding ${name}`, actual[name], exp);
  expect("dotenv issues", dotenvKeys(out.dotenvIssues), EXPECTED_PR_DOTENV);
  const refNames = new Set(out.refs.map((x) => x.name));
  for (const n of ["OLD_MISSING", "DELETED_VAR", "RENAMED_VAR", "NODE_MODULES_VAR", "VENDORED_VAR", "DIST_VAR", "IN_MARKDOWN", "lowercase_var", "OLD_EMPTY"]) {
    expect(`not scanned: ${n}`, refNames.has(n), false);
  }
  for (const n of ["SHARED_KEY", "REPO_VAR", pagedVar(PAGED_VARS), "PROD_ONLY", "NODE_ENV", "SENTRY_DSN", "LOCAL_ONLY", "GITHUB_SHA", "GITHUB_TOKEN"]) {
    expect(`scanned but satisfied/ignored: ${n}`, refNames.has(n) && !(n in actual), true);
  }
  expect("dynamic process.env[name] not reported", out.refs.some((x) => x.file === "src/app.ts" && x.line === 10), false);

  section("CLI: output formats");
  r = runCli(dir, args);
  const textLines = r.stdout.trim().split(/\r?\n/);
  expect("text: one line per finding + dotenv issue", textLines.length, Object.keys(EXPECTED_PR_FINDINGS).length + EXPECTED_PR_DOTENV.length);
  expect("text: STRIPE_KEY line", textLines.includes(
    ".github/workflows/deploy.yml:7  STRIPE_KEY missing in repository, production; present in staging"), true);
  expect("text: no internal (repository) token", r.stdout.includes("(repository)"), false);
  r = runCli(dir, [...args, "--format", "markdown"]);
  expect("markdown: marker + table", r.stdout.startsWith("<!-- envsure -->") && r.stdout.includes("| `TOTALLY_MISSING` |"), true);
  expect("markdown: exit 1", r.status, 1);

  section("CLI: unused names (live)");
  r = runCli(dir, [...args, "--format", "json", "--unused"]);
  const unusedRepo = json(r).unused?.["(repository)"] ?? [];
  expect("unused: PAGED_VAR_01..34 at repository level",
    unusedRepo, Array.from({ length: PAGED_VARS - 1 }, (_, i) => pagedVar(i + 1)));
  expect("unused: names the code uses are not listed", Object.keys(json(r).unused ?? {}), ["(repository)"]);

  section("CLI: full scan (no --base)");
  r = runCli(dir, ["--repo", REPO, "--format", "json"]);
  out = json(r);
  const full = summarize(out.findings);
  expect("reports OLD_MISSING on unchanged line", "OLD_MISSING" in full, true);
  expect("reports RENAMED_VAR in renamed file", "RENAMED_VAR" in full, true);
  expect("deleted file not reported", "DELETED_VAR" in full, false);
  expect("lints unchanged .env.staging", dotenvKeys(out.dotenvIssues).includes(".env.staging:1:empty"), true);

  section("CLI: config variants");
  r = runCli(dir, [...args, "--format", "json", "--config", ".github/envsure-qa.yml"]);
  const qa = summarize(json(r).findings);
  expect("unknown env qa: exit 1, no crash", r.status, 1);
  expect("unknown env qa: FEATURE_FLAG missing in qa", qa.FEATURE_FLAG?.missingIn, ["(repository)", "qa"]);
  expect("unknown env qa: SHARED_KEY ok", "SHARED_KEY" in qa, false);
  expect("job env not in config (production): PROD_ONLY ok", "PROD_ONLY" in qa, false);
  expect("job env not in config (production): STAGING_ONLY missing in production",
    qa.STAGING_ONLY?.missingIn, ["production", "qa"]);

  out = withConfig(null, () => json(runCli(dir, [...args, "--format", "json"])));
  const nocfg = summarize(out.findings);
  expect("no config: code refs checked at repository level", nocfg.TOTALLY_MISSING?.missingIn, ["(repository)"]);
  expect("no config: FEATURE_FLAG (env-only) missing at repository level", nocfg.FEATURE_FLAG?.missingIn, ["(repository)"]);
  expect("no config: default excludes no longer skip vendored/", "VENDORED_VAR" in nocfg, true);
  expect("no config: SENTRY_DSN no longer ignored", "SENTRY_DSN" in nocfg, true);
  expect("no config: node_modules/ still excluded", "NODE_MODULES_VAR" in nocfg, false);
  expect("no config: workflow job envs still resolved (STRIPE_KEY present in staging)",
    nocfg.STRIPE_KEY?.presentIn, ["staging"]);

  r = runCli(dir, [...args, "--config", ".github/envsure-bad.yml"]);
  expect("invalid config: exit 2", r.status, 2);
  expect("invalid config: message", r.stderr.includes('"environments" must be a list of strings'), true);
  r = runCli(dir, [...args, "--config", ".github/nope.yml"]);
  expect("missing --config file: exit 2", r.status, 2);
  expect("missing --config file: message", r.stderr.includes("config not found"), true);
  r = withConfig("environments: [staging\n", () => runCli(dir, args));
  expect("unparseable YAML config: exit 2", r.status, 2);
  r = runCli(dir, [...args, "--config", ".github/envsure-clean.yml"]);
  expect("clean config: exit 0", r.status, 0);
  expect("clean config: success message", r.stdout.trim(), "envsure: all referenced variables are configured");

  section("CLI: offline");
  r = runCli(dir, ["--offline", "--base", "origin/main"], { GITHUB_TOKEN: "" });
  expect("exit 1 (dotenv issues)", r.status, 1);
  expect("lists TOTALLY_MISSING", r.stdout.includes("src/app.ts:3  TOTALLY_MISSING  (code)"), true);
  r = runCli(dir, ["--offline", "--base", "origin/main", "--format", "json"], { GITHUB_TOKEN: "" });
  expect("json is a list of refs", Array.isArray(json(r)) && json(r).some((x) => x.name === "UNICODE_VAR"), true);

  section("CLI: argument and API errors");
  r = runCli(dir, ["--help"]);
  expect("--help exits 0", r.status, 0);
  r = runCli(dir, [], { GITHUB_TOKEN: "" });
  expect("no repo/token: exit 2", r.status, 2);
  r = runCli(dir, ["--repo", "not-a-repo"]);
  expect("malformed --repo: exit 2", r.status, 2);
  r = runCli(dir, [], { GITHUB_REPOSITORY: REPO });
  expect("repo from $GITHUB_REPOSITORY: exit 1 with findings", r.status, 1);
  r = runCli(dir, ["--repo", REPO], { GITHUB_TOKEN: "", ENVSURE_TOKEN: token });
  expect("token from $ENVSURE_TOKEN: exit 1 with findings", r.status, 1);
  r = runCli(dir, ["--repo", REPO, "--bogus"]);
  expect("unknown flag: exit 2", r.status, 2);
  r = runCli(dir, ["--repo", REPO, "--base", "origin/does-not-exist"]);
  expect("unknown --base ref: exit 2", r.status, 2);
  // Repeated: exiting while parallel requests are open used to crash Node on Windows intermittently.
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((r = runCli(dir, args, { GITHUB_TOKEN: "ghp_invalid" })).status);
  expect("bad token: exit 2 (x5)", statuses, [2, 2, 2, 2, 2]);
  expect("bad token: message", /GitHub API 401/.test(r.stderr), true);
  r = runCli(dir, ["--repo", `${REPO}-does-not-exist`]);
  expect("repo not found: exit 2", r.status, 2);
  r = runCli(dir, args, { GITHUB_API_URL: "http://127.0.0.1:9" });
  expect("API unreachable: exit 2", r.status, 2);

  section("CLI: after the missing secrets are added");
  setSecret("STRIPE_KEY", "production");
  setSecret("STRIPE_KEY");
  try {
    const fixed = summarize(json(runCli(dir, [...args, "--format", "json"])).findings);
    expect("STRIPE_KEY no longer reported", "STRIPE_KEY" in fixed, false);
    expect("others still reported", "TOTALLY_MISSING" in fixed, true);
  } finally {
    deleteSecret("STRIPE_KEY", "production");
    deleteSecret("STRIPE_KEY");
  }
}

function runAction(dir, event, extra = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "envcontract-e2e-action-"));
  const eventPath = join(tmp, "event.json");
  const summary = join(tmp, "summary.md");
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(summary, "");
  const r = sh(process.execPath, [ACTION], {
    cwd: dir,
    allowFail: true,
    env: {
      ...process.env,
      INPUT_TOKEN: token,
      GITHUB_REPOSITORY: REPO,
      GITHUB_WORKSPACE: dir,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_STEP_SUMMARY: summary,
      ...extra,
    },
  });
  const summaryText = readFileSync(summary, "utf8");
  rmSync(tmp, { recursive: true, force: true });
  allOutput.push(r.stdout, r.stderr, summaryText);
  return { ...r, summaryText };
}

function markerComments(pr) {
  const bodies = JSON.parse(gh("api", `repos/${REPO}/issues/${pr}/comments?per_page=100`));
  return bodies.filter((c) => c.body.includes("<!-- envsure -->"));
}

/** Live Fly.io check: a throwaway app with staged secrets (no machines, so no cost). */
function flyScenarios(dir) {
  section("Fly.io source (live)");
  if (!ghOkCmd("fly", ["auth", "whoami"])) {
    console.log("SKIP  flyctl not installed or not logged in");
    return;
  }
  const apps = JSON.parse(sh("fly", ["apps", "list", "--json"]).stdout).map((a) => a.Name ?? a.name);
  const app = process.env.E2E_FLY_APP ?? apps.find((n) => n.startsWith("envcontract-e2e-")) ??
    `envcontract-e2e-${Math.random().toString(16).slice(2, 10)}`;
  if (!apps.includes(app)) sh("fly", ["apps", "create", app, "--org", "personal"]);
  sh("fly", ["secrets", "set", "--stage", "-a", app, `E2E_FLY_SECRET=${DUMMY}`]);
  const flyToken = sh("fly", ["auth", "token"]).stdout.trim();
  const config = join(dir, ".github", "envsure-fly.yml");
  writeFileSync(config, lines(
    "environments: [production]",
    "excludePaths: [.github/, node_modules/, dist/, vendored/]",
    "sources:",
    "  production:",
    `    - fly: { app: ${app}, config: fly.toml }`,
  ));
  try {
    const run = (env) => runCli(dir, ["--base", "origin/main", "--format", "json", "--config", ".github/envsure-fly.yml"],
      { GITHUB_TOKEN: "", ...env });
    let r = run({ FLY_API_TOKEN: flyToken });
    const out = summarize(json(r).findings);
    expect(`fly ${app}: exit 1`, r.status, 1);
    expect("fly: staged secret found", "E2E_FLY_SECRET" in out, false);
    expect("fly: fly.toml [env] key found", "E2E_FLYTOML_VAR" in out, false);
    expect("fly: unknown name reported", out.E2E_FLY_MISSING?.missingIn, ["production"]);
    expect("fly: works without a GitHub token (no workflow refs scanned)", r.stderr.includes("need --repo"), false);
    r = run({ FLY_API_TOKEN: "bad-token" });
    expect("fly: bad token -> exit 2 with hint", [r.status, /fly .*HTTP 401 .*FLY_API_TOKEN/.test(r.stderr)], [2, true]);
    r = run({ FLY_API_TOKEN: "" });
    expect("fly: no token -> exit 2 naming the variable", [r.status, r.stderr.includes("set FLY_API_TOKEN")], [2, true]);
  } finally {
    rmSync(config, { force: true });
  }
}
const ghOkCmd = (cmd, args) => {
  try {
    return sh(cmd, args, { allowFail: true }).status === 0;
  } catch {
    return false;
  }
};

function actionScenarios(dir, pr, base) {
  const prEvent = { pull_request: { number: pr, base: { sha: base } } };

  section("Action: pull_request event");
  let r = runAction(dir, prEvent);
  expect("exit code 1", r.status, 1);
  const errors = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  expect("one error annotation per finding", errors.length, Object.keys(EXPECTED_PR_FINDINGS).length);
  expect("STRIPE_KEY annotation", errors.includes(
    "::error file=.github/workflows/deploy.yml,line=7::STRIPE_KEY is missing in repository, production"), true);
  const warnings = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("::warning file="));
  expect("one warning per dotenv issue", warnings.length, EXPECTED_PR_DOTENV.length);
  expect("step summary has table", r.summaryText.includes("| `TOTALLY_MISSING` |"), true);
  expect("commented without warnings", r.stdout.includes("could not comment"), false);
  let comments = markerComments(pr);
  expect("exactly one PR comment", comments.length, 1);
  const commentId = comments[0]?.id;

  r = runAction(dir, prEvent);
  comments = markerComments(pr);
  expect("rerun: still exactly one comment (updated in place)", [comments.length, comments[0]?.id], [1, commentId]);
  expect("comment lists UNICODE_VAR", comments[0]?.body.includes("`UNICODE_VAR`"), true);

  section("Action: inputs");
  r = runAction(dir, prEvent, { "INPUT_FAIL-ON-MISSING": "false" });
  expect("fail-on-missing=false: exit 0", r.status, 0);
  r = runAction(dir, prEvent, { INPUT_CONFIG: ".github/envsure-clean.yml" });
  expect("clean result: exit 0", r.status, 0);
  expect("clean result without comment-on-success: comment untouched",
    markerComments(pr)[0]?.body.includes("`TOTALLY_MISSING`"), true);
  r = runAction(dir, prEvent, { INPUT_CONFIG: ".github/envsure-clean.yml", "INPUT_COMMENT-ON-SUCCESS": "true" });
  comments = markerComments(pr);
  expect("comment-on-success: same comment now shows success",
    [comments.length, comments[0]?.id, comments[0]?.body.includes("All referenced environment variables are configured")],
    [1, commentId, true]);
  r = runAction(dir, prEvent, { "INPUT_COMMENT-TOKEN": "ghp_invalid" });
  expect("bad comment-token: warns, still fails on findings", [r.status, r.stdout.includes("could not comment")], [1, true]);
  expect("bad comment-token: comment not changed", markerComments(pr)[0]?.body.includes("All referenced"), true);
  r = runAction(dir, prEvent, { "INPUT_COMMENT-TOKEN": token });
  expect("separate comment-token restores failing comment", markerComments(pr)[0]?.body.includes("`TOTALLY_MISSING`"), true);
  r = runAction(dir, prEvent, { INPUT_CONFIG: ".github/nope.yml" });
  expect("missing config input: exit 1 with error", [r.status, r.stdout.includes("config not found")], [1, true]);

  section("Action: push event and failures");
  const before = markerComments(pr)[0]?.updated_at;
  r = runAction(dir, {});
  expect("push event: full scan finds OLD_MISSING", r.summaryText.includes("`OLD_MISSING`"), true);
  expect("push event: exit 1", r.status, 1);
  expect("push event: does not touch PR comment", markerComments(pr)[0]?.updated_at, before);
  r = runAction(dir, prEvent, { INPUT_TOKEN: "" });
  expect("missing token: exit 1 with message", [r.status, r.stdout.includes("the `token` input")], [1, true]);
  r = runAction(dir, prEvent, { INPUT_TOKEN: "ghp_invalid" });
  expect("bad token: exit 1 with API error", [r.status, r.stdout.includes("::error::envsure: GitHub API 401")], [1, true]);
}

// ---------- main ----------
for (const f of [CLI, ACTION]) readFileSync(f); // fail fast if not built
console.log(`envsure e2e against ${REPO}`);
prepareSandbox();
const { dir, base } = pushFixtures();
const pr = ensurePr();
console.log(`PR: https://github.com/${REPO}/pull/${pr}`);
try {
  cliScenarios(dir);
  actionScenarios(dir, pr, base);
  flyScenarios(dir);
  section("Privacy");
  expect("no secret/variable value appears in any output", allOutput.some((o) => o?.includes(DUMMY)), false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
