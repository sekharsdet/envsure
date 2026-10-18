import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, type Finding } from "./check.js";
import { parseConfig, type Config, type SourceSpec } from "./config.js";
import { lintDotenv, type DotenvIssue } from "./dotenv.js";
import { GitHubClient, type Inventory } from "./github.js";
import { addedLines, scanText, type EnvRef } from "./scan.js";
import { valueNotName } from "./secrets.js";
import { SOURCES } from "./sources/index.js";
import type { SourceContext } from "./sources/types.js";
import { findUnused, repoWords } from "./unused.js";

export interface RunOptions {
  cwd: string;
  /** Only check references on lines added since this git ref. Full scan when undefined. */
  base?: string;
  repo?: { owner: string; repo: string };
  token?: string;
  apiUrl?: string;
  configPath?: string;
  /**
   * Trusted ref (the PR base): the config is read from it, and `command`/`file` sources run against
   * a checkout of it, so a pull request cannot change its own check or the code those sources run.
   */
  configRef?: string;
  /** Only scan; do not contact GitHub or any source. */
  offline?: boolean;
  /** Also report names configured somewhere but not found anywhere in the repository. */
  unused?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
}

export interface RunResult {
  config: Config;
  refs: EnvRef[];
  findings: Finding[];
  dotenvIssues: DotenvIssue[];
  /** Labels of the sources checked per environment (environments using GitHub are omitted). */
  sourcesChecked: Record<string, string[]>;
  /** Possibly unused names per environment ("(repository)" = repo-level GitHub values), when requested. */
  unused?: Record<string, string[]>;
}

/**
 * Git with output that does not depend on the user's git config: no quoted non-ASCII paths,
 * standard a/ b/ prefixes, no colors, external diff drivers or textconv.
 */
const GIT_CONFIG = ["-c", "core.quotepath=off", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false", "-c", "color.ui=never"];
const git = (cwd: string, args: string[]) =>
  execFileSync("git", [...GIT_CONFIG, ...args], {
    cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
const gitOk = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args).trim();
  } catch {
    return undefined;
  }
};

/** Files bigger than this are not scanned (generated bundles, data dumps). */
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

/** Refuse refs git could read as options (`--output=...`) or that are not plain ref syntax. */
export function assertRef(ref: string): string {
  // `HEAD~1`, `origin/main^` are fine; a leading `-` would be read as an option, `:` as `ref:path`.
  if (!ref || ref.startsWith("-") || /[\s\0-\x1f\x7f:]/.test(ref)) {
    throw new Error(`invalid git ref: ${JSON.stringify(ref.slice(0, 80))}`);
  }
  return ref;
}

/** A committed env file with real values (not an example/template). */
export function isCommittedEnvFile(file: string): boolean {
  const base = file.split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base);
}

/** The repository root, so running from a subdirectory scans the same files with the same paths. */
export function repoRoot(cwd: string): string {
  const top = gitOk(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`not inside a git repository: ${cwd}`);
  return top;
}

/** A regular file inside the repo (not a symlink, directory or submodule) small enough to scan. */
function scannable(root: string, f: string): boolean {
  try {
    const st = lstatSync(join(root, f));
    return st.isFile() && st.size <= MAX_SCAN_BYTES;
  } catch {
    return false;
  }
}

export function loadConfig(cwd: string, configPath?: string, ref?: string): Config {
  const rel = (configPath ?? ".github/envsure.yml").replace(/\\/g, "/").replace(/^\.\//, "");
  if (ref) {
    let text: string | undefined;
    try {
      text = git(cwd, ["show", `${assertRef(ref)}:${rel}`]);
    } catch {
      if (configPath) throw new Error(`config not found at ${ref}: ${rel}`);
    }
    return parseConfig(text);
  }
  const p = join(cwd, rel);
  if (configPath && !existsSync(p)) throw new Error(`config not found: ${p}`);
  return parseConfig(existsSync(p) ? readFileSync(p, "utf8") : undefined);
}

/**
 * The diff of HEAD against `base`. Uses the merge base (`base...HEAD`) when history allows; in a
 * shallow clone it fetches the base commit and compares trees directly, which is exact for the
 * merge commit a pull_request workflow checks out.
 */
function diffAgainst(root: string, base: string, warn: (m: string) => void): string {
  assertRef(base);
  const flags = ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
  const hasBase = () => gitOk(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (!hasBase() && /^[0-9a-f]{7,40}$/i.test(base)) gitOk(root, ["fetch", "--no-tags", "--quiet", "--depth=1", "origin", base]);
  if (!hasBase()) {
    throw new Error(`base commit ${base} is not available; check out with full history (actions/checkout: fetch-depth: 0)`);
  }
  if (gitOk(root, ["merge-base", base, "HEAD"])) return git(root, [...flags, `${base}...HEAD`]);
  if (gitOk(root, ["rev-parse", "HEAD^1"]) !== gitOk(root, ["rev-parse", `${base}^{commit}`])) {
    warn(`no shared history with ${base} (shallow clone?); comparing trees directly. Use fetch-depth: 0 for exact results`);
  }
  return git(root, [...flags, base, "HEAD"]);
}

export function collectRefs(cwd: string, config: Config, base?: string, warn: (m: string) => void = () => {}):
  { refs: EnvRef[]; files: string[] } {
  const root = repoRoot(cwd);
  const excluded = (f: string) => config.excludePaths.some((p) => f.startsWith(p));
  const refs: EnvRef[] = [];
  let files: string[];
  let added: Map<string, Set<number>> | undefined;
  if (base) {
    added = addedLines(diffAgainst(root, base, warn));
    files = [...added.keys()];
  } else {
    files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  }
  files = files.filter((f) => !excluded(f) && scannable(root, f));
  for (const f of files) refs.push(...scanText(f, readFileSync(join(root, f), "utf8"), added?.get(f)));
  return { refs, files };
}

/** GitHub environment a `github` source reads (its `environment` option, else the EnvSure environment). */
const githubEnvOf = (env: string, s: SourceSpec) => (typeof s.options.environment === "string" ? s.options.environment : env);

/** Configured environments plus every literal workflow job `environment:`, which must be checked even if unlisted. */
export function environmentsToFetch(config: Config, refs: EnvRef[]): string[] {
  const jobEnvs = refs.flatMap((r) => (typeof r.environment === "string" ? [r.environment] : []));
  const githubSourceEnvs = Object.entries(config.sources).flatMap(([env, list]) =>
    list.filter((s) => s.type === "github").map((s) => githubEnvOf(env, s)));
  return [...new Set([...config.environments, ...jobEnvs, ...githubSourceEnvs])];
}

/** GitHub is needed unless every environment has non-GitHub sources and there are no workflow refs. */
export function needsGitHub(config: Config, refs: EnvRef[]): boolean {
  if (refs.some((r) => r.kind === "workflow-secret" || r.kind === "workflow-var")) return true;
  if (config.environments.length === 0) return true;
  return config.environments.some((env) => !config.sources[env] || config.sources[env].some((s) => s.type === "github"));
}

/** A detached checkout of `ref`, for sources that execute or read repository content. */
function snapshot(root: string, ref: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "envsure-base-"));
  git(root, ["worktree", "add", "--detach", "--quiet", dir, `${assertRef(ref)}^{commit}`]);
  return {
    dir,
    remove: () => {
      gitOk(root, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
      gitOk(root, ["worktree", "prune"]);
    },
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const warn = opts.warn ?? ((m) => console.error(`envsure: warning: ${m}`));
  const root = repoRoot(opts.cwd);
  const config = loadConfig(root, opts.configPath, opts.configRef);
  const { refs, files } = collectRefs(root, config, opts.base, warn);
  const dotenvIssues = files
    .filter(isCommittedEnvFile)
    .flatMap((f) => lintDotenv(f, readFileSync(join(root, f), "utf8")));
  const sourcesChecked: Record<string, string[]> = {};
  for (const [env, list] of Object.entries(config.sources)) {
    sourcesChecked[env] = list.map((s) => (s.type === "github" ? `github ${githubEnvOf(env, s)}` : SOURCES[s.type].label(s.options)));
  }
  if (opts.offline) return { config, refs, findings: [], dotenvIssues, sourcesChecked };

  let inv: Inventory = { shared: new Set(), environments: new Map() };
  if (needsGitHub(config, refs)) {
    if (!opts.repo || !opts.token) {
      throw new Error(
        "need --repo and $GITHUB_TOKEN (Action: the `token` input) that can read secret names: GitHub is checked for " +
          "workflow refs and for environments without sources. Or pass --offline. " +
          "(Pull requests from forks receive no secrets.)",
      );
    }
    const gh = new GitHubClient(opts.token, opts.apiUrl, opts.fetchImpl);
    inv = await gh.inventory(opts.repo.owner, opts.repo.repo, environmentsToFetch(config, refs));
  }

  const untrustedTree = Object.values(config.sources).flat().some((s) => s.type === "command" || s.type === "file");
  const base = opts.configRef && untrustedTree ? snapshot(root, opts.configRef) : undefined;
  let runtime: Map<string, Set<string>>;
  try {
    runtime = await fetchRuntime(config, inv, {
      env: opts.env ?? process.env,
      cwd: base?.dir ?? root,
      repoCwd: root,
      fetch: opts.fetchImpl ?? fetch,
      exec: (cmd, args, o) => spawnSync(cmd, args ?? [], { ...o, encoding: "utf8" }) as ReturnType<SourceContext["exec"]>,
      warn,
    });
  } finally {
    base?.remove();
  }
  const result: RunResult = { config, refs, findings: check(refs, inv, config, runtime), dotenvIssues, sourcesChecked };
  if (opts.unused) {
    // Usage is judged against the whole repository, not just the PR diff.
    const excluded = (f: string) => config.excludePaths.some((p) => f.startsWith(p));
    const all = git(root, ["ls-files", "-z"]).split("\0").filter((f) => f && !excluded(f) && scannable(root, f));
    result.unused = findUnused(config, inv, runtime, repoWords(root, all));
  }
  return result;
}

/** Union of names from each environment's sources, all fetched in parallel. Any failing source fails the run. */
export async function fetchRuntime(config: Config, inv: Inventory, ctx: SourceContext): Promise<Map<string, Set<string>>> {
  const runtime = new Map<string, Set<string>>();
  const jobs: Promise<void>[] = [];
  for (const [env, list] of Object.entries(config.sources)) {
    const names = new Set<string>();
    runtime.set(env, names);
    for (const s of list) {
      if (s.type === "github") {
        for (const n of inv.shared) names.add(n);
        for (const n of inv.environments.get(githubEnvOf(env, s)) ?? []) names.add(n);
        continue;
      }
      const def = SOURCES[s.type];
      jobs.push(def.fetchNames(s.options, ctx).then(
        (found) => {
          // A misconfigured source can return values instead of names; never let those reach output.
          let dropped = 0;
          for (const n of found) {
            if (valueNotName(n)) dropped++;
            else names.add(n);
          }
          if (dropped) ctx.warn(`${def.label(s.options)}: ignored ${dropped} entries that look like secret values, not variable names`);
        },
        (err: Error) => {
          throw new Error(err.message.startsWith(s.type) ? `${err.message} [${env}]` : `${def.label(s.options)} [${env}]: ${err.message}`);
        },
      ));
    }
  }
  const results = await Promise.allSettled(jobs);
  const errors = results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
  if (errors.length) throw new Error(errors.join("\n"));
  return runtime;
}

export function parseRepo(s: string | undefined): { owner: string; repo: string } | undefined {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s ?? "");
  return m ? { owner: m[1], repo: m[2] } : undefined;
}
