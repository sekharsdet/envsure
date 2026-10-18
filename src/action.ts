import { appendFileSync, readFileSync } from "node:fs";
import { COMMENT_MARKER, renderMarkdown, scopeLabel } from "./report.js";
import { parseRepo, run } from "./run.js";

const input = (name: string) => process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`]?.trim() || undefined;

async function upsertComment(token: string, apiUrl: string, repo: string, pr: number, body: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const list = await fetch(`${apiUrl}/repos/${repo}/issues/${pr}/comments?per_page=100`, { headers });
  if (!list.ok) throw new Error(`listing comments failed: ${list.status}`);
  const existing = ((await list.json()) as { id: number; body?: string }[]).find((c) => c.body?.includes(COMMENT_MARKER));
  const url = existing
    ? `${apiUrl}/repos/${repo}/issues/comments/${existing.id}`
    : `${apiUrl}/repos/${repo}/issues/${pr}/comments`;
  const res = await fetch(url, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`writing comment failed: ${res.status}`);
}

async function main() {
  // Only needed when GitHub itself is checked; run() says so if it is missing.
  const token = input("token");
  const repoName = process.env.GITHUB_REPOSITORY!;
  const apiUrl = process.env.ENVSURE_GITHUB_API_URL || process.env.GITHUB_API_URL || "https://api.github.com";
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pr = event.pull_request as { number: number; base: { sha: string } } | undefined;

  const result = await run({
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    base: pr?.base.sha,
    configPath: input("config"),
    // On PRs the config comes from the base commit, so a PR cannot loosen the check or add a
    // `command` source that would run with the platform tokens.
    configRef: pr?.base.sha,
    repo: parseRepo(repoName),
    token,
    apiUrl,
    warn: (m) => console.log(`::warning::envsure: ${m}`),
  });

  const body = renderMarkdown(result.findings, result.dotenvIssues, result.sourcesChecked);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + "\n");

  const problems = result.findings.length + result.dotenvIssues.length;
  const commentToken = input("comment-token") ?? token;
  if (pr && !commentToken) console.log("::warning::envsure: no token to comment with; set `comment-token`");
  else if (pr && commentToken && (problems > 0 || input("comment-on-success") === "true")) {
    await upsertComment(commentToken, apiUrl, repoName, pr.number, body).catch((e) =>
      console.log(`::warning::envsure could not comment on the PR: ${e.message}`),
    );
  }
  for (const f of result.findings) {
    const r = f.refs[0];
    console.log(`::error file=${r.file},line=${r.line}::${f.name} is missing in ${f.missingIn.map(scopeLabel).join(", ")}`);
  }
  for (const i of result.dotenvIssues) console.log(`::warning file=${i.file},line=${i.line}::${i.message}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `missing=${result.findings.length}\ndotenv-issues=${result.dotenvIssues.length}\n`);
  }
  if (problems > 0 && input("fail-on-missing") !== "false") process.exitCode = 1;
}

main().catch((err) => {
  console.log(`::error::envsure: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
