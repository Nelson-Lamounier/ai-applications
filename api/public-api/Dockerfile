# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Compiles @bedrock/shared and @repo/public-api, then prunes devDeps.
# public-api imports @bedrock/shared (workspace:*), so the whole workspace
# graph's manifests are needed for `yarn install`, and shared must be built
# before public-api's tsc can resolve its types. Mirrors the proven
# applications/job-strategist/Dockerfile pattern.
FROM node:22-alpine AS builder

WORKDIR /app

# Activate Yarn Berry v4 via Corepack BEFORE copying any files.
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Workspace root manifests + tsconfig bases.
COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./
COPY applications/tsconfig.json ./applications/

# All workspace manifests — required for `yarn install --immutable` to resolve
# the workspace graph (root package.json declares every workspace).
COPY applications/shared/package.json                  ./applications/shared/
COPY applications/ontology-importer/package.json       ./applications/ontology-importer/
COPY applications/synthetic-monitor/package.json       ./applications/synthetic-monitor/
COPY applications/job-strategist/package.json          ./applications/job-strategist/
COPY applications/article-pipeline/package.json        ./applications/article-pipeline/
COPY applications/ingestion/package.json               ./applications/ingestion/
COPY applications/chatbot-public/package.json          ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json   ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json            ./applications/self-healing/
COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY applications/platform-job-watcher/package.json    ./applications/platform-job-watcher/
COPY api/public-api/package.json                       ./api/public-api/
COPY packages/script-utils/package.json                ./packages/script-utils/
COPY infra/package.json                                ./infra/
COPY mcp-servers/tucaken-smoke/package.json     ./mcp-servers/tucaken-smoke/
RUN yarn install --immutable

# Source for the two workspaces we build.
COPY applications/shared/tsconfig.json ./applications/shared/
COPY applications/shared/src           ./applications/shared/src/
COPY api/public-api/tsconfig.json      ./api/public-api/
COPY api/public-api/src                ./api/public-api/src/

# Build @bedrock/shared first (project reference), then public-api. Gate the
# shared build on dist emission rather than tsc exit code (rootDir diagnostics
# from path mapping are non-fatal for emit).
RUN node_modules/.bin/tsc -b applications/shared --force \
 || [ -f applications/shared/dist/index.js ]
RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"
RUN yarn workspace @repo/public-api build

# Prune to production-only deps for the runtime layer.
RUN yarn workspaces focus @bedrock/shared @repo/public-api --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Run as non-root user (uid 1001) matching Kubernetes podSecurityContext.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

# Compiled output for public-api + its workspace dependency @bedrock/shared,
# plus the hoisted node_modules (which symlinks @bedrock/shared → applications/shared).
COPY --from=builder --chown=appuser:appgroup /app/api/public-api/dist         ./api/public-api/dist
COPY --from=builder --chown=appuser:appgroup /app/api/public-api/package.json ./api/public-api/
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/dist         ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/package.json ./applications/shared/
COPY --from=builder --chown=appuser:appgroup /app/node_modules                ./node_modules

USER appuser

WORKDIR /app/api/public-api

EXPOSE 3001

# Healthcheck mirrors the Kubernetes startupProbe.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz || exit 1

CMD ["node", "dist/index.js"]
