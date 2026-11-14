# FlashSpace API — production container image (Module 15)
#
# The backend is a long-running Express process with an in-process SQLite
# fallback and a persistent Postgres path, so it must NOT be deployed to a
# pure serverless runtime (Vercel/Lambda) that kills background work and
# request streaming. This image runs on Render/Fly/Railway or any Docker host.
#
# Build:  docker build -f apps/api/Dockerfile -t flashspace-api .
# Run:    docker run --env-file apps/api/.env -p 4000:4000 flashspace-api

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @flashspace/api --workspace @flashspace/shared --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY tsconfig.base.json ./
RUN npm run build --workspace @flashspace/shared \
 && npm run build --workspace @flashspace/api

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Only production dependencies, plus the built shared package and API output.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @flashspace/api --workspace @flashspace/shared --include-workspace-root \
 && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/src/repositories/postgres/migrations apps/api/dist/repositories/postgres/migrations
COPY apps/api/src/repositories/postgres/local-supabase-shim.sql apps/api/dist/repositories/postgres/local-supabase-shim.sql
COPY apps/api/scripts/db-import.ts apps/api/scripts/db-import.ts

# Non-root user; the SQLite/data directory is only used in local mode.
RUN useradd --system --uid 10001 --create-home flashspace \
 && mkdir -p /app/data && chown -R flashspace:flashspace /app/data
USER flashspace

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
