#!/usr/bin/env sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT="$PROJECT_ROOT/tests/lan-transport"
SOURCE="$PROJECT_ROOT/app/src/main/java/ee/dold/techcontrol/LanSyncTransport.java"
TEST_SOURCE="$TEST_ROOT/LanSyncR4SessionTest.java"
OUT_DIR=$(mktemp -d /tmp/dold-r4-lan-tests.XXXXXX)
trap 'rm -rf "$OUT_DIR"' EXIT HUP INT TERM

java -m jdk.compiler/com.sun.tools.javac.Main -Xlint:all -d "$OUT_DIR" \
  "$SOURCE" "$TEST_SOURCE"
java -cp "$OUT_DIR" ee.dold.techcontrol.LanSyncR4SessionTest
