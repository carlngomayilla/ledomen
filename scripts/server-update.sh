#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/ledomen}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm install --omit=dev --no-audit --no-fund
npm run check
sudo systemctl restart ledomen
sudo systemctl --no-pager --full status ledomen | head -n 20
