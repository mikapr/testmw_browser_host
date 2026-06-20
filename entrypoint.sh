#!/bin/sh
set -e

if [ -z "$WORKER_TOKEN" ]; then
  echo "ERROR: WORKER_TOKEN is not set. Get a token in the TestMW dashboard"
  echo "       and pass it via the environment (-e WORKER_TOKEN=... or .env)."
  exit 1
fi

echo "Starting TestMW Browser Host (relay=${RELAY_URL:-wss://testmw.ru/relay/host})..."
exec node src/index.js
