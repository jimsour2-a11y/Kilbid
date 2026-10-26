#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${DTC_S2_SIGNATURE_FIXTURE:-}"
if [[ -z "$FIXTURE" || ! -f "$FIXTURE" ]]; then
  echo "Set DTC_S2_SIGNATURE_FIXTURE to the approved v0.9.0 R4 XLSX fixture." >&2
  exit 2
fi
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
SOURCES=(
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignatureCanonicalJson.java"
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignatureCaptureCore.java"
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignaturePngRenderer.java"
  "$ROOT/app/src/main/java/ee/dold/techcontrol/SignatureDraftStore.java"
  "$ROOT/tests/signature/SignatureCaptureS1Test.java"
  "$ROOT/tests/signature/SignaturePngPocFixture.java"
  "$ROOT/tests/signature/SignaturePngS2AlternateFixture.java"
)
java -m jdk.compiler/com.sun.tools.javac.Main -encoding UTF-8 -d "$OUT" "${SOURCES[@]}"
java -Djava.awt.headless=true -cp "$OUT" ee.dold.techcontrol.SignaturePngPocFixture "$OUT/s3-primary.png"
java -Djava.awt.headless=true -cp "$OUT" ee.dold.techcontrol.SignaturePngPocFixture "$OUT/s3-v1.png" --v1
export DTC_S2_TEST_PNG="$OUT/s3-primary.png"
export DTC_S2_V1_TEST_PNG="$OUT/s3-v1.png"
export DTC_RUN_S2_SIGNATURE=1
export DTC_RUN_S3_SIGNATURE=1
export DTC_TEST_FILTER="${DTC_TEST_FILTER:-s3 signature}"
export CODEX_PRIMARY_RUNTIME_NODE_MODULES="${CODEX_PRIMARY_RUNTIME_NODE_MODULES:-/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules}"
node "$ROOT/tests/headless-regression.cjs" "$FIXTURE" "${1:-/tmp/dold-s3-parandus-tests}"
