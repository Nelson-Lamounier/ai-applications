# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Compiles @bedrock/shared and @bedrock/article-pipeline, then prunes devDeps.
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./
COPY applications/tsconfig.json ./applications/

# All workspace manifests are required so `yarn install` resolves the
# lockfile unambiguously — tsc, @types/jest, @types/node are spread across
# sibling workspaces in the root yarn.lock.
COPY applications/shared/package.json            ./applications/shared/
COPY applications/article-pipeline/package.json  ./applications/article-pipeline/
COPY applications/ontology-importer/package.json ./applications/ontology-importer/
COPY applications/synthetic-monitor/package.json ./applications/synthetic-monitor/
COPY applications/ingestion/package.json         ./applications/ingestion/
COPY applications/job-strategist/package.json    ./applications/job-strategist/
COPY applications/chatbot-public/package.json    ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json           ./applications/self-healing/
COPY applications/resume-import-processor/package.json  ./applications/resume-import-processor/
COPY applications/platform-job-watcher/package.json   ./applications/platform-job-watcher/
COPY api/public-api/package.json                 ./api/public-api/
COPY packages/script-utils/package.json          ./packages/script-utils/
COPY infra/package.json                          ./infra/
COPY mcp-servers/tucaken-smoke/package.json     ./mcp-servers/tucaken-smoke/
RUN yarn install --immutable

COPY applications/shared/tsconfig.json           ./applications/shared/
COPY applications/shared/src                     ./applications/shared/src/
COPY applications/article-pipeline/tsconfig.json ./applications/article-pipeline/
COPY applications/article-pipeline/src           ./applications/article-pipeline/src/

# Build via TypeScript project references. tsc -b emits JS even when it
# reports rootDir-boundary diagnostics from the workspace path mapping into
# shared's source; success is gated on the entrypoint being produced.
RUN node_modules/.bin/tsc -b applications/shared applications/article-pipeline --force \
 || [ -f applications/article-pipeline/dist/run-pipeline.js ]

# Patch @bedrock/shared/package.json so runtime require() resolves to dist/index.js
RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"

RUN yarn workspaces focus @bedrock/shared @bedrock/article-pipeline --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/applications/article-pipeline/dist         ./applications/article-pipeline/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/article-pipeline/package.json ./applications/article-pipeline/
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/dist                   ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/package.json           ./applications/shared/
COPY --from=builder --chown=appuser:appgroup /app/node_modules                               ./node_modules

USER appuser

WORKDIR /app/applications/article-pipeline

# K8s Job default; the Job spec may override CMD.
CMD ["node", "dist/run-pipeline.js"]
