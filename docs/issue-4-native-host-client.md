# Issue #4: Collector Native Messaging Client (development slice)

> **Superseded in part (Collector 0.2.0, 2026-11-12):** the manifest now carries the fixed public `key` and the `nativeMessaging` permission, and the client defaults to the Host name `org.maginalia.collector`. The `collector.host-profile` entry below remains only as the override used by the disposable tooling under `dev/`. The rest of this document is the historical record of the read-only slice.

**Status:** Implementation for review. The architecture direction is Accepted (MAGINALIA IDE ADR 0019 / D070). Everything specific to the helper used here is **experimental** and is not a product contract.

**Scope:** Collector only. Parent `main` was verified at `2cc33b302982acde59263e7d5f572cfb7552b77b` (`origin/main` and the work branch base were identical; no `STALE_BASE_COMMIT`). Work branch: `codex/collector-native-host-client`. MAGINALIA IDE and MAGINALIA Desktop were not modified.

## What this slice adds

- `host-client.js` — a small Native Messaging client that runs in the extension service worker. It supports exactly two read-only operations: `health` and `configured_shelf`.
- `service-worker.js` — `importScripts("host-client.js")`, an extension-page sender check, and a `collector:host-check` message that returns a compatibility report. Content scripts and web pages cannot reach the helper.
- `popup.*` — a compact 「MAGINALIAとの接続」 section that renders the report.
- `tests/host-client.test.cjs`, `tests/service-worker-host.test.cjs` — protocol, validation, sender and failure-path tests.
- `dev/native-host-smoke/` — a disposable setup/cleanup harness for the isolated real-Chrome check.

## What this slice deliberately does not do

| Not implemented | Why |
| --- | --- |
| Saving a web quote to the Shelf | Cross-process write coordination, multi-file crash recovery and durable acknowledgement are unresolved in ADR 0019 |
| Reviewer capture staging | No approved durable queue or importer receipt contract exists |
| Removing or acknowledging outbox items | Requires a durably acknowledged host receipt |
| Embedding a production extension ID, host name or registration | Not approved; the production `manifest.json` stays free of `nativeMessaging` |

A successful connection check is **not** a Shelf save. The popup says so in its lead text and in every success message, and the check performs no write, no outbox mutation and no network request.

## Experimental surface (replaceable in one place)

The current Desktop helper is a development foundation, not an approved contract. The complete experimental surface is declared in `host-client.js`:

| Element | Current experimental value | Approved? |
| --- | --- | --- |
| Protocol string | `maginalia.collector.experimental.v1` | No |
| Operations | `health`, `configured_shelf` | No (`unsupported_operation` for anything else) |
| Envelope | exactly `{protocol, operation}`; response exactly `{protocol, ok, …}` | No |
| Host name | read at runtime from `chrome.storage.local["collector.host-profile"].hostName` | No |
| Descriptor | `MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR` JSON with `experimental`, `shelfLocationPath`, `expectedShelfId`, `allowedOrigin` | No |
| Registration | per-user `HKCU\...\NativeMessagingHosts\<test name>` | No |
| Extension identity | generated per smoke run from a throwaway manifest `key` | No |

The production manifest declares no `nativeMessaging` permission, no host name and no extension ID. The disposable build for the smoke copies the repository files and adds only the permission (and a throwaway `key`) inside a temporary directory.

## Response validation and failure taxonomy

Requests are sent with exactly two fields because the experimental helper rejects unknown keys. Responses are accepted only if they are plain objects, stay under 64 KiB, carry the expected protocol, and match the exact key set of the operation; every field is type-checked and a Shelf identifier or display name shaped like a filesystem path is treated as a privacy regression.

| Client code | Meaning |
| --- | --- |
| `host-not-configured` | No helper profile is stored in this browser profile |
| `native-messaging-unavailable` | The `nativeMessaging` API is missing (permission not granted) |
| `host-not-registered` | Chrome: "Specified native messaging host not found." |
| `host-access-forbidden` | Chrome refused the caller (manifest `allowed_origins` did not match) |
| `host-exited`, `host-communication-failed`, `host-unreachable` | Transport failures, kept distinct |
| `host-timeout` | No response within the bounded timeout; a late response is ignored |
| `host-no-response`, `invalid-response`, `host-response-too-large` | Malformed or oversized reply |
| `host-protocol-error`, `host-rejected-request` | Helper rejected the frame or the request |
| `host-configuration-invalid`, `shelf-configuration-unavailable` | Helper configuration unreadable |
| `shelf-not-configured`, `shelf-identity-unavailable`, `shelf-identity-mismatch`, `shelf-unavailable` | Shelf resolution outcomes, kept distinct |
| `unsupported-operation` | Helper does not advertise `configured_shelf` |
| `host-error` | Unrecognized helper error code, preserved verbatim |

`checkCompatibility()` never throws. It reports `compatible`, `incompatible` (the helper answered but cannot be used) or `unavailable` (no usable answer), plus the individual checks.

## Verification

Environment: Windows 11 Home 10.0.26300, Google Chrome 156.0.8078.49, Node.js v24.14.0. The helper was the built experimental host `apps/desktop/dist/main/collector-native-host.js` from a local read-only mirror of MAGINALIA Desktop `dev0.2` at `0dd396ce32e0c3105e2b8d829a1c020d2e704cdc`; that mirror's `apps/desktop/src/collector-native-host.ts` hashes identically to the PR #78 reference. The built artifact was not rebuilt during this work. The Desktop UI was not running for any check.

| Item | Result | Evidence |
| --- | --- | --- |
| Parent SHA check | PASS | `origin/main` = `2cc33b302982acde59263e7d5f572cfb7552b77b`, exactly the requested parent |
| Static syntax and manifest JSON | PASS | `node --check host-client.js service-worker.js popup.js` and manifest parse |
| Unit and mock tests | PASS | `node --test tests/*.cjs` — 59 tests, 0 failures |
| Real Chrome: loads as an unpacked MV3 extension | PASS | Chrome 156, disposable profile; `--load-extension` is ignored on this build, so the extension was loaded through the CDP `Extensions.loadUnpacked` command with `--enable-unsafe-extension-debugging`; generated ID matched the throwaway manifest `key` |
| Real Chrome: `health` + `configured_shelf` through the service worker and popup | PASS | Popup rendered 「接続を確認できました。指定されたPrivate Shelfも確認できました。」 with the fixture name and UUID, no path |
| Real Chrome: Shelf identity mismatch | PASS | Changed only the descriptor `expectedShelfId`; popup rendered 「設定されたPrivate Shelfと、応答した保存先が一致しません。」 and no Shelf card |
| Real Chrome: caller not allowed by the host manifest | PASS | Restricted `allowed_origins` to a different ID; popup rendered 「MAGINALIA連携プログラムへの接続が許可されませんでした。」 (Chrome blocked the launch) |
| Real Chrome: helper not registered | PASS | Removed only the test registry key; popup rendered 「…登録されていません。」 |
| Real Chrome: no host profile | PASS | Cleared the disposable profile's stored profile; popup rendered 「接続先がまだ設定されていません。」 |
| Real Chrome: recovery after restoring registration | PASS | Next check returned to compatible |
| Real Chrome: no Shelf mutation | PASS | Recursive size+SHA-256 comparison of the fixture before/after every check was identical |
| Desktop UI closed | PASS | No Electron process was started; the helper was launched by Chrome per request |
| Real Shelf write, cross-process coordination, durable receipt | NOT VERIFIED | Out of scope for this slice and unauthorised by ADR 0019 |
| Reviewer staging or import | NOT VERIFIED | No approved queue contract exists |
| Production host registration, packaging, Installer lifecycle, approved extension ID | NOT VERIFIED | Not approved and not attempted |
| Helper provenance beyond the pinned source (that the present build artifact equals that source) | NOT VERIFIED | The artifact was used as found in the mirror; it exposes the pinned experimental protocol and behaved exactly as the pinned source describes, but it was not rebuilt |

Cleanup of this run: the test registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\org.maginalia.smoke_971a0fb9` was removed after its value was proven to point at this run's manifest, the disposable tree was deleted, and no Chrome process using it remained.

**Pre-existing, not touched:** `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.maginalia.issue3.smoke` (a leftover from the Issue #3 smoke, whose cleanup was already reported incomplete) is still present. It was not created by this work and ownership could not be proven, so it was left as found.

## Review follow-up: smoke tooling safety

The disposable harness in `dev/native-host-smoke/` was hardened so it fails closed. This changed development tooling only: `host-client.js`, the service worker, the popup, the Outbox and the experimental host itself are unchanged.

| Item | Result | Evidence |
| --- | --- | --- |
| `setup.mjs` never reuses an existing `--root` | PASS | Root is created with a non-recursive `mkdir`; an existing path, a missing parent directory or a path inside the repository aborts before any write |
| Unique ownership marker bound to host name, extension ID and root | PASS | Random 32-hex marker in `smoke-owner.json`, mirrored into `native-host.json` `description`; the extension ID is re-derived from the copied manifest `key` at cleanup time |
| `cleanup.mjs` verifies ownership, registration target and path before deleting | PASS | `collectOwnershipProblems` runs before any deletion; the registry key is re-read after removal; the tree is deleted bottom-up with a per-entry re-check |
| Refusal paths fail closed | PASS | `node --test tests/*.cjs` — 69 tests, 0 failures; the new `tests/native-host-smoke.test.cjs` covers an existing directory, an already-registered host, a forged manifest, a cross-root registration, a copied tree, a junction and a missing ownership record |
| No change to the production Host path or the Outbox | PASS | `git diff --stat` for this follow-up limited to `dev/native-host-smoke/`, `tests/native-host-smoke.test.cjs` and this note |
| Issue #3 leftover registration untouched | PASS | `com.maginalia.issue3.smoke` was only ever queried, never modified or deleted |
| Full real-Chrome re-run of the smoke after the harness change | NOT VERIFIED | This follow-up changes only the disposable harness; the transport, the helper and the extension code under test are byte-identical to the run recorded above |

**Boundary:** passing Chrome and mock checks do not establish a production Collector, Shelf writes, cross-process safety, or Reviewer delivery. ADR 0019's implementation acceptance items remain NOT VERIFIED.

## Running the isolated smoke

`dev/native-host-smoke/` builds a disposable environment outside this repository. It is development tooling, never shipped, and must not be pointed at real research data.

```text
node dev/native-host-smoke/setup.mjs --root <temp-dir> --desktop-host <abs path to built experimental host .js>
```

`setup.mjs` writes a disposable Collector build (with `nativeMessaging` and a throwaway manifest `key`), a Shelf fixture, a `shelf_location.yml` in the current Desktop registry format, a descriptor, a launcher, a test-only Chrome host manifest and a `smoke-owner.json` ownership record. It creates `--root` with a non-recursive `mkdir`, so it never reuses or overwrites an existing directory, and it refuses to run if the chosen host name is already registered. It never writes inside the repository.

After the checks, remove only what was created:

```text
node dev/native-host-smoke/cleanup.mjs --root <temp-dir> --host <host name>
```

`cleanup.mjs` fails closed. Before deleting anything it requires that the ownership record, the host name, the absolute root path, the ownership marker embedded in `native-host.json` `description`, the extension ID re-derived from `extension/manifest.json` `key`, the single `allowed_origins` entry and the current registry value all agree. A missing, forged, moved, or re-registered environment stops the run with a
`cleanup:` message and leaves the registration and the directory in place. It also refuses any tree containing a symbolic link or junction, and deletes entries bottom-up while re-checking each one.

`tests/native-host-smoke.test.cjs` covers the refusal paths with an in-memory registry adapter: an existing `--root`, an already-registered host name, a forged host manifest, a registration that points at another root, a copied tree, a junction inside the root, and a missing ownership record.

Chrome 156 ignores `--load-extension` for unpacked extensions. Loading the disposable build therefore requires either the `chrome://extensions` developer-mode UI or the CDP `Extensions.loadUnpacked` command with `--enable-unsafe-extension-debugging`. Both keep the extension inside the disposable profile.

## Open decisions (unchanged from ADR 0019)

Approved extension identity and distribution targets; host packaging, registration scope and lifecycle; descriptor ownership, ACL and expected-Shelf-UUID binding with legacy migration; cross-process write coordination, crash recovery and idempotency; protocol versioning and payload limits; whether an offline Reviewer queue exists at all.

This document is a Collector-side implementation note. It does not amend the requirements plan, ADR 0019, the Shelf contract, or `.magicap`.
