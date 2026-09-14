# FleetFlow backend image — multi-target.
#   api    : REST API + WebSocket (node src/server.js)
#   worker : BullMQ background workers (node src/jobs/worker.js)
# Build e.g.: docker build -t fleetflow-api --target api .
#             docker build -t fleetflow-worker --target worker .

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --omit=dev --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
# One operations tool belongs in the image: the one-time bootstrap-admin script.
# Everything else under scripts/ stays out of the build context via .dockerignore.
COPY scripts/bootstrap-admin.js ./scripts/bootstrap-admin.js

# Prisma engine resolution (Phase 13): runtime openssl probing on Alpine can
# fall back to the openssl-1.1 musl engine (not present on modern Alpine), so
# pin the openssl-3 engine generated above — deterministic at runtime. Set
# AFTER `prisma generate` (generate itself validates the env var's path).
FROM base AS api
ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
EXPOSE 3000
CMD ["node", "src/server.js"]

FROM base AS worker
ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
CMD ["node", "src/jobs/worker.js"]

# Dedicated pre-deploy migration image. The runtime images install --omit=dev,
# so the Prisma CLI (a devDependency) is not present.
# Deliberately NOT based on the alpine `base` stage: on Alpine, prisma's openssl
# probe fails and it downloads linux-musl engines that link libssl.so.1.1 (not
# present on modern Alpine) — migrate deploy dies with "Error loading shared
# library libssl.so.1.1". On Debian slim detection works and the correct engines
# are fetched. This stage only carries the CLI + schema; never the app runtime.
FROM node:22-slim AS migrate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# prisma's openssl probe needs the openssl CLI, which node:*-slim does not ship
# (the warning literally instructs this) — without it detection defaults to
# openssl-1.1.x and the wrong engine variant is downloaded.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
# Pin to the lockfile's resolved CLI version (5.22.0); postinstall downloads
# the schema/query engines for linux-gnu where openssl detection now succeeds.
RUN npm install --no-save --no-audit --no-fund prisma@5.22.0
COPY scripts/bootstrap-admin.js ./scripts/bootstrap-admin.js
CMD ["npx", "prisma", "migrate", "deploy"]
