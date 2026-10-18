// False positives and false negatives seen in real repositories.
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import { lintDotenv } from "../../src/dotenv.js";
import { scanText } from "../../src/scan.js";

const names = (file: string, text: string) => scanText(file, text).map((r) => r.name);

describe("commented-out code is not a reference", () => {
  it.each([
    ["a.ts", "// const x = process.env.OLD_JS;\n/* process.env.BLOCK_START */\n * process.env.JSDOC_LINE\nprocess.env.REAL_JS;"],
    ["a.py", "# os.environ['OLD_PY']\nos.environ['REAL_PY']"],
    ["a.rb", "# ENV['OLD_RB']\nENV['REAL_RB']"],
    ["main.go", "// os.Getenv(\"OLD_GO\")\nos.Getenv(\"REAL_GO\")"],
    ["compose.yml", "# image: ${OLD_COMPOSE}\nimage: ${REAL_COMPOSE}"],
    [".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      # - run: echo ${{ secrets.OLD_WF }}\n      - run: echo ${{ secrets.REAL_WF }}"],
  ])("%s", (file, text) => {
    const found = names(file, text);
    expect(found.some((n) => n.startsWith("OLD") || n === "BLOCK_START" || n === "JSDOC_LINE")).toBe(false);
    expect(found.some((n) => n.startsWith("REAL"))).toBe(true);
  });
});

describe("framework built-ins are not configuration", () => {
  it("Vite and Astro import.meta.env built-ins", () => {
    const src = "import.meta.env.MODE; import.meta.env.DEV; import.meta.env.PROD; import.meta.env.SSR;\n" +
      "import.meta.env.BASE_URL; import.meta.env.SITE; import.meta.env.ASSETS_PREFIX; import.meta.env.VITE_REAL;";
    expect(names("a.ts", src)).toEqual(["VITE_REAL"]);
  });
  it("process.env.MODE is still a reference (only import.meta.env has built-ins)", () => {
    expect(names("a.ts", "process.env.MODE")).toEqual(["MODE"]);
  });
});

describe("GitHub workflows", () => {
  it("finds secrets and vars in `if:` conditions written without ${{ }}", () => {
    const wf = "jobs:\n  a:\n    if: vars.DEPLOY_ENABLED == 'true'\n    steps:\n      - if: secrets.SLACK_WEBHOOK != ''\n        run: x\n";
    expect(names(".github/workflows/ci.yml", wf)).toEqual(["DEPLOY_ENABLED", "SLACK_WEBHOOK"]);
  });

  it("skips secrets a reusable workflow receives from its caller", () => {
    const wf = [
      "on:",
      "  workflow_call:",
      "    secrets:",
      "      DEPLOY_KEY:",
      "        required: true",
      "jobs:",
      "  deploy:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ secrets.DEPLOY_KEY }} ${{ secrets.REPO_LEVEL }}",
    ].join("\n");
    expect(names(".github/workflows/reusable.yml", wf)).toEqual(["REPO_LEVEL"]);
  });

  it("does not treat text in a `run:` script as an expression", () => {
    expect(names(".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - run: echo secrets.NOT_AN_EXPRESSION\n")).toEqual([]);
  });

  it("handles multiple expressions on a line and expressions containing braces", () => {
    const wf = "jobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.A1 }} ${{ format('{0}', vars.B1) }} ${{ secrets.C1 }}\n";
    expect(names(".github/workflows/ci.yml", wf)).toEqual(["A1", "B1", "C1"]);
  });
});

describe(".env files", () => {
  const problems = (text: string) => lintDotenv(".env", text).map((i) => `${i.key}:${i.problem}`);
  it("treats an inline comment after `=` as an empty value", () => {
    expect(problems("A= # set me\nB=value # comment\nC=\"value # not a comment\"\n")).toEqual(["A:empty"]);
  });
  it("handles quotes, export and spacing", () => {
    expect(problems("export D=''\nE = \"\"\nF='x'\n")).toEqual(["D:empty", "E:empty"]);
  });
  it("does not flag ordinary URLs or local defaults as secrets", () => {
    expect(problems("SITE=https://example.com\nREDIS_URL=redis://localhost:6379\nLOG_LEVEL=debug\nPORT=3000\n")).toEqual([]);
  });
});

describe("config mistakes are caught, not silently ignored", () => {
  it("rejects unknown top-level keys with a suggestion", () => {
    expect(() => parseConfig("enviroments: [production]\n")).toThrow(/unknown key "enviroments".*did you mean "environments"/);
  });
  it("accepts a UTF-8 byte order mark", () => {
    expect(parseConfig("\uFEFFenvironments: [production]\n").environments).toEqual(["production"]);
  });
  it("rejects duplicate environments", () => {
    expect(() => parseConfig("environments: [prod, prod]\n")).toThrow(/duplicate/);
  });
});
