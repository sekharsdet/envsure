// Builds throwaway git repos (base commit + PR commit) and runs the shipped dist/ entry points.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
export const ACTION = fileURLToPath(new URL("../../dist/action.js", import.meta.url));

export type Files = Record<string, string | Buffer>;

export interface Repo {
  dir: string;
  base: string;
  git(...args: string[]): string;
  write(files: Files): void;
  cleanup(): void;
}

/** A repo whose `main` has `base` files and whose checked-out `pr` branch adds `pr` files on top. */
export function makeRepo(base: Files, pr: Files = {}, opts: { gitConfig?: string[] } = {}): Repo {
  const dir = mkdtempSync(join(tmpdir(), "envsure-scn-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (files: Files) => {
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), content);
    }
  };
  git("init", "-q", "-b", "main");
  for (const c of opts.gitConfig ?? []) git("config", ...c.split("="));
  write(base);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const baseSha = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "pr");
  write(pr);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "pr");
  return { dir, base: baseSha, git, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export function node(script: string, args: string[], cwd: string, env: Record<string, string | undefined> = {}, timeout = 60_000) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, GITHUB_TOKEN: "", ENVSURE_TOKEN: "", GITHUB_REPOSITORY: "", ...env })) {
    if (v !== undefined) merged[k] = v;
  }
  const start = Date.now();
  return new Promise<Run>((done) => {
    execFile(process.execPath, [script, ...args], { cwd, env: merged, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ status: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr, ms: Date.now() - start }));
  });
}

export const cli = (repo: Repo | string, args: string[], env: Record<string, string | undefined> = {}) =>
  node(CLI, args, typeof repo === "string" ? repo : repo.dir, env);

/** Runs dist/action.js like the runner does for a pull_request event. */
export async function action(repo: Repo, env: Record<string, string | undefined> = {}, event?: unknown) {
  const tmp = mkdtempSync(join(tmpdir(), "envsure-act-"));
  const files = { event: join(tmp, "event.json"), summary: join(tmp, "summary.md"), output: join(tmp, "output.txt") };
  writeFileSync(files.event, JSON.stringify(event ?? { pull_request: { number: 1, base: { sha: repo.base } } }));
  writeFileSync(files.summary, "");
  writeFileSync(files.output, "");
  const r = await node(ACTION, [], repo.dir, {
    GITHUB_REPOSITORY: "o/r", GITHUB_WORKSPACE: repo.dir, GITHUB_EVENT_PATH: files.event,
    GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, ...env,
  });
  const out = { ...r, summary: readFileSync(files.summary, "utf8"), outputs: readFileSync(files.output, "utf8") };
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

/**
 * Fake credentials for tests, assembled at runtime so the source never contains a key-shaped literal
 * (GitHub push protection and secret scanners would rightly flag one). None of these are real.
 */
export const FAKE = {
  awsKeyId: ["AK", "IA", "IOSFODNN7EXAMPLE"].join(""),
  githubToken: ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
  stripeLive: ["sk", "_li", "ve_", "51HabcdefghijklmnopqrstuVWXYZ"].join(""),
  awsSecret: ["wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY"].join(""),
};
