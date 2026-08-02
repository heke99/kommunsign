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
USER nonroot
ENV APP_ENV=production
CMD ["dist/apps/workers/src/production-runner.js"]
