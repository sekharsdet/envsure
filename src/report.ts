import { REPO_SCOPE, type Finding } from "./check.js";
import type { DotenvIssue } from "./dotenv.js";

export const COMMENT_MARKER = "<!-- envsure -->";

export const scopeLabel = (scope: string) => (scope === REPO_SCOPE ? "repository" : scope);

export function renderMarkdown(findings: Finding[], dotenvIssues: DotenvIssue[], sourcesChecked: Record<string, string[]> = {}): string {
  const lines = [COMMENT_MARKER, "### EnvSure"];
  if (findings.length === 0 && dotenvIssues.length === 0) {
    lines.push("", "All referenced environment variables are configured. ✅");
    return lines.join("\n");
  }
  if (findings.length) {
    lines.push("", "| Variable | Referenced at | Missing in | Present in |", "|---|---|---|---|");
    for (const f of findings) {
      const at = f.refs.slice(0, 3).map((r) => `\`${r.file}:${r.line}\``).join(", ") +
        (f.refs.length > 3 ? ` +${f.refs.length - 3} more` : "");
      const missing = f.missingIn.map((e) => (e === REPO_SCOPE ? "repository" : `\`${e}\``)).join(", ");
      const present = f.presentIn.length ? f.presentIn.map((e) => `\`${e}\``).join(", ") : "—";
      lines.push(`| \`${f.name}\` | ${at} | ${missing} | ${present} |`);
    }
  }
  if (dotenvIssues.length) {
    lines.push("", "**Committed env files**", "");
    for (const i of dotenvIssues) lines.push(`- \`${i.file}:${i.line}\` — ${i.message}`);
  }
  if (findings.length && Object.keys(sourcesChecked).length) {
    lines.push("", "<sub>Code references checked against: " +
      Object.entries(sourcesChecked).map(([env, labels]) => `\`${env}\` → ${labels.join(", ")}`).join("; ") +
      ". Other environments and workflow references: GitHub.</sub>");
  }
  return lines.join("\n");
}

export function renderText(findings: Finding[], dotenvIssues: DotenvIssue[], sourcesChecked: Record<string, string[]> = {}): string {
  const out: string[] = [];
  for (const f of findings) {
    const r = f.refs[0];
    const missing = f.missingIn.map(scopeLabel).join(", ");
    const present = f.presentIn.length ? `; present in ${f.presentIn.join(", ")}` : "";
    out.push(`${r.file}:${r.line}  ${f.name} missing in ${missing}${present}`);
  }
  for (const i of dotenvIssues) out.push(`${i.file}:${i.line}  ${i.message}`);
  if (findings.length) {
    for (const [env, labels] of Object.entries(sourcesChecked)) out.push(`  (${env} checked against: ${labels.join(", ")})`);
  }
  return out.join("\n");
}

const unusedCount = (unused: Record<string, string[]>) => Object.values(unused).reduce((n, l) => n + l.length, 0);

export function renderUnusedText(unused: Record<string, string[]>): string {
  if (!unusedCount(unused)) return "";
  return ["Possibly unused (configured, but the name appears nowhere in the repository):",
    ...Object.entries(unused).map(([env, names]) => `  ${scopeLabel(env)}: ${names.join(", ")}`)].join("\n");
}

export function renderUnusedMarkdown(unused: Record<string, string[]>): string {
  const n = unusedCount(unused);
  if (!n) return "";
  return [
    "", `<details><summary>Possibly unused: ${n} configured name${n === 1 ? "" : "s"} appear nowhere in the repository</summary>`, "",
    "| Environment | Names |", "|---|---|",
    ...Object.entries(unused).map(([env, names]) =>
      `| ${env === REPO_SCOPE ? "repository" : `\`${env}\``} | ${names.map((x) => `\`${x}\``).join(", ")} |`),
    "", "Remove them, or list them under `unusedIgnore` if something reads them implicitly.", "</details>",
  ].join("\n");
}
