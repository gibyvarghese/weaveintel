# ─── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Native build toolchain for native modules (better-sqlite3, etc.)
RUN apk add --no-cache python3 make g++ libc6-compat

# Install dependencies (workspaces include packages/* and apps/*)
COPY package.json package-lock.json* turbo.json tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
RUN npm ci
RUN npx turbo build

# ─── Production stage ─────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Security: run as non-root
RUN addgroup -S geneweave && adduser -S geneweave -G geneweave

# Copy built monorepo
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/turbo.json ./
COPY --from=builder /app/tsconfig.base.json /app/tsconfig.json ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/ apps/
COPY --from=builder /app/node_modules/ node_modules/
COPY deploy/ deploy/

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R geneweave:geneweave /app/data

# Runtime config
ENV NODE_ENV=production
ENV PORT=3500
ENV DATABASE_PATH=/app/data/geneweave.db

EXPOSE 3500

USER geneweave

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3500/api/auth/me || exit 1

CMD ["npx", "tsx", "deploy/server.ts"]
