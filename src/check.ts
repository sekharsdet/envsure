import { Config, DEFAULT_IGNORE, matchesAny } from "./config.js";
import type { Inventory } from "./github.js";
import type { EnvRef } from "./scan.js";

export interface Finding {
  name: string;
  refs: EnvRef[];
  /** Environments where the name is missing. "(repository)" = missing everywhere when no environments are configured. */
  missingIn: string[];
  presentIn: string[];
}

export const REPO_SCOPE = "(repository)";

/**
 * @param runtime names available at runtime per environment, from that environment's configured sources.
 *   Code references in an environment listed here are checked against it instead of GitHub.
 *   Workflow `secrets.X`/`vars.X` references are always checked against GitHub.
 */
export function check(refs: EnvRef[], inv: Inventory, config: Config, runtime = new Map<string, Set<string>>()): Finding[] {
  const ignore = [...DEFAULT_IGNORE, ...config.ignore];
  const byName = new Map<string, EnvRef[]>();
  for (const r of refs) {
    if (r.kind === "workflow-secret" && r.name === "GITHUB_TOKEN") continue;
    if (matchesAny(r.name, ignore)) continue;
    byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  }

  const defaultScopes = config.environments.length ? config.environments : [REPO_SCOPE];
  const scopesOf = requiredScopes(defaultScopes);
  const findings: Finding[] = [];
  for (const [name, nameRefs] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const github = (scope: string) => inv.shared.has(name) || (inv.environments.get(scope)?.has(name) ?? false);
    // REPO_SCOPE resolves from repository/organization values only.
    const has = (r: EnvRef, scope: string) =>
      !isWorkflowRef(r) && runtime.has(scope) ? runtime.get(scope)!.has(name) : github(scope);

    const missing = new Set<string>();
    const present = new Set<string>();
    const missingRefs: EnvRef[] = [];
    for (const r of nameRefs) {
      let refMissing = false;
      for (const s of scopesOf(r)) {
        if (has(r, s)) present.add(s);
        else {
          missing.add(s);
          refMissing = true;
        }
      }
      if (refMissing) missingRefs.push(r);
    }
    if (missing.size === 0) continue;
    const presentIn = [...present].filter((s) => s !== REPO_SCOPE && !missing.has(s));
    const elsewhere = new Set([...inv.environments.keys(), ...runtime.keys()]);
    for (const env of elsewhere) {
      if (missing.has(env) || presentIn.includes(env)) continue;
      if (runtime.get(env)?.has(name) || inv.environments.get(env)?.has(name)) presentIn.push(env);
    }
    findings.push({ name, refs: missingRefs, missingIn: [...missing], presentIn });
  }
  return findings;
}

const isWorkflowRef = (r: EnvRef) => r.kind === "workflow-secret" || r.kind === "workflow-var";

/** Where a reference must resolve: the workflow job's own environment when known, else every configured one. */
const requiredScopes = (defaults: string[]) => (r: EnvRef): string[] => {
  if (r.environment === null) return [REPO_SCOPE];
  if (typeof r.environment === "string") return [r.environment];
  return defaults;
};
