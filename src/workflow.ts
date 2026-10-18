import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

export interface JobScope {
  job: string;
  startLine: number;
  endLine: number;
  /** Literal environment name, null when the job has none, undefined when it is an expression. */
  environment: string | null | undefined;
}

/**
 * Workflow files come from pull requests. Larger ones are not parsed as YAML (refs are still found
 * line by line; only job-environment scoping and reusable-workflow detection are skipped).
 */
const MAX_YAML_BYTES = 512 * 1024;

function parse(text: string, lineCounter?: LineCounter) {
  if (text.length > MAX_YAML_BYTES) return undefined;
  try {
    // Aliases are never expanded: only toJS() does that, and it is not used.
    return parseDocument(text, { lineCounter });
  } catch {
    return undefined; // e.g. stack overflow on absurd nesting
  }
}

/** Line ranges of each job in a workflow file and the GitHub Environment it deploys to. */
export function jobScopes(text: string): JobScope[] {
  const lc = new LineCounter();
  const doc = parse(text, lc);
  const jobs = doc?.get("jobs", true);
  if (!isMap(jobs)) return [];
  const line = (offset: number) => lc.linePos(offset).line;
  const scopes: JobScope[] = [];
  for (const pair of jobs.items) {
    if (!isScalar(pair.key) || !pair.key.range || !isMap(pair.value) || !pair.value.range) continue;
    const env = pair.value.get("environment", true);
    let environment: string | null | undefined = null;
    const name = isMap(env) ? env.get("name", true) : env;
    if (name !== undefined) {
      const v = isScalar(name) ? String(name.value) : undefined;
      environment = v && !v.includes("${{") ? v : undefined;
    }
    scopes.push({
      job: String(pair.key.value),
      startLine: line(pair.key.range[0]),
      endLine: line(Math.max(pair.value.range[1] - 1, pair.value.range[0])),
      environment,
    });
  }
  return scopes;
}

/** Secrets a reusable workflow declares under `on.workflow_call.secrets`; its caller supplies them. */
export function workflowCallSecrets(text: string): Set<string> {
  if (!text.includes("workflow_call")) return new Set();
  const on = parse(text)?.get("on", true);
  const call = isMap(on) ? on.get("workflow_call", true) : undefined;
  const secrets = isMap(call) ? call.get("secrets", true) : undefined;
  if (!isMap(secrets)) return new Set();
  return new Set(secrets.items.flatMap((p) => (isScalar(p.key) ? [String(p.key.value)] : [])));
}
