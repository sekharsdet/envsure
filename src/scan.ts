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
const code = (re: string): Pattern => ({ re: new RegExp(re, "g"), kind: "code" });

/** Single-line patterns per language; group 1 is the variable name. */
const CODE_PATTERNS: Record<string, Pattern[]> = {
  js: [
    code(`\\bprocess\\.env\\.${NAME}\\b`),
    code(`\\bprocess\\.env\\[\\s*${Q}${NAME}${Q}\\s*\\]`),
    code(`\\bimport\\.meta\\.env\\.${NAME}\\b`),
    code(`\\bBun\\.env\\.${NAME}\\b`),
    code(`\\bDeno\\.env\\.get\\(\\s*${Q}${NAME}${Q}`),
  ],
  py: [
    code(`(?<![\\w])(?:os\\.)?environ\\[\\s*${Q}${NAME}${Q}\\s*\\]`),
    code(`(?<![\\w])(?:os\\.)?(?:environ\\.get|getenv)\\(\\s*${Q}${NAME}${Q}`),
  ],
  go: [code(`\\bos\\.(?:Getenv|LookupEnv)\\(\\s*"${NAME}"`)],
  rb: [code(`\\bENV(?:\\.fetch\\(\\s*|\\[\\s*)${Q}${NAME}${Q}`)],
  // Java, Kotlin, Scala, Groovy
  jvm: [code(`\\bSystem\\.getenv\\(\\s*"${NAME}"`)],
  cs: [code(`\\bEnvironment\\.GetEnvironmentVariable\\(\\s*"${NAME}"`)],
  php: [
    code(`\\bgetenv\\(\\s*${Q}${NAME}${Q}`),
    code(`\\$_ENV\\[\\s*${Q}${NAME}${Q}\\s*\\]`),
    code(`(?<![\\w>$:])env\\(\\s*${Q}${NAME}${Q}`), // Laravel's env() helper
  ],
  rs: [
    code(`\\benv::var(?:_os)?\\(\\s*"${NAME}"`),
    code(`\\b(?:option_)?env!\\(\\s*"${NAME}"`),
  ],
  ex: [code(`\\bSystem\\.(?:get_env|fetch_env!?)\\(\\s*"${NAME}"`)],
  swift: [code(`\\bProcessInfo\\.processInfo\\.environment\\[\\s*"${NAME}"\\s*\\]`)],
  prisma: [code(`\\benv\\(\\s*"${NAME}"\\s*\\)`)],
  // Compose interpolation; `${X:-default}` / `${X-default}` have a fallback and are not required.
  compose: [code(`(?<!\\$)\\$\\{${NAME}(?::?\\?[^}]*)?\\}`), code(`(?<![$\\w])\\$${NAME}\\b(?![{:-])`)],
  workflow: [
    { re: new RegExp(`\\$\\{\\{[^}]*\\bsecrets\\.${NAME}\\b`, "g"), kind: "workflow-secret" },
    { re: new RegExp(`\\$\\{\\{[^}]*\\bvars\\.${NAME}\\b`, "g"), kind: "workflow-var" },
  ],
};

const ENV_OBJECT = String.raw`(?:process\.env|import\.meta\.env|Bun\.env)`;
/** `const { A, B: b = "x" } = process.env`, also across lines. */
const DESTRUCTURE = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${ENV_OBJECT}\b`, "g");
/** `const env = process.env` (not followed by `.` or `[`) and `import { env } from "node:process"`. */
const ALIAS = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${ENV_OBJECT}\s*(?![.\[\w])`, "g");
const PROCESS_ENV_IMPORT = /\bimport\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']|\{\s*env\s*\}\s*=\s*(?:process|require\(["'](?:node:)?process["']\))/;

const EXT_LANG: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  vue: "js", svelte: "js", astro: "js",
  py: "py", go: "go", rb: "rb",
  java: "jvm", kt: "jvm", kts: "jvm", scala: "jvm", groovy: "jvm",
  cs: "cs", php: "php", rs: "rs", ex: "ex", exs: "ex", swift: "swift", prisma: "prisma",
};

export function languageOf(file: string): string | undefined {
  const norm = file.replace(/\\/g, "/");
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(norm)) return "workflow";
  if (/(^|\/)\.env\.(example|sample|template)$/.test(norm)) return "env-example";
  if (/(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/.test(norm)) return "compose";
  const ext = norm.split(".").pop() ?? "";
  return EXT_LANG[ext];
}

/** Scan selected lines of a file (all lines when `lines` is undefined). */
export function scanText(file: string, text: string, lines?: Set<number>): EnvRef[] {
  const lang = languageOf(file);
  if (!lang) return [];
  const hits: { at: number; ref: EnvRef }[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const add = (name: string, offset: number, kind: RefKind = "code") => {
    const line = lineOf(offset);
    if (!lines || lines.has(line)) hits.push({ at: offset, ref: { name, file, line, kind } });
  };

  if (lang === "env-example") {
    for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) add(m[1], m.index!, "env-example");
  } else {
    const patterns = [...CODE_PATTERNS[lang]];
    if (lang === "js") {
      const aliases = [...text.matchAll(ALIAS)].map((m) => m[1]);
      if (PROCESS_ENV_IMPORT.test(text)) aliases.push("env");
      for (const a of new Set(aliases)) {
        const id = a.replace(/\$/g, "\\$");
        patterns.push(code(`(?<![\\w$.])${id}\\.${NAME}\\b`), code(`(?<![\\w$.])${id}\\[\\s*${Q}${NAME}${Q}\\s*\\]`));
      }
    }
    // Line by line, so a pattern can never span lines.
    text.split("\n").forEach((content, i) => {
      for (const { re, kind } of patterns) for (const m of content.matchAll(re)) add(m[1], lineStarts[i] + m.index!, kind);
    });
    if (lang === "js") {
      for (const m of text.matchAll(DESTRUCTURE)) {
        const body = m[1];
        const bodyStart = m.index! + m[0].indexOf(body);
        for (const k of body.matchAll(/(?:^|,)\s*([A-Z_][A-Z0-9_]*)\b/g)) add(k[1], bodyStart + k.index! + k[0].indexOf(k[1]));
      }
      for (const [name, offset] of createEnvKeys(text)) add(name, offset);
    }
  }

  // One ref per name per line, in source order.
  const seen = new Set<string>();
  const refs = hits.sort((a, b) => a.at - b.at).map((h) => h.ref)
    .filter((r) => !seen.has(`${r.line}:${r.kind}:${r.name}`) && seen.add(`${r.line}:${r.kind}:${r.name}`));
  if (lang === "workflow") attachJobEnvironments(text, refs);
  return refs;
}

/**
 * Keys declared in t3-env / `createEnv({ server: { A: z.string() }, client: {...}, shared: {...} })`.
 * Those are the variables the app requires, even when only `runtimeEnv` reads process.env.
 */
function createEnvKeys(text: string): [string, number][] {
  const out: [string, number][] = [];
  for (const call of text.matchAll(/\bcreateEnv\s*\(\s*\{/g)) {
    const objStart = call.index! + call[0].length - 1;
    for (const section of ["server", "client", "shared"]) {
      const re = new RegExp(`\\b${section}\\s*:\\s*\\{`, "g");
      re.lastIndex = objStart;
      const m = re.exec(text);
      if (!m || m.index > matchingBrace(text, objStart)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchingBrace(text, open);
      // Keys at depth 1 of the section object only.
      let depth = 0;
      for (let i = open; i < close; i++) {
        const ch = text[i];
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth--;
        else if (depth === 1 && /[A-Z_]/.test(ch) && /[\s,{]/.test(text[i - 1])) {
          const key = /^([A-Z_][A-Z0-9_]*)\s*:/.exec(text.slice(i, i + 200));
          if (key) {
            out.push([key[1], i]);
            i += key[1].length - 1;
          }
        }
      }
    }
  }
  return out;
}

/** Index of the brace closing the one at `open` (string contents are not special-cased). */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length;
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
