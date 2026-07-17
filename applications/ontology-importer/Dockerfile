# syntax=docker/dockerfile:1
# (dockerfile frontend >= 1.4 required for `COPY --from ... --chmod`)
# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./
COPY applications/tsconfig.json ./applications/

# Sibling-workspace manifests required for lockfile resolution (mirror the
# ingestion Dockerfile's full manifest copy; add ontology-importer).
COPY applications/shared/package.json         ./applications/shared/
COPY applications/ontology-importer/package.json ./applications/ontology-importer/
COPY applications/ingestion/package.json      ./applications/ingestion/
COPY api/public-api/package.json              ./api/public-api/
COPY applications/article-pipeline/package.json  ./applications/article-pipeline/
COPY applications/job-strategist/package.json    ./applications/job-strategist/
COPY applications/chatbot-public/package.json    ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json           ./applications/self-healing/
COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY applications/synthetic-monitor/package.json      ./applications/synthetic-monitor/
COPY applications/platform-job-watcher/package.json   ./applications/platform-job-watcher/
COPY packages/script-utils/package.json          ./packages/script-utils/
COPY infra/package.json                          ./infra/
COPY mcp-servers/tucaken-smoke/package.json     ./mcp-servers/tucaken-smoke/
RUN yarn install --immutable

COPY applications/shared/tsconfig.json         ./applications/shared/
COPY applications/shared/src                   ./applications/shared/src/
COPY applications/ontology-importer/tsconfig.json ./applications/ontology-importer/
COPY applications/ontology-importer/src           ./applications/ontology-importer/src/
COPY applications/ontology-importer/data          ./applications/ontology-importer/data/

RUN node_modules/.bin/tsc -b applications/shared applications/ontology-importer --force \
 || [ -f applications/ontology-importer/dist/run-import.js ]

# Patch @bedrock/shared main -> dist for runtime require().
RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"

RUN yarn workspaces focus @bedrock/shared @bedrock/ontology-importer --production

# ── Stage 2: botocore data ───────────────────────────────────────────────────
# The AWS source reads service definitions from botocore's bundled JSON data.
# Pinned to a real release tag (not a branch) for reproducible builds — bump
# deliberately. Shallow single-branch clone keeps the stage small.
FROM alpine/git AS botocore
RUN git clone --depth 1 --branch 1.43.14 https://github.com/boto/botocore /botocore

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001
WORKDIR /app

# Copied artifacts are read-only (--chmod): the non-root runtime user must not
# be able to modify its own code/deps at runtime (defense-in-depth). Directories
# use 0555 (traversable + readable, no write); standalone files use 0444.
# The only writable path at runtime is the /work emptyDir mounted by the Job.
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/applications/ontology-importer/dist ./applications/ontology-importer/dist
# 0555 (not 0444): a directory needs the execute bit to be traversable, else the
# runtime user gets EACCES opening files inside it (caught by the dry-run Job).
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/applications/ontology-importer/data ./applications/ontology-importer/data
COPY --from=builder --chown=appuser:appgroup --chmod=0444 /app/applications/ontology-importer/package.json ./applications/ontology-importer/
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/applications/shared/dist ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup --chmod=0444 /app/applications/shared/package.json ./applications/shared/
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/node_modules ./node_modules

# botocore service-definition data (reference data, not executable code).
# BOTOCORE_DATA_DIR points the AWS source at the bundled JSON definitions.
COPY --from=botocore --chown=appuser:appgroup /botocore/botocore/data /opt/botocore/botocore/data
ENV BOTOCORE_DATA_DIR=/opt/botocore/botocore/data

USER appuser
WORKDIR /app/applications/ontology-importer
CMD ["node", "dist/run-import.js"]
