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
#           toolchains in slim requires apt, and apt in slim is what this
#           image keeps as simple as possible (see below).
#   build — compile engine (dist/) and web cockpit (web-dist/).
#   final — node:22-slim + tmux/procps (apt) + Claude Code CLI (npm -g).
#
# apt note: bookworm sources are plain HTTP on purpose. Debian repositories are
# GPG-signed (integrity does not depend on TLS), and slim ships NO
# ca-certificates — HTTPS apt fails cert verification on a stock slim image.
# Plain HTTP works on clean networks and behind explicit proxy build-args.
# Behind an intercepting TUN/fake-IP proxy, build with:
#   docker build --build-arg http_proxy=http://host.docker.internal:<port> \
#                --build-arg https_proxy=http://host.docker.internal:<port> .
FROM node:22 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit

FROM node:22 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig*.json vite.web.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build && npm run web

FROM node:22-slim
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tmux procps; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
# Claude Code — the agent executor (npm ships with node:22-slim).
RUN npm install -g @anthropic-ai/claude-code --no-fund --no-audit
# Skip Claude Code first-run onboarding (theme picker) AND pre-trust /app —
# fresh containers would otherwise boot into interactive wizards instead of the
# REPL, and dispatched prompts would be lost on them (the trust dialog even
# defaults to "No, exit").
RUN mkdir -p /root/.claude \
  && printf '%s\n' '{' '  "hasCompletedOnboarding": true,' '  "theme": "dark",' '  "projects": {' '    "/app": { "hasTrustVoted": true, "hasTrustDialogAccepted": true, "allowedTools": [] }' '  }' '}' > /root/.claude.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
# CLI 源码（setup/doctor 走 npx tsx 直跑 TS，imports ../src/*；引擎本体在 dist/）
COPY cli ./cli
COPY src ./src

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
