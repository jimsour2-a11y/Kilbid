#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
SOURCES=(
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignatureCanonicalJson.java"
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignatureCaptureCore.java"
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignaturePngRenderer.java"
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignatureDraftStore.java"
  "$ROOT/tests/signature/SignatureCaptureS1Test.java"
)
java -m jdk.compiler/com.sun.tools.javac.Main -encoding UTF-8 -d "$OUT" "${SOURCES[@]}"
java -Djava.awt.headless=true -cp "$OUT" ee.dold.techcontrol.SignatureCaptureS1Test
