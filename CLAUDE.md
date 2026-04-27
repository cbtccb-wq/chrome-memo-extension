## CLAUDE.md

このファイルは Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

「Quick Memo」 — Chrome Manifest V3 拡張機能。**ビルド手順・バンドラ・パッケージマネージャ・テストスイートはありません**。ソースファイルは Chrome がそのまま読み込みます。

## よく使うコマンド

- **拡張機能を読み込む**: `chrome://extensions` を開き、デベロッパーモードを ON にして「パッケージ化されていない拡張機能を読み込む」からこのフォルダを選択。ファイル編集後は拡張機能カードのリロードボタンを押す（または新しいタブを開き直す）。
- **アイコン再生成**: `node generate-icons.js` — Node.js 標準の `zlib` のみ使用するため `npm install` 不要。`icons/icon{16,48,128}.png` を出力します。
- lint/test/build コマンドは存在しません。勝手に作らないでください。

## アーキテクチャ

新しいタブの上書き画面 (`newtab.html` / `newtab.css` / `newtab.js`) が拡張機能の唯一の画面。`manifest.json` の `chrome_url_overrides.newtab` で登録され、ツールバーアイコンをクリックすると新しいタブが開いてこの画面が現れる。`action.default_popup` は登録されていない。

### データモデルと永続化

- **データモデル**: `elements: Array<{id, type, x, y, w, h, content}>`。`type` は `'text'` または `'image'`。画像の `content` は data URL 文字列（`MAX_IMG = 5MB` で制限）。
- **永続化**: IndexedDB — DB `QuickMemoDB`、オブジェクトストア `canvas`、キー `'main'` に配列全体を JSON 文字列化して保存。`DB_VERSION = 3`（コメントは「キャンバスモードへ移行」）。スキーマを変える際は version を上げて `onupgradeneeded` を実装すること。
- **DOM ミラー**: `domMap: Map<id, HTMLElement>` を `elements` と同期させて保持。状態変更は必ず `addElement` / `removeElement` / `syncDOM` を経由するため、データと DOM がずれません。各要素には 8 方向のリサイズハンドル（`HANDLES = ['nw','n','ne','e','se','s','sw','w']`）がつきます。

### インタラクション

- **配置・編集**: キャンバス上の `mousedown` / `mousemove` / `mouseup` を 1 つのステートマシン（`dragState` / `resizeState` / `marqueeState` / `panState`）で処理。空白部分のダブルクリックでテキストボックス新規作成、テキスト要素のダブルクリックで `contentEditable` の編集モードへ。Ctrl+V とドラッグ＆ドロップは `insertImageFile` 経由で画像挿入され、現在のビューポート（`canvasEl.offsetWidth/scale`）に対して `0.45w / 0.70h` に収まるよう縮小されます。
- **選択とマーキー**: `selectedIds: Set<string>` + `primaryId`（リサイズハンドルは `.primary` 要素のみ表示）。要素クリックで単独選択、Shift+クリックでトグル追加。空キャンバスをドラッグするとマーキー (`#marquee` div、画面座標で描画) が表示され、リリース時に交差した要素を選択（Shift で既存選択に追加、3px 未満の動きは「空白クリック」扱いで全解除）。`selectEl(id, additive)` / `setPrimary(id)` / `clearSelection()` / `removeElements(ids[])` が選択モデルへの正規アクセス経路。
- **ドラッグ・リサイズ**: ドラッグは選択中の **全要素** を同じ delta で移動（`dragState.starts: Map<id,{x,y}>` に開始位置を保存し、最終位置の最小座標が 0 を割らないよう全体クランプ）。Shift 押下中は `GRID = 24px`（CSS のドットグリッドと一致）にスナップ。リサイズは `primaryId` のハンドルのみ動作し、Shift+コーナーハンドルで縦横比を固定。
- **ズーム/パン**: `canvas-inner` ラッパに `transform: translate(tx, ty) scale(scale)` を適用。Ctrl+ホイールでマウス位置を不動点にズーム（`MIN_SCALE=0.25`, `MAX_SCALE=4`）、Space+ドラッグまたは中ボタンドラッグでパン（`panState`、`spaceHeld` フラグで Space の keydown/keyup を追跡、`window.blur` で取りこぼし防止）。すべての画面座標→キャンバス座標変換は `screenToCanvas()` ヘルパに集約。ステータスバーの `#zoom-pill` がズーム率を表示し、クリックで `scale=1, tx=ty=0` にリセット。`tx`/`ty`/`scale` は永続化しない。
- **Undo/Redo**: `history` 配列に `elements` の浅いコピーを最大 50 件保持（画像 data URL の文字列は immutable なので参照共有でメモリ効率◎）。`addElement` / `removeElement(s)` / ドラッグ完了 / リサイズ完了 / 編集完了 / クリア / 矢印キー(500ms デバウンス) のタイミングで `pushHistory()`。`Ctrl+Z` / `Ctrl+Shift+Z` (Ctrl+Y) ショートカットとツールバーボタンの両方で操作可。
- **自動保存とステータス**: ミューテーションを伴う処理はすべて `scheduleSave()` を呼ぶ — 配列全体を 600ms デバウンスで書き込み。フッターのステータスピルが `saving` / `saved` を表示。一時メッセージは `flash(text)` ヘルパ（2 秒で `保存済み` に戻る）に統一されており、`alert()` は使わない。

### エクスポートとコピー

- **エクスポート**: TXT は `\n\n---\n\n` でテキスト要素を結合。HTML は `max(x+w)` / `max(y+h)` のサイズで絶対配置の単独 HTML を生成し、画像要素は data URL をそのまま埋め込みます。
- **画像コピー (右クリック)**: 画像要素の `contextmenu` で `dataUrlToPngBlob()` 経由で PNG 化し、`navigator.clipboard.write()` で OS クリップボードへ。テキスト要素や空白部分の右クリックはブラウザ既定動作。
- **要素のコピー&ペースト**: `document` の `copy` / `paste` イベントを使用。`copy` で選択中の全要素を `elementClipboard: Array<elem>` に保存。`paste` の優先順位は **画像 (システムクリップボード) > 内部要素クリップボード**。内部要素ペーストは元の位置から `+20px` ずらして複製し、新しい要素群を選択状態にする。テキスト編集中（`editingId` が真）はどちらも素通し。

### アイコン生成 (`generate-icons.js`)

自前の最小 PNG エンコーダ（`zlib.deflateSync` + CRC32 + IHDR/IDAT/IEND チャンク）。RGBA バッファにピクセル単位で角丸四角＋白い横線 3 本を描画します。アイコンの見た目を変えるなら `drawIcon()` を編集して再実行。生成された PNG はリポジトリにコミット済みです（`.gitignore` のコメント参照）。

## 規約

- 素の ES2017+ Vanilla JS、`'use strict'`、モジュール無し、フレームワーク無し、TypeScript 無し。ユーザの明示的な要望が無い限り維持してください。
- コメント・UI 文字列は全て日本語。既存ファイルを編集する際はそのスタイルに合わせること。
- ユーザ向けの一時メッセージは `alert()` ではなく `flash(text)` をステータスバーに表示する方式で統一。エラー時もこの経路。
- データ構造（`elements` の各フィールド）を変更する場合は `openDB()` の `DB_VERSION` と `onupgradeneeded` ハンドラを更新すること — 既存ユーザは現行スキーマでデータを保持しています。
- ビュー状態 (`tx` / `ty` / `scale`) は意図的に永続化していません。永続化する場合は IndexedDB に別キーで保存し、起動時の `applyTransform()` 呼び出し前に復元してください。
