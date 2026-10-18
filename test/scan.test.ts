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
