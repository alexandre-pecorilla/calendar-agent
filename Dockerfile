# calendar-agent application image.
# Multi-stage (pattern from an earlier internal project): the build stage carries the toolchain, the
# runtime stage carries production dependencies and compiled output only, and
# runs as the non-root `node` user. No native modules: SQLite is Node's built-in
# `node:sqlite`, so the alpine base needs no compiler.
# Pinned by digest (R4-9); bump deliberately, see docs/development/release.md.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
ENV CI=true
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-assets.mjs ./scripts/
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The data directory is a named volume; Docker copies this ownership into the
# volume on first creation, so the non-root user can write it.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8400
CMD ["node", "dist/index.js"]
