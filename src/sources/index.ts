import { awsSecretsManager, awsSsm, azureAppService, azureKeyVault, gcpCloudRun, gcpSecretManager } from "./cloud.js";
import { command, file } from "./local.js";
import { cloudflare, digitalocean, doppler, fly, heroku, netlify, railway, render, vercel } from "./platforms.js";
import type { SourceDef } from "./types.js";

/** `github` is handled in run.ts because it shares the GitHub inventory used for workflow refs. */
export const SOURCES: Record<string, SourceDef> = {
  vercel,
  render,
  netlify,
  heroku,
  railway,
  fly,
  cloudflare,
  digitalocean,
  doppler,
  "aws-ssm": awsSsm,
  "aws-secretsmanager": awsSecretsManager,
  "gcp-secret-manager": gcpSecretManager,
  "gcp-cloud-run": gcpCloudRun,
  "azure-keyvault": azureKeyVault,
  "azure-appservice": azureAppService,
  command,
  file,
};

export const SOURCE_TYPES = ["github", ...Object.keys(SOURCES)];
