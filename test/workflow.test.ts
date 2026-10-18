import { describe, expect, it } from "vitest";
import { scanText } from "../src/scan.js";
import { jobScopes } from "../src/workflow.js";

const WF = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.TEST_KEY }}
  deploy:
    environment: production
    steps:
      - run: echo \${{ secrets.DEPLOY_KEY }}
  preview:
    environment:
      name: staging
      url: https://x
    steps:
      - run: echo \${{ vars.PREVIEW_URL }}
  dynamic:
    environment: \${{ inputs.env }}
    steps:
      - run: echo \${{ secrets.DYN_KEY }}
`;

describe("jobScopes", () => {
  it("finds job line ranges and environments", () => {
    expect(jobScopes(WF).map((j) => [j.job, j.startLine, j.endLine, j.environment])).toEqual([
      ["test", 3, 6, null],
      ["deploy", 7, 10, "production"],
      ["preview", 11, 16, "staging"],
      ["dynamic", 17, 20, undefined],
    ]);
  });

  it("tolerates non-workflow yaml", () => {
    expect(jobScopes("a: [1, 2]")).toEqual([]);
  });
});

describe("scanText on workflows", () => {
  it("attaches job environments to refs", () => {
    expect(scanText(".github/workflows/ci.yml", WF).map((r) => [r.name, r.environment])).toEqual([
      ["TEST_KEY", null],
      ["DEPLOY_KEY", "production"],
      ["PREVIEW_URL", "staging"],
      ["DYN_KEY", undefined],
    ]);
  });

  it("still scans files that fail to parse", () => {
    expect(scanText(".github/workflows/bad.yml", "jobs: [\n${{ secrets.X }}").map((r) => r.name)).toEqual(["X"]);
  });
});
