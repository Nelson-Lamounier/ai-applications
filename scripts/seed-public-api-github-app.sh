#!/usr/bin/env bash
# Seed the public-api GitHub App secret (k8s/development/public-api-github-app)
# with the { appId, privateKeyPem, webhookSecret } shape public-api's
# lib/githubAppSecrets.ts expects.
#
# The Secrets Manager *resource* is created by CDK (data-stack.ts
# PublicApiGithubAppSecret, RETAIN). This script only sets its VALUE,
# assembled from existing material so no new GitHub App credentials are needed:
#   - appId         <- SM   k8s/development/tucaken-github-app .github_app_id
#   - privateKeyPem <- SM   k8s/development/tucaken-github-app .github_app_private_key
#   - webhookSecret <- SSM  /k8s/development/tucaken-webhook-secret
#
# Idempotent. Run after `cdk deploy Data-development`. Requires jq.
#   AWS_PROFILE=dev-account ./scripts/seed-public-api-github-app.sh
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
SRC_SECRET="k8s/development/tucaken-github-app"
WEBHOOK_SSM="/k8s/development/tucaken-webhook-secret"
DEST_SECRET="k8s/development/public-api-github-app"

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

echo "Reading source GitHub App material…"
src=$(aws secretsmanager get-secret-value --secret-id "$SRC_SECRET" --region "$REGION" --query SecretString --output text)
app_id=$(jq -r '.github_app_id // empty' <<<"$src")
private_key=$(jq -r '.github_app_private_key // empty' <<<"$src")
webhook=$(aws ssm get-parameter --name "$WEBHOOK_SSM" --with-decryption --region "$REGION" --query Parameter.Value --output text)

# Fail loudly if any component is missing (never write a partial secret).
[ -n "$app_id" ]      || { echo "ERROR: github_app_id empty in $SRC_SECRET" >&2; exit 1; }
[ -n "$private_key" ] || { echo "ERROR: github_app_private_key empty in $SRC_SECRET" >&2; exit 1; }
[ -n "$webhook" ]     || { echo "ERROR: webhook secret empty at $WEBHOOK_SSM" >&2; exit 1; }

payload=$(jq -n --arg a "$app_id" --arg k "$private_key" --arg w "$webhook" \
  '{appId:$a, privateKeyPem:$k, webhookSecret:$w}')

echo "Writing $DEST_SECRET…"
aws secretsmanager put-secret-value --secret-id "$DEST_SECRET" --region "$REGION" \
  --secret-string "$payload" >/dev/null

echo "Seeded $DEST_SECRET with keys: appId, privateKeyPem, webhookSecret."
