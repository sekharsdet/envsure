// Escape hatches for anything without a built-in connector (Kubernetes, Vault, 1Password, ...).
import { readFileSync } from "node:fs";
import { parseNames } from "./names.js";
import { insideRepo, type SourceDef, SourceError, str } from "./types.js";

export const command: SourceDef = {
  required: ["run"],
  optional: ["shell"],
  label: (o) => `command \`${str(o, "run")}\``,
  async fetchNames(o, ctx) {
    const label = this.label(o);
    const shell = str(o, "shell") ?? true;
    const r = ctx.exec(str(o, "run")!, undefined, {
      cwd: ctx.cwd,
      encoding: "utf8",
      shell,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: ctx.env as NodeJS.ProcessEnv,
    });
    if (r.error) throw new SourceError(`${label}: ${r.error.message}`);
    // stderr is not echoed: it may contain values.
    if (r.status !== 0) throw new SourceError(`${label}: exited with ${r.status ?? r.signal}`);
    return parseNames(String(r.stdout));
  },
};

export const file: SourceDef = {
  required: ["path"],
  optional: [],
  label: (o) => `file ${str(o, "path")}`,
  async fetchNames(o, ctx) {
    const path = insideRepo(ctx.cwd, str(o, "path")!, this.label(o));
    try {
      return parseNames(readFileSync(path, "utf8"));
    } catch {
      throw new SourceError(`${this.label(o)}: cannot read file`);
    }
  },
};
