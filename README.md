# EnvSure

Fails a pull request when it references an environment variable that isn't configured
in every deployment environment — before the merge, instead of a 503 after it.

```
src/billing.ts:42  STRIPE_WEBHOOK_SECRET missing in production; present in staging
.env.production:1  STRIPE_SECRET_KEY has an empty value
```

EnvSure reads secret and variable **names only**. GitHub's secret endpoints never
return values; variable values are discarded on receipt.

## Quick start (Vercel)

`.github/envsure.yml`:

```yaml
environments: [preview, production]
excludePaths: [node_modules/, dist/, .github/]
sources:
  production: [{ vercel: { project: my-app, target: production } }]
  preview:    [{ vercel: { project: my-app, target: preview } }]
```

`.github/workflows/envsure.yml`:

```yaml
name: envsure
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  envsure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: sekharsdet/envsure@v1
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

Swap `vercel` for Render, Netlify, Heroku, Railway, Fly.io, Cloudflare, DigitalOcean, Doppler, AWS,
Google Cloud, Azure or any command (see [Platform sources](#platform-sources)), or leave `sources` out to
check GitHub Environments, which needs the `token` input described under [GitHub Action](#github-action).

## What it checks

- References added in the PR (`git diff base...HEAD`):
  - JS/TS: `process.env.X`, `process.env["X"]`, `import.meta.env.X`, `Bun.env.X`, `Deno.env.get("X")`
  - Python: `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`
  - Go: `os.Getenv("X")`, `os.LookupEnv("X")`
  - Ruby: `ENV["X"]`, `ENV.fetch("X")`
  - Workflows: `${{ secrets.X }}`, `${{ vars.X }}`
  - Keys in `.env.example` / `.env.sample` / `.env.template`
- Each name must exist as a repository, organization-visible, or environment secret/variable
  in every environment listed in the config.
- Workflow `secrets.X` / `vars.X` are checked against the job's own `environment:`. A job without
  one only sees repository/organization values, so a secret stored only in `production` is
  reported for it (it would silently resolve to an empty string at runtime).
- Committed `.env` / `.env.*` files with empty or placeholder values (`sk_test_…`, `your_key_here`, `changeme`).

Platform-provided names (`PORT`, `NODE_ENV`, `GITHUB_*`, `VERCEL_*`, …) are ignored by default.
Dynamic lookups such as `process.env[name]` are not detected.

## Config

`.github/envsure.yml`:

```yaml
environments: [staging, production]   # GitHub Environments to require
ignore: [SENTRY_*, LOCAL_ONLY_FLAG]   # extra names to skip; trailing * is a prefix match
excludePaths: [node_modules/, dist/, test/fixtures/]
```

With no `environments`, names only need to exist at repository/organization level.

## Platform sources

By default each environment is checked against GitHub. When an environment's runtime values live on a
hosting platform or secret store, list them under `sources`; a code reference then has to exist in **one of
that environment's sources**. Workflow `${{ secrets.X }}` / `${{ vars.X }}` references are always checked
against GitHub, because that is where Actions resolves them.

```yaml
environments: [staging, production]
sources:
  production:
    - vercel: { project: web, target: production, team: acme }
    - aws-ssm: { path: /web/prod, region: us-east-1 }
  staging:
    - render: { service: srv-abc123, envGroups: [evg-shared] }
    - github: {}            # also accept this environment's GitHub secrets/variables
```

Credentials are read from environment variables only, never from the config. Every source accepts
`tokenEnv: NAME` to read a different variable (e.g. two Vercel teams). Only names are kept: list endpoints that
also return values (Vercel, Render, Heroku, ...) have them discarded on receipt, and error messages never include
response bodies.

| Source | Options | Credential |
|---|---|---|
| `vercel` | `project`, `target` (production/preview/development), `team`, `gitBranch` | `VERCEL_TOKEN` |
| `render` | `service` and/or `envGroups: [...]` | `RENDER_API_KEY` |
| `netlify` | `account`, `site`, `context` (production, deploy-preview, branch-deploy, `branch:<name>`) | `NETLIFY_AUTH_TOKEN` |
| `heroku` | `app` | `HEROKU_API_KEY` |
| `railway` | `project`, `environment` (id), `service` | `RAILWAY_API_TOKEN` (account) or `RAILWAY_TOKEN` (project) |
| `fly` | `app`, `config` (fly.toml whose `[env]` keys count too) | `FLY_API_TOKEN` |
| `cloudflare` | `account`, and `worker` or `pages` (+ `deployment`: production/preview) | `CLOUDFLARE_API_TOKEN` |
| `digitalocean` | `app`, `component` | `DIGITALOCEAN_ACCESS_TOKEN` |
| `doppler` | `project`, `config` | `DOPPLER_TOKEN` |
| `aws-ssm` | `path`, `region`, `recursive`, `profile` | AWS default chain (env keys, profile/SSO, GitHub OIDC role) |
| `aws-secretsmanager` | `prefix`, `region`, `profile` | AWS default chain |
| `gcp-secret-manager` | `project`, `prefix` | `GOOGLE_OAUTH_ACCESS_TOKEN`, or `gcloud` login |
| `gcp-cloud-run` | `project`, `region`, `service` | same as above |
| `azure-keyvault` | `vault` (`db-url` is matched as `DB_URL`) | `AZURE_KEYVAULT_TOKEN`, or `az` login |
| `azure-appservice` | `subscription`, `resourceGroup`, `app`, `slot` | `AZURE_MANAGEMENT_TOKEN`, or `az` login |
| `command` | `run` (+ `shell`): prints names one per line, as a JSON array, or as `KEY=value` lines | whatever the command needs |
| `file` | `path` to a names file in the repo (same formats) | — |

`command` covers anything else, e.g. Kubernetes:
`- command: { run: "kubectl get secret web -o json | jq -r '.data | keys[]'" }`.
For AWS SSM/Secrets Manager only `DescribeParameters`/`ListSecrets` are called, which never return values, so a
role limited to `ssm:DescribeParameters` and `secretsmanager:ListSecrets` is enough.

If every environment uses platform sources and no workflow files are scanned, no GitHub token is needed.
Each API base can be overridden with `ENVSURE_<SOURCE>_API_URL` (e.g. `ENVSURE_VERCEL_API_URL`) for
proxies, sovereign clouds, or tests.

## GitHub Action

To check GitHub Environments and workflow secrets, EnvSure needs a token that can list them. The
default `GITHUB_TOKEN` cannot, so use a GitHub App installation token
(or a fine-grained PAT) with **Secrets: read, Variables: read, Environments: read, Actions: read**.

```yaml
name: envsure
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  envsure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/create-github-app-token@v1
        id: app
        with:
          app-id: ${{ vars.ENVSURE_APP_ID }}
          private-key: ${{ secrets.ENVSURE_APP_KEY }}
      - uses: sekharsdet/envsure@v1
        with:
          token: ${{ steps.app.outputs.token }}
```

Inputs: `token` (needed only when GitHub is checked), `comment-token` (default `github.token`), `config`, `fail-on-missing` (default `true`),
`comment-on-success` (default `false`). Outputs: `missing`, `dotenv-issues` (counts).

On pull requests the config is read from the **base commit**, so a PR cannot loosen its own check or add a
`command` source that runs with your platform tokens; config changes take effect once merged.

Platform credentials go in the step's `env:`. AWS works with OIDC, so no long-lived keys are needed:

```yaml
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      # ... checkout and app token as above
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/envsure-read-names
          aws-region: us-east-1
      - uses: sekharsdet/envsure@v1
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}
        with:
          token: ${{ steps.app.outputs.token }}
```

Runs on Linux, Windows and macOS runners (Node 24 runtime); CI exercises the Action on all three.

## CLI

Needs Node.js 22 or newer (Node 20 is end-of-life and the AWS SDK is dropping it). Works on Linux, macOS and Windows.

```sh
npm run build
GITHUB_TOKEN=... node dist/cli.js --repo owner/name --base origin/main
node dist/cli.js --offline            # list references without calling GitHub
```

Exit codes: `0` clean, `1` findings, `2` usage or API error.

## Development

```sh
npm install
npm run check   # typecheck + tests
npm run build   # bundles dist/cli.js and dist/action.js
npm run test:integration   # built CLI + Action against a local mock of every platform (after build)
npm run e2e     # end-to-end against real GitHub (needs `gh auth login` with repo scope) and Fly.io (if `fly` is logged in)
```

`npm run e2e` creates or reuses a private sandbox repo (`<you>/envcontract-e2e`, override with `E2E_REPO`)
with dummy secrets and variables in `staging` and `production`, opens a fixture PR, and runs `dist/cli.js`
and `dist/action.js` against it: every scanner pattern, job-environment scoping, pagination, config
variants, `.env` lint, PR comment upsert, Action inputs and error exits. Set `E2E_DIST` to test another build.
Your gh token is passed to the tools at runtime only; it is never stored in the sandbox.
