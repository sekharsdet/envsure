/**
 * Parse a list of names from command output or a file. Accepts a JSON array (strings, or objects
 * with `name`/`key`), a JSON object (its keys), or lines of `NAME`, `NAME=value`, `export NAME=value`
 * or `NAME: value`. Values are never kept.
 */
export function parseNames(text: string): Set<string> {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) {
        return new Set(
          data
            .map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? (x.name ?? x.key) : undefined))
            .filter((x): x is string => typeof x === "string" && x !== ""),
        );
      }
      if (data && typeof data === "object") return new Set(Object.keys(data));
    } catch {
      // fall through to line format
    }
  }
  const names = new Set<string>();
  for (const line of trimmed.split(/\r?\n/)) {
    if (/^\s*(#|\/\/|$)/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:[=:]|$)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Keys of the `[env]` table in a fly.toml. Minimal TOML: only `KEY = value` lines in that table. */
export function flyTomlEnvKeys(text: string): Set<string> {
  const keys = new Set<string>();
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (table) {
      inEnv = table[1] === "env";
      continue;
    }
    if (!inEnv) continue;
    const m = /^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** `foo-bar` (Azure Key Vault) -> `FOO_BAR`. */
export const fromKebab = (name: string) => name.toUpperCase().replace(/-/g, "_");

/** Last path segment after an optional prefix: `/app/prod/DB_URL` -> `DB_URL`. */
export function stripPath(name: string, prefix = ""): string {
  const rest = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return rest.split("/").filter(Boolean).pop() ?? rest;
}
