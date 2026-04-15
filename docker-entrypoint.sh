#!/bin/sh
set -e

echo "=== SupaConsole Startup ==="
echo "Checking DATABASE_URL..."

# Debug: show all available env vars (masking values)
echo "All environment variables:"
env | sort | while IFS='=' read -r key value; do
  echo "  $key=***"
done

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set!"
  exit 1
fi

echo "DATABASE_URL is set, running prisma db push..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || {
  echo "WARNING: prisma db push failed, but continuing..."
}

echo "Starting server..."
exec node server.js
