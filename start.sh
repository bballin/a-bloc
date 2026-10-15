#!/bin/sh
set -eu

cd "$(dirname "$0")"

exec node src/server.js
