# Stage 1: Build
FROM node:20-bookworm AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Stage 2: Runtime
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Create non-root user
RUN groupadd -r prestige && useradd -r -g prestige prestige

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /data && chown -R prestige:prestige /data /app

USER prestige

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

CMD ["node", "dist/web/server.js"]

# Stage 3: CLI
FROM runtime AS cli

CMD ["node", "dist/cli/index.js"]
