import { parse } from "yaml";
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
  return { type, options: opts };
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
  const environments = list(raw.environments, "environments") ?? DEFAULT_CONFIG.environments;
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
