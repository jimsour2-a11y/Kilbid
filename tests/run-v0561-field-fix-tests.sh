#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root="$project_root/tests/field-fix"
output_dir="${TMPDIR:-/tmp}/dold-v0561-field-fix-tests"
mkdir -p "$output_dir"

node "$test_root/field-fix-handshake.test.cjs"

java -m jdk.compiler/com.sun.tools.javac.Main -Xlint:all -d "$output_dir" \
  "$project_root/app/src/main/java/ee/dold/techcontrol/LanSyncTransport.java" \
  "$test_root/LanSyncFieldFixTest.java"
java -cp "$output_dir" ee.dold.techcontrol.LanSyncFieldFixTest
