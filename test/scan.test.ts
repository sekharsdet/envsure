import { describe, expect, it } from "vitest";
import { addedLines, scanText } from "../src/scan.js";

const names = (file: string, text: string, lines?: Set<number>) => scanText(file, text, lines).map((r) => r.name);

describe("scanText", () => {
  it("finds JS/TS references", () => {
    const src = [
      "const a = process.env.STRIPE_KEY;",
      "const b = process.env['RESEND_KEY'] ?? process.env[\"OTHER\"];",
      "const c = import.meta.env.VITE_API_URL;",
      "const d = Deno.env.get('DENO_KEY'); const e = Bun.env.BUN_KEY;",
      "const dyn = process.env[name];",
    ].join("\n");
    expect(names("src/a.ts", src)).toEqual(["STRIPE_KEY", "RESEND_KEY", "OTHER", "VITE_API_URL", "DENO_KEY", "BUN_KEY"]);
  });

  it("finds destructured references", () => {
    expect(names("a.ts", 'const { API_KEY, DB_URL: db = "x", ...rest } = process.env;')).toEqual(["API_KEY", "DB_URL"]);
  });

  it("finds Python, Go and Ruby references", () => {
    expect(names("app.py", "os.environ['DB_URL']\nos.getenv(\"A\")\nos.environ.get('B', 'x')")).toEqual(["DB_URL", "A", "B"]);
    expect(names("main.go", 'os.Getenv("GO_KEY")\nos.LookupEnv("GO_OTHER")')).toEqual(["GO_KEY", "GO_OTHER"]);
    expect(names("app.rb", "ENV['RB_KEY']\nENV.fetch(\"RB_OTHER\")")).toEqual(["RB_KEY", "RB_OTHER"]);
  });

  it("finds workflow secrets and vars with kinds", () => {
    const wf = "env:\n  A: ${{ secrets.DEPLOY_KEY }}\n  B: ${{ vars.REGION || 'x' }}\n";
    expect(scanText(".github/workflows/ci.yml", wf).map((r) => [r.name, r.kind, r.line])).toEqual([
      ["DEPLOY_KEY", "workflow-secret", 2],
      ["REGION", "workflow-var", 3],
    ]);
  });

  it("finds JVM, C#, PHP, Rust, Elixir, Swift and Prisma references", () => {
    expect(names("App.java", 'String a = System.getenv("JAVA_KEY");')).toEqual(["JAVA_KEY"]);
    expect(names("App.kt", 'val a = System.getenv("KOTLIN_KEY")')).toEqual(["KOTLIN_KEY"]);
    expect(names("Program.cs", 'var a = Environment.GetEnvironmentVariable("CS_KEY");')).toEqual(["CS_KEY"]);
    expect(names("index.php", "getenv('PHP_A'); $_ENV[\"PHP_B\"]; env('PHP_C', 'x'); $this->env('NOPE'); Foo::env('NOPE2');"))
      .toEqual(["PHP_A", "PHP_B", "PHP_C"]);
    expect(names("main.rs", 'std::env::var("RS_A"); env::var_os("RS_B"); env!("RS_C"); option_env!("RS_D");'))
      .toEqual(["RS_A", "RS_B", "RS_C", "RS_D"]);
    expect(names("config.exs", 'System.get_env("EX_A")\nSystem.fetch_env!("EX_B")')).toEqual(["EX_A", "EX_B"]);
    expect(names("App.swift", 'ProcessInfo.processInfo.environment["SWIFT_KEY"]')).toEqual(["SWIFT_KEY"]);
    expect(names("schema.prisma", 'url = env("DATABASE_URL")\nshadowDatabaseUrl = env("SHADOW_DB")')).toEqual(["DATABASE_URL", "SHADOW_DB"]);
  });

  it("finds Python names imported from os", () => {
    expect(names("a.py", "from os import environ, getenv\nenviron['PY_A']\ngetenv('PY_B')\nmyenviron['NOPE']")).toEqual(["PY_A", "PY_B"]);
  });

  it("finds Docker Compose interpolation, skipping variables with defaults", () => {
    const compose = [
      "services:",
      "  web:",
      "    image: app:${TAG:-latest}",
      "    environment:",
      "      DATABASE_URL: ${DATABASE_URL}",
      "      API_KEY: ${API_KEY:?set API_KEY}",
      "      LOG: $LOG_LEVEL",
      "      LITERAL: $$NOT_A_VAR",
      "      OPTIONAL: ${OPTIONAL-x}",
    ].join("\n");
    expect(names("docker-compose.yml", compose)).toEqual(["DATABASE_URL", "API_KEY", "LOG_LEVEL"]);
    expect(names("compose.prod.yaml", "x: ${PROD_ONLY}")).toEqual(["PROD_ONLY"]);
  });

  it("finds multi-line destructuring with the right lines", () => {
    const src = "const {\n  API_KEY,\n  DB_URL: db = 'x',\n  lowercase,\n} = process.env;\n";
    expect(scanText("a.ts", src).map((r) => [r.name, r.line])).toEqual([["API_KEY", 2], ["DB_URL", 3]]);
    // Only the added line counts in a PR diff.
    expect(names("a.ts", src, new Set([3]))).toEqual(["DB_URL"]);
  });

  it("follows process.env aliases", () => {
    const src = [
      "const env = process.env;",
      "const e2 = import.meta.env",
      "export const a = env.ALIAS_A, b = env['ALIAS_B'], c = e2.ALIAS_C;",
      "const notAlias = process.env.DIRECT;",
      "other.env.NOPE; myenv.NOPE2;",
    ].join("\n");
    expect(names("a.ts", src)).toEqual(["ALIAS_A", "ALIAS_B", "ALIAS_C", "DIRECT"]);
    expect(names("b.ts", 'import { env } from "node:process";\nenv.FROM_IMPORT')).toEqual(["FROM_IMPORT"]);
    expect(names("c.ts", "env.NOT_BOUND")).toEqual([]);
  });

  it("finds keys declared in createEnv (t3-env)", () => {
    const src = [
      'import { createEnv } from "@t3-oss/env-nextjs";',
      "export const env = createEnv({",
      "  server: {",
      "    DATABASE_URL: z.string().url(),",
      "    NODE_ENV: z.enum([\"development\", \"production\"]),",
      "    OPTS: z.object({ NESTED_NOT_ENV: z.string() }),",
      "  },",
      "  client: { NEXT_PUBLIC_SITE: z.string() },",
      "  runtimeEnv: { DATABASE_URL: process.env.DATABASE_URL },",
      "});",
    ].join("\n");
    expect(scanText("env.ts", src).map((r) => `${r.name}:${r.line}`)).toEqual(
      ["DATABASE_URL:4", "NODE_ENV:5", "OPTS:6", "NEXT_PUBLIC_SITE:8", "DATABASE_URL:9"]);
  });

  it("reads keys from .env.example and ignores unknown files", () => {
    expect(names(".env.example", "# c\nexport A=\nB=1\n")).toEqual(["A", "B"]);
    expect(names("README.md", "process.env.NOPE")).toEqual([]);
  });

  it("limits to selected lines", () => {
    expect(names("a.js", "process.env.A\nprocess.env.B", new Set([2]))).toEqual(["B"]);
  });
});

describe("addedLines", () => {
  it("maps added lines from a -U0 diff", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@",
      "+x",
      "+y",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    const m = addedLines(diff);
    expect([...m.keys()]).toEqual(["src/a.ts"]);
    expect([...m.get("src/a.ts")!]).toEqual([4, 5, 12]);
  });
});
