# Isolated Native Messaging smoke (development only)

Disposable tooling for checking the Collector's helper client against the
**experimental** MAGINALIA Native Messaging host. Nothing here ships, and nothing
here is a product contract: the protocol, descriptor, host name, shelf identity
expectation, registration and extension identity are all experimental.

Never point this at real research data, a real Chrome profile, or an existing host
registration. Use a disposable directory under your temporary folder.

## What it creates

`setup.mjs` builds a self-contained tree in `--root`:

| Path | Contents |
| --- | --- |
| `extension/` | A copy of this repository with `nativeMessaging` added and a throwaway manifest `key`, so the extension ID is known before Chrome starts |
| `shelf/` | A Shelf fixture: typed `shelf.magi` marker, `library.json`, `books/`, `annotations/` |
| `shelf_location.yml` | Desktop `shelf_location.yml` shape pointing the Private Shelf at `shelf/` |
| `descriptor.json` | The experimental host descriptor (`experimental`, `shelfLocationPath`, `expectedShelfId`, `allowedOrigin`) |
| `native-host.json` | Test-only Chrome host manifest with `allowed_origins` for exactly that extension ID and the run's ownership marker in `description` |
| `smoke-owner.json` | Ownership record: marker, host name, extension ID, absolute root, creation time |
| `launcher.cmd` | Launches the experimental host with the absolute Node executable |
| `profile/` | An empty disposable Chrome profile |

The repository, the user's Chrome profile, and any existing registration are not
modified. `setup.mjs` creates `--root` with a non-recursive `mkdir`, so an existing
directory is never reused or written into, and it refuses to run if the chosen
host name is already registered.

## Ownership marker

Every run generates a random 32-hex marker. It is stored in `smoke-owner.json` and
embedded in the `native-host.json` `description` as `[smoke-marker:<marker>]`. The
owner record also binds the host name, the throwaway extension ID (re-derived at
cleanup time from the copied manifest `key`) and the absolute root path.

The experimental host descriptor takes exactly four keys, so the marker cannot
live there. Binding runs through the host manifest instead: `allowed_origins[0]`
must equal `chrome-extension://<extensionId>/`, and `<extensionId>` must equal the
one in the owner record and the one derived from `extension/manifest.json` `key`.

## Usage

```text
node dev/native-host-smoke/setup.mjs \
  --root "%TEMP%\maginalia-collector-nh-smoke" \
  --desktop-host "<absolute path to the built experimental collector host .js>"
```

It prints a JSON description including the extension ID, host name, ownership
marker, registry key and the paths it created. `--root` must be a path that does
not exist yet; setup creates it and refuses to reuse anything. Register the
printed key for the current user only:

```text
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\<host name>" /ve /t REG_SZ /d "<root>\native-host.json" /f
```

Start a fresh Chrome process with the disposable profile, the disposable
extension, and the descriptor in its environment. Chrome must inherit
`MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR` from the process that starts it:

```text
set MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR=<root>\descriptor.json
chrome.exe --user-data-dir=<root>\profile --enable-unsafe-extension-debugging --no-first-run about:blank
```

Chrome 156 no longer honours `--load-extension` for unpacked extensions. Load
`<root>\extension` either through `chrome://extensions` in developer mode, or, for
automation, through CDP:

```text
Extensions.loadUnpacked { "path": "<root>\\extension" }
```

Check that the returned ID equals the `extensionId` from the setup output, and
that it equals `chrome-extension://<id>/` in the descriptor and host manifest.

The disposable profile also needs the helper profile, which the popup cannot set:

```js
chrome.storage.local.set({ "collector.host-profile": { hostName: "<host name>" } })
```

Open `chrome-extension://<id>/popup.html` and press 「接続を確認」.

## Checks worth running

| Check | Expected |
| --- | --- |
| Configured Shelf matches | 「接続を確認できました。」 with the fixture name and UUID, no filesystem path |
| Change only `expectedShelfId` in `descriptor.json` | 「設定されたPrivate Shelfと、応答した保存先が一致しません。」 |
| Point `allowed_origins` at a different ID | 「MAGINALIA連携プログラムへの接続が許可されませんでした。」 |
| Delete only the test registry key | 「…登録されていません。」 |
| Clear the stored helper profile | 「接続先がまだ設定されていません。」 |

Compare a recursive checksum of `<root>\shelf` before and after. No file may be
created or modified: this slice never writes.

## Cleanup

```text
node dev/native-host-smoke/cleanup.mjs --root "<root>" --host "<host name>"
```

Close every Chrome process using the disposable profile first.

`cleanup.mjs` checks all of the following before it deletes anything:

| Check | Refuses when |
| --- | --- |
| `--root` | does not exist, is not a directory, or is itself a symbolic link/junction |
| `smoke-owner.json` | is missing, unparseable, not a smoke record, or malformed |
| Host name | the record, `native-host.json` `name` and `--host` are not all the same |
| Root path | the record's absolute root differs from `--root` (moved or copied tree) |
| Ownership marker | `native-host.json` `description` carries no marker or a different one |
| Extension identity | `extension/manifest.json` `key` does not derive the recorded extension ID, or the manifest lacks `nativeMessaging` |
| Allowed origin | `allowed_origins` is not exactly `chrome-extension://<extensionId>/` |
| Registration | the key holds a value other than `<root>\native-host.json` |
| Tree contents | any symbolic link or junction exists anywhere below `--root` |

It then deletes the registry key (only if it was present and matched), re-reads
the key to prove it is gone, deletes the tree bottom-up while re-checking each
entry, and confirms `--root` no longer exists. Any failed check stops the run
with a `cleanup:` message and deletes nothing — not the registration, not the
directory, not a link target. An unproven directory is left for a human to
inspect; `cleanup.mjs` never guesses.

Ownership that cannot be proven is not recoverable by this tool. A root whose
`smoke-owner.json` is gone, corrupted, or belongs to another host must be removed
manually after inspecting it. The same applies to a root left behind by a
`setup.mjs` that failed partway: no ownership record was written, so cleanup
refuses it by design and names the directory in the setup error.

## Limits

A passing run proves this transport, this client, and this experimental helper
against a fixture. It does not prove production registration, packaging, the
approved extension identity, Shelf writes, cross-process coordination, or
Reviewer import. See `docs/issue-4-native-host-client.md`.
