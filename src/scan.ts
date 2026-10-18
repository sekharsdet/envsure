import { jobScopes, type JobScope } from "./workflow.js";

export type RefKind = "code" | "workflow-secret" | "workflow-var" | "env-example";

export interface EnvRef {
  name: string;
  file: string;
  line: number;
  kind: RefKind;
  /**
   * Workflow refs only: the job's GitHub Environment, or null when the job has none
   * (then only repository/organization values resolve). Undefined = unknown.
   */
  environment?: string | null;
}

interface Pattern {
  re: RegExp;
  kind: RefKind;
}

const NAME = "([A-Z_][A-Z0-9_]*)";
const Q = `["'\`]`;

const CODE_PATTERNS: Record<string, Pattern[]> = {
  js: [
    { re: new RegExp(`\\bprocess\\.env\\.${NAME}\\b`, "g"), kind: "code" },
    { re: new RegExp(`\\bprocess\\.env\\[\\s*${Q}${NAME}${Q}\\s*\\]`, "g"), kind: "code" },
    { re: new RegExp(`\\bimport\\.meta\\.env\\.${NAME}\\b`, "g"), kind: "code" },
    { re: new RegExp(`\\bBun\\.env\\.${NAME}\\b`, "g"), kind: "code" },
    { re: new RegExp(`\\bDeno\\.env\\.get\\(\\s*${Q}${NAME}${Q}`, "g"), kind: "code" },
  ],
  py: [
    { re: new RegExp(`\\bos\\.environ\\[\\s*${Q}${NAME}${Q}\\s*\\]`, "g"), kind: "code" },
    { re: new RegExp(`\\bos\\.(?:environ\\.get|getenv)\\(\\s*${Q}${NAME}${Q}`, "g"), kind: "code" },
  ],
  go: [{ re: new RegExp(`\\bos\\.(?:Getenv|LookupEnv)\\(\\s*"${NAME}"`, "g"), kind: "code" }],
  rb: [{ re: new RegExp(`\\bENV(?:\\.fetch\\(\\s*|\\[\\s*)${Q}${NAME}${Q}`, "g"), kind: "code" }],
  workflow: [
    { re: new RegExp(`\\$\\{\\{[^}]*\\bsecrets\\.${NAME}\\b`, "g"), kind: "workflow-secret" },
    { re: new RegExp(`\\$\\{\\{[^}]*\\bvars\\.${NAME}\\b`, "g"), kind: "workflow-var" },
  ],
};

/** `const { A, B: b = "x" } = process.env` (single line). */
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)\b/g;

const EXT_LANG: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  vue: "js", svelte: "js", astro: "js",
  py: "py", go: "go", rb: "rb",
};

export function languageOf(file: string): string | undefined {
  const norm = file.replace(/\\/g, "/");
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(norm)) return "workflow";
  if (/(^|\/)\.env\.(example|sample|template)$/.test(norm)) return "env-example";
  const ext = norm.split(".").pop() ?? "";
  return EXT_LANG[ext];
}

/** Scan selected lines of a file (all lines when `lines` is undefined). */
export function scanText(file: string, text: string, lines?: Set<number>): EnvRef[] {
  const lang = languageOf(file);
  if (!lang) return [];
  const refs: EnvRef[] = [];
  text.split(/\r?\n/).forEach((content, i) => {
    const line = i + 1;
    if (lines && !lines.has(line)) return;
    if (lang === "env-example") {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(content);
      if (m) refs.push({ name: m[1], file, line, kind: "env-example" });
      return;
    }
    const hits: { at: number; ref: EnvRef }[] = [];
    for (const { re, kind } of CODE_PATTERNS[lang]) {
      for (const m of content.matchAll(re)) hits.push({ at: m.index ?? 0, ref: { name: m[1], file, line, kind } });
    }
    if (lang === "js") {
      for (const m of content.matchAll(DESTRUCTURE)) {
        for (const part of m[1].split(",")) {
          const key = /^\s*([A-Z_][A-Z0-9_]*)\b/.exec(part);
          if (key) hits.push({ at: (m.index ?? 0) + m[1].indexOf(key[1]), ref: { name: key[1], file, line, kind: "code" } });
        }
      }
    }
    refs.push(...hits.sort((a, b) => a.at - b.at).map((h) => h.ref));
  });
  if (lang === "workflow") attachJobEnvironments(text, refs);
  return refs;
}

function attachJobEnvironments(text: string, refs: EnvRef[]) {
  let scopes: JobScope[];
  try {
    scopes = jobScopes(text);
  } catch {
    return;
  }
  for (const r of refs) {
    const s = scopes.find((j) => r.line >= j.startLine && r.line <= j.endLine);
    if (s && s.environment !== undefined) r.environment = s.environment;
  }
}

/** Map of file -> line numbers added, parsed from a unified diff (`git diff -U0`). */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | undefined;
  let next = 0;
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).trim();
      file = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!file || l.startsWith("--- ")) continue;
    if (l.startsWith("+")) out.get(file)!.add(next++);
    else if (!l.startsWith("-") && !l.startsWith("\\")) next++;
  }
  return out;
}
