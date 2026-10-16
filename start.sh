#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  npm ci --omit=dev
fi

exec npm start