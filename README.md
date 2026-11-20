# MAGINALIA Collector

**Webで見つけた文章を、研究の本棚へ。**

MAGINALIA Collector は、Webページ上の引用を集めるための Chromium 系ブラウザー向けの **Manifest V3 拡張機能**です。文系の学生・研究者・書き手が、出典を失わずに資料を保存することを目指しています。保存先は、[MAGINALIA Desktop](https://github.com/potoha/MAGINALIA_desktop) で設定した **Private Shelf（自分の本棚）** です。

> **状態: 0.3.0（[Releases](https://github.com/potoha/MAGINALIA-Collector/releases/tag/v0.3.0)）。α2 の先行版です。**
> 実ブラウザーと製品の連携プログラムを組み合わせた受入確認は、まだ済んでいません（NOT VERIFIED）。使い捨ての本棚で試してください。

## できること（0.3.0）

1. Webページで引用したい文章を選び、右クリック → **「本棚に追加」**。
2. 開いた画面で、引用本文・出典・コメントを確認し、必要なら編集します。
3. 次のどちらかを選びます。
   - 「このブラウザーに保留」: 拡張機能専用の保存領域（IndexedDB）に置きます。MAGINALIA へは送りません。
   - 「本棚に保存」: MAGINALIA の連携プログラムを通して、設定済みの Private Shelf に保存します。

記録する出典情報は、**実際に閲覧した URL、ページタイトル、サイト名、取得日時、確認できた場合の著者・公開日**です。自動で取得できなかった属性を、推測で補いません。

### 保存の確実さ

- 「保留しました」は本棚への保存完了ではありません。
- 「保存しました」と表示するのは、連携プログラムが保存を受領し、保存先の本棚と依頼 ID が一致したことを確認できたときだけです。
- 保存に失敗しても、引用は保留に残ります。自動での再送・削除はしません。再送は利用者の操作で行い、同じ依頼 ID を使うため、本棚に二重には保存されません。
- 本棚には保存できたのに、この端末の保留だけ片付けられなかったときは、その旨を表示して項目を残します。
- 失敗の原因（連携プログラム未登録、保存先未設定、本棚の不一致、本棚の使用中、タイムアウト、書き込み失敗など）は区別して表示します。

### 保留キューについて

- 保留項目は 1 件 16 MiB、合計 128 MiB までです（本文などの論理サイズで計算します）。自動では削除も期限切れにもしません。ツールバー画面から、確認のうえ個別に削除します。
- 保留はブラウザープロファイルの中に保存され、同期されません。拡張機能の削除、プロファイルの削除、サイトデータの消去で失われます。エクスポート機能はありません。
- 複数のブラウザー（またはプロファイル）に入れると、保留キューはそれぞれ別になります。
- 保留する前の引用は、その画面を開いている間だけの一時データです。ブラウザーや拡張機能が異常終了すると失われることがあります。

## インストール

**通常は MAGINALIA Desktop から設定します。**
MAGINALIA の「ファイル」→「**Collector 連携を設定…**」が、対応ブラウザーの検出、連携プログラムの登録、拡張機能の入れ方の案内、接続確認までを案内します。うまく動かないときは「**Collector 連携の確認・修復…**」を使います。

拡張機能そのものは、Chromium 系ブラウザーの仕組み上、利用者が自分で読み込みます（デスクトップアプリから無断でインストールすることはしません）。

- 拡張機能 ID は固定です: `blgmoddncpknfnikdfnjelmdmphfgknf`（`manifest.json` の固定 `key` による）。
- 配布ファイル: [Releases](https://github.com/potoha/MAGINALIA-Collector/releases) の `maginalia-collector-0.3.0.zip`。同じ場所に SHA-256 を載せています。展開前に確かめてください。
- 一画面一操作の手順書: [docs/install-guide-ja.md](docs/install-guide-ja.md)（書き直しを予定しています）。

### 対応ブラウザー

- Google Chrome を主な対象にしています。
- どのブラウザーで動作を確認したかは、MAGINALIA Desktop の連携ウィザードの一覧が正です。一覧にないブラウザー（Microsoft Edge を含む、確認中のもの）は、動作を保証しません。
- Chrome Web Store などでの公開は未定です。

## 権限とプライバシー

- 選択した本文は確認画面を開いている間だけ `chrome.storage.session` で受け渡します。本文を URL、ログ、同期ストレージ、外部サービスへ送りません。
- 宣言する権限は次のとおりです。全サイトのホスト権限と `tabs` 権限は求めません。
  - `contextMenus`: 選択時の右クリック項目。
  - `activeTab` / `scripting`: 利用者が右クリックしたタブのページ情報の取得。
  - `storage`: 画面間の短時間の受け渡し。
  - `nativeMessaging`: MAGINALIA の連携プログラム（`org.maginalia.collector`）との接続確認と、「本棚に保存」。
- Collector は保存先の本棚を列挙・選択・切替しません。保存先は MAGINALIA 側で設定します。
- 「MAGINALIAとの接続」の確認は読み取り専用で、引用を送りません。

## MAGINALIA との関係

```text
Webページ ── 選択テキスト ──► 確認画面 ──► ブラウザー内の保留（IndexedDB）
                                   └────► 連携プログラム ──► Private Shelf
```

Collector は**収集のための窓口**で、本棚のデータの正本は持ちません。ブラウザーからローカルファイルへ直接は書かず、MAGINALIA が提供する限定的な連携プログラム（Native Messaging）だけを通します。収集の操作で、自動的に公開することはありません。

## 版の互換性

- 接続確認は連携プログラムが `host_info` に対応している場合だけ、Collector と連携プログラムの版を照合します。保存の経路では呼びません。
- 版が合わないときは、Collector を更新する場合（MAGINALIA の「Collector 連携を確認・修復…」）と、MAGINALIA を更新する場合を区別して案内します。
- 古い版が書いた保留キューと `chrome.storage` のキーは、新しい版が読めなければなりません。規則は [docs/storage-compatibility.md](docs/storage-compatibility.md) にあります。

## 今後の予定（未実装）

次の機能はまだ実装していません。

- キャプチャー: 選択できない文章（画像など）を、画面の四角形で撮影し、MAGINALIA Reviewer の確認待ちキューへ送る機能。画像内の文字は、Reviewer の OCR と人の確認・承認を経て、はじめて正式な引用になります。Collector が、未確認の OCR 結果を確定引用として保存することはありません。
- HTML の保存（任意機能）、初期設定・詳細設定の画面。
- 導入ガイドの書き直しと、拡張機能の自動再読み込み。

この README は、要件定義や承認済みの設計判断を上書きしません。

## 開発者向け

変更履歴: [CHANGELOG.md](CHANGELOG.md)。開発担当エージェント向けの作業規則: [AGENT.md](AGENT.md) と [AGENTS.md](AGENTS.md)。

### 開発用の読み込み

1. ブラウザーで `chrome://extensions` を開き、**デベロッパー モード**を ON にします。
2. **パッケージ化されていない拡張機能を読み込む**で、`manifest.json` が直下にあるフォルダー（このリポジトリのルート、または配布 ZIP の展開先）を選びます。
3. 一覧の ID が `blgmoddncpknfnikdfnjelmdmphfgknf` であることを確かめます。同じプロファイルに、リポジトリと ZIP の両方を同時に読み込まないでください。

本棚への保存の検証には、使い捨ての本棚だけを使います（[dev/native-host-e2e](dev/native-host-e2e)）。

### テスト

Node.js の標準機能だけで実行できます。ブラウザー API をモックした確認であり、実ブラウザーでの確認の代わりにはなりません。

```text
node --test tests/*.test.cjs
```

`dev/` の smoke と E2E は開発用で、配布物には含みません。読み取り専用の接続確認は [dev/native-host-smoke](dev/native-host-smoke)、使い捨ての本棚での保存・復旧は [dev/native-host-e2e](dev/native-host-e2e) です。

### 配布 ZIP の作成

```text
node scripts/build-dist.mjs
```

`dist/maginalia-collector-<version>.zip`（`manifest.json` が直下）と `dist/SHA256SUMS` が作られます。同梱するのは `scripts/build-dist.mjs` の許可リストにあるファイルだけです。作成後に ZIP を読み直して内容を照合します。改行を LF にそろえ、日時を固定するため、同じコミットからは同じ ZIP ができます。`dist/` は Git の管理対象外です。

**企画・開発:** beyond the Word / MAGINALIA
