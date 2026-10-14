# MAGINALIA Collector

**Webで見つけた文章を、研究の本棚へ。**

MAGINALIA Collector は、Webページ上の引用を集めるための **Chrome / Chromium 系ブラウザ向け Manifest V3 拡張機能**です。文系の学生・研究者・書き手が、出典を失わずに資料を保存することを目指しています。

> **開発状況: 選択引用の確認画面まで実装済みです（α・開発用）。**
> 実 Chrome での unpacked 導入と操作確認は未完了です。Private Shelf への保存、未送信キュー、HTML 保存、OCR、MAGINALIA との接続は未実装です。このリポジトリは配布リリースではありません。

## 現在の基盤

- Chrome のツールバー action は、`準備中` と未実装内容を示す画面を開く設定です。
- HTTP(S) ページ上の選択用に `本棚に追加` メニューを登録し、引用本文とページ属性を確認・編集する画面を開きます。著者・公開日はページのメタ情報が見つかった場合だけ入力します。実 Chrome での動作確認は未完了です。
- 選択本文は `chrome.storage.session` を使って拡張機能内の確認画面へ一時的に渡し、画面が受け取ると削除します。本文をURL、ログ、ローカル/同期ストレージへ入れません。受け渡しに失敗した場合も保存成功とは表示しません。
- 保存先は Private Shelf と表示しますが、Outbox/Bridge が未接続のため「本棚に追加」ボタンは無効です。入力内容は画面を閉じると失われます。未送信キュー、Shelf writer、Reviewer、OCR、ローカルホスト、Installer、HTML 保存、クラウド連携はありません。
- 宣言権限は `contextMenus`、`activeTab`、`scripting`、`storage` です。全サイトのホスト権限や `tabs` 権限は要求しません。ページ属性取得は、利用者がコンテキストメニューを実行したタブに限ります。

以下は**将来の目標機能（未実装）**です。

## できるようにすること

### 1. 選択した文章を「本棚に追加」

1. Webページで引用したい文章を選択します。
2. 右クリック → **「本棚に追加」**。
3. 開いた画面で、出典情報・引用本文を確認し、コメントを記入します。
4. 必要に応じて **ページのHTMLも保存**するか選びます。
5. **MAGINALIA Private Shelf** に登録します（既定の保存先）。

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
| 選択できるテキスト | 右クリック → 本棚に追加 | **Private Shelf** |
| 画像などの選択できないテキスト | アイコン → 四角形キャプチャー | **Reviewer（OCR待ち）** |

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
4. MAGINALIA Collector が一覧に追加されたら、ツールバーアイコンをクリックします。`準備中` と未実装の案内が表示され、保存が行われないことを確認します。
5. 通常の HTTP(S) ページで文字列を選択して右クリックし、`本棚に追加` を選びます。確認画面に引用本文とページ情報が表示され、引用本文を編集できることを確認します。canonical URL は閲覧中の URL と別の候補として表示されます。
6. 確認画面で保存先が Private Shelf と表示され、HTML 保存チェック欄と「本棚に追加」ボタンが未接続のため無効であることを確認します。入力内容は保存・送信されません。
7. 選択を解除して右クリックしたときに項目がなく、`chrome://extensions` などの内部ページにも項目が出ないことを確認します。ツールバー画面には保存成功の表示がありません。
8. `chrome://extensions` で拡張機能を再読み込みし、右クリック項目が一つだけ表示されることを確認します。サービスワーカーが停止してからの再起動後も同じ操作を確認します。
9. 検証時は Chrome と OS のバージョン、権限表示、各操作の結果を記録します。テスト用の選択文字列に実際の私的情報を使わないでください。

静的確認は Node.js の標準機能だけで行えます（実 Chrome の確認の代わりにはなりません）。

```text
node --check service-worker.js
node --check popup.js
node --check capture.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json', 'utf8'))"
node --test tests/service-worker.test.cjs
```

単体テストは Chrome API をモックした登録・クリック分岐の確認です。実 Chrome の拡張機能読み込みや右クリック動作の証拠とは別に扱います。

宣言権限 `contextMenus` は選択時の右クリック項目に、`activeTab` と `scripting` は明示操作後のページ属性取得に、`storage` は短時間の画面受け渡しに使います。項目は HTTP(S) ページ上の選択時だけ表示されます。権限が利用できない場合はページ属性を確認できなかったことを画面に表示し、保存成功を示しません。

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
Webページ ── 選択テキスト ──► Collector ──► Private Shelf
       └── 画面キャプチャー ─► Collector ──► Reviewer (OCR/人手確認)
                                                └──► Private Shelf
```

Collector は**収集インターフェース**で、ShelfやReviewerのデータ正本を独自に持ちません。ブラウザからローカルファイルへ無制限に直接書き込まず、MAGINALIA側が提供する限定的な接続アダプターを通します。具体的な接続方式（Native Messagingなど）は**未確定**です。ローカル保存とGitHub同期・Publishは別の操作で、収集行為による自動公開は行いません。

実装時は現行の **Shelf JSON v0.4** と **`.magicap` v3** を尊重します。Webページは `source.kind = "website"` として扱い、正式な引用には出典・取得日時を付与します。HTMLスナップショットや四角形座標の契約は、既存スキーマへ無断でフィールドを追加せず、正式な仕様決定を経て導入します。

## 仕様書・開発参加

- **[Collector 要件定義 v0.2（MAGINALIA IDE側・現行計画）](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md)**
- [Shelf JSON Contract v0.4](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/shelf-json-contract.md)
- [`.magicap` v3 Contract](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/magicap-contract-v3.md)
- [Reviewer UX specification](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/17_CAPTURE_REVIEW_UX_SPEC.md)
- **[AGENT.md](AGENT.md):** 開発担当エージェント向けの作業規則。Codex等の自動検出用に[AGENTS.md](AGENTS.md)も配置します。

このリポジトリのREADMEは製品案内であり、上記の要件定義やAccepted ADRを上書きしません。機能実装、公開ライセンス、配布開始日、ブラウザ対応範囲などの未確定事項を既成事実として扱わないでください。

**企画・開発:** beyond the Word / MAGINALIA
