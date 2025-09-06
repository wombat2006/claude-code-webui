# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code and utils
COPY src/ ./src/

# Build TypeScript (ignore type errors for demo)
RUN npx tsc --noEmit false || npm run build || npx tsc --skipLibCheck --noEmit false

# Production stage
FROM node:18-alpine AS production

# Install system dependencies and create mock claude-code
RUN apk add --no-cache curl bash && \
    echo '#!/bin/bash\necho "Mock Claude Code CLI for demo"\nwhile read line; do echo "Processed: $line"; done' > /usr/local/bin/claude-code && \
    chmod +x /usr/local/bin/claude-code

# Create app user
RUN addgroup -g 1001 -S claude && \
    adduser -S claude -u 1001

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Create necessary directories
RUN mkdir -p /app/logs /tmp/claude-sessions && \
    chown -R claude:claude /app /tmp/claude-sessions

# Switch to non-root user
USER claude

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

# Expose port
EXPOSE 3001

# Start application
CMD ["node", "dist/index.js"]