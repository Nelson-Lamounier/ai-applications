# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./

COPY applications/tsconfig.json ./applications/

COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/

# Sibling workspace manifests for lockfile resolution
COPY applications/shared/package.json              ./applications/shared/
COPY applications/ingestion/package.json           ./applications/ingestion/
COPY api/public-api/package.json                   ./api/public-api/
COPY applications/article-pipeline/package.json    ./applications/article-pipeline/
COPY applications/job-strategist/package.json      ./applications/job-strategist/
COPY applications/chatbot/package.json             ./applications/chatbot/
COPY applications/chatbot-public/package.json      ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json              ./applications/self-healing/
COPY applications/platform-job-watcher/package.json     ./applications/platform-job-watcher/
COPY packages/script-utils/package.json                 ./packages/script-utils/
COPY infra/package.json                                 ./infra/
RUN yarn install --immutable

COPY applications/resume-import-processor/tsconfig.json ./applications/resume-import-processor/
COPY applications/resume-import-processor/src            ./applications/resume-import-processor/src/

# shared source required by tsc -b project references
COPY applications/shared/tsconfig.json ./applications/shared/
COPY applications/shared/src           ./applications/shared/src/

RUN node_modules/.bin/tsc -b applications/resume-import-processor

RUN yarn workspaces focus @bedrock/resume-import-processor --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/applications/resume-import-processor/dist     ./applications/resume-import-processor/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY --from=builder --chown=appuser:appgroup /app/node_modules                                  ./node_modules
# @bedrock/shared is a workspace package — node_modules symlink resolves to this path
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/dist                      ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/package.json              ./applications/shared/package.json

USER appuser

WORKDIR /app/applications/resume-import-processor

CMD ["node", "dist/run-import.js"]
