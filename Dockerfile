# ---- PayPulse API image ----
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies (cached unless package files change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts ./scripts

# Run as the non-root user that ships with the node image
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
