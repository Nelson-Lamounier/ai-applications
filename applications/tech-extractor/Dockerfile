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
# ingestion Dockerfile's full manifest copy; add tech-extractor).
COPY applications/shared/package.json         ./applications/shared/
COPY applications/tech-extractor/package.json ./applications/tech-extractor/
COPY applications/ingestion/package.json      ./applications/ingestion/
COPY api/public-api/package.json              ./api/public-api/
COPY applications/article-pipeline/package.json  ./applications/article-pipeline/
COPY applications/job-strategist/package.json    ./applications/job-strategist/
COPY applications/chatbot/package.json           ./applications/chatbot/
COPY applications/chatbot-public/package.json    ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json           ./applications/self-healing/
COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY applications/synthetic-monitor/package.json      ./applications/synthetic-monitor/
COPY applications/platform-job-watcher/package.json   ./applications/platform-job-watcher/
COPY packages/script-utils/package.json          ./packages/script-utils/
COPY infra/package.json                          ./infra/
RUN yarn install --immutable

COPY applications/shared/tsconfig.json         ./applications/shared/
COPY applications/shared/src                   ./applications/shared/src/
COPY applications/tech-extractor/tsconfig.json ./applications/tech-extractor/
COPY applications/tech-extractor/src           ./applications/tech-extractor/src/

RUN node_modules/.bin/tsc -b applications/shared applications/tech-extractor --force \
 || [ -f applications/tech-extractor/dist/run-tech-extract.js ]

# Patch @bedrock/shared main -> dist for runtime require().
RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"

RUN yarn workspaces focus @bedrock/shared @bedrock/tech-extractor --production

# ── Stage 2: Syft binary ─────────────────────────────────────────────────────
# Official image ships a static binary that runs on alpine/musl.
# Pinned (not :latest) for reproducible builds — bump deliberately.
FROM anchore/syft:v1.44.0 AS syft

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001
WORKDIR /app

# Copied artifacts are read-only (--chmod): the non-root runtime user must not
# be able to modify its own code/deps at runtime (defense-in-depth). Directories
# use 0555 (traversable + readable, no write); standalone files use 0444.
# The only writable path at runtime is the /work emptyDir mounted by the Job.
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/applications/tech-extractor/dist ./applications/tech-extractor/dist
COPY --from=builder --chown=appuser:appgroup --chmod=0444 /app/applications/tech-extractor/package.json ./applications/tech-extractor/
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/applications/shared/dist ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup --chmod=0444 /app/applications/shared/package.json ./applications/shared/
COPY --from=builder --chown=appuser:appgroup --chmod=0555 /app/node_modules ./node_modules

# Syft binary on PATH (read + execute, no write); SYFT_BIN points the extractor at it.
COPY --from=syft --chmod=0555 /syft /usr/local/bin/syft
ENV SYFT_BIN=/usr/local/bin/syft

# web-tree-sitter ships its wasm in node_modules; grammar .wasm files are
# resolved at runtime from node_modules/<grammar-pkg>. If Phase 2 adds the live
# AST pass, COPY any extra .wasm grammar files here. (Phase 1 regex pass needs none.)

USER appuser
WORKDIR /app/applications/tech-extractor
CMD ["node", "dist/run-tech-extract.js"]
