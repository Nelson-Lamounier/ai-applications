# justfile — AI Applications CI/CD recipes
# Requires: just (https://just.systems)

set shell := ["bash", "-euo", "pipefail", "-c"]

# ── Code Quality ────────────────────────────────────────────────────────────

# Lint all TypeScript source (infra + applications)
[group('quality')]
lint:
    cd infra && yarn lint

# Fix lint issues
[group('quality')]
lint-fix:
    cd infra && yarn lint:fix

# Type-check all workspaces
[group('quality')]
typecheck:
    cd infra && yarn typecheck

# Build TypeScript
[group('quality')]
build:
    cd infra && yarn build

# Security audit — high severity and above
[group('quality')]
audit *ARGS:
    cd infra && yarn npm audit --all --recursive --no-deprecations --severity high {{ARGS}}

# Run CDK stack unit tests (infra/tests/unit/stacks)
[group('quality')]
test-stacks:
    cd infra && yarn test tests/unit/stacks --coverage

# Run Step Functions TestState integration tests
# Requires: TEST_SFN_ROLE_ARN env var, AWS credentials
[group('quality')]
test-sfn *ARGS:
    cd infra && yarn jest --config jest.integration.config.js {{ARGS}}

# Synthesise CDK stacks for CI validation (bedrock + self-healing, dev environment)
[group('quality')]
ci-synth-validate:
    #!/usr/bin/env bash
    set -uo pipefail
    cd infra
    FAILURES=0

    echo "==========================================="
    echo "Validating Bedrock Project (dev)"
    echo "==========================================="
    # CDK_BUNDLING_STACKS=[] skips Lambda bundling — validates CloudFormation
    # template structure only (imports/types caught by typecheck instead)
    if CDK_BUNDLING_STACKS='[]' npx cdk synth -c project=bedrock -c environment=dev --no-lookups --quiet; then
      echo "✓ Bedrock synth passed"
    else
      echo "✗ Bedrock synth FAILED"
      FAILURES=$((FAILURES + 1))
    fi

    echo ""
    echo "==========================================="
    echo "Validating Self-Healing Project (dev)"
    echo "==========================================="
    if CDK_BUNDLING_STACKS='[]' npx cdk synth -c project=self-healing -c environment=dev --no-lookups --quiet; then
      echo "✓ Self-Healing synth passed"
    else
      echo "✗ Self-Healing synth FAILED"
      FAILURES=$((FAILURES + 1))
    fi

    if [[ "$FAILURES" -gt 0 ]]; then
      echo ""
      echo "✗ $FAILURES project(s) failed CDK synthesis"
      exit 1
    fi
    echo ""
    echo "✓ All CDK projects synthesised successfully"

# ── CI Deploy Pipeline ──────────────────────────────────────────────────────

# CI preflight: validate inputs, verify credentials and bootstrap
[group('ci')]
ci-preflight *ARGS:
    npx tsx infra/scripts/ci/preflight-checks.ts {{ARGS}}

# CI rescue: detect and import orphaned CloudFormation resources before deploy
[group('ci')]
ci-cfn-rescue *ARGS:
    npx tsx infra/scripts/ci/cfn-import-rescue.ts {{ARGS}}

# CI deploy: deploy a specific CDK stack
# Usage: just ci-deploy Bedrock-Pipeline-development bedrock development
[group('ci')]
ci-deploy *ARGS:
    npx tsx infra/scripts/cd/deploy.ts {{ARGS}}

# CI diagnose: diagnose a failed CloudFormation stack deployment
[group('ci')]
ci-diagnose *ARGS:
    npx tsx infra/scripts/cd/diagnose-rollback.ts {{ARGS}} --mode diagnose

# CI rollback: rollback a failed deployment
[group('ci')]
ci-rollback *ARGS:
    npx tsx infra/scripts/cd/diagnose-rollback.ts {{ARGS}} --mode rollback

# CI failure report: aggregate multi-stack diagnostics for failed deployment
[group('ci')]
ci-failure-report *ARGS:
    npx tsx infra/scripts/cd/deployment-failure-report.ts {{ARGS}}

# CI finalize: collect outputs, write summary, save artifacts
[group('ci')]
ci-finalize-deployment *ARGS:
    npx tsx infra/scripts/cd/finalize.ts {{ARGS}}

# CI security scan: run Checkov against synthesised CDK templates
[group('ci')]
ci-security-scan *ARGS:
    npx tsx infra/scripts/ci/security-scan.ts {{ARGS}}

# CI synth: synthesise CDK stacks for a project/environment
[group('ci')]
ci-synth project environment:
    npx tsx infra/scripts/ci/synthesize.ts {{project}} {{environment}}

# ── Job Strategist ───────────────────────────────────────────────────────────

ECR_STRATEGIST := env_var_or_default("ECR_STRATEGIST", "")

# Run the full job-strategist end-to-end integration test.
# Manages the pgbouncer port-forward automatically — no split terminals needed.
# Reads PG credentials from the platform-rds-credentials k8s secret by default.
# Env overrides: see .env.strategist-integration (copy and fill in to customise).
#
# Usage:
#   just test-strategist-integration
#   just test-strategist-integration SKIP_BUILD=1          # skip tsc rebuild
#   just test-strategist-integration SKIP_CLEANUP=1        # keep RDS rows for inspection
#   just test-strategist-integration PG_PASSWORD=<secret>  # bypass k8s secret read
[group('strategist')]
test-strategist-integration *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    # Load .env.strategist-integration if present (values are additive; env vars already
    # set in the shell take precedence because we only export unset vars)
    if [[ -f .env.strategist-integration ]]; then
      while IFS='=' read -r key value || [[ -n "$key" ]]; do
        # Skip comments and blank lines
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${key// }" ]] && continue
        # Only export if not already set in the caller's environment
        key="${key// /}"
        value="${value// /}"
        [[ -n "$value" && -z "${!key:-}" ]] && export "$key=$value"
      done < .env.strategist-integration
    fi
    # Allow recipe-level overrides: just test-strategist-integration SKIP_BUILD=1
    for arg in {{ARGS}}; do export "$arg"; done
    npx tsx scripts/test-strategist-integration.ts

# Run the projects-migration (030/031) E2E test against a local Postgres.
# Creates and drops an ephemeral `tucaken_test_<ts>` database; requires the
# connecting role to have CREATEDB and a Postgres with pgvector available.
#
# Usage:
#   just test-projects-migration                                    # uses PGHOST/PGUSER/PGPASSWORD from env
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGSSL=disable just test-projects-migration
[group('rds')]
test-projects-migration:
    npx tsx scripts/test-projects-migration.ts

# Run the Phase 2A project-clustering E2E test against a local Postgres.
# Same prerequisites as test-projects-migration. Injects a mocked Bedrock
# clustering agent so no AWS credentials are required.
#
# Usage:
#   just test-projects-clustering
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGSSL=disable just test-projects-clustering
[group('rds')]
test-projects-clustering:
    npx tsx scripts/test-projects-clustering.ts

# Build the job-strategist Docker image locally.
[group('strategist')]
build-strategist:
    docker build \
      -f applications/job-strategist/Dockerfile \
      -t job-strategist:local \
      .

# Open a port-forward to pgbouncer for manual psql / inspection.
# Keep running in a separate terminal when using other strategist recipes.
[group('strategist')]
pgbouncer-tunnel:
    kubectl port-forward svc/pgbouncer 15432:5432 -n platform

# Push the local strategist image to ECR (requires: aws ecr get-login-password).
# Usage: just push-strategist [tag]
[group('strategist')]
push-strategist tag="local":
    #!/usr/bin/env bash
    set -euo pipefail
    ECR_REGISTRY=$(echo "{{ECR_STRATEGIST}}" | cut -d'/' -f1)
    aws ecr get-login-password --region eu-west-1 \
      | docker login --username AWS --password-stdin "$ECR_REGISTRY"
    docker tag job-strategist:{{tag}} {{ECR_STRATEGIST}}:{{tag}}
    docker push {{ECR_STRATEGIST}}:{{tag}}
    echo "Pushed {{ECR_STRATEGIST}}:{{tag}}"

# ── Resume Import Processor ──────────────────────────────────────────────────

ECR_RESUME    := env_var_or_default("ECR_RESUME", "")
RDS_HOST      := env_var_or_default("RDS_HOST_DEV", "")
ASSETS_BUCKET := env_var_or_default("ASSETS_BUCKET_DEV", "")

# Run PDF extraction integration test against live AWS Textract (no Docker needed)
[group('resume-processor')]
test-pdf-integration:
    NODE_OPTIONS=--experimental-vm-modules \
    node_modules/.bin/jest \
      --config applications/jest.config.js \
      --testPathPattern="pdf.integration.test" \
      --rootDir applications/resume-import-processor \
      --testTimeout=180000 \
      --verbose

# Build the resume-import-processor Docker image locally
[group('resume-processor')]
build-resume-processor:
    docker build \
      -f applications/resume-import-processor/Dockerfile \
      -t resume-import-processor:local \
      .

# Open a port-forward tunnel to dev RDS via a socat relay pod.
# Keep this running in a separate terminal before calling run-resume-processor.
[group('resume-processor')]
db-tunnel:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Launching socat relay pod..."
    kubectl delete pod rds-relay -n admin-api --ignore-not-found --wait=false
    kubectl run rds-relay \
      --image=alpine/socat \
      --restart=Never \
      --namespace=admin-api \
      -- TCP-LISTEN:5432,fork,reuseaddr TCP:{{RDS_HOST}}:5432 &
    KUBECTL_PID=$!
    cleanup() {
      kubectl delete pod rds-relay -n admin-api --ignore-not-found
      kill "$KUBECTL_PID" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    echo "Waiting for relay pod to become ready..."
    kubectl wait pod/rds-relay -n admin-api --for=condition=Ready --timeout=60s
    echo "Tunnel open: localhost:5432 → {{RDS_HOST}}:5432  (Ctrl-C to close)"
    kubectl port-forward pod/rds-relay 5432:5432 -n admin-api

# Run the processor container locally against dev AWS + RDS.
# Requires db-tunnel open in another terminal.
# Usage: just run-resume-processor <import-id> <user-id> <s3-key>
[group('resume-processor')]
run-resume-processor import_id user_id s3_key:
    #!/usr/bin/env bash
    set -euo pipefail
    SECRET=$(aws secretsmanager get-secret-value \
      --secret-id k8s-development/platform-rds/credentials \
      --query SecretString --output text)
    PG_PASS=$(echo "$SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

    # Export SSO credentials as KEY=VALUE pairs for docker -e
    while IFS= read -r line; do
      line="${line#export }"        # strip leading 'export '
      [[ "$line" == AWS_CREDENTIAL_EXPIRATION* ]] && continue
      CRED_FLAGS+=("-e" "$line")
    done < <(aws configure export-credentials --format env)

    # On macOS Docker Desktop --network host is unavailable;
    # host.docker.internal resolves to the host running the port-forward.
    docker run --rm \
      "${CRED_FLAGS[@]}" \
      -e AWS_REGION=eu-west-1 \
      -e IMPORT_ID={{import_id}} \
      -e USER_ID={{user_id}} \
      -e S3_KEY={{s3_key}} \
      -e CONTENT_TYPE=application/pdf \
      -e ASSETS_BUCKET_NAME={{ASSETS_BUCKET}} \
      -e PG_HOST=host.docker.internal \
      -e PG_PORT=5432 \
      -e PG_DATABASE=tucaken \
      -e PG_USER=postgres \
      -e PG_PASSWORD="$PG_PASS" \
      resume-import-processor:local

# ── GitHub Workflow Dispatch ─────────────────────────────────────────────────

# Trigger a GitHub Actions workflow by file name
# Usage: just gh-dispatch deploy-bedrock.yml
#        just gh-dispatch deploy-bedrock.yml --ref main
[group('ci')]
gh-dispatch workflow *ARGS:
    gh workflow run {{workflow}} --repo nelson-lamounier/ai-applications {{ARGS}}

# ── E2E Smoke (real Bedrock, dev account — NEVER in CI) ──────────────────────

# Run the end-to-end smoke suite against the deployed dev account.
# Usage: just smoke-e2e                 # all flows
#        just smoke-e2e job-strategist  # one flow
#        just smoke-e2e chatbots SKIP_CLEANUP=1
[group('smoke')]
smoke-e2e *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -f .env.smoke ]]; then
      while IFS='=' read -r key value || [[ -n "$key" ]]; do
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${key// }" ]] && continue
        key="${key// /}"; value="${value// /}"
        [[ -n "$value" && -z "${!key:-}" ]] && export "$key=$value"
      done < .env.smoke
    fi
    flows=(); for arg in {{ARGS}}; do
      if [[ "$arg" == *=* ]]; then export "$arg"; else flows+=("$arg"); fi
    done
    npx tsx scripts/smoke-e2e.ts "${flows[@]:-all}"

# Open the pgbouncer tunnel for manual psql inspection during a smoke run.
[group('smoke')]
smoke-tunnel:
    kubectl port-forward svc/pgbouncer 15432:5432 -n platform
