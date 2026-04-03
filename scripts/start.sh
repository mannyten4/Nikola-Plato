#!/usr/bin/env bash
set -euo pipefail

echo "=== Browser AI — Starting ==="

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v$(node -v))"
  exit 1
fi
echo "[✓] Node.js $(node -v)"

# Check .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in values."
  exit 1
fi
echo "[✓] .env found"

# Create logs directory
mkdir -p logs

# Build TypeScript
echo "[...] Building TypeScript..."
npm run build
echo "[✓] Build complete"

# Check PM2
if ! command -v pm2 &>/dev/null; then
  echo "[...] PM2 not found, installing globally..."
  npm install -g pm2
fi
echo "[✓] PM2 $(pm2 -v)"

# Start the app
echo "[...] Starting with PM2..."
pm2 start ecosystem.config.js

# Wait and check status
sleep 5
STATUS=$(pm2 jlist | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const app = d.find(a => a.name === 'browser-ai');
  console.log(app ? app.pm2_env.status : 'not_found');
")

if [ "$STATUS" = "online" ]; then
  echo ""
  echo "=== Browser AI is ONLINE ==="
  pm2 status browser-ai
else
  echo ""
  echo "=== STARTUP FAILED (status: $STATUS) ==="
  echo "Check logs: pm2 logs browser-ai --lines 50"
  exit 1
fi
