#!/bin/sh
set -eu

cd "$(dirname "$0")"

# Dependencies are installed during the build; exec so SIGTERM reaches Node directly.
exec node src/server.js