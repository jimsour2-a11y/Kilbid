# Android v2 A1, isolated package foundation

This is an offline Python reference codec for the frozen `TEST-CONTRACT 0.1` transport envelope and one artificial `WORK_PACKAGE`. It lives only on branch `android-v2-a1-test`. It is not wired into the v1 APK, Android UI, SQLite, LAN, or Desktop.

Run from the repository root:

```sh
python3 -m unittest discover -s tests/v2_package -p 'test_*.py' -v
```

`create_fixture.py` creates one synthetic package once and refuses to overwrite it. The checked-in `TEST_A1_WORK_PACKAGE.dtcpkg` contains no production data. `read_package(raw, expected_dataset_id)` returns validated manifest, payload, and an external archive SHA-256 without writing to disk or a database.

The A1 validator checks the TEST manifest and WORK links, ZIP inventory and limits. CHANGE/ACK business semantics, durable import, signatures, cross-language vectors, and Android runtime integration are separate later stages. This module is a reference fixture and test gate, not an import implementation for a phone.
