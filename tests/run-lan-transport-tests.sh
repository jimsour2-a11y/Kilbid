#!/usr/bin/env sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT="$PROJECT_ROOT/tests/lan-transport"
SOURCE="$PROJECT_ROOT/app/src/main/java/ee/dold/techcontrol/LanSyncTransport.java"
SYNC_SOURCE="$PROJECT_ROOT/app/src/main/assets/DOLD_TechControl_v0.5.3.js"
OUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dold-lan-tests.XXXXXX")
trap 'rm -rf "$OUT_DIR"' EXIT HUP INT TERM

java -m jdk.compiler/com.sun.tools.javac.Main -Xlint:all -d "$OUT_DIR" \
  "$SOURCE" "$TEST_ROOT/LanSyncTransportTest.java"
java -cp "$OUT_DIR" ee.dold.techcontrol.LanSyncTransportTest "$SOURCE" "$SYNC_SOURCE"
