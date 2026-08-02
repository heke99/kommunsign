FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /app/dist ./dist
USER nonroot
CMD ["dist/apps/api/src/index.js"]
