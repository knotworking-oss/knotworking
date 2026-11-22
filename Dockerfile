# syntax=docker/dockerfile:1
#
# Knotworking images. Build both with `docker compose build`, or individually:
#   docker build --target api -t knotworking-api .
#   docker build --target web -t knotworking-web .
#   docker build --target mcp -t knotworking-mcp .

ARG NODE_IMAGE=node:22-bookworm-slim

# ── Build everything once ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @knotworking/server build \
 && pnpm --filter @knotworking/web build \
 && pnpm --filter @knotworking/mcp build \
 && node apps/server/scripts/runtime-package.mjs > /repo/api-runtime-package.json

# ── API: bundled server + the few packages that can't be bundled ────────────
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production PORT=4000 MIGRATIONS_DIR=/app/migrations UPLOAD_DIR=/app/data/uploads
WORKDIR /app
COPY --from=build /repo/api-runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
# /app/data/uploads holds attachments (a named volume in compose.yaml). Creating it here, owned by
# node, makes a fresh named volume start with the same owner.
RUN mkdir -p /app/data/uploads && chown -R node:node /app
USER node
EXPOSE 4000
# Liveness only: /health confirms the process answers, not that the database is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Applies pending migrations, then starts the API.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]

# ── Web: Next.js standalone server ───────────────────────────────────────────
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ── MCP: Model Context Protocol server (docs/mcp.md) ─────────────────────────
# Fully bundled by tsup, so there is nothing to install: just the dist/ folder. It is a stateless
# client of the API (KNOTWORKING_API_URL) and holds no credentials of its own.
FROM ${NODE_IMAGE} AS mcp
ENV NODE_ENV=production MCP_PORT=4100 MCP_HOST=0.0.0.0
WORKDIR /app
# "type": "module" so node runs the bundled .js files as ES modules.
RUN echo '{"name":"knotworking-mcp","private":true,"type":"module"}' > package.json
COPY --from=build --chown=node:node /repo/apps/mcp/dist ./dist
USER node
EXPOSE 4100
# Liveness only: /health confirms the process answers, not that the API is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.MCP_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
