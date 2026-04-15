#!/bin/sh
set -e

echo "=== SupaConsole Startup ==="
echo "Checking DATABASE_URL..."

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set!"
  echo "Available env vars:"
  env | sort | cut -d= -f1
  exit 1
fi

echo "DATABASE_URL is set, running prisma db push..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || {
  echo "WARNING: prisma db push failed, but continuing..."
}

echo "Starting server..."
exec node server.js
