# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# QueryVault — production container (Phase 6B)
#
# Target: AWS ECS Fargate (linux/amd64)
# Build:  Bun for dependency install (fast, lockfile-exact) + Vite/Nitro build
#         executed by Node 22 (identical to the Phase 6A verified build).
# Run:    Node 22 slim, non-root, no dev dependencies, no source, no secrets.
# ---------------------------------------------------------------------------

# ---------- Stage 1: dependencies (Bun, exact lockfile) --------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Bun is used ONLY for dependency installation; the build itself runs on Node
# so it matches the runtime verified in Phase 6A byte-for-byte in behavior.
COPY --from=oven/bun:1.2-slim /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock bunfig.toml ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---------- Stage 2: build (Nitro node-server preset) ----------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=production \
    NITRO_PRESET=node-server \
    CI=true

# Browser-safe publishable configuration only. These are inlined into the
# client bundle by Vite and are NOT secrets. Server secrets are never build
# arguments — they are injected at runtime by ECS task definition / Secrets
# Manager.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Produces .output/server/index.mjs + .output/public (Nitro node-server).
RUN npm run build:node \
 && test -f .output/server/index.mjs

# ---------- Stage 3: runtime ----------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

# Nitro's node-server output is self-contained: it bundles its runtime
# dependencies into .output/server/node_modules. No package.json install, no
# dev dependencies, no application source, no tests, no .env files.
COPY --from=build --chown=root:root /app/.output ./.output

# node:22-bookworm-slim already ships an unprivileged `node` (uid/gid 1000)
# user. The application owns nothing writable.
USER node

EXPOSE 3000

# Health check uses the application's own readiness endpoint. No curl/wget in
# the slim image, so the check runs through Node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/public/health?probe=live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# PID 1 is the Node server itself so SIGTERM reaches it directly and Nitro's
# graceful shutdown runs (verified in Phase 6A).
CMD ["node", ".output/server/index.mjs"]
