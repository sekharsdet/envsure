// Hostile pull requests and dangerous misconfigurations. Each test states what EnvSure must do.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanText } from "../../src/scan.js";
import { type MockServer, startMockServer, TOKENS, VALUE } from "../mock/server.mjs";
import { action, cli, FAKE, makeRepo } from "./helpers.js";

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockServer();
});
afterAll(() => mock.close());

const gh = () => ({ ...mock.env, GITHUB_TOKEN: TOKENS.github });
const herokuOnly = (extra = "") =>
  `environments: [production]\nexcludePaths: [.github/]\nsources:\n  production:\n    - heroku: { app: hk-app }\n${extra}`;

describe("output injection from attacker-controlled file names", () => {
  it("escapes workflow-command properties in annotations", async () => {
    // `,` and `%` are legal in file names on every OS and are workflow-command metacharacters.
    const repo = makeRepo({ ".github/envsure.yml": herokuOnly() }, { "src/evil,line=999%0Atitle=x.ts": "process.env.MISSING_A;\n" });
    try {
      const r = await action(repo, { ...gh(), INPUT_TOKEN: "" });
      const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("::error file="))!;
      expect(line).toBe("::error file=src/evil%2Cline=999%250Atitle=x.ts,line=1::MISSING_A is missing in production");
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("keeps file names inside code spans in the PR comment and summary", async () => {
    // Backticks and brackets are legal file-name characters on every OS.
    const repo = makeRepo({ ".github/envsure.yml": herokuOnly() }, { "src/x`](evil.example)`.ts": "process.env.MISSING_B;\n" });
    try {
      const r = await action(repo, { ...gh(), INPUT_TOKEN: "" });
      expect(r.summary).toContain("`src/x'](evil.example)'.ts:1`");
      expect(r.summary).not.toContain("`](evil.example)`");
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("files the PR controls", () => {
  it("does not follow symlinks out of the repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "envsure-outside-"));
    writeFileSync(join(outside, "secret.ts"), "process.env.OUTSIDE_NAME;\n");
    const repo = makeRepo({});
    try {
      try {
        symlinkSync(join(outside, "secret.ts"), join(repo.dir, "link.ts"));
      } catch {
        return; // symlinks need privileges on Windows; covered on Linux/macOS CI
      }
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "link");
      const r = await cli(repo, ["--offline", "--base", repo.base]);
      expect(r.stdout).not.toContain("OUTSIDE_NAME");
    } finally {
      repo.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);

  it("survives a submodule and a directory in the diff", async () => {
    const repo = makeRepo({}, { "src/a.ts": "process.env.AFTER_SUBMODULE;\n" });
    try {
      repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.base},vendor/sub`);
      repo.git("commit", "-q", "-m", "submodule");
      mkdirSync(join(repo.dir, "vendor", "sub"), { recursive: true });
      const r = await cli(repo, ["--offline", "--base", repo.base]);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("AFTER_SUBMODULE");
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("rejects file and fly.toml sources that point outside the repository", async () => {
    for (const source of ["file: { path: ../outside.txt }", "fly: { app: fly-app, config: ../../fly.toml }"]) {
      const repo = makeRepo({ ".github/envsure.yml": `environments: [production]\nsources:\n  production:\n    - ${source}\n` },
        { "src/a.ts": "process.env.X_NAME;\n" });
      try {
        const r = await cli(repo, ["--base", repo.base], mock.env);
        expect(r.status, source).toBe(2);
        expect(r.stderr, source).toMatch(/outside the repository/);
      } finally {
        repo.cleanup();
      }
    }
  }, 60_000);

  it("on pull requests, runs `command` sources against the base commit, not PR-modified scripts", async () => {
    const marker = join(tmpdir(), `envsure-pwned-${Date.now()}`);
    const repo = makeRepo(
      {
        ".github/envsure.yml": "environments: [production]\nsources:\n  production:\n    - command: { run: node scripts/names.js }\n",
        "scripts/names.js": "console.log('BASE_NAME')\n",
      },
      {
        // The PR rewrites the script the trusted config runs: it would run with every platform token.
        "scripts/names.js": `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.HEROKU_API_KEY || 'x'); console.log('BASE_NAME\\nPR_NAME')\n`,
        "src/a.ts": "process.env.BASE_NAME; process.env.PR_NAME;\n",
      },
    );
    try {
      const r = await action(repo, { ...gh(), INPUT_TOKEN: "" });
      expect(existsSync(marker)).toBe(false);
      expect(r.summary).toContain("`PR_NAME`"); // only the base script's names count
      expect(r.summary).not.toContain("`BASE_NAME`");
    } finally {
      repo.cleanup();
      rmSync(marker, { force: true });
    }
  }, 60_000);
});

describe("secrets never leak", () => {
  it("does not print secret-looking values a misconfigured command source returns as names", async () => {
    const values = [FAKE.awsKeyId, FAKE.githubToken, FAKE.stripeLive];
    const repo = makeRepo({
      ".github/envsure.yml": "environments: [production]\nsources:\n  production:\n    - command: { run: node scripts/leak.js }\n",
      // e.g. `kubectl get secret -o jsonpath={.data.*}`: values, not names
      "scripts/leak.js": `console.log(${JSON.stringify(values.join("\n"))})\n`,
    }, { "src/a.ts": "process.env.SOMETHING_ELSE;\n" });
    try {
      const r = await cli(repo, ["--base", repo.base, "--unused"]);
      for (const v of values) expect(r.stdout + r.stderr).not.toContain(v);
      expect(r.stderr).toMatch(/look like secret values/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("flags real-looking secrets committed in .env files without printing them", async () => {
    const env = [
      `STRIPE_KEY=${FAKE.stripeLive}`,
      `AWS_SECRET_ACCESS_KEY=${FAKE.awsSecret}`,
      "DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app",
      "PORT=3000",
      "SITE_URL=https://example.com",
    ].join("\n");
    const repo = makeRepo({}, { ".env.production": env + "\n" });
    try {
      const r = await cli(repo, ["--offline", "--base", repo.base]);
      expect(r.stdout).toContain(".env.production:1  STRIPE_KEY looks like a real secret");
      expect(r.stdout).toContain(".env.production:2  AWS_SECRET_ACCESS_KEY looks like a real secret");
      expect(r.stdout).toContain(".env.production:3  DATABASE_URL contains a password");
      expect(r.stdout).not.toMatch(/PORT|SITE_URL/);
      for (const v of [FAKE.stripeLive, FAKE.awsSecret, "hunter2pass"]) expect(r.stdout + r.stderr).not.toContain(v);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("refuses a token pasted where an env var name belongs, without echoing it", async () => {
    const pasted = FAKE.githubToken;
    const repo = makeRepo({ ".github/envsure.yml": herokuOnly().replace("app: hk-app", `app: hk-app, tokenEnv: ${pasted}`) },
      { "src/a.ts": "process.env.A_NAME;\n" });
    try {
      const r = await cli(repo, ["--base", repo.base]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/tokenEnv must be the name of an environment variable/);
      expect(r.stdout + r.stderr).not.toContain(pasted);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("never prints GitHub variable values in JSON output", async () => {
    const repo = makeRepo({}, { "src/a.ts": "process.env.GH_SHARED;\n" });
    try {
      const r = await cli(repo, ["--repo", "o/r", "--base", repo.base, "--format", "json", "--unused"], gh());
      expect(r.stdout + r.stderr).not.toContain(VALUE);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("tokens only go where they should", () => {
  it("rejects an Azure vault name that would change the host", async () => {
    const repo = makeRepo({ ".github/envsure.yml": "environments: [p]\nsources:\n  p:\n    - azure-keyvault: { vault: \"evil.example/x#\" }\n" },
      { "src/a.ts": "process.env.A_NAME;\n" });
    try {
      const r = await cli(repo, ["--base", repo.base], { AZURE_KEYVAULT_TOKEN: "t" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/vault.*must be/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("does not follow a Key Vault nextLink to another host", async () => {
    const repo = makeRepo({ ".github/envsure.yml": "environments: [p]\nsources:\n  p:\n    - azure-keyvault: { vault: kv-test }\n" },
      { "src/a.ts": "process.env.A_NAME;\n" });
    try {
      const r = await cli(repo, ["--base", repo.base],
        { ...mock.env, ENVSURE_AZURE_KEYVAULT_API_URL: `${mock.base}/azure-kv-evil` });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/nextLink .*different host/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("hostile or broken APIs", () => {
  it("times out a hanging API instead of hanging the CI job", async () => {
    const repo = makeRepo({ ".github/envsure.yml": "environments: [p]\nsources:\n  p:\n    - heroku: { app: x }\n" },
      { "src/a.ts": "process.env.A_NAME;\n" });
    try {
      const r = await cli(repo, ["--base", repo.base],
        { ...mock.env, ENVSURE_HEROKU_API_URL: `${mock.base}/hang`, ENVSURE_HTTP_TIMEOUT_MS: "1000" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/timed out/);
      expect(r.ms).toBeLessThan(15_000);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("explains a GitHub rate limit instead of blaming permissions", async () => {
    const repo = makeRepo({}, { "src/a.ts": "process.env.A_NAME;\n" });
    try {
      const r = await cli(repo, ["--repo", "ratelimited/r", "--base", repo.base], gh());
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/rate limit/i);
      expect(r.stderr).not.toMatch(/lacks Secrets/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("PR comment cannot be hijacked or duplicated", () => {
  it("does not get stuck on a marker comment someone else wrote", async () => {
    mock.comments.length = 0;
    mock.comments.push({ id: 1, issue: 1, body: "<!-- envsure --> all good, nothing to see", user: { login: "intruder" } });
    const repo = makeRepo({ ".github/envsure.yml": herokuOnly() }, { "src/a.ts": "process.env.MISSING_C;\n" });
    try {
      await action(repo, { ...gh(), INPUT_TOKEN: "", "INPUT_COMMENT-TOKEN": TOKENS.github });
      const mine = mock.comments.filter((c) => c.user.login === "envsure-bot");
      expect(mine).toHaveLength(1);
      expect(mine[0].body).toContain("`MISSING_C`");
      expect(mock.comments.find((c) => c.id === 1)!.body).toContain("nothing to see");
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("finds its own comment past the first page of comments", async () => {
    mock.comments.length = 0;
    for (let i = 0; i < 150; i++) mock.comments.push({ id: i + 1, issue: 1, body: `chatter ${i}`, user: { login: "someone" } });
    mock.comments.push({ id: 500, issue: 1, body: "<!-- envsure -->\nold result", user: { login: "envsure-bot" } });
    const repo = makeRepo({ ".github/envsure.yml": herokuOnly() }, { "src/a.ts": "process.env.MISSING_D;\n" });
    try {
      await action(repo, { ...gh(), INPUT_TOKEN: "", "INPUT_COMMENT-TOKEN": TOKENS.github });
      const markers = mock.comments.filter((c) => c.body.includes("<!-- envsure -->"));
      expect(markers.map((c) => c.id)).toEqual([500]);
      expect(markers[0].body).toContain("`MISSING_D`");
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("keeps the comment under GitHub's 65,536 character limit", async () => {
    mock.comments.length = 0;
    const many = Array.from({ length: 3000 }, (_, i) => `process.env.MISSING_LONG_VARIABLE_NAME_${i};`).join("\n");
    const repo = makeRepo({ ".github/envsure.yml": herokuOnly() }, { "src/many.ts": many });
    try {
      await action(repo, { ...gh(), INPUT_TOKEN: "", "INPUT_COMMENT-TOKEN": TOKENS.github });
      expect(mock.comments).toHaveLength(1);
      expect(mock.comments[0].body.length).toBeLessThanOrEqual(65_536);
      expect(mock.comments[0].body).toMatch(/more lines not shown/);
    } finally {
      repo.cleanup();
    }
  }, 120_000);
});

describe("arguments", () => {
  it("rejects a --base that git would read as an option", async () => {
    const repo = makeRepo({}, { "src/a.ts": "process.env.A_NAME;\n" });
    try {
      const out = join(repo.dir, "written-by-git.txt");
      const r = await cli(repo, ["--offline", `--base=--output=${out}`]);
      expect(r.status).toBe(2);
      expect(existsSync(out)).toBe(false);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("denial of service through pathological files", () => {
  const timed = (file: string, text: string) => {
    const start = Date.now();
    scanText(file, text);
    return Date.now() - start;
  };
  it.each([
    ["workflow expression without closing braces", ".github/workflows/x.yml", "run: " + "${{ ".repeat(200_000)],
    ["unclosed destructuring", "a.ts", "const {" + " a,".repeat(500_000)],
    ["many createEnv calls", "env.ts", "createEnv({ server: {".repeat(50_000)],
    ["compose interpolation without end", "compose.yml", "x: ${A:?" + "y".repeat(1_000_000)],
    ["very long single line", "a.ts", "process.env.".repeat(300_000)],
    ["many unclosed compose interpolations", "compose.yml", "x: " + "${A:?".repeat(300_000)],
    ["many unclosed imports", "a.ts", "import { env ".repeat(200_000)],
    ["many if: expressions", ".github/workflows/x.yml", "jobs:\n  a:\n    steps:\n" + "      - if: vars.A == 'x' && secrets.B\n".repeat(100_000)],
    ["unclosed expression then many secrets", ".github/workflows/x.yml", "run: ${{ " + "secrets.A ".repeat(200_000)],
  ])("%s scans quickly", (_name, file, text) => {
    // Quadratic behaviour shows up as tens of seconds; real inputs take well under one.
    expect(timed(file, text)).toBeLessThan(5_000);
  });

  it("deeply nested workflow YAML does not crash the scan", () => {
    const deep = "jobs: " + "[".repeat(100_000) + "]".repeat(100_000) + "\n";
    expect(() => scanText(".github/workflows/deep.yml", deep + "x: ${{ secrets.DEEP }}\n")).not.toThrow();
  });
});
