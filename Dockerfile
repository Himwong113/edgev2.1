FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY _worker.js ./
COPY self-host ./self-host
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "self-host/server.js"]
