# syntax=docker/dockerfile:1.7

# ---------- Base deps stage: install node_modules ----------
FROM node:22-alpine AS deps
WORKDIR /app

# Copy only manifest files first to leverage layer caching
COPY package*.json ./

# Use BuildKit cache mounts to speed up npm installs between builds
# Falls back to npm install if no lockfile.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev || npm install --omit=dev

# ---------- Runtime stage ----------
FROM node:22-alpine AS runner
WORKDIR /app

# curl is used by the Docker HEALTHCHECK below
RUN apk add --no-cache curl

# Copy production deps and app code
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

# Persist Baileys auth across restarts (mounted from host)
RUN mkdir -p /app/auth && chown -R node:node /app
VOLUME ["/app/auth"]

# Sensible defaults (can be overridden with -e)
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# Run as the non-root "node" user provided by the official image
USER node

# Basic liveness probe against the app's /status endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/status || exit 1

CMD ["node", "src/server.js"]
