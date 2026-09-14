# FleetFlow dashboard image: Vite build stage → minimal
# nginx serving the SPA. Built/pushed by the CD workflow (cd.yml) — also handy
# for local/staging parity; production can equally deploy the static dist/ to
# a CDN instead of running a container (§13.2 / §13.3).
#
# Build: docker build -t fleetflow-dashboard .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# Build-time env vars (VITE_* from the environment, e.g. VITE_MAP_PROVIDER /
# Sentry DSN; VITE_GOOGLE_MAPS_API_KEY is DORMANT — only read when
# VITE_MAP_PROVIDER=google) are consumed by vite at build time. Blank = OSM
# map + no Sentry.
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
