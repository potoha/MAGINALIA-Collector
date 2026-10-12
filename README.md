# MAGINALIA Collector

**Webで見つけた文章を、研究の本棚へ。**

MAGINALIA Collector は、Webページ上の引用を集めるための **Chrome / Chromium 系ブラウザ向け拡張機能**（Manifest V3予定）です。文系の学生・研究者・書き手が、出典を失わずに資料を保存することを目指しています。

> **開発状況: 要件定義・リポジトリ初期整備段階。**
> 現時点のこのリポジトリには実行可能な拡張機能（`manifest.json` など）はありません。以下は**計画中の機能・操作**であり、利用可能な状態を示すものではありません。

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

### Chromeでの手動導入（配布開始後）

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
