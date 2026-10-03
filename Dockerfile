FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY _worker.js ./
COPY self-host ./self-host
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node self-host/healthcheck.js
CMD ["node", "self-host/server.js"]
