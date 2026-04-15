#!/bin/sh
set -e

echo "=== SupaConsole Startup ==="
echo "Checking DATABASE_URL..."

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set!"
  exit 1
fi

echo "DATABASE_URL is set, running prisma db push..."
node ./node_modules/prisma/build/index.js db push --accept-data-loss 2>&1 || {
  echo "WARNING: prisma db push failed, but continuing..."
}

echo "Starting server..."
exec ./node_modules/.bin/next start
