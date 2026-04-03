#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="browser-ai"
CONTAINER_NAME="browser-ai"

echo "=== Browser AI Deployment ==="

# 1. Build the image
echo "[1/4] Building Docker image..."
docker compose build

# 2. Tag old image for rollback
OLD_IMAGE=$(docker inspect --format='{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || echo "")
if [ -n "$OLD_IMAGE" ]; then
  echo "  Old image saved for rollback: ${OLD_IMAGE:0:12}"
fi

# 3. Stop old container and start new one
echo "[2/4] Restarting container..."
docker compose down
docker compose up -d

# 4. Health check — wait up to 60 seconds
echo "[3/4] Waiting for health check..."
MAX_WAIT=60
WAITED=0
HEALTHY=false

while [ $WAITED -lt $MAX_WAIT ]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    HEALTHY=true
    break
  fi
  if [ "$STATUS" = "unhealthy" ]; then
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  echo "  Waiting... (${WAITED}s)"
done

if [ "$HEALTHY" = true ]; then
  echo "[4/4] Deployment successful! Container is healthy."
  docker compose logs --tail=5
else
  echo "[4/4] HEALTH CHECK FAILED — rolling back..."
  docker compose down

  if [ -n "$OLD_IMAGE" ]; then
    echo "  Attempting rollback to previous image..."
    docker run -d \
      --name "$CONTAINER_NAME" \
      --restart unless-stopped \
      --env-file .env \
      -e BROWSER_HEADLESS=true \
      -e NODE_ENV=production \
      -v "$(pwd)/browser-data:/app/browser-data" \
      -v "$(pwd)/screenshots:/app/screenshots" \
      -v "$(pwd)/logs:/app/logs" \
      -v "$(pwd)/data:/app/data" \
      "$OLD_IMAGE"
    echo "  Rolled back. Check logs: docker logs $CONTAINER_NAME"
  else
    echo "  No previous image to roll back to."
  fi
  exit 1
fi
