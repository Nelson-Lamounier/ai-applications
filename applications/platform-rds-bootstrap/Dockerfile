FROM node:22-alpine AS builder
WORKDIR /app
# Build context is repo root (ai-applications/) — all paths relative to it.
COPY applications/platform-rds-bootstrap/package.json ./
RUN npm install
COPY applications/platform-rds-bootstrap/tsconfig.json ./
COPY applications/platform-rds-bootstrap/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY applications/platform-rds-bootstrap/package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
