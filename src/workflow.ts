import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

export interface JobScope {
  job: string;
  startLine: number;
  endLine: number;
  /** Literal environment name, null when the job has none, undefined when it is an expression. */
  environment: string | null | undefined;
}

/** Line ranges of each job in a workflow file and the GitHub Environment it deploys to. */
export function jobScopes(text: string): JobScope[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const jobs = doc.get("jobs", true);
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
