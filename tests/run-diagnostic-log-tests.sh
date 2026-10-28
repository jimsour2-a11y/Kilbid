#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
java -m jdk.compiler/com.sun.tools.javac.Main -encoding UTF-8 -Xlint:all -d "$OUT" \
  "$ROOT/app/src/main/java/ee/dold/techcontrol/DiagnosticLogStore.java" \
  "$ROOT/tests/diagnostic/DiagnosticLogStoreTest.java"
java -cp "$OUT" ee.dold.techcontrol.DiagnosticLogStoreTest
node "$ROOT/tests/diagnostic/diagnostic-log-ui.test.cjs"
