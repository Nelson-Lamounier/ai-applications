# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./
COPY applications/tsconfig.json ./applications/

COPY applications/synthetic-monitor/package.json ./applications/synthetic-monitor/
COPY applications/ontology-importer/package.json         ./applications/ontology-importer/

# Sibling workspace manifests for lockfile resolution
COPY applications/shared/package.json                    ./applications/shared/
COPY applications/resume-import-processor/package.json   ./applications/resume-import-processor/
COPY applications/ingestion/package.json                 ./applications/ingestion/
COPY api/public-api/package.json                         ./api/public-api/
COPY applications/article-pipeline/package.json          ./applications/article-pipeline/
COPY applications/job-strategist/package.json            ./applications/job-strategist/
COPY applications/chatbot-public/package.json            ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json     ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json              ./applications/self-healing/
COPY applications/platform-job-watcher/package.json      ./applications/platform-job-watcher/
COPY packages/script-utils/package.json                  ./packages/script-utils/
COPY infra/package.json                                  ./infra/
COPY mcp-servers/tucaken-smoke/package.json     ./mcp-servers/tucaken-smoke/
RUN yarn install --immutable

COPY applications/synthetic-monitor/tsconfig.json ./applications/synthetic-monitor/
COPY applications/synthetic-monitor/src           ./applications/synthetic-monitor/src/

# shared source required by tsc -b project references
COPY applications/shared/tsconfig.json ./applications/shared/
COPY applications/shared/src           ./applications/shared/src/

RUN node_modules/.bin/tsc -b applications/synthetic-monitor

RUN yarn workspaces focus @bedrock/synthetic-monitor --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/applications/synthetic-monitor/dist ./applications/synthetic-monitor/dist
COPY --from=builder /app/applications/shared/dist            ./applications/shared/dist

# FIXTURE_PATH defaults to /fixtures/sample-resume.pdf — mount a real resume PDF
# there via a ConfigMap (binaryData) on the CronJob. Not baked into the image so
# the sample can be rotated without a rebuild.
USER node
ENTRYPOINT ["node", "applications/synthetic-monitor/dist/check.js"]
