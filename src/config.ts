import { parse } from "yaml";
import { looksLikeSecret, valueNotName } from "./secrets.js";
import { SOURCE_TYPES, SOURCES } from "./sources/index.js";
import type { Options } from "./sources/types.js";

export interface SourceSpec {
  type: string;
  options: Options;
}

export interface Config {
  /** GitHub Environments every referenced variable must be available in. */
  environments: string[];
  /** Names that are provided by the platform/runtime and never need a secret. */
  ignore: string[];
  /** Path prefixes to skip when scanning. */
  excludePaths: string[];
  /** Names never reported as unused (trailing * is a prefix match). */
  unusedIgnore: string[];
  /** Where each environment's runtime values live. Environments without an entry use GitHub. */
  sources: Record<string, SourceSpec[]>;
}

export const DEFAULT_IGNORE = [
  "CI", "HOME", "PATH", "PWD", "PORT", "HOST", "HOSTNAME", "NODE_ENV", "TZ", "LANG", "SHELL", "USER",
  "GITHUB_*", "RUNNER_*", "ACTIONS_*", "VERCEL", "VERCEL_*", "NEXT_RUNTIME", "RENDER", "RENDER_*",
  "RAILWAY_*", "FLY_*", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_LAMBDA_*", "NETLIFY", "DEPLOY_URL", "DEPLOY_PRIME_URL",
  "DYNO", "K_SERVICE", "K_REVISION", "K_CONFIGURATION",
  "WEBSITE_*", "CF_PAGES", "CF_PAGES_*",
];

export const DEFAULT_CONFIG: Config = {
  environments: [],
  ignore: [],
  excludePaths: ["node_modules/", "dist/", "build/", "vendor/", ".git/"],
  unusedIgnore: [],
  sources: {},
};

const fail = (msg: string): never => {
  throw new Error(`envsure config: ${msg}`);
};

function list(v: unknown, key: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(`"${key}" must be a list of strings`);
  return v as string[];
}

/** Accepts `- vercel: { project: web }` or `- type: vercel` + options. */
function parseSource(entry: unknown, where: string): SourceSpec {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${where} must be a mapping like "- vercel: { project: web }"`);
  const obj = entry as Record<string, unknown>;
  let type: string;
  let options: unknown;
  if (typeof obj.type === "string") {
    ({ type } = obj as { type: string });
    const { type: _t, ...rest } = obj;
    options = rest;
  } else {
    const keys = Object.keys(obj);
    if (keys.length !== 1) fail(`${where} must have exactly one source type key, got ${keys.join(", ") || "none"}`);
    type = keys[0];
    options = obj[type] ?? {};
  }
  if (!SOURCE_TYPES.includes(type)) fail(`${where}: unknown source "${type}" (known: ${SOURCE_TYPES.join(", ")})`);
  if (typeof options !== "object" || Array.isArray(options)) fail(`${where}: options for "${type}" must be a mapping`);
  const opts = options as Options;
  const def = SOURCES[type];
  const allowed = def ? [...def.required, ...def.optional] : ["environment"];
  for (const k of Object.keys(opts)) {
    if (!allowed.includes(k)) fail(`${where}: unknown option "${k}" for ${type} (allowed: ${allowed.join(", ") || "none"})`);
  }
  for (const k of def?.required ?? []) {
    if (opts[k] === undefined || opts[k] === "") fail(`${where}: ${type} needs "${k}"`);
  }
  for (const [k, v] of Object.entries(opts)) {
    const ok = ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!ok) fail(`${where}: option "${k}" for ${type} must be a string, number, boolean or list of strings`);
  }
  // A token pasted here instead of a variable name would otherwise be echoed in "set <tokenEnv>".
  // Real tokens (ghp_..., sk_live_...) can also look like identifiers, so known formats are refused too.
  const tokenEnv = opts.tokenEnv;
  if (tokenEnv !== undefined &&
      !(typeof tokenEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tokenEnv) && !valueNotName(tokenEnv) && !looksLikeSecret(tokenEnv))) {
    fail(`${where}: tokenEnv must be the name of an environment variable (like VERCEL_TOKEN), not a token`);
  }
  return { type, options: opts };
}

const TOP_LEVEL_KEYS = ["environments", "ignore", "unusedIgnore", "excludePaths", "sources"];

/** Edit distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

export function parseConfig(text: string | undefined): Config {
  if (!text) return { ...DEFAULT_CONFIG, sources: {} };
  let raw: Partial<Record<keyof Config, unknown>>;
  try {
    raw = (parse(text) ?? {}) as typeof raw;
  } catch (err) {
    return fail(`invalid YAML (${(err as Error).message.split("\n")[0]})`);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) fail("top level must be a mapping");
  // A typo would otherwise silently fall back to defaults and weaken the check.
  for (const key of Object.keys(raw)) {
    if (TOP_LEVEL_KEYS.includes(key)) continue;
    const best = TOP_LEVEL_KEYS.map((k) => [k, distance(key.toLowerCase(), k.toLowerCase())] as const).sort((a, b) => a[1] - b[1])[0];
    fail(`unknown key "${key}"${best[1] <= 3 ? `; did you mean "${best[0]}"?` : ` (known: ${TOP_LEVEL_KEYS.join(", ")})`}`);
  }
  const environments = list(raw.environments, "environments") ?? DEFAULT_CONFIG.environments;
  const dup = environments.find((e, i) => environments.indexOf(e) !== i);
  if (dup) fail(`"environments" lists "${dup}" more than once (duplicate)`);
  if (environments.some((e) => e.trim() === "" || e === "(repository)")) fail(`"environments" has an empty or reserved name`);
  const sources: Record<string, SourceSpec[]> = {};
  if (raw.sources !== undefined && raw.sources !== null) {
    if (typeof raw.sources !== "object" || Array.isArray(raw.sources)) fail(`"sources" must map environment names to lists`);
    for (const [env, entries] of Object.entries(raw.sources as Record<string, unknown>)) {
      if (!environments.includes(env)) fail(`sources.${env}: "${env}" is not listed in "environments"`);
      if (!Array.isArray(entries) || entries.length === 0) fail(`sources.${env} must be a non-empty list`);
      sources[env] = (entries as unknown[]).map((e, i) => parseSource(e, `sources.${env}[${i}]`));
    }
  }
  return {
    environments,
    ignore: list(raw.ignore, "ignore") ?? DEFAULT_CONFIG.ignore,
    unusedIgnore: list(raw.unusedIgnore, "unusedIgnore") ?? DEFAULT_CONFIG.unusedIgnore,
    // Accept Windows-style separators; git always reports "/".
    excludePaths: (list(raw.excludePaths, "excludePaths") ?? DEFAULT_CONFIG.excludePaths).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
    sources,
  };
}

export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}
