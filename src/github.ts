/**
 * Reads secret and variable NAMES from GitHub. Secret endpoints never return values;
 * variable endpoints do, so values are dropped immediately and never stored.
 */
export interface Inventory {
  /** Names available to every job: repo + org-visible secrets/variables. */
  shared: Set<string>;
  /** The organization-level subset of `shared` (also used by other repos, so never reported as unused). */
  org?: Set<string>;
  /** Per-environment names (environment secrets + environment variables). */
  environments: Map<string, Set<string>>;
}

type Fetch = typeof fetch;

export class GitHubClient {
  constructor(
    private token: string,
    private apiUrl = "https://api.github.com",
    private fetchImpl: Fetch = fetch,
  ) {}

  private async get(path: string): Promise<any> {
    const timeout = Number(process.env.ENVSURE_HTTP_TIMEOUT_MS) > 0 ? Number(process.env.ENVSURE_HTTP_TIMEOUT_MS) : 30_000;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.apiUrl}${path}`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        if (attempt < 2) continue; // timeouts and dropped keep-alive sockets
        const e = err as Error & { cause?: { code?: string } };
        throw new Error(`GitHub API request for ${path} ${e.name === "TimeoutError" ? `timed out after ${timeout / 1000}s` : `failed (${e.cause?.code ?? e.message})`}`);
      }
      const limited = res.headers.get("x-ratelimit-remaining") === "0" && (res.status === 403 || res.status === 429);
      if (limited) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const when = reset ? ` until ${new Date(reset * 1000).toISOString()}` : "";
        throw new Error(`GitHub API rate limit exceeded for this token${when} (${path})`);
      }
      if ((res.status >= 500 || res.status === 429) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}${githubHint(res.status, path)}`);
      return res.json();
    }
  }

  /** Collect `name` fields from a paginated list endpoint (at most 1000 pages). */
  private async names(path: string, key: string, perPage: number): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 1000; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await this.get(`${path}${sep}per_page=${perPage}&page=${page}`);
      const items: { name: string }[] = body[key] ?? [];
      // A server that ignores `page` would otherwise return the same names forever.
      if (page > 1 && items.length && out.includes(items[0].name)) return out;
      out.push(...items.map((i) => i.name));
      if (items.length < perPage || out.length >= (body.total_count ?? Infinity)) return out;
    }
    return out;
  }

  async listEnvironments(owner: string, repo: string): Promise<string[]> {
    return this.names(`/repos/${owner}/${repo}/environments`, "environments", 100);
  }

  async inventory(owner: string, repo: string, environments: string[]): Promise<Inventory> {
    const base = `/repos/${owner}/${repo}`;
    const [repoSecrets, orgSecrets, repoVars, orgVars] = await Promise.all([
      this.names(`${base}/actions/secrets`, "secrets", 100),
      this.names(`${base}/actions/organization-secrets`, "secrets", 100).catch(() => []),
      this.names(`${base}/actions/variables`, "variables", 30),
      this.names(`${base}/actions/organization-variables`, "variables", 30).catch(() => []),
    ]);
    const envs = new Map<string, Set<string>>();
    for (const env of environments) {
      const e = `${base}/environments/${encodeURIComponent(env)}`;
      const [secrets, vars] = await Promise.all([
        this.names(`${e}/secrets`, "secrets", 100).catch(notFoundAsEmpty),
        this.names(`${e}/variables`, "variables", 30).catch(notFoundAsEmpty),
      ]);
      envs.set(env, new Set([...secrets, ...vars]));
    }
    return {
      shared: new Set([...repoSecrets, ...orgSecrets, ...repoVars, ...orgVars]),
      org: new Set([...orgSecrets, ...orgVars]),
      environments: envs,
    };
  }
}

/** Which permission a failed call needs, so a 403 says what to grant. */
export function githubHint(status: number, path: string): string {
  const permission = /\/secrets(\?|$)/.test(path) ? "Secrets: read"
    : /\/variables(\?|$)/.test(path) ? "Variables: read"
    : /\/environments(\?|$)/.test(path) ? "Environments: read"
    : "Metadata: read";
  if (status === 401) return " — the token is invalid or expired";
  if (status === 403) {
    return ` — the token lacks ${permission} on this repository (GitHub App / fine-grained PAT), or \`repo\` scope (classic PAT); GITHUB_TOKEN cannot list secrets`;
  }
  if (status === 404 && !/\/environments\/[^/]+\//.test(path)) return " — repository not found, or the token cannot access it";
  return "";
}

function notFoundAsEmpty(err: Error): string[] {
  if (/GitHub API 404/.test(err.message)) return [];
  throw err;
}
