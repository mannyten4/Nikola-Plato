#!/usr/bin/env bash
set -euo pipefail

echo "Stopping Browser AI..."
pm2 stop browser-ai
echo "Browser AI stopped."
