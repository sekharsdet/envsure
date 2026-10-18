import { describe, expect, it } from "vitest";
import { REPO_SCOPE } from "../src/check.js";
import { renderMarkdown, renderText, scopeLabel } from "../src/report.js";

const finding = {
  name: "STRIPE_KEY",
  refs: [{ name: "STRIPE_KEY", file: "src/app.ts", line: 2, kind: "code" as const }],
  missingIn: [REPO_SCOPE, "production"],
  presentIn: ["staging"],
};

describe("report", () => {
  it("labels the repository scope for people", () => {
    expect(scopeLabel(REPO_SCOPE)).toBe("repository");
    expect(scopeLabel("production")).toBe("production");
  });

  it("renders text without the internal scope token", () => {
    expect(renderText([finding], [])).toBe("src/app.ts:2  STRIPE_KEY missing in repository, production; present in staging");
  });

  it("renders a markdown row", () => {
    expect(renderMarkdown([finding], [])).toContain("| `STRIPE_KEY` | `src/app.ts:2` | repository, `production` | `staging` |");
  });
});
