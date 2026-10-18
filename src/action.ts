import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { COMMENT_MARKER, renderMarkdown, renderUnusedMarkdown, scopeLabel } from "./report.js";
import { parseRepo, run } from "./run.js";

const input = (name: string) => process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`]?.trim() || undefined;

/**
 * Workflow commands are parsed from stdout, and file names come from the pull request, so every
 * value is escaped as GitHub specifies (otherwise `,` `:` `%` or a newline in a path could inject
 * properties or whole commands).
 */
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const command = (name: string, props: Record<string, string | number>, message: string) =>
  console.log(`::${name} ${Object.entries(props).map(([k, v]) => `${k}=${escapeProperty(String(v))}`).join(",")}::${escapeData(message)}`);
const warning = (message: string) => console.log(`::warning::${escapeData(message)}`);

/** GitHub rejects comments over 65,536 characters; keep whole lines and say what was cut. */
function fit(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const lines = body.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > limit - 200) break;
    kept.push(l);
    size += l.length + 1;
  }
  return `${kept.join("\n")}\n\n… ${lines.length - kept.length} more lines not shown; see the job summary or run the CLI.`;
}

interface Comment {
  id: number;
  body?: string;
}

async function upsertComment(token: string, apiUrl: string, repo: string, pr: number, body: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const signal = () => AbortSignal.timeout(30_000);
  // Every page: on a busy PR the earlier EnvSure comment can be past the first 100.
  const marked: Comment[] = [];
  for (let page = 1; page <= 50; page++) {
    const list = await fetch(`${apiUrl}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, { headers, signal: signal() });
    if (!list.ok) throw new Error(`listing comments failed: ${list.status}`);
    const items = (await list.json()) as Comment[];
    marked.push(...items.filter((c) => c.body?.startsWith(COMMENT_MARKER) || c.body?.includes(COMMENT_MARKER)));
    if (items.length < 100) break;
  }
  // Newest first. Anyone can post a comment containing the marker; editing one written by someone
  // else fails, so fall through to the next and finally post a new comment.
  for (const c of marked.reverse()) {
    const res = await fetch(`${apiUrl}/repos/${repo}/issues/comments/${c.id}`,
      { method: "PATCH", headers, body: JSON.stringify({ body }), signal: signal() });
    if (res.ok) return;
  }
  const res = await fetch(`${apiUrl}/repos/${repo}/issues/${pr}/comments`,
    { method: "POST", headers, body: JSON.stringify({ body }), signal: signal() });
  if (!res.ok) throw new Error(`writing comment failed: ${res.status}`);
}

async function main() {
  // Only needed when GitHub itself is checked; run() says so if it is missing.
  const token = input("token");
  const repoName = process.env.GITHUB_REPOSITORY!;
  const apiUrl = process.env.ENVSURE_GITHUB_API_URL || process.env.GITHUB_API_URL || "https://api.github.com";
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pr = event.pull_request as { number: number; base: { sha: string } } | undefined;
  // Merge queues check the merged result against the target branch.
  const base: string | undefined = pr?.base.sha ?? event.merge_group?.base_sha;
  const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();

  if (pr && process.env.GITHUB_EVENT_NAME === "pull_request_target") {
    let head = "";
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch {
      // not a git checkout; run() reports that
    }
    if (head === pr.base.sha) {
      warning("envsure: the PR base is checked out, so the PR's changes are not checked. With pull_request_target, " +
        "check out ${{ github.event.pull_request.head.sha }} (EnvSure still reads its config from the base).");
    }
  }

  const result = await run({
    cwd,
    base,
    configPath: input("config"),
    // The config, and any command/file source, come from the base commit, so a PR cannot loosen
    // the check or change code that runs with the platform tokens.
    configRef: base,
    repo: parseRepo(repoName),
    token,
    apiUrl,
    warn: (m) => warning(`envsure: ${m}`),
    unused: input("report-unused") === "true" || input("fail-on-unused") === "true",
  });

  const unused = result.unused ?? {};
  const unusedCount = Object.values(unused).reduce((n, l) => n + l.length, 0);
  const body = renderMarkdown(result.findings, result.dotenvIssues, result.sourcesChecked) + renderUnusedMarkdown(unused);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, fit(body, 1_000_000) + "\n");

  const problems = result.findings.length + result.dotenvIssues.length + (input("fail-on-unused") === "true" ? unusedCount : 0);
  const commentToken = input("comment-token") ?? token;
  if (pr && !commentToken) warning("envsure: no token to comment with; set `comment-token`");
  else if (pr && commentToken && (problems > 0 || input("comment-on-success") === "true")) {
    await upsertComment(commentToken, apiUrl, repoName, pr.number, fit(body, 65_536)).catch((e) =>
      warning(`envsure could not comment on the PR: ${e.message}`),
    );
  }
  for (const f of result.findings) {
    const r = f.refs[0];
    command("error", { file: r.file, line: r.line }, `${f.name} is missing in ${f.missingIn.map(scopeLabel).join(", ")}`);
  }
  for (const i of result.dotenvIssues) command("warning", { file: i.file, line: i.line }, i.message);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `missing=${result.findings.length}\ndotenv-issues=${result.dotenvIssues.length}\nunused=${unusedCount}\n`);
  }
  if (problems > 0 && input("fail-on-missing") !== "false") process.exitCode = 1;
}

main().catch((err) => {
  console.log(`::error::${escapeData(`envsure: ${err instanceof Error ? err.message : err}`)}`);
  process.exitCode = 1;
});
