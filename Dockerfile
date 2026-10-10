# julI MVP image — engine + agent execution substrate in one container.
#
# Unlike a service-only image, this one carries the FULL loop: tmux + Claude Code
# live alongside the engine, so dispatched agents actually run inside the
# container (tmux-first execution). Node 22; node:sqlite built in — no external
# DB/Redis.
#
# Build stages:
#   deps  — full node:22 (native toolchain preinstalled): node-pty has no
#           linux-arm64 prebuilt and must compile from source. Installing
#           toolchains in slim requires apt, which is unreliable behind
#           intercepting proxies (plain-HTTP deb mirrors 502). Full image
#           avoids apt entirely at this stage.
#   build — compile engine (dist/) and web cockpit (web-dist/).
#   final — node:22-slim + tmux (apt over HTTPS) + Claude Code CLI (npm -g).
FROM node:22 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit

FROM node:22 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig*.json vite.web.config.ts vitest.config.ts ./
COPY src ./src
COPY cli ./cli
COPY web ./web
COPY test ./test
RUN npm run build && npm run web

FROM node:22-slim
# tmux over HTTPS apt sources — plain-HTTP mirrors break behind intercepting
# proxies; HTTPS deb.debian.org is stable in both clean and proxied environments.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
  && apt-get update \
  && apt-get install -y --no-install-recommends tmux procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
# Claude Code — the agent executor (npm ships with node:22-slim).
RUN npm install -g @anthropic-ai/claude-code --no-fund --no-audit
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist

# Data plane (lifecycle.db / pipelines / config.json via JULI_DATA_DIR).
VOLUME ["/data"]
ENV JULI_DATA_DIR=/data \
    JULI_LISTEN_HOST=0.0.0.0 \
    JULI_LISTEN_PORT=7070 \
    LANG=C.UTF-8

EXPOSE 7070
# slim has no curl/wget — probe with node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:7070/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
