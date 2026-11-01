# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine
# tini reaps zombies and forwards SIGTERM, so `docker stop` triggers the API's graceful shutdown.
# OpenSSL and zlib fixes reach Alpine before they reach the node image, so upgrade. The runtime only ever runs `node`: npm, npx,
# corepack and yarn are build tools whose bundled dependencies carry their own advisories, so they are not shipped.
RUN apk upgrade --no-cache && apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
# Root-owned and read-only to the runtime user: the process cannot modify its own code.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.mjs"]
