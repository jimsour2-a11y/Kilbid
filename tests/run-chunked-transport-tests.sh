#!/usr/bin/env sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node "$PROJECT_ROOT/tests/chunked-transport/chunked-transport.test.cjs"
