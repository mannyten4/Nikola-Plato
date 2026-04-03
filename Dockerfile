FROM node:20-slim

# Install Playwright Chromium system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Create persistent data directories
RUN mkdir -p browser-data screenshots logs data

# Create non-root user
RUN groupadd -r browserai && useradd -r -g browserai -d /app browserai \
    && chown -R browserai:browserai /app

USER browserai

# No ports needed — Socket Mode uses outbound WebSocket
CMD ["node", "dist/index.js"]
