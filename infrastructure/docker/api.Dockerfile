FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN npm run build \
 && npm prune --omit=dev

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Every .mjs beside the entrypoint, not just the entrypoint. server.mjs imports siblings --
# compression.mjs and request-limits.mjs today -- and naming one file here meant the image booted
# without the others and crashlooped on ERR_MODULE_NOT_FOUND, while Railway kept serving the last
# image that worked. A glob cannot be forgotten the next time a module is split out.
COPY --from=build /app/apps/api/*.mjs ./apps/api/
USER nonroot
ENV PORT=8787
ENV APP_ENV=production
ENV KOMMUNSIGN_API_BOOTSTRAP_MODULE=../../dist/apps/api/src/production-runtime.js
CMD ["apps/api/server.mjs"]
