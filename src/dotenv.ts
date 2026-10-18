export interface DotenvIssue {
  file: string;
  line: number;
  key: string;
  problem: "empty" | "placeholder" | "quoted-for-docker";
  message: string;
}

const PLACEHOLDERS = [
  /^your[_-]?.*[_-]?here$/i,
  /^<.*>$/,
  /^(changeme|change[_-]me|todo|tbd|xxx+|placeholder|replace[_-]?me|dummy|example)$/i,
  /^sk_test_/,
  /^pk_test_/,
];

/**
 * Lint a committed .env-style file. `dockerEnvFile` flags quoted values, because
 * `docker run --env-file` keeps quotes literally while dotenv libraries strip them.
 */
export function lintDotenv(file: string, text: string, dockerEnvFile = false): DotenvIssue[] {
  const issues: DotenvIssue[] = [];
  text.split(/\r?\n/).forEach((content, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(content);
    if (!m) return;
    const [, key, raw] = m;
    const line = i + 1;
    const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value === "") {
      issues.push({ file, line, key, problem: "empty", message: `${key} has an empty value` });
    } else if (PLACEHOLDERS.some((re) => re.test(value))) {
      issues.push({ file, line, key, problem: "placeholder", message: `${key} looks like a placeholder value` });
    }
    if (dockerEnvFile && /^(['"]).*\1$/.test(raw.trim())) {
      issues.push({
        file, line, key, problem: "quoted-for-docker",
        message: `${key} is quoted; docker --env-file passes the quotes as part of the value`,
      });
    }
  });
  return issues;
}
