# A4.1 TEST candidate checkpoint (UNVERIFIED)

Base: `5f388d3796129e9555e64bc7ff9f7d02d34e4151` (`android-v2-a1-test`, A3).
Production reference: `adb342537ea6eb4a759a4a5a3dfdd95535263439`; untouched.

Adds `:v2testhost`, a temporary Java 17 Android application with applicationId `ee.dold.techcontrol.v2test`. It uses only `:v2reader` and `:v2storage`, imports the existing artificial A1 fixture through the existing reader/store path, displays stored IDs and original record JSON, and reloads the receipt and records from SQLite on startup. No physical device install is included.

`WorkPackageStore.getLatestReceipt()` is a read-only accessor to `package_receipts`; no database schema or import behavior changes. One A3 Robolectric test covers receipt metadata. Eight host Robolectric tests cover import and display, relationships, app activity recreation, idempotency, corrupt bytes, wrong environment, wrong dataset, and explicit delta rejection.

## Apply

In the Windows TEST checkout:

1. Confirm `git status --short` is empty and `git rev-parse HEAD` prints the base SHA above.
2. Copy `A4_1_TEST_CANDIDATE.patch` into the checkout and run `git apply --check A4_1_TEST_CANDIDATE.patch`.
3. If the check succeeds, run `git apply A4_1_TEST_CANDIDATE.patch`.
4. Run the existing TEST workflow or locally execute the Gradle tasks listed in `.github/workflows/android-v2-test.yml`.
5. Inspect JUnit XML for exactly 8 host tests, zero failures/errors, plus the A1/A2/A3 regression evidence, and preserve the debug APK artifact.

This patch is intentionally not a commit and is not a verified checkpoint. Do not use it as production code before TEST CI review.
