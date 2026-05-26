# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Compiles @bedrock/shared and @bedrock/job-strategist, then prunes devDeps.
# Image carries TWO entrypoints (run-pipeline.js, run-coach.js); the K8s Job
# spec selects which one via its `command:` field.
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./
COPY applications/tsconfig.json ./applications/

COPY applications/shared/package.json           ./applications/shared/
COPY applications/job-strategist/package.json   ./applications/job-strategist/
COPY applications/ontology-importer/package.json ./applications/ontology-importer/
COPY applications/article-pipeline/package.json ./applications/article-pipeline/
COPY applications/ingestion/package.json        ./applications/ingestion/
COPY applications/chatbot/package.json          ./applications/chatbot/
COPY applications/chatbot-public/package.json   ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json          ./applications/self-healing/
COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY applications/platform-job-watcher/package.json  ./applications/platform-job-watcher/
COPY api/public-api/package.json                ./api/public-api/
COPY packages/script-utils/package.json         ./packages/script-utils/
COPY infra/package.json                         ./infra/
RUN yarn install --immutable

COPY applications/shared/tsconfig.json         ./applications/shared/
COPY applications/shared/src                   ./applications/shared/src/
COPY applications/job-strategist/tsconfig.json ./applications/job-strategist/
COPY applications/job-strategist/src           ./applications/job-strategist/src/

# Build shared + job-strategist via project references; gate on entrypoint
# emission rather than tsc exit code (rootDir diagnostics from the path
# mapping into shared/src are non-fatal for emit).
RUN node_modules/.bin/tsc -b applications/shared applications/job-strategist --force \
 || ([ -f applications/job-strategist/dist/run-pipeline.js ] && [ -f applications/job-strategist/dist/run-coach.js ])

RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"

RUN yarn workspaces focus @bedrock/shared @bedrock/job-strategist --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/applications/job-strategist/dist         ./applications/job-strategist/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/job-strategist/package.json ./applications/job-strategist/
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/dist                 ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/package.json         ./applications/shared/
COPY --from=builder --chown=appuser:appgroup /app/node_modules                             ./node_modules

USER appuser

WORKDIR /app/applications/job-strategist

# Default entrypoint (analysis pipeline). The coach Job overrides via spec.command.
CMD ["node", "dist/run-pipeline.js"]
