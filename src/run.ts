import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, type Finding } from "./check.js";
import { parseConfig, type Config, type SourceSpec } from "./config.js";
import { lintDotenv, type DotenvIssue } from "./dotenv.js";
import { GitHubClient, type Inventory } from "./github.js";
import { addedLines, scanText, type EnvRef } from "./scan.js";
import { SOURCES } from "./sources/index.js";
import type { SourceContext } from "./sources/types.js";

export interface RunOptions {
  cwd: string;
  /** Only check references on lines added since this git ref. Full scan when undefined. */
  base?: string;
  repo?: { owner: string; repo: string };
  token?: string;
  apiUrl?: string;
  configPath?: string;
  /** Read the config from this git ref instead of the working tree (the Action uses the PR base). */
  configRef?: string;
  /** Only scan; do not contact GitHub or any source. */
  offline?: boolean;
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
}

// quotepath=off: otherwise git prints non-ASCII paths as quoted octal escapes and those files are skipped.
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });

/** A committed env file with real values (not an example/template). */
export function isCommittedEnvFile(file: string): boolean {
  const base = file.split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base);
}

export function loadConfig(cwd: string, configPath?: string, ref?: string): Config {
  const rel = (configPath ?? ".github/envsure.yml").replace(/\\/g, "/").replace(/^\.\//, "");
  if (ref) {
    let text: string | undefined;
    try {
      text = git(cwd, ["show", `${ref}:${rel}`]);
    } catch {
      if (configPath) throw new Error(`config not found at ${ref}: ${rel}`);
    }
    return parseConfig(text);
  }
  const p = join(cwd, rel);
  if (configPath && !existsSync(p)) throw new Error(`config not found: ${p}`);
  return parseConfig(existsSync(p) ? readFileSync(p, "utf8") : undefined);
}

export function collectRefs(cwd: string, config: Config, base?: string): { refs: EnvRef[]; files: string[] } {
  const excluded = (f: string) => config.excludePaths.some((p) => f.startsWith(p));
  const refs: EnvRef[] = [];
  let files: string[];
  if (base) {
    const added = addedLines(git(cwd, ["diff", "-U0", "--no-color", `${base}...HEAD`]));
    files = [...added.keys()].filter((f) => !excluded(f) && existsSync(join(cwd, f)));
    for (const f of files) refs.push(...scanText(f, readFileSync(join(cwd, f), "utf8"), added.get(f)));
  } else {
    files = git(cwd, ["ls-files"]).split("\n").filter((f) => f && !excluded(f) && existsSync(join(cwd, f)));
    for (const f of files) refs.push(...scanText(f, readFileSync(join(cwd, f), "utf8")));
  }
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

export async function run(opts: RunOptions): Promise<RunResult> {
  const config = loadConfig(opts.cwd, opts.configPath, opts.configRef);
  const { refs, files } = collectRefs(opts.cwd, config, opts.base);
  const dotenvIssues = files
    .filter(isCommittedEnvFile)
    .flatMap((f) => lintDotenv(f, readFileSync(join(opts.cwd, f), "utf8")));
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
          "workflow refs and for environments without sources. Or pass --offline.",
      );
    }
    const gh = new GitHubClient(opts.token, opts.apiUrl, opts.fetchImpl);
    inv = await gh.inventory(opts.repo.owner, opts.repo.repo, environmentsToFetch(config, refs));
  }

  const runtime = await fetchRuntime(config, inv, {
    env: opts.env ?? process.env,
    cwd: opts.cwd,
    fetch: opts.fetchImpl ?? fetch,
    exec: (cmd, args, o) => spawnSync(cmd, args ?? [], { ...o, encoding: "utf8" }) as ReturnType<SourceContext["exec"]>,
    warn: opts.warn ?? ((m) => console.error(`envsure: warning: ${m}`)),
  });
  return { config, refs, findings: check(refs, inv, config, runtime), dotenvIssues, sourcesChecked };
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
          for (const n of found) names.add(n);
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
