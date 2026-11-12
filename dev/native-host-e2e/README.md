# Isolated Chrome → Native Host → Private Shelf E2E

This development harness verifies Collector's explicit selection flow against the experimental Desktop Native Host. It is not a product contract, installer, or release artifact. Since Collector 0.2.0 the ordinary manifest carries `nativeMessaging` and the fixed product key; this harness still writes its own throwaway `key` into the private copy, so the test extension has a different ID and talks only to the uniquely named test Host set through the `collector.host-profile` override.

The test Host exposes `save_web_quote` only when **both** a test-only descriptor flag and the Host process environment gate are present. The harness sets those values in its unique launcher and registers one unique `HKCU` Native Messaging name with the exact generated extension origin. The browser sends only a request ID, quote, source URL, acquisition time, and optional bibliographic fields. Shelf paths, Shelf UUID binding, and the isolated coordination root come from the temporary MAGINALIA-side configuration.

## Build the test Host

Use a clean Desktop development worktree based on Draft PR #87's head. Keep the user-designated Desktop UI worktree separate and do not reset or clean it.

```powershell
npm run build:main --workspace @maginalia/desktop
npm run build:native --workspace @maginalia/desktop
```

For the child-process contract and disposable recovery test:

```powershell
npm run test:collector-host --workspace @maginalia/desktop
```

That test intentionally fails the first disposable write after its Book is published but before its Annotation commit point. It confirms the Outbox remains retryable, the persistent recovery marker remains, the retry completes the same request, the duplicate returns `already-committed`, and the fixture contains one v0.4 Book and one v0.4 Annotation.

## Disposable real-Chrome run

Create a new Host registration and disposable Shelf. Omit the `--root` option to create a new, never-reused temporary directory. `--desktop-host` must point at the compiled Host from the separate test worktree.

```powershell
node dev/native-host-e2e/prepare.mjs --disposable --desktop-host "<Desktop test worktree>\apps\desktop\dist\main\collector-native-host.js"
```

The command creates a private test extension copy with `nativeMessaging` and a throwaway stable extension key. It registers only the generated test Host name for the current Windows user. It prints the extension directory, extension ID, Host name, and isolated Desktop app-data root; it never prints the selected Shelf path or contents.

In a new Chrome profile, enable Developer mode at `chrome://extensions` and load the printed extension directory with **Load unpacked**. Open that extension's popup DevTools Console and set its machine-local test Host name:

```js
chrome.storage.local.set({ "collector.host-profile": { hostName: "<printed test Host name>" } })
```

Open [example.com](https://example.com/), select one exact string visible in its English paragraph, and use the Collector context menu **本棚に追加**. The page currently has no `Example Domain` heading; record the exact selected text locally for the later verifier. The confirmation page shows the 「本棚に保存」 button; its Shelf status line names the disposable Shelf once the test Host reports `save_web_quote`.

The first save is expected to return a failure after leaving a staged Book and recovery marker. Confirm the quote remains pending in the capture page, then click 「もう一度保存」. Each click sends exactly one `save_web_quote` with the original request ID. The retry should return `committed` and show 「保存しました」; the Outbox entry is removed only after that receipt validates. A further same-ID resend (for example from 「保留を開く」 before cleanup) must return `already-committed`. The forced second send that earlier builds performed now exists only in the unit tests. Verify the fixture has one Book and one Annotation and that both validate as Shelf v0.4.

The fault injection exists only in the disposable launcher's environment. A harness created with `--shelf-root` below does not include that failpoint.

## Backup and selected-Shelf run

Proceed only after the disposable save, recovery, duplicate, and schema checks pass. Back up the selected Shelf to a new sibling directory; the script refuses to reuse a destination and verifies the copy against a read-only source snapshot.

```powershell
node dev/native-host-e2e/backup.mjs --shelf-root "<selected Private Shelf root>"
```

Record the returned backup location privately. Before registering the real-Shelf test Host, capture a hash-only inventory outside the Shelf:

```powershell
node dev/native-host-e2e/snapshot.mjs --shelf-root "<selected Private Shelf root>" --output "<new temporary file path>"
```

Create a fresh test Host environment. This does not write into the Shelf; its temporary `shelf_location.yml` explicitly selects the provided root and binds the D068 UUID read from its marker.

```powershell
node dev/native-host-e2e/prepare.mjs --shelf-root "<selected Private Shelf root>" --desktop-host "<Desktop test worktree>\apps\desktop\dist\main\collector-native-host.js"
```

Load this new copy in a fresh Chrome profile and set the new printed Host name using the same `chrome.storage.local.set` command. Repeat the real selection flow once. One click sends the request once and must return `committed` (or `already-committed` after a retry of an earlier lost response).

After saving, run the read-only verifier from the separate Desktop PR #87 test worktree (the same worktree that built the test Host). It uses the test descriptor and pre-save hash inventory, confirms every original Shelf file is unchanged, confirms exactly one new Book and Annotation and no other new Shelf files, validates the records with the Desktop Shelf v0.4 validator, compares the quote with the selected text supplied on the command line, and verifies the persisted coordination receipt:

```powershell
node apps/desktop/test/collector-shelf-e2e-verify.mjs "<test root>\descriptor.json" "<pre-save snapshot file>" "<exact selected text>"
```

Expected output is `status: PASS`, one Book, one Annotation, both v0.4, and `durableReceipt: committed`. The command prints no Shelf path, name, UUID, quote, or record contents.

## Desktop UI verification

Use the exact Desktop UI worktree requested for this task. Before launch, record its current branch, HEAD, status, and dependency state. Preserve its pre-existing changes. Set `APPDATA` to the printed test app-data root in the PowerShell session, then run the required `npm start` from that worktree:

```powershell
$env:APPDATA = "<printed isolated Desktop app-data root>"
npm start
```

Open the configured Private Shelf in the Desktop UI. Confirm the new quote appears and search for the exact selected text and source URL `https://example.com/`. Record each result separately. The checked Desktop search projection and result card do not include source URLs; a URL search miss is FAIL for URL search and must not be reported as a complete Desktop E2E pass. Shelf JSON validation alone is not Desktop E2E acceptance.

## Cleanup

Close the test Chrome profile and Desktop app. Remove the generated test Host registration and temporary environment only through the ownership-checked cleanup helper:

```powershell
node dev/native-host-smoke/cleanup.mjs --root "<printed test root>" --host "<printed test Host name>"
```

Keep the verified backup directory. Remove the temporary Chrome profile through Chrome's profile manager. The cleanup helper never follows links and refuses to delete a root if ownership no longer matches. Do not clean the user-designated Desktop worktree or the Private Shelf.
