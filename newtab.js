'use strict';

// ── 設定 ───────────────────────────────────────────────────────
const DB_NAME       = 'QuickMemoDB';
const DB_VERSION    = 1;
const STORE_NAME    = 'memo';
const MAX_IMG_BYTES = 5 * 1024 * 1024; // 5MB / 枚
const SAVE_DELAY_MS = 400;

// ── DOM ────────────────────────────────────────────────────────
const editor      = document.getElementById('editor');
const dropOverlay = document.getElementById('drop-overlay');
const infoText    = document.getElementById('info-text');
const saveStatus  = document.getElementById('save-status');
const btnExportTxt  = document.getElementById('btn-export-txt');
const btnExportHtml = document.getElementById('btn-export-html');
const btnClear      = document.getElementById('btn-clear');

// ── IndexedDB ─────────────────────────────────────────────────
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbSave(html) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(html, 'main');
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}

function dbLoad() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get('main');
    req.onsuccess = (e) => resolve(e.target.result || '');
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ── 自動保存 ──────────────────────────────────────────────────
let saveTimer = null;

function scheduleSave() {
  setSaveStatus('saving', '保存中...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await dbSave(editor.innerHTML);
      setSaveStatus('saved', '保存済み');
      setTimeout(() => setSaveStatus('', '保存済み'), 2000);
      updateInfo();
    } catch (e) {
      setSaveStatus('', 'エラー: 保存できませんでした');
      console.error(e);
    }
  }, SAVE_DELAY_MS);
}

// ── 起動時読み込み ────────────────────────────────────────────
(async () => {
  db = await openDB();
  const html = await dbLoad();
  if (html) {
    editor.innerHTML = html;
    // 読み込んだ画像にクリック選択を付与
    editor.querySelectorAll('img').forEach(attachImageClick);
  }
  updateInfo();
  editor.focus();
})();

// ── エディタ入力検知 ──────────────────────────────────────────
editor.addEventListener('input', scheduleSave);

// ── 画像クリック選択 ──────────────────────────────────────────
function attachImageClick(img) {
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    // 他の選択を解除
    editor.querySelectorAll('img.selected').forEach(i => i.classList.remove('selected'));
    img.classList.add('selected');
  });
}

// 編集エリア外クリックで選択解除
document.addEventListener('click', (e) => {
  if (!editor.contains(e.target)) {
    editor.querySelectorAll('img.selected').forEach(i => i.classList.remove('selected'));
  }
});

// Delete / Backspace で選択中の画像を削除
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const selected = editor.querySelector('img.selected');
    if (selected) {
      e.preventDefault();
      selected.remove();
      scheduleSave();
    }
  }
});

// ── 画像挿入ユーティリティ ────────────────────────────────────
function insertImageAtCursor(src) {
  const img = document.createElement('img');
  img.src = src;
  attachImageClick(img);

  // カーソル位置に挿入
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    // カーソルを画像の後ろへ
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.appendChild(img);
  }
  scheduleSave();
}

// Blob/File → base64 data URI
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 画像サイズチェック付きで挿入
async function insertImageFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('画像ファイルのみ対応しています。');
    return;
  }
  if (file.size > MAX_IMG_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    alert(`画像が大きすぎます（${mb}MB）。\n1枚あたり最大 5MB までです。`);
    return;
  }
  const dataUrl = await fileToDataURL(file);
  insertImageAtCursor(dataUrl);
}

// ── Ctrl+V 貼り付け ───────────────────────────────────────────
editor.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  // 画像が含まれていれば画像優先で処理
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) await insertImageFile(file);
      return;
    }
  }

  // テキストのみの場合: プレーンテキストとして貼り付け（リッチHTMLを除去）
  for (const item of items) {
    if (item.type === 'text/plain') {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
      return;
    }
  }
});

// ── ドラッグ＆ドロップ ────────────────────────────────────────
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  if ([...e.dataTransfer.items].some(i => i.kind === 'file' && i.type.startsWith('image/'))) {
    e.preventDefault();
    dragCounter++;
    dropOverlay.hidden = false;
  }
});

document.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.hidden = true; }
});

document.addEventListener('dragover', (e) => e.preventDefault());

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.hidden = true;

  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  for (const file of files) {
    await insertImageFile(file);
  }
});

// ── エクスポート ──────────────────────────────────────────────
function timestamp() {
  const n = new Date(), p = (v) => String(v).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

btnExportTxt.addEventListener('click', () => {
  const text = editor.innerText.trim();
  if (!text) { alert('テキストがありません。'); return; }
  download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `memo_${timestamp()}.txt`);
});

btnExportHtml.addEventListener('click', () => {
  if (!editor.innerHTML.trim()) { alert('メモが空です。'); return; }
  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<title>Quick Memo エクスポート</title>
<style>
  body { max-width:800px; margin:40px auto; font-family:sans-serif; line-height:1.8; color:#1a1a1a; padding:0 24px; }
  img  { max-width:100%; border-radius:6px; margin:12px 0; display:block; }
</style></head>
<body>${editor.innerHTML}</body></html>`;
  download(new Blob([html], { type: 'text/html;charset=utf-8' }), `memo_${timestamp()}.html`);
});

// ── クリア ─────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!editor.innerHTML.trim()) return;
  if (!confirm('メモをすべて削除しますか？\nテキストも画像も消えます。この操作は元に戻せません。')) return;
  editor.innerHTML = '';
  await dbSave('');
  setSaveStatus('saved', 'クリアしました');
  setTimeout(() => setSaveStatus('', '保存済み'), 2000);
  updateInfo();
});

// ── ステータス表示 ────────────────────────────────────────────
function setSaveStatus(cls, text) {
  saveStatus.className = 'save-status' + (cls ? ` ${cls}` : '');
  saveStatus.textContent = text;
}

function updateInfo() {
  const chars  = editor.innerText.length;
  const images = editor.querySelectorAll('img').length;
  const parts  = [];
  if (chars  > 0) parts.push(`${chars.toLocaleString()} 文字`);
  if (images > 0) parts.push(`画像 ${images} 枚`);
  infoText.textContent = parts.join('　／　');
}

// コンテンツ変化時にも情報更新
new MutationObserver(updateInfo).observe(editor, { childList: true, subtree: true, characterData: true });
