## CLAUDE.md

このファイルは Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

「Quick Memo」 — Chrome Manifest V3 拡張機能。**ビルド手順・バンドラ・パッケージマネージャ・テストスイートはありません**。ソースファイルは Chrome がそのまま読み込みます。

## よく使うコマンド

- **拡張機能を読み込む**: `chrome://extensions` を開き、デベロッパーモードを ON にして「パッケージ化されていない拡張機能を読み込む」からこのフォルダを選択。ファイル編集後は拡張機能カードのリロードボタンを押す（または新しいタブを開き直す）。
- **アイコン再生成**: `node generate-icons.js` — Node.js 標準の `zlib` のみ使用するため `npm install` 不要。`icons/icon{16,48,128}.png` を出力します。
- lint/test/build コマンドは存在しません。勝手に作らないでください。

## アーキテクチャ

この拡張機能は**互いに独立した 2 つの画面**を持ち、**それぞれが別の永続化レイヤを持ちます**。両者はデータを共有せず、片方を編集してももう片方には反映されません。

### 1. 新しいタブの上書き (`newtab.html` / `newtab.css` / `newtab.js`)

`manifest.json` の `chrome_url_overrides.newtab` で登録される、現在のメイン画面（manifest version 2.0.0）。

- **データモデル**: `elements: Array<{id, type, x, y, w, h, content}>`。`type` は `'text'` または `'image'`。画像の `content` は data URL 文字列（`MAX_IMG = 5MB` で制限）。
- **永続化**: IndexedDB — DB `QuickMemoDB`、オブジェクトストア `canvas`、キー `'main'` に配列全体を JSON 文字列化して保存。`DB_VERSION = 3`（コメントは「キャンバスモードへ移行」）。スキーマを変える際は version を上げて `onupgradeneeded` を実装すること。
- **DOM ミラー**: `domMap: Map<id, HTMLElement>` を `elements` と同期させて保持。状態変更は必ず `addElement` / `removeElement` / `syncDOM` を経由するため、データと DOM がずれません。各要素には 8 方向のリサイズハンドル（`HANDLES = ['nw','n','ne','e','se','s','sw','w']`）がつきます。
- **インタラクション**: キャンバス上の `mousedown` / `mousemove` / `mouseup` を 1 つのステートマシン（`dragState` / `resizeState`）で処理。空白部分のダブルクリックでテキストボックス新規作成、テキスト要素のダブルクリックで `contentEditable` の編集モードへ。Ctrl+V とドラッグ＆ドロップは `insertImageFile` 経由で画像挿入され、`0.45 × canvasW` / `0.70 × canvasH` に収まるよう縮小されます。
- **自動保存**: ミューテーションを伴う処理はすべて `scheduleSave()` を呼ぶ — 配列全体を 600ms デバウンスで書き込み。フッターのステータスピルが `saving` / `saved` を表示。
- **エクスポート**: TXT は `\n\n---\n\n` でテキスト要素を結合。HTML は `max(x+w)` / `max(y+h)` のサイズで絶対配置の単独 HTML を生成し、画像要素は data URL をそのまま埋め込みます。

### 2. ツールバーポップアップ (`popup.html` / `popup.css` / `popup.js`)

単一の `<textarea>` メモ。**注意: ポップアップは `manifest.json` に登録されていません**（`action.default_popup` が無い）— ツールバーアイコンは現在ポップアップではなく新しいタブを開きます。ファイル自体は残っており、再接続すれば動作します。

- **永続化**: `chrome.storage.local` のキー `memoText`（300ms デバウンス保存）。新しいタブ側の IndexedDB とは完全に別。

### アイコン生成 (`generate-icons.js`)

自前の最小 PNG エンコーダ（`zlib.deflateSync` + CRC32 + IHDR/IDAT/IEND チャンク）。RGBA バッファにピクセル単位で角丸四角＋白い横線 3 本を描画します。アイコンの見た目を変えるなら `drawIcon()` を編集して再実行。生成された PNG はリポジトリにコミット済みです（`.gitignore` のコメント参照）。

## 規約

- 素の ES2017+ Vanilla JS、`'use strict'`、モジュール無し、フレームワーク無し、TypeScript 無し。ユーザの明示的な要望が無い限り維持してください。
- コメント・UI 文字列は全て日本語。既存ファイルを編集する際はそのスタイルに合わせること。
- README の「ファイル構成」セクションは古いまま（popup ファイルしか記載しておらず `newtab.*` が抜けている）。README を触る際は併せて更新してください。
- 新しいタブのデータ構造を変更する場合は `openDB()` の `DB_VERSION` と `onupgradeneeded` ハンドラを更新すること — 既存ユーザは現行スキーマでデータを保持しています。
