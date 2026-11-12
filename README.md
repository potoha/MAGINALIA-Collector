# MAGINALIA Collector

**Webで見つけた文章を、研究の本棚へ。**

MAGINALIA Collector は、Webページ上の引用を集めるための **Chrome / Chromium 系ブラウザ向け Manifest V3 拡張機能**です。文系の学生・研究者・書き手が、出典を失わずに資料を保存することを目指しています。

> **開発状況（0.2.0、未リリース）: 選択引用の確認画面、ブラウザー内の保留キュー、連携状態の確認に加え、確認画面の「本棚に保存」からMAGINALIA連携プログラム（Native Messaging Host `org.maginalia.collector`）経由でPrivate Shelfへ保存する製品経路を実装しています。**
> 製品Hostと組み合わせた実Chromeでの受入はまだ行っていません（NOT VERIFIED）。リリースはその受入とオーナー承認の後です。過去の隔離E2Eの記録は[dev/native-host-e2e](dev/native-host-e2e)にあります。

## 現在の基盤

- Chrome のツールバー action は、このブラウザープロファイルに保留した引用の件数・状態を表示します。Private Shelfへの保存完了とは区別します。
- HTTP(S) ページ上の選択用に `本棚に追加` メニューを登録し、引用本文とページ属性を確認・編集する画面を開きます。著者・公開日はページのメタ情報が見つかった場合だけ入力します。実 Chrome での動作確認は未完了です。
- 選択本文は確認画面を開く間だけ `chrome.storage.session` で受け渡し、利用者が「このブラウザーに保留」を選ぶと、編集後の引用・出典・コメントを拡張機能専用のIndexedDBに保存します。本文はURL、ログ、同期ストレージ、外部サービスへ送りません。
- 保留項目は1件16 MiB、合計128 MiBまでです。上限は本文などのUTF-8文字列、Blob等から計算する論理サイズで、IndexedDB内部の保存オーバーヘッドを含むディスク使用量ではありません。ブラウザーの実際の保存容量が不足する場合は保存失敗を表示し、確認画面の入力は残します。項目は自動削除・自動期限切れにせず、ツールバー画面から利用者が確認ダイアログを経て個別に削除します。
- 保留成功はPrivate Shelfへの保存完了ではありません。「本棚に保存」は、まず引用をOutboxに保留し、Hostへ`save_web_quote`を同じ依頼IDで1回だけ送ります。Hostの受領（`committed`または`already-committed`、設定済みShelfと依頼IDに一致）を確認した後にだけOutboxから削除し「保存しました」と表示します。受領後にOutboxの削除だけが失敗した場合は「本棚には保存済みですが、この端末の保留が残っています」と表示し、項目を残します。それ以外の失敗では原因を表示して保留を残します。自動再送・自動削除はせず、再送は利用者の明示操作で同じ依頼IDを使います。画像キャプチャー、Reviewer取込、OCR、Installer、HTML保存、クラウド連携はありません。
- ツールバー画面の「MAGINALIAとの接続」は、稼働状態とMAGINALIAが設定した単一Private Shelfの表示名・識別IDを確認するread-only操作です。`manifest.json`は固定の公開鍵（`key`）で拡張機能IDを `blgmoddncpknfnikdfnjelmdmphfgknf` に固定し、`nativeMessaging`権限を持ちます。Host名の既定は`org.maginalia.collector`です。`chrome.storage.local`の`collector.host-profile`は、[dev/](dev)の使い捨て開発・E2E用ツールだけが使う上書き設定です。Collectorは保存先の本棚を列挙・選択・切替しません。保存先はMAGINALIA側で設定します。
- 保留前の確認画面を閉じる操作では、未保留の引用・編集内容を破棄する確認を表示します。ブラウザー離脱時にも標準の離脱確認を要求します。保留する前の引用はセッション内の一時データなので、ブラウザーや拡張機能の異常終了時には失われる場合があります。
- IndexedDBはChromeの拡張機能データとして現在のブラウザープロファイル内に保存され、同期されません。拡張機能の削除、プロファイルの削除、ブラウザーのサイトデータ消去で保留内容を失う場合があります。現状、キューのエクスポート/バックアップ機能はありません。
- 宣言権限は `contextMenus`、`activeTab`、`scripting`、`storage` です。全サイトのホスト権限や `tabs` 権限は要求しません。ページ属性取得は、利用者がコンテキストメニューを実行したタブに限ります。

以下は**今後の連携・キャプチャー目標（未実装）**です。

## できるようにすること

### 1. 選択した文章を「本棚に追加」

1. Webページで引用したい文章を選択します。
2. 右クリック → **「本棚に追加」**。
3. 開いた画面で、出典情報・引用本文を確認し、コメントを記入します。
4. 必要に応じて **ページのHTMLも保存**するか選びます。
5. **MAGINALIA Private Shelf** に登録します（既定の保存先）。

現在は手順4の確認後、「このブラウザーに保留」を選ぶとIndexedDBにローカル保存します。Private Shelfへの登録とHostへの送信はまだ行いません。

記録する出典情報の例は、**実際に閲覧したURL、ページタイトル、サイト名、取得日時、確認できた場合の著者・公開日**です。選択テキストは保存前に編集できます。自動取得できなかった属性を捏造しません。HTML保存は任意機能で、完全なオフライン複製は保証しません。

### 2. 選択できない文章をキャプチャー

1. 拡張機能のアイコンから **キャプチャー**を開始します。
2. 開いているタブの**画面に見えている範囲**を撮影します。
3. ドラッグで領域を選び、四隅を調整して**任意の四角形**を指定します。
4. プレビュー、出典情報、コメントを確認します。
5. **「OCR待ちに追加」**で MAGINALIA Reviewer の確認待ちキューに送ります。

画像内の文字は、**ReviewerでOCRし、人が内容を確認・承認してから**正式な引用として Shelf に登録します。Collectorが未確認のOCR結果を確定引用として保存することはありません。

| 入力 | 操作 | 保存先 |
| --- | --- | --- |
| 選択できるテキスト | 右クリック → 確認 → このブラウザーに保留 | **現在: ブラウザー内キュー** / 将来: Private Shelf |
| 画像などの選択できないテキスト | アイコン → 四角形キャプチャー | 将来: **Reviewer（OCR待ち）**（画面未実装） |

## 初期設定と詳細設定（計画）

拡張機能に **初期設定用HTML画面**と**詳細設定用HTML画面**を用意します。

- **初期設定:** MAGINALIAとの接続を確認し、アプリに登録された利用可能なレジストリ（作業領域）の一覧から既定のPrivate Shelfを選び、Reviewerへの接続も確認する。
- **詳細設定:** 接続状態と再接続、保存先一覧の再取得、HTML保存の既定値、未送信データの確認・再送・削除、ブラウザ権限、更新情報を管理する。

通常の利用で、Git、GitHub、ローカルフォルダパスやJSONを理解する必要はない設計です。MAGINALIAが起動していない場合も、データを黙って失わせず、未送信状態を明示します。

## 配布とインストール（計画）

**現在、インストール可能なリリースはありません。** 配布物とガイドが整った後、次の流れを採用する予定です。

- **α:** MAGINALIA公式サイトから本リポジトリ／[Releases](https://github.com/potoha/MAGINALIA-Collector/releases)へ案内。配布ZIPを展開して手動導入します。
- **α2:** MAGINALIAのインストーラーと初期設定から、対応ブラウザの検出、導入手順、接続設定を支援します。
- **β:** Chrome Web Storeでの公開を**検討**します。公開は未決定です。

### 開発用の手動導入と検証

新しい Chrome プロファイルで、リポジトリのルートフォルダ（`manifest.json` が直下にあるフォルダ）を読み込みます。

1. Chrome で `chrome://extensions` を開きます。
2. `デベロッパー モード` を ON にします。
3. `パッケージ化されていない拡張機能を読み込む` を選び、このリポジトリのルートフォルダを指定します。
4. MAGINALIA Collector が一覧に追加されたら、ツールバーアイコンをクリックします。ブラウザー内の保留件数が表示され、Private Shelf未保存・Host未接続で送信していないことを確認します。「MAGINALIAとの接続」の「接続を確認」は、実験的なMAGINALIA連携プログラムを別途用意しない限り、未登録または未設定の案内になります。これは正常な状態です。接続を確認できた場合も、引用の送信・保存はまだ行われません。
5. 通常の HTTP(S) ページで文字列を選択して右クリックし、`本棚に追加` を選びます。確認画面に引用本文とページ情報が表示され、引用本文を編集できることを確認します。canonical URL は閲覧中の URL と別の候補として表示されます。
6. 確認画面で本文・出典・コメントを編集し、「このブラウザーに保留」を選びます。成功表示がPrivate Shelfへの正式保存を意味しないことを確認します。
7. ツールバー画面で保留項目が表示され、状態が「Private Shelf未保存」と区別されることを確認します。削除を一度キャンセルし、項目が残ることを確認した後、確認してから個別削除します。
8. 保留項目を残した状態で拡張機能を再読み込みし、再度ツールバー画面を開いて項目が残ることを確認します。サービスワーカー停止後の再起動でも同じ確認をします。
9. 選択を解除して右クリックしたときに項目がなく、`chrome://extensions` などの内部ページにも項目が出ないことを確認します。テスト用の選択文字列に実際の私的情報を使わないでください。
10. 検証時は Chrome と OS のバージョン、権限表示、各操作の結果を記録します。

静的確認は Node.js の標準機能だけで行えます（実 Chrome の確認の代わりにはなりません）。

```text
node --check service-worker.js
node --check popup.js
node --check capture.js
node --check outbox.js
node --check host-client.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json', 'utf8'))"
node --test tests/service-worker.test.cjs tests/outbox.test.cjs tests/capture-outbox.test.cjs tests/host-client.test.cjs tests/service-worker-host.test.cjs
```

単体テストは Chrome API をモックした登録・クリック分岐の確認です。実 Chrome の拡張機能読み込みや右クリック動作の証拠とは別に扱います。read-only接続確認のsmokeは[dev/native-host-smoke](dev/native-host-smoke)、使い捨てShelfでの保存・復旧E2Eは[dev/native-host-e2e](dev/native-host-e2e)です。どちらも開発用で、配布物ではありません。

宣言権限 `contextMenus` は選択時の右クリック項目に、`activeTab` と `scripting` は明示操作後のページ属性取得に、`storage` は短時間の画面受け渡しに使います。IndexedDBは拡張機能のオリジン内で使用し、追加のChrome権限は要求しません。項目は HTTP(S) ページ上の選択時だけ表示されます。権限が利用できない場合はページ属性を確認できなかったことを画面に表示し、Shelfへの保存成功を示しません。

### Chromeでの手動導入（配布開始後の予定）

1. Releasesから検証済みの拡張機能ZIPを取得して**展開**する。
2. アドレスバーで `chrome://extensions` を開く。
3. **「デベロッパー モード」**をONにする。
4. **「パッケージ化されていない拡張機能を読み込む」**をクリックする。
5. **`manifest.json` が直下にある展開済みフォルダ**を選ぶ。
6. Collectorの初期設定画面でMAGINALIAへ接続し、Private Shelf／Reviewerを設定する。

手順は、リリース時に**スクリーンショット付き・一画面一操作**の日本語ガイドとして整備します。通常のChromeに対し、デスクトップアプリから拡張機能を無断でインストールする設計は採用しません。

## MAGINALIAとの関係

```text
Webページ ── 選択テキスト ──► Collector IndexedDB ──[接続確認のみ・送信は未実装]──► Private Shelf
       └── 画面キャプチャー ─► Collector IndexedDB ──[未実装]──► Reviewer (OCR/人手確認)
                                                                        └──► Private Shelf
```

Collector は**収集インターフェース**で、ShelfやReviewerのデータ正本を独自に持ちません。ブラウザからローカルファイルへ無制限に直接書き込まず、MAGINALIA側が提供する限定的な接続アダプターを通します。接続方式は [ADR 0019 / D070](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/decisions/0019-collector-native-messaging-host.md) でNative Messagingの方針のみがAcceptedで、登録方法、拡張機能ID、Shelf identity binding、cross-process write safety、冪等性、Reviewerのオフラインqueueは未決定です。現在の接続確認は**開発用の実験的な連携プログラム**を対象にしており、本番契約ではありません。ローカル保存とGitHub同期・Publishは別の操作で、収集行為による自動公開は行いません。

実装時は現行の **Shelf JSON v0.4** と **`.magicap` v3** を尊重します。Webページは `source.kind = "website"` として扱い、正式な引用には出典・取得日時を付与します。HTMLスナップショットや四角形座標の契約は、既存スキーマへ無断でフィールドを追加せず、正式な仕様決定を経て導入します。

## 仕様書・開発参加

- **[Collector 要件定義 v0.2（MAGINALIA IDE側・現行計画）](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md)**
- [Shelf JSON Contract v0.4](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/shelf-json-contract.md)
- [`.magicap` v3 Contract](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/magicap-contract-v3.md)
- [Reviewer UX specification](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/17_CAPTURE_REVIEW_UX_SPEC.md)
- **[AGENT.md](AGENT.md):** 開発担当エージェント向けの作業規則。Codex等の自動検出用に[AGENTS.md](AGENTS.md)も配置します。

このリポジトリのREADMEは製品案内であり、上記の要件定義やAccepted ADRを上書きしません。機能実装、公開ライセンス、配布開始日、ブラウザ対応範囲などの未確定事項を既成事実として扱わないでください。

**企画・開発:** beyond the Word / MAGINALIA
