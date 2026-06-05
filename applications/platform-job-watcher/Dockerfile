# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./

COPY applications/tsconfig.json ./applications/

COPY applications/platform-job-watcher/package.json ./applications/platform-job-watcher/

# Sibling workspace manifests for lockfile resolution
COPY applications/shared/package.json              ./applications/shared/
COPY applications/ontology-importer/package.json   ./applications/ontology-importer/
COPY applications/tech-extractor/package.json      ./applications/tech-extractor/
COPY applications/synthetic-monitor/package.json   ./applications/synthetic-monitor/
COPY applications/ingestion/package.json           ./applications/ingestion/
COPY api/public-api/package.json                   ./api/public-api/
COPY applications/article-pipeline/package.json    ./applications/article-pipeline/
COPY applications/job-strategist/package.json      ./applications/job-strategist/
COPY applications/chatbot/package.json             ./applications/chatbot/
COPY applications/chatbot-public/package.json      ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json        ./applications/self-healing/
COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY packages/script-utils/package.json            ./packages/script-utils/
COPY infra/package.json                            ./infra/
COPY mcp-servers/tucaken-smoke/package.json     ./mcp-servers/tucaken-smoke/
RUN yarn install --immutable

COPY applications/platform-job-watcher/tsconfig.json ./applications/platform-job-watcher/
COPY applications/platform-job-watcher/src            ./applications/platform-job-watcher/src/

RUN node_modules/.bin/tsc -b applications/platform-job-watcher --force \
 || [ -f applications/platform-job-watcher/dist/run-watcher.js ]

RUN yarn workspaces focus @platform/job-watcher --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/applications/platform-job-watcher/dist     ./applications/platform-job-watcher/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/platform-job-watcher/package.json ./applications/platform-job-watcher/
COPY --from=builder --chown=appuser:appgroup /app/node_modules                                  ./node_modules

USER appuser

WORKDIR /app/applications/platform-job-watcher

CMD ["node", "dist/run-watcher.js"]
