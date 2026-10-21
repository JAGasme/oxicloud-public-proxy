FROM node:24.22.1-alpine3.23 AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.22.1-alpine3.23
WORKDIR /app

RUN addgroup -g 1001 -S proxy && \
    adduser -u 1001 -S proxy -G proxy

COPY --from=builder --chown=proxy:proxy /app/node_modules ./node_modules
COPY --from=builder --chown=proxy:proxy /app/dist ./dist
COPY --chown=proxy:proxy package.json ./
COPY --chown=proxy:proxy views ./views
COPY --chown=proxy:proxy public ./public

USER proxy
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/healthcheck || exit 1

CMD ["node", "dist/server.js"]
