// Real-world git setups: where EnvSure is run from, user git config, shallow CI clones, odd files.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unquoteGitPath } from "../../src/scan.js";
import { action, cli, makeRepo } from "./helpers.js";

const offline = (base: string) => ["--offline", "--base", base, "--format", "json"];
const refNames = (stdout: string) => (JSON.parse(stdout) as { name: string; file: string; line: number }[]).map((r) => `${r.file}:${r.line}:${r.name}`);

describe("where EnvSure runs from", () => {
  it("gives the same result from a subdirectory as from the root", async () => {
    const repo = makeRepo({}, { "apps/web/src/a.ts": "process.env.SUBDIR_VAR;\n", "pkg/b.py": "os.getenv('ROOT_VAR')\n" });
    try {
      const fromRoot = await cli(repo, offline(repo.base));
      const fromSub = await cli(join(repo.dir, "apps", "web"), offline(repo.base));
      expect(refNames(fromSub.stdout)).toEqual(refNames(fromRoot.stdout));
      expect(refNames(fromRoot.stdout)).toEqual(["apps/web/src/a.ts:1:SUBDIR_VAR", "pkg/b.py:1:ROOT_VAR"]);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("explains when it is not run inside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "envsure-nogit-"));
    try {
      const r = await cli(dir, ["--offline"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not inside a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the user's git config does not change results", () => {
  it.each([
    ["diff.noprefix=true"],
    ["diff.mnemonicPrefix=true"],
    ["color.ui=always"],
    ["color.diff=always"],
    ["core.quotepath=true"],
    ["diff.external=does-not-exist"],
    ["diff.renames=false"],
  ])("%s", async (setting) => {
    const repo = makeRepo({ "src/old.ts": "export const a = 1;\n" },
      { "src/new.ts": "process.env.NEW_VAR;\n", "src/ünï.ts": "process.env.UNI_VAR;\n" }, { gitConfig: [setting] });
    try {
      const r = await cli(repo, offline(repo.base));
      expect(r.stderr).toBe("");
      expect(refNames(r.stdout)).toEqual(["src/new.ts:1:NEW_VAR", "src/ünï.ts:1:UNI_VAR"]);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("CI checkouts", () => {
  it("fetches the base commit in a shallow clone", async () => {
    const origin = makeRepo({ "src/base.ts": "process.env.BASE_VAR;\n" }, { "src/pr.ts": "process.env.PR_VAR;\n" });
    const clone = mkdtempSync(join(tmpdir(), "envsure-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth=1", "--branch", "pr", `file://${origin.dir.replace(/\\/g, "/")}`, clone]);
      const r = await cli(clone, offline(origin.base));
      expect(r.stderr).toMatch(/no shared history|^$/);
      expect(refNames(r.stdout)).toEqual(["src/pr.ts:1:PR_VAR"]);
    } finally {
      origin.cleanup();
      rmSync(clone, { recursive: true, force: true });
    }
  }, 60_000);

  it("says how to fix a missing base commit it cannot fetch", async () => {
    const repo = makeRepo({}, { "src/a.ts": "process.env.A_VAR;\n" });
    try {
      const r = await cli(repo, offline("0123456789abcdef0123456789abcdef01234567"));
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/fetch-depth: 0/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("checks only the PR's own lines on the merge commit a pull_request workflow checks out", async () => {
    const repo = makeRepo({ "src/app.ts": "// app\n" }, { "src/app.ts": "// app\nprocess.env.PR_ONLY;\n" });
    try {
      // main moves on after the PR branched; GitHub then builds refs/pull/N/merge = main + PR.
      repo.git("checkout", "-q", "main");
      writeFileSync(join(repo.dir, "src/main.ts"), "process.env.MAIN_ONLY;\n");
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "main moves");
      const mainTip = repo.git("rev-parse", "HEAD").trim();
      repo.git("merge", "-q", "--no-ff", "-m", "merge pr", "pr");
      repo.git("checkout", "-q", "--detach", "HEAD");
      const r = await cli(repo, offline(mainTip));
      expect(refNames(r.stdout)).toEqual(["src/app.ts:2:PR_ONLY"]);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("uses the merge queue's base commit", async () => {
    // A platform-only config, so the run needs no GitHub token.
    const config = "environments: [p]\nexcludePaths: [.github/]\nsources:\n  p:\n    - file: { path: names.txt }\n";
    const repo = makeRepo({ ".github/envsure.yml": config, "names.txt": "", "src/old.ts": "process.env.OLD_VAR;\n" },
      { "src/new.ts": "process.env.QUEUED_VAR;\n" });
    try {
      const r = await action(repo, { INPUT_TOKEN: "" }, { merge_group: { base_sha: repo.base, head_sha: "x" } });
      expect(r.stdout).toMatch(/QUEUED_VAR/);
      expect(r.stdout).not.toMatch(/OLD_VAR/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("warns when pull_request_target checked out the base instead of the PR", async () => {
    const repo = makeRepo({}, { "src/a.ts": "process.env.A_VAR;\n" });
    try {
      repo.git("checkout", "-q", "--detach", repo.base);
      const r = await action(repo, { INPUT_TOKEN: "", GITHUB_EVENT_NAME: "pull_request_target" });
      expect(r.stdout).toMatch(/::warning::envsure: the PR base is checked out/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("works on a PR that adds the config file for the first time", async () => {
    const repo = makeRepo({}, { ".github/envsure.yml": "environments: [production]\n", "src/a.ts": "process.env.A_VAR;\n" });
    try {
      const r = await action(repo, { INPUT_TOKEN: "" });
      // Base has no config: defaults apply (GitHub at repository level), which needs a token.
      expect(r.stdout).toMatch(/::error::envsure: need --repo and \$GITHUB_TOKEN/);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

// Big enough that a one-line edit stays above git's 50% rename-similarity threshold.
const MOVED = ["process.env.MOVED_OLD;", "export const x = 1;", ...Array.from({ length: 10 }, (_, i) => `export const c${i} = ${i};`)]
  .join("\n") + "\n";

describe("unusual files in a diff", () => {
  it("skips files over 5 MB, binaries and deleted files without failing", async () => {
    const repo = makeRepo(
      { "src/gone.ts": "process.env.DELETED_VAR;\n", "src/moved.ts": MOVED },
      {
        "dist/huge.js": "process.env.HUGE_VAR;\n" + "x".repeat(6 * 1024 * 1024),
        "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]),
        "src/ok.ts": "process.env.OK_VAR;\n",
      },
    );
    try {
      repo.git("rm", "-q", "src/gone.ts");
      repo.git("mv", "src/moved.ts", "src/renamed.ts");
      writeFileSync(join(repo.dir, "src/renamed.ts"), MOVED.replace("export const x = 1;", "export const x = process.env.MOVED_NEW;"));
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "more");
      const r = await cli(repo, ["--offline", "--base", repo.base, "--format", "json"]);
      expect(r.stderr).toBe("");
      expect(refNames(r.stdout)).toEqual(["src/ok.ts:1:OK_VAR", "src/renamed.ts:2:MOVED_NEW"]);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("keeps line numbers right with CRLF line endings and a byte order mark", async () => {
    const repo = makeRepo({}, { "src/win.ts": "﻿// a\r\n// b\r\nprocess.env.CRLF_VAR;\r\n" });
    try {
      const r = await cli(repo, offline(repo.base));
      expect(refNames(r.stdout)).toEqual(["src/win.ts:3:CRLF_VAR"]);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("handles a repository whose PR branch has only deletions", async () => {
    const repo = makeRepo({ "src/a.ts": "process.env.A_VAR;\n" });
    try {
      repo.git("rm", "-q", "src/a.ts");
      repo.git("commit", "-q", "-m", "delete");
      const r = await cli(repo, ["--offline", "--base", repo.base]);
      expect(r.status).toBe(0);
    } finally {
      repo.cleanup();
    }
  }, 60_000);
});

describe("git's quoting of unusual paths", () => {
  it.each([
    ['"a\\"b.ts"', 'a"b.ts'],
    ['"tab\\there.ts"', "tab\there.ts"],
    ['"back\\\\slash.ts"', "back\\slash.ts"],
    ['"\\303\\274ni.ts"', "üni.ts"],
    ["plain.ts", "plain.ts"],
  ])("%s", (quoted, plain) => {
    expect(unquoteGitPath(quoted)).toBe(plain);
  });
});

describe("empty and unusual repositories", () => {
  it("explains a repository with no commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "envsure-empty-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "process.env.UNCOMMITTED;\n");
      const full = await cli(dir, ["--offline"]);
      expect(full.status).toBe(0); // nothing tracked yet
      const diff = await cli(dir, ["--offline", "--base", "main"]);
      expect(diff.status).toBe(2);
      expect(diff.stderr).toMatch(/base commit main is not available/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
