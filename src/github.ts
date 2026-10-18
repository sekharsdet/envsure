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
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}${githubHint(res.status, path)}`);
    return res.json();
  }

  /** Collect `name` fields from a paginated list endpoint. */
  private async names(path: string, key: string, perPage: number): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await this.get(`${path}${sep}per_page=${perPage}&page=${page}`);
      const items: { name: string }[] = body[key] ?? [];
      out.push(...items.map((i) => i.name));
      if (items.length < perPage || out.length >= (body.total_count ?? Infinity)) return out;
    }
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
