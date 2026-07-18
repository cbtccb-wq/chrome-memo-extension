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

- **データモデル**: `elements: Array<{id, type, x, y, w, h, content, bgColor?, locked?}>`。`type` は `'text'` または `'image'`。画像の `content` は data URL 文字列（`MAX_IMG = 5MB` で制限）。`bgColor` はオプションの背景色（CSS カラー文字列）、`locked` はオプションのロックフラグ（真偽値）。
- **永続化**: IndexedDB — DB `QuickMemoDB`、オブジェクトストア `canvas`。マルチタブ対応で `'elements_' + tabId` キーに各タブの要素配列を JSON 文字列化して保存。`'config'` キーに設定（テーマ、グリッド、タブ情報）を保存。スキーマを変える際は `DB_VERSION` を上げて `onupgradeneeded` を実装すること。
- **DOM ミラー**: `domMap: Map<id, HTMLElement>` を `elements` と同期させて保持。状態変更は必ず `addElement` / `removeElement` / `syncDOM` を経由するため、データと DOM がずれません。各要素には 8 方向のリサイズハンドル（`HANDLES = ['nw','n','ne','e','se','s','sw','w']`）がつきます。

### インタラクション

- **配置・編集**: キャンバス上の `mousedown` / `mousemove` / `mouseup` を 1 つのステートマシン（`dragState` / `resizeState` / `marqueeState` / `panState`）で処理。空白部分のダブルクリックでテキストボックス新規作成、テキスト要素のダブルクリックで `contentEditable` の編集モードへ。Ctrl+V とドラッグ＆ドロップは `insertImageFile` 経由で画像挿入され、現在のビューポート（`canvasEl.offsetWidth/scale`）に対して `0.45w / 0.70h` に収まるよう縮小されます。
- **選択とマーキー**: `selectedIds: Set<string>` + `primaryId`（リサイズハンドルは `.primary` 要素のみ表示）。要素クリックで単独選択、Shift+クリックでトグル追加。空キャンバスをドラッグするとマーキー (`#marquee` div、画面座標で描画) が表示され、リリース時に交差した要素を選択（Shift で既存選択に追加、3px 未満の動きは「空白クリック」扱いで全解除）。`selectEl(id, additive)` / `setPrimary(id)` / `clearSelection()` / `removeElements(ids[])` が選択モデルへの正規アクセス経路。
- **ドラッグ・リサイズ**: ドラッグは選択中の **全要素** を同じ delta で移動（`dragState.starts: Map<id,{x,y}>` に開始位置を保存し、最終位置の最小座標が 0 を割らないよう全体クランプ）。グリッド有効時はドラッグと画像リサイズの動かしている辺がグリッドにスナップし、Shift 押下中はドラッグのスナップ解除、コーナーリサイズの縦横比固定に使う。
- **ズーム/パン**: `canvas-inner` ラッパに `transform: translate(tx, ty) scale(scale)` を適用。ホイール単独でマウス位置を不動点にズーム（`MIN_SCALE=0.25`, `MAX_SCALE=8`）、Space+ドラッグまたは中ボタンドラッグでパン（`panState`、`spaceHeld` フラグで Space の keydown/keyup を追跡、`window.blur` で取りこぼし防止）。すべての画面座標→キャンバス座標変換は `screenToCanvas()` ヘルパに集約。ステータスバーの `#zoom-pill` がズーム率を表示し、クリックで `scale=1, tx=ty=0` にリセット。`tx`/`ty`/`scale` はタブごとに `config` の各タブオブジェクト内に永続化される。
- **Undo/Redo**: `history` 配列に `elements` の浅いコピーを最大 50 件保持（画像 data URL の文字列は immutable なので参照共有でメモリ効率◎）。`addElement` / `removeElement(s)` / ドラッグ完了 / リサイズ完了 / 編集完了 / クリア / 矢印キー(500ms デバウンス) のタイミングで `pushHistory()`。`Ctrl+Z` / `Ctrl+Shift+Z` (Ctrl+Y) ショートカットとツールバーボタンの両方で操作可。
- **自動保存とステータス**: ミューテーションを伴う処理はすべて `scheduleSave()` を呼ぶ — 配列全体を 600ms デバウンスで書き込み。フッターのステータスピルが `saving` / `saved` を表示。一時メッセージは `flash(text)` ヘルパ（2 秒で `保存済み` に戻る）に統一されており、`alert()` は使わない。

### エクスポートとコピー

- **エクスポート**: TXT は `\n\n---\n\n` でテキスト要素を結合。HTML は `max(x+w)` / `max(y+h)` のサイズで絶対配置の単独 HTML を生成し、画像要素は data URL をそのまま埋め込みます。
- **画像コピー/サイズ揃え (右クリック)**: コンテキストメニューの「画像をコピー」から PNG 化し、`navigator.clipboard.write()` で OS クリップボードへ。複数画像選択時は選択画像のみを最小外接矩形へ透明背景で合成し、相対位置を保った1枚のPNGとしてコピーする。画像サイズは `copiedImageSize` に一時保持し、単体または複数選択中のロックされていない画像へ反映できる。
- **要素のコピー&ペースト**: `document` の `copy` / `paste` イベントを使用。`copy` で選択中の全要素を `elementClipboard: Array<elem>` に保存。`paste` の優先順位は **画像 (システムクリップボード) > 内部要素クリップボード**。内部要素ペーストは元の位置から `+20px` ずらして複製し、新しい要素群を選択状態にする。テキスト編集中（`editingId` が真）はどちらも素通し。

### マルチタブ

- `config.tabs` で管理。各タブは `{id, name, scale, tx, ty}` を持つ。
- タブ切り替え時は現タブの要素を保存し、新タブの要素を IDB からロードして復元。各タブは独立した Undo/Redo 履歴スタックを保持。

### コンテキストメニュー・背景色・ロック

- **カスタムモーダル**: `showConfirm()` / `showPrompt()` で `confirm()` / `prompt()` を置換し、アプリ内モーダルに統一。フェードイン・スライドインアニメーション付き。
- **空白右クリック**: `canvasEl` の `contextmenu` でブラウザ標準メニューを抑止し、テキスト追加、マウス位置への貼り付け、表示リセット、グリッド切替を出す。画像貼り付けは `navigator.clipboard.read()` を使うため `manifest.json` に `clipboardRead` 権限がある。
- **背景色**: `CARD_COLORS` プリセット（黄色、緑、青、ピンク、オレンジ、紫、赤）。ダークモード時は `CARD_COLORS_DARK` で自動変換。右クリックコンテキストメニューから選択。
- **ロック**: `elem.locked` フラグでドラッグ/リサイズ/編集/削除を無効化。ロック中は 🔒 バッジを表示。右クリックメニューからトグル。

### 検索・フィルタ機能

- **検索バー (Ctrl+F)**: ブラウザ標準の検索をインターセプトし、アプリ右上部に固定表示されるカスタム検索バー (#search-bar) を表示。
- **検索ロジック**: `type === 'text'` の要素を対象に大文字小文字不問で部分一致検索。ヒットIDリスト `matchedIds` を生成し、マッチ数と現在位置を表示。該当要素に `.search-hit` を追加。
- **フォーカスと自動パン**: `Enter` (次へ) / `Shift + Enter` (前へ) でインデックス `searchIndex` を更新し、対応要素に `.search-hit-active` を追加（オレンジ色のパルスアニメーション）。該当要素が画面中央になるよう `tx` / `ty` を算出してパン移動。
- **ズーム自動復元**: パン移動時、現在の `scale` が 0.75 未満の場合は、自動的にズーム率を `1.0` に戻してからパン移動。
- **スムーズスクロール**: 移動時に一時的にキャンバス inner に `.smooth-transform` クラスを追加して CSS transition で滑らかに移動させ、移動完了後（350ms）に取り除く。
- **クリーンアップ**: Escapeキー、閉じるボタン、またはタブ切り替え時に検索バーを隠し、ハイライトクラスを全解除し、検索状態を初期化。

### アイコン生成 (`generate-icons.js`)

自前の最小 PNG エンコーダ（`zlib.deflateSync` + CRC32 + IHDR/IDAT/IEND チャンク）。RGBA バッファにピクセル単位で角丸四角＋白い横線 3 本を描画します。アイコンの見た目を変えるなら `drawIcon()` を編集して再実行。生成された PNG はリポジトリにコミット済みです（`.gitignore` のコメント参照）。

## 規約

- 素の ES2017+ Vanilla JS、`'use strict'`、モジュール無し、フレームワーク無し、TypeScript 無し。ユーザの明示的な要望が無い限り維持してください。
- コメント・UI 文字列は全て日本語。既存ファイルを編集する際はそのスタイルに合わせること。
- ユーザ向けの一時メッセージは `alert()` ではなく `flash(text)` をステータスバーに表示する方式で統一。エラー時もこの経路。
- データ構造（`elements` の各フィールド）を変更する場合は `openDB()` の `DB_VERSION` と `onupgradeneeded` ハンドラを更新すること — 既存ユーザは現行スキーマでデータを保持しています。
- ビュー状態はタブごとに `config` オブジェクト内で永続化済み。
