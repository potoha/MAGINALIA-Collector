# MAGINALIA Collector — 開発エージェント運用規則

**対象:** `potoha/MAGINALIA-Collector` の調査・設計・実装・検証・ドキュメント変更を担当するAIエージェント／人間の開発者。

**状態:** 初期開発規約。これを読むことは実装、マージ、リリースの自動許可を意味しない。

## 1. プロダクトの役割と境界

CollectorはChrome / Chromium系のManifest V3拡張機能としてWeb引用を**収集**する。

- **選択テキスト:** 右クリック「本棚に追加」→プロパティ・コメント・任意のHTML保存を確認→MAGINALIA **Private Shelf**へ。
- **画像化された文字:** 拡張機能アイコン→可視領域の四角形選択（四隅を個別に調整）→**ReviewerのOCR待ち**へ。承認済みの引用としてShelfへ直送しない。
- **初期設定／詳細設定:** MAGINALIAの接続、登録済みレジストリ取得、既定Shelf選択、Reviewer接続、未送信キュー等を扱うHTML画面。
- **配布:** 当面GitHub Releasesと丁寧な手動導入手順。α2でデスクトップInstallerから導入支援。βでWeb Store公開を検討するのみ。

**責務分担:** Collectorはブラウザー側の取得・入力・一時保留を担当する。永続的なShelf正本、ReviewerによるOCR/人手承認、Git/GitHub同期、公開の判断はMAGINALIA側。Collector自身に二つ目の研究データ正本や無制限のローカルファイル書き込みを持たせない。

## 2. 情報源と優先順位

作業開始時に現在のGit状態と関連ソースを確認する。古いチャットの要約だけで実装しない。

1. 今回のユーザー／Product Ownerによる**最新の明示決定**。
2. **MAGINALIA IDEのAccepted ADR・canonical contract・Decision Log**。
3. [Collector要件定義v0.2](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md)などの現行approved plan（当該v0.2の未決定事項は未決定のまま扱う）。
4. このCollectorリポジトリの指定ブランチ上の実装、テスト、README、およびIssue/PRのレビュー。
5. 古い設計や議論（参考のみ）。

確認すべき必要な契約は[ Shelf v0.4 ](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/shelf-json-contract.md)、[Shelf schemas](https://github.com/potoha/MAGINALIA_IDE/tree/main/spec)、[.magicap v3](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/magicap-contract-v3.md)、[Reviewer UX](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/17_CAPTURE_REVIEW_UX_SPEC.md)。情報源の内容と実装が衝突した場合は黙って上書きせず、差分を報告する。

`potoha/toybox` は歴史的な議論の参照専用であり、**strict read-only**。Collectorからもtoyboxにcommit、branch、Issue/PRなどの変更を行わない。

## 3. Git・作業開始・提出

- 実装依頼は、**親ブランチ名と確認済み40桁SHA**、**作業ブランチ名とNEWまたは確認済み40桁SHA**を明示した形で受け取る。推測で埋めない。
- 手元の未コミット変更を保全し、`git fetch origin` 後に指定親ブランチのHEADを照合する。不一致は **`STALE_BASE_COMMIT` として停止**。勝手に読み替え・reset・rebase・force-pushをしない。
- 各作業を一つのレビュー可能な成果へ分割する。要求外のリファクタ・依存更新・機能追加を抱き合わせない。
- 指定の作業ブランチへcommit/pushし、**指定親ブランチ宛のPR**で提出する（その操作が許可された依頼の場合）。既存PR、レビューコメント、CIを確認する。
- **マージ、Release、Chrome Web Store公開、本番デプロイはオーナーの明示承認が必要。** 書き込み権限があることは承認ではない。
- 調査・レビュー専用依頼ではread-only。外部リポジトリやIDE側正本の仕様を、Collectorの作業中に勝手に変更しない。

このファイルはリポジトリの恒久ルール。個々の開発依頼はGoal、Scope/Non-goals、受入条件、対象ブランチ/SHA、禁止事項に集中させる。

## 4. 守るべきデータ契約

- 新しいShelfデータは**Shelf JSON v0.4** に従う。Webページは `Book.source.kind = "website"`。Book / Annotationの安定ID、URL、`get.date`（ローカル取得日時、`YYYYMMDDHHMM`）、引用の非空条件などを正規スキーマで検証する。
- 同一ページ由来の複数引用は出典Bookに紐づける。URLだけで常に同一資料とみなすことはしない。
- コメントは既存Annotationの `comment` を利用する。HTMLスナップショット、Web位置情報、四角形座標等の**既存スキーマにないフィールドを任意追加しない**。契約変更はMAGINALIA IDE側のADR／versioned contract決定を経る。
- 画像キャプチャーは`.magicap` v3を基礎とし、Reviewerに**未確認**として渡す。正本画像や受領データを不意に消さず、OCR派生物を原資料と同一視しない。
- **受領確認後**にのみ「保存しました」。未送信は未送信と表示し、同一リクエストIDによる再送を冪等にする。接続不能、キャンセル、重複送信でデータを失わない。
- Collectorによる自動Git Sync・push・Publish・公開を行わない。Private Shelfの情報を外部へ勝手に送らない。

## 5. セキュリティとプライバシー

- Manifest V3の**最小権限**から開始。選択操作やアイコンクリックに関連する`contextMenus`、`activeTab`、必要に応じた`scripting`／`storage`／`tabs.captureVisibleTab`等を検討し、全サイトの常時アクセス権を当然視しない。
- 収集は明示的なユーザー操作から開始する。パスワード・フォーム入力・認証情報・機密ページ内容を自動収集しない。
- HTMLの保存は任意。保存スナップショット内のスクリプト、認証情報、フォーム状態、外部リソース、容量制限、表示時のサニタイズを未解決のまま「安全」と宣言しない。
- 接続方式（Native Messaging / 認証済みloopback API）は未決定。送信元extension ID、origin、権限、接続先認証、スキーマバージョン照合を設計・検証する。拡張機能に無制限なPCファイル書き込み能力を与えない。
- データ、閲覧履歴、GitHub資格情報を不要なログ・テレメトリー・外部サーバへ送らない。秘密情報や私的引用をIssue、PR、テストfixture、スクリーンショット、公開配布物に含めない。
- DRM解除、技術的保護の回避、ページ全体の無断クロールは対象外。権限拒否や保護ページは安全に失敗する。

## 6. UXとスコープ管理

通常UIは日本語を基準とし、Git/JSON/Repository/パス/IPCといった内部用語を利用者に要求しない。

- 通常の引用保存は「選択→本棚に追加→内容確認→保存」。
- 画面キャプチャーは「アイコン→範囲選択→確認→OCR待ちに追加」。
- 初期設定ではMAGINALIAから使える保存先を取得する。Project/Workdeskへの直送は正式な書き込み契約ができるまで有効化しない。
- 接続未設定、MAGINALIA未起動、Reviewer不達、拡張機能未導入、保存失敗はそれぞれ区別して案内する。
- ユーザーが保存前に原文と出典を確認できること。選択テキストを不必要に正規化・改変しない。
- 初期版ではブラウザ内OCR、ページ全体スクロール合成、完全なオフラインWebアーカイブ、Web Store公開をスコープに混ぜない。
- 実装方式が未決定の項目は小さな技術スパイクで可否を確かめ、選択に製品上の重大な影響があればオーナー判断へ戻す。

## 7. 検証と完了条件

作業ごとに観測可能な受入条件を定め、**PASS / FAIL / NOT VERIFIED**で報告する。

- **Static / lint / type / build**は、実際のChrome導入成功を証明しない。
- **単体・モックテスト**は、実Chrome API、Native Messaging host、実Reviewerへの取り込み成功を証明しない。
- 機能が実装された段階で、**実Chrome/Chromiumの拡張機能として**コンテキストメニュー、キャプチャーUI、権限拒否、設定画面、再送、更新を検証する。
- **接続E2E**はMAGINALIAの本物のShelf/Reviewerと検証する。スキーマ検査は正式なvalidatorを使い、Browser UIの表示成功だけで保存成功としない。
- 導入ガイドは新規ブラウザプロファイルで検証し、α2 Installer連携は本物のインストーラーで別途検証する。
- できなかった検証は省略理由とともに**NOT VERIFIED**にする。未確認をPASSと言い換えない。

完了報告は、親／作業ブランチとSHA、変更ファイル、実施した検証と結果、受入条件、未解決判断、PR URL、未実施操作（特にmerge/release）を含める。

## 8. 禁止される思い込み

- Collectorリポジトリに`manifest.json`や実装が最初からあると仮定しない。
- 本文の計画を「すでに動く機能」としてREADMEに記載しない。
- 既存のShelfスキーマ、`.magicap`、Reviewerの内部構造を黙って変更しない。
- Chrome通常環境で外部アプリからunpacked拡張機能を無人インストールできると約束しない。
- βでのストア公開、ライセンス、技術スタックの細部をオーナー決定済みとみなさない。

設計上の正本はMAGINALIA IDE側、**実装の正本はこのリポジトリの現行ブランチ**。両者の差を解消するため、根拠なくどちらかを上書きしない。
