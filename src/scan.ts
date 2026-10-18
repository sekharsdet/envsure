import { jobScopes, workflowCallSecrets, type JobScope } from "./workflow.js";

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
  /** Names this pattern matches that are built in, not configuration. */
  builtins?: Set<string>;
}

const NAME = "([A-Z_][A-Z0-9_]*)";
const Q = `["'\`]`;
const code = (re: string, builtins?: string[]): Pattern =>
  ({ re: new RegExp(re, "g"), kind: "code", builtins: builtins && new Set(builtins) });

/** Provided by Vite/Astro at build time on import.meta.env. */
const IMPORT_META_BUILTINS = ["MODE", "DEV", "PROD", "SSR", "BASE_URL", "SITE", "ASSETS_PREFIX"];

/**
 * Single-line patterns per language; group 1 is the variable name. Every quantifier that can
 * run over attacker-controlled text is bounded, so a hostile file cannot cause backtracking blowups.
 */
const CODE_PATTERNS: Record<string, Pattern[]> = {
  js: [
    code(`\\bprocess\\.env\\.${NAME}\\b`),
    code(`\\bprocess\\.env\\[\\s*${Q}${NAME}${Q}\\s*\\]`),
    code(`\\bimport\\.meta\\.env\\.${NAME}\\b`, IMPORT_META_BUILTINS),
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
  compose: [code(`(?<!\\$)\\$\\{${NAME}(?::?\\?[^}\\n]{0,200})?\\}`), code(`(?<![$\\w])\\$${NAME}\\b(?![{:-])`)],
  workflow: [], // see workflowRefs
};

/** Line prefixes that make a whole line a comment, per language. */
const COMMENT_PREFIXES: Record<string, string[]> = {
  js: ["//", "/*", "*"], go: ["//", "/*", "*"], jvm: ["//", "/*", "*"], cs: ["//", "/*", "*"],
  rs: ["//", "/*", "*"], swift: ["//", "/*", "*"], php: ["//", "/*", "*", "#"], prisma: ["//"],
  py: ["#"], rb: ["#"], ex: ["#"], compose: ["#"], workflow: ["#"],
};

const ENV_OBJECT = String.raw`(?:process\.env|import\.meta\.env|Bun\.env)`;
/** `const { A, B: b = "x" } = process.env`, also across lines (bounded length). */
const DESTRUCTURE = new RegExp(String.raw`\{([^{}]{0,4000})\}\s*=\s*${ENV_OBJECT}\b`, "g");
/** `const env = process.env` (not followed by `.` or `[`) and `import { env } from "node:process"`. */
const ALIAS = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${ENV_OBJECT}\s*(?![.\[\w])`, "g");
/** One bounded quantifier per pattern; the `env` check happens on the captured list, not by backtracking. */
const PROCESS_IMPORT = /\bimport\s*\{([^}]{0,300})\}\s*from\s*["'](?:node:)?process["']/g;
const PROCESS_ENV_REQUIRE = /\{\s*env\s*\}\s*=\s*(?:process|require\(["'](?:node:)?process["']\))/;
const importsProcessEnv = (text: string) =>
  PROCESS_ENV_REQUIRE.test(text) || [...text.matchAll(PROCESS_IMPORT)].some((m) => /(^|[\s,])env([\s,]|$)/.test(m[1]));

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
  const rows = text.split("\n");
  const lineStarts: number[] = [];
  for (let i = 0, at = 0; i < rows.length; at += rows[i].length + 1, i++) lineStarts.push(at);
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
  const prefixes = COMMENT_PREFIXES[lang] ?? [];
  const isComment = (row: string) => {
    const t = row.trimStart();
    return prefixes.some((p) => t.startsWith(p));
  };
  const add = (name: string, offset: number, kind: RefKind = "code") => {
    const line = lineOf(offset);
    if ((!lines || lines.has(line)) && !isComment(rows[line - 1])) hits.push({ at: offset, ref: { name, file, line, kind } });
  };

  if (lang === "env-example") {
    for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) add(m[1], m.index!, "env-example");
  } else if (lang === "workflow") {
    rows.forEach((row, i) => {
      for (const [name, at, kind] of workflowRefs(row)) add(name, lineStarts[i] + at, kind);
    });
  } else {
    const patterns = [...CODE_PATTERNS[lang]];
    if (lang === "js") {
      const aliases = [...text.matchAll(ALIAS)].map((m) => m[1]);
      if (importsProcessEnv(text)) aliases.push("env");
      for (const a of new Set(aliases)) {
        const id = a.replace(/\$/g, "\\$");
        patterns.push(code(`(?<![\\w$.])${id}\\.${NAME}\\b`), code(`(?<![\\w$.])${id}\\[\\s*${Q}${NAME}${Q}\\s*\\]`));
      }
    }
    // Line by line, so a pattern can never span lines.
    rows.forEach((row, i) => {
      for (const { re, kind, builtins } of patterns) {
        for (const m of row.matchAll(re)) if (!builtins?.has(m[1])) add(m[1], lineStarts[i] + m.index!, kind);
      }
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
  let refs = hits.sort((a, b) => a.at - b.at).map((h) => h.ref)
    .filter((r) => !seen.has(`${r.line}:${r.kind}:${r.name}`) && seen.add(`${r.line}:${r.kind}:${r.name}`));
  if (lang === "workflow" && refs.length) {
    // A reusable workflow's declared secrets come from its caller, whose own refs are checked.
    const passedIn = workflowCallSecrets(text);
    refs = refs.filter((r) => !(r.kind === "workflow-secret" && passedIn.has(r.name)));
    attachJobEnvironments(text, refs);
  }
  return refs;
}

const EXPR_REF = /\b(secrets|vars)\.([A-Z_][A-Z0-9_]*)\b/g;

/**
 * `secrets.X` / `vars.X` inside `${{ ... }}` expressions, and in `if:` conditions, which are
 * expressions even without `${{ }}`. Linear in the line length: expressions are located with
 * indexOf (an unclosed `${{` runs to the end of the line), never with backtracking regexes.
 */
function workflowRefs(row: string): [string, number, RefKind][] {
  const out: [string, number, RefKind][] = [];
  const scan = (from: number, to: number) => {
    EXPR_REF.lastIndex = 0;
    for (const m of row.slice(from, to).matchAll(EXPR_REF)) {
      out.push([m[2], from + m.index! + m[1].length + 1, m[1] === "secrets" ? "workflow-secret" : "workflow-var"]);
    }
  };
  let i = row.indexOf("${{");
  if (i === -1) {
    const cond = /^\s*(?:-\s+)?if:\s*/.exec(row);
    if (cond) scan(cond[0].length, row.length);
    return out;
  }
  while (i !== -1) {
    const end = row.indexOf("}}", i + 3);
    const stop = end === -1 ? row.length : end;
    scan(i + 3, stop);
    if (end === -1) break;
    i = row.indexOf("${{", end + 2);
  }
  return out;
}

/** At most this many createEnv calls per file are read (each costs a pass over the call's text). */
const MAX_CREATE_ENV_CALLS = 20;

/**
 * Keys declared in t3-env / `createEnv({ server: { A: z.string() }, client: {...}, shared: {...} })`.
 * Those are the variables the app requires, even when only `runtimeEnv` reads process.env.
 */
function createEnvKeys(text: string): [string, number][] {
  const out: [string, number][] = [];
  let calls = 0;
  for (const call of text.matchAll(/\bcreateEnv\s*\(\s*\{/g)) {
    if (++calls > MAX_CREATE_ENV_CALLS) break;
    const objStart = call.index! + call[0].length - 1;
    const objEnd = matchingBrace(text, objStart);
    const obj = text.slice(objStart, objEnd);
    for (const section of ["server", "client", "shared"]) {
      const m = new RegExp(`\\b${section}\\s*:\\s*\\{`).exec(obj);
      if (!m) continue;
      const open = objStart + m.index + m[0].length - 1;
      const close = matchingBrace(text, open, objEnd);
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

/** Index of the brace closing the one at `open`, or `limit` (string contents are not special-cased). */
function matchingBrace(text: string, open: number, limit = text.length): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return limit;
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

/** Undo git's C-style quoting of unusual paths: `"a\"b\tc"` -> `a"b<TAB>c`, octal escapes as UTF-8. */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      bytes.push(...Buffer.from(s[i], "utf8"));
      continue;
    }
    const next = s[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(simple[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Map of file -> line numbers added, parsed from a unified diff (`git diff -U0`). */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | undefined;
  let next = 0;
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith("+++ ")) {
      const p = unquoteGitPath(l.slice(4).replace(/\t$/, ""));
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
