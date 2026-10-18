import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_SCOPE } from "./check.js";
import { type Config, DEFAULT_IGNORE, matchesAny } from "./config.js";
import type { Inventory } from "./github.js";

/** Read by runtimes, SDKs and frameworks without appearing in application code. */
export const IMPLICIT = [
  "NEXTAUTH_SECRET", "NEXTAUTH_URL", "AUTH_SECRET", "AUTH_URL", "AUTH_TRUST_HOST",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET",
  "DATABASE_URL", "REDIS_URL", "NODE_OPTIONS", "NPM_TOKEN", "NODE_AUTH_TOKEN", "JAVA_OPTS", "PYTHONPATH",
  "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "TURBO_TOKEN", "TURBO_TEAM",
  "RAILS_MASTER_KEY", "SECRET_KEY_BASE", "WEB_CONCURRENCY",
];

/** Every ENV_STYLE word in the repository's text files: a name found anywhere counts as used. */
export function repoWords(cwd: string, files: string[]): Set<string> {
  const words = new Set<string>();
  for (const f of files) {
    const p = join(cwd, f);
    try {
      if (statSync(p).size > 2 * 1024 * 1024) continue;
      const text = readFileSync(p, "utf8");
      if (text.includes("\0")) continue; // binary
      for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) words.add(m[0]);
    } catch {
      // unreadable: ignore
    }
  }
  return words;
}

/**
 * Names configured for an environment (or at repository level) that appear nowhere in the repo.
 * Org-level GitHub values, platform names, implicit SDK/framework names and ignore patterns are skipped.
 */
export function findUnused(
  config: Config,
  inv: Inventory,
  runtime: Map<string, Set<string>>,
  used: Set<string>,
): Record<string, string[]> {
  const skip = [...DEFAULT_IGNORE, ...config.ignore, ...config.unusedIgnore, ...IMPLICIT, "GITHUB_TOKEN"];
  const unusedOf = (names: Iterable<string>) =>
    [...names].filter((n) => !used.has(n) && !inv.org?.has(n) && !matchesAny(n, skip)).sort();
  const out: Record<string, string[]> = {};
  const repoLevel = unusedOf(inv.shared);
  if (repoLevel.length) out[REPO_SCOPE] = repoLevel;
  const envs = new Set([...config.environments, ...runtime.keys()]);
  for (const env of envs) {
    // Repository-level names are reported once, above.
    const names = runtime.get(env) ?? inv.environments.get(env) ?? new Set<string>();
    const list = unusedOf([...names].filter((n) => !inv.shared.has(n)));
    if (list.length) out[env] = list;
  }
  return out;
}
