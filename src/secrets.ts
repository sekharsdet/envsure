// Heuristics for "this string is a secret value". Used to warn about secrets committed in .env
// files and to keep secret-looking strings out of output. Never print the value itself.

/** Formats of real credentials (live/production keys; test-mode keys are handled as placeholders). */
const KNOWN_FORMATS: RegExp[] = [
  /^(?:sk|rk)_live_[0-9A-Za-z]{16,}$/, // Stripe
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/, // AWS access key id
  /^(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}$/, // GitHub
  /^github_pat_[0-9A-Za-z_]{40,}$/,
  /^xox[abposr]-[0-9A-Za-z-]{10,}$/, // Slack
  /^AIza[0-9A-Za-z_-]{35}$/, // Google API key
  /^glpat-[0-9A-Za-z_-]{20,}$/, // GitLab
  /^SG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}$/, // SendGrid
  /^npm_[0-9A-Za-z]{36}$/,
  /^sk-(?:ant-|proj-)?[0-9A-Za-z_-]{20,}$/, // OpenAI / Anthropic
  /^whsec_[0-9A-Za-z+/=]{20,}$/, // webhook signing secrets
  /^shp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}$/, // Shopify
  /^dop_v1_[0-9a-f]{64}$/, // DigitalOcean
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_?KEY|ACCESS_?KEY|CREDENTIAL|SIGNING|AUTH/i;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const randomLooking = (v: string) =>
  v.length >= 20 && !/\s/.test(v) && entropy(v) >= 3.5 && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/^https?:\/\//i.test(v);

/** A value that looks like a real credential (for a variable called `name`, when known). */
export function looksLikeSecret(value: string, name = ""): boolean {
  if (KNOWN_FORMATS.some((re) => re.test(value))) return true;
  return SECRET_NAME.test(name) && randomLooking(value);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const PLACEHOLDER_PASSWORDS = new Set(["password", "pass", "postgres", "root", "secret", "changeme", "example", "admin", "test", "user"]);

/** `scheme://user:password@host` with a real-looking password on a non-local host. */
export function urlWithPassword(value: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^@\s/]+)@([^/:?\s]+)/i.exec(value);
  if (!m) return false;
  const [, password, host] = m;
  return !LOCAL_HOSTS.has(host.toLowerCase()) && !PLACEHOLDER_PASSWORDS.has(password.toLowerCase()) && !/^\$\{?/.test(password);
}

/**
 * Something offered as a variable *name* that is really a value: a source misconfigured to print
 * values (e.g. `kubectl ... jsonpath={.data.*}`). Real names are short identifiers.
 */
export function valueNotName(s: string): boolean {
  return KNOWN_FORMATS.some((re) => re.test(s)) || (s.length >= 20 && !s.includes("_") && randomLooking(s)) || s.length > 128;
}
