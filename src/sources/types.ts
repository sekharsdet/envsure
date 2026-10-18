import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

export type Options = Record<string, unknown>;

export interface SourceContext {
  env: Record<string, string | undefined>;
  /** Repository root; `file` and `command` sources and fly.toml paths resolve against it. */
  cwd: string;
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
