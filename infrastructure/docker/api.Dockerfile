FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/api/server.mjs ./apps/api/server.mjs
USER nonroot
ENV PORT=3001
ENV APP_ENV=production
ENV KOMMUNSIGN_API_BOOTSTRAP_MODULE=../../dist/apps/api/src/production-runtime.js
CMD ["apps/api/server.mjs"]
