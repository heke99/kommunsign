FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN npm run build \
 && npm prune --omit=dev

FROM node:22.23.2-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends qpdf ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin kommunsign
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
USER 10001
ENV APP_ENV=production
CMD ["dist/apps/workers/src/production-runner.js"]
