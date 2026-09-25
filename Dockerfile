# minizep HTTP service — multi-stage: build with dev deps, run with production deps only.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# the web UI page (served on /ui only when MINIZEP_UI_GROUPS is set)
COPY ui ./ui
# the usage guide the memory_guide tool and GET /v1/guide serve
COPY docs/MEMORY-GUIDE.md ./docs/MEMORY-GUIDE.md

# run unprivileged
USER node

# The service refuses to start without MINIZEP_TOKENS (or explicit anonymous
# opt-in), so a misconfigured deployment fails loudly instead of serving an
# unauthenticated graph.
ENV MINIZEP_HOST=0.0.0.0
ENV MINIZEP_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MINIZEP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/http.js"]
