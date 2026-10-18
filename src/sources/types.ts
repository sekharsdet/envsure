import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type Options = Record<string, unknown>;

export interface SourceContext {
  env: Record<string, string | undefined>;
  /**
   * Where `command` runs and `file` reads: the repository root, or on pull requests a checkout of the
   * trusted base commit, so a PR cannot change the code or data those sources use.
   */
  cwd: string;
  /** The checked-out tree (fly.toml is deployment config that ships with the change). Defaults to cwd. */
  repoCwd?: string;
  fetch: typeof fetch;
  exec: (cmd: string, args: string[] | undefined, opts: SpawnSyncOptions) => SpawnSyncReturns<string>;
  warn: (message: string) => void;
}

export interface SourceDef {
  /** Option names; `required` ones must be present and non-empty strings. */
  required: string[];
  optional: string[];
  /** Short human label, e.g. `vercel web (production)`. */
  label(opts: Options): string;
  /** Names available at runtime. Values must be dropped as soon as a response is parsed. */
  fetchNames(opts: Options, ctx: SourceContext): Promise<Set<string>>;
}

export class SourceError extends Error {}

export const str = (opts: Options, key: string): string | undefined =>
  typeof opts[key] === "string" && opts[key] !== "" ? (opts[key] as string) : typeof opts[key] === "number" ? String(opts[key]) : undefined;

/** Resolve a repository-relative path, refusing anything that escapes the repository or is a symlink. */
export function insideRepo(root: string, rel: string, label: string): string {
  const full = resolve(root, rel);
  const fromRoot = relative(resolve(root), full);
  if (isAbsolute(rel) || fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new SourceError(`${label}: ${rel} is outside the repository`);
  }
  try {
    if (lstatSync(full).isSymbolicLink()) throw new SourceError(`${label}: ${rel} is a symlink`);
  } catch (err) {
    if (err instanceof SourceError) throw err;
  }
  return full;
}
