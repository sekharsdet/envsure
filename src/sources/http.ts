import { type Options, type SourceContext, SourceError, str } from "./types.js";

/** `ENVSURE_<TYPE>_API_URL` overrides a source's API base (tests, proxies, sovereign clouds). */
export function apiBase(type: string, fallback: string, ctx: SourceContext): string {
  const key = `ENVSURE_${type.toUpperCase().replace(/-/g, "_")}_API_URL`;
  return (ctx.env[key] || fallback).replace(/\/+$/, "");
}

/** Token from `tokenEnv` (if configured) or the first default env var that is set. */
export function token(opts: Options, ctx: SourceContext, defaults: string[]): { value?: string; name: string } {
  const names = str(opts, "tokenEnv") ? [str(opts, "tokenEnv")!] : defaults;
  for (const name of names) if (ctx.env[name]) return { value: ctx.env[name], name };
  return { name: names.join(" or ") };
}

export function requireToken(label: string, opts: Options, ctx: SourceContext, defaults: string[]) {
  const t = token(opts, ctx, defaults);
  if (!t.value) throw new SourceError(`${label}: no credentials; set ${t.name}`);
  return t as { value: string; name: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-request limit, so a stalled API fails the run instead of hanging the job (ENVSURE_HTTP_TIMEOUT_MS). */
export const timeoutMs = (env: Record<string, string | undefined>) => Number(env.ENVSURE_HTTP_TIMEOUT_MS) > 0 ? Number(env.ENVSURE_HTTP_TIMEOUT_MS) : 30_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Request JSON. Retries 429/5xx twice. Error messages never include response bodies,
 * because some platforms echo values back.
 */
export async function requestJson(
  ctx: SourceContext,
  label: string,
  url: string,
  init: RequestInit & { tokenName?: string } = {},
): Promise<any> {
  const path = new URL(url).pathname;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs(ctx.env)),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        if (attempt < 2) continue;
        throw new SourceError(`${label}: request to ${new URL(url).host} timed out after ${timeoutMs(ctx.env) / 1000}s`);
      }
      // A pooled keep-alive socket the server (or a proxy) already closed fails like this; retry reads.
      if ((init.method ?? "GET") === "GET" && attempt < 2) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new SourceError(`${label}: request to ${new URL(url).host} failed (${cause?.code ?? cause?.message ?? (err as Error).message})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403 ? ` — check ${init.tokenName ?? "credentials"} and its permissions`
        : res.status === 404 ? " — check the source options (project/service/app id)"
        : "";
      throw new SourceError(`${label}: HTTP ${res.status} for ${path}${hint}`);
    }
    if (Number(res.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      throw new SourceError(`${label}: response from ${path} is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
    }
    try {
      return await res.json();
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new SourceError(`${label}: reading ${path} timed out`);
      throw new SourceError(`${label}: invalid JSON from ${path}`);
    }
  }
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Access token from env vars, else from a CLI (`gcloud`/`az`) when installed. */
export function cliToken(
  label: string,
  opts: Options,
  ctx: SourceContext,
  envNames: string[],
  cli: { cmd: string; args: string[] },
): { value: string; name: string } {
  const t = token(opts, ctx, envNames);
  if (t.value) return t as { value: string; name: string };
  // On Windows gcloud/az are .cmd shims that need a shell; the command line is a fixed constant
  // (never user input), passed as one string rather than shell + args (Node DEP0190).
  const r = process.platform === "win32"
    ? ctx.exec([cli.cmd, ...cli.args].join(" "), undefined, { encoding: "utf8", shell: true, timeout: 30_000 })
    : ctx.exec(cli.cmd, cli.args, { encoding: "utf8", timeout: 30_000 });
  const out = r.status === 0 ? String(r.stdout).trim() : "";
  if (!out) throw new SourceError(`${label}: no credentials; set ${t.name} or log in with \`${cli.cmd}\``);
  return { value: out, name: `${cli.cmd} login` };
}

/** Most pages any source will request; far beyond real accounts, small enough to never hang a job. */
export const MAX_PAGES = 1000;

/**
 * Tracks pagination cursors: returns the next cursor, or throws when a server repeats one or pages
 * forever, so a buggy or hostile API cannot keep the job running.
 */
export function pageGuard(label: string) {
  const seen = new Set<string>();
  return (next: string | undefined | null): string | undefined => {
    if (!next) return undefined;
    if (seen.has(next)) throw new SourceError(`${label}: the API repeated a pagination cursor; stopping`);
    if (seen.size >= MAX_PAGES) throw new SourceError(`${label}: stopped after ${MAX_PAGES} pages`);
    seen.add(next);
    return next;
  };
}
