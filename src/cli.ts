import { parseArgs } from "node:util";
import { renderMarkdown, renderText, renderUnusedMarkdown, renderUnusedText, safePath } from "./report.js";
import { parseRepo, run } from "./run.js";

const USAGE = `Usage: envsure [options]

Checks that environment variables referenced in code exist in every configured
environment: as GitHub secrets/variables, or in the sources configured for that
environment (Vercel, Render, AWS SSM, ...). Reads names only.

Options:
  --repo <owner/name>   Repository to check (default: $GITHUB_REPOSITORY)
  --base <ref>          Only check lines added since <ref> (e.g. origin/main)
  --config <path>       Config file (default: .github/envsure.yml)
  --format <text|markdown|json>
  --offline             Only list references; do not call GitHub
  --unused              Also list configured names that appear nowhere in the repo
  --fail-on-unused      Like --unused, and exit 1 when any are found
  -h, --help

GitHub access needs $GITHUB_TOKEN (or $ENVSURE_TOKEN) with Secrets,
Variables, Environments and Actions read. Each source reads its own credential
(VERCEL_TOKEN, RENDER_API_KEY, AWS credential chain, ...); see README.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      config: { type: "string" },
      format: { type: "string", default: "text" },
      offline: { type: "boolean", default: false },
      unused: { type: "boolean", default: false },
      "fail-on-unused": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  // `||`, not `??`: an unset secret expands to "" in Actions and must not mask GITHUB_TOKEN.
  const token = process.env.ENVSURE_TOKEN || process.env.GITHUB_TOKEN;
  const repo = parseRepo(values.repo || process.env.GITHUB_REPOSITORY);
  if (values.repo && !repo) {
    console.error(`envsure: --repo must look like owner/name, got "${values.repo}"\n`);
    console.error(USAGE);
    return 2;
  }

  const result = await run({
    cwd: process.cwd(),
    base: values.base,
    configPath: values.config,
    offline: values.offline,
    unused: values.unused || values["fail-on-unused"],
    repo,
    token,
    apiUrl: process.env.ENVSURE_GITHUB_API_URL || process.env.GITHUB_API_URL,
  });

  const unused = result.unused ?? {};
  if (values.format === "json") {
    console.log(JSON.stringify(values.offline ? result.refs : result, null, 2));
  } else if (values.offline) {
    for (const r of result.refs) console.log(`${safePath(r.file)}:${r.line}  ${r.name}  (${r.kind})`);
    const issues = renderText([], result.dotenvIssues);
    if (issues) console.log(issues);
  } else if (values.format === "markdown") {
    console.log(renderMarkdown(result.findings, result.dotenvIssues, result.sourcesChecked) + renderUnusedMarkdown(unused));
  } else {
    const text = renderText(result.findings, result.dotenvIssues, result.sourcesChecked);
    console.log(text || "envsure: all referenced variables are configured");
    const unusedText = renderUnusedText(unused);
    if (unusedText) console.log(unusedText);
  }
  const failUnused = values["fail-on-unused"] && Object.values(unused).some((l) => l.length);
  return result.findings.length || result.dotenvIssues.length || failUnused ? 1 : 0;
}

// Set exitCode rather than calling process.exit(): exiting while sibling fetches are still
// open crashes Node on Windows, and can truncate piped stdout.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`envsure: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 2;
  },
);
