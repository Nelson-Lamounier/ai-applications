# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Compiles @bedrock/shared and @bedrock/ingestion, then prunes devDependencies.
FROM node:22-alpine AS builder

WORKDIR /app

# Activate Yarn Berry v4 via Corepack BEFORE copying any files.
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Copy workspace root manifests.
COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./

# Workspace meta-tsconfig referenced by package tsconfigs (extends "../tsconfig.json").
COPY applications/tsconfig.json ./applications/

# Sibling-workspace manifests required for resolution.
COPY applications/shared/package.json   ./applications/shared/
COPY applications/ingestion/package.json ./applications/ingestion/
COPY applications/ontology-importer/package.json ./applications/ontology-importer/
COPY applications/synthetic-monitor/package.json ./applications/synthetic-monitor/

# Pull in every workspace manifest so `yarn install` resolves the lockfile
# unambiguously. We need a full install (not workspaces-focus) because tsc,
# @types/jest, and @types/node are scattered across sibling workspaces in
# the root yarn.lock. The runtime stage re-prunes via workspaces-focus.
COPY api/public-api/package.json                 ./api/public-api/
COPY applications/article-pipeline/package.json  ./applications/article-pipeline/
COPY applications/job-strategist/package.json    ./applications/job-strategist/
COPY applications/chatbot-public/package.json    ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json           ./applications/self-healing/
COPY applications/resume-import-processor/package.json  ./applications/resume-import-processor/
COPY applications/platform-job-watcher/package.json   ./applications/platform-job-watcher/
COPY packages/script-utils/package.json          ./packages/script-utils/
COPY infra/package.json                          ./infra/
COPY mcp-servers/tucaken-smoke/package.json     ./mcp-servers/tucaken-smoke/
RUN yarn install --immutable

# Copy source.
COPY applications/shared/tsconfig.json   ./applications/shared/
COPY applications/shared/src             ./applications/shared/src/
COPY applications/ingestion/tsconfig.json ./applications/ingestion/
COPY applications/ingestion/src          ./applications/ingestion/src/

# Build shared then the app via TypeScript project references. tsc -b emits
# JS even when it reports rootDir-boundary diagnostics (a known limitation
# of the workspace's tsconfig path mapping into shared's source); we gate
# success on the entrypoint being produced rather than tsc's exit code.
RUN node_modules/.bin/tsc -b applications/shared applications/ingestion --force \
 || [ -f applications/ingestion/dist/run-ingestion.js ]

# Patch @bedrock/shared/package.json so runtime require() resolves to dist/index.js
# (the source main field points at src/index.ts which Node cannot execute).
RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"

# Prune to production-only deps for the runtime layer.
RUN yarn workspaces focus @bedrock/shared @bedrock/ingestion --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

# Compiled output and production node_modules (hoisted at the workspace root).
COPY --from=builder --chown=appuser:appgroup /app/applications/ingestion/dist     ./applications/ingestion/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/ingestion/package.json ./applications/ingestion/
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/dist        ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/package.json ./applications/shared/
COPY --from=builder --chown=appuser:appgroup /app/node_modules                    ./node_modules

USER appuser

WORKDIR /app/applications/ingestion

# K8s Job — no HTTP server, no healthcheck.
CMD ["node", "dist/run-ingestion.js"]
