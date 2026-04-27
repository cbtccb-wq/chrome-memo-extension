# Quick Memo — Chrome拡張機能

新しいタブを自由配置のメモキャンバスに置き換える Chrome 拡張機能です。テキストと画像をドラッグ・リサイズしながら、自動保存。

## 機能

- **新しいタブを開くだけでメモ画面** — `chrome_url_overrides.newtab` で常駐
- **自由配置キャンバス** — ダブルクリックでテキスト追加、Ctrl+V またはドロップで画像挿入
- **ドラッグ / 8 方向リサイズ** — Shift で比率固定、Shift+ドラッグでグリッドスナップ (24px)
- **Ctrl+ホイールでズーム** — マウス位置を中心に拡大縮小、Space+ドラッグまたは中ボタンドラッグでパン
- **Undo / Redo** — Ctrl+Z / Ctrl+Shift+Z、ツールバーボタンでも操作可
- **コピー & ペースト** — Ctrl+C / Ctrl+V で要素を複製、画像は右クリックでクリップボードへ
- **エクスポート** — テキストのみの `.txt` と、画像込みの単独 `.html` の 2 種類
- **自動保存** — IndexedDB に 600ms デバウンスで保存、再起動後も復元
- **ダークモード対応** — OS の設定に自動追従

## Chromeへのインストール方法

1. Chrome のアドレスバーに `chrome://extensions` と入力して開く
2. 右上の **「デベロッパーモード」** をオンにする
3. **「パッケージ化されていない拡張機能を読み込む」** ボタンをクリック
4. このフォルダ（`chrome-memo-extension`）を選択する
5. 新しいタブを開くと Quick Memo のキャンバスが表示されます

## ファイル構成

```
chrome-memo-extension/
├── manifest.json       # 拡張機能の設定（Manifest V3）
├── newtab.html         # キャンバス画面の HTML
├── newtab.css          # スタイル（ダークモード対応）
├── newtab.js           # 配置・編集・自動保存などのロジック
├── generate-icons.js   # アイコン生成スクリプト（開発用）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## アイコンを再生成したい場合

```bash
node generate-icons.js
```

外部パッケージ不要（Node.js 標準の `zlib` のみ使用）。
