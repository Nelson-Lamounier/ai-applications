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
