#!/usr/bin/env bash
set -euo pipefail

echo "Restarting Browser AI..."
pm2 restart browser-ai
sleep 5
pm2 status browser-ai
