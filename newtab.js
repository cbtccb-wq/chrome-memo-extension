'use strict';

// ── 設定 ───────────────────────────────────────────────────────────
const DB_NAME    = 'QuickMemoDB';
const DB_VERSION = 3;             // キャンバスモードへ移行
const STORE      = 'canvas';
const MAX_IMG    = 5 * 1024 * 1024;
const SAVE_DELAY = 600;
const MIN_W      = 80;
const MIN_H      = 36;
const HANDLES    = ['nw','n','ne','e','se','s','sw','w'];

// ── DOM refs ──────────────────────────────────────────────────────
const canvasEl      = document.getElementById('canvas');
const dropOverlay   = document.getElementById('drop-overlay');
const infoEl        = document.getElementById('info');
const saveEl        = document.getElementById('save-status');
const btnExportTxt  = document.getElementById('btn-export-txt');
const btnExportHtml = document.getElementById('btn-export-html');
const btnClear      = document.getElementById('btn-clear');

// ── アプリ状態 ────────────────────────────────────────────────────
let elements   = [];       // [{id, type, x, y, w, h, content}]
let domMap     = new Map();// id → DOM要素
let selectedId = null;
let editingId  = null;
let db;
let zCounter   = 10;       // z-index管理

// ドラッグ状態
let dragState  = null;
// { id, startMX, startMY, startEX, startEY, hasMoved }

// リサイズ状態
let resizeState = null;
// { id, handle, startMX, startMY, startX, startY, startW, startH }

// ── ユーティリティ ────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getElem(id) {
  return elements.find(e => e.id === id);
}

// ── IndexedDB ─────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE);
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbSave(data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.stringify(data), 'main');
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbLoad() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('main');
    req.onsuccess = e => {
      try { resolve(JSON.parse(e.target.result || '[]')); }
      catch { resolve([]); }
    };
    req.onerror = e => reject(e.target.error);
  });
}

// ── 自動保存 ──────────────────────────────────────────────────────
let saveTimer = null;

function scheduleSave() {
  setStatus('saving', '保存中...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await dbSave(elements);
      setStatus('saved', '保存済み');
      setTimeout(() => setStatus('', '保存済み'), 2000);
    } catch(err) {
      setStatus('', 'エラー: 保存失敗');
      console.error(err);
    }
  }, SAVE_DELAY);
}

// ── 起動時読み込み ────────────────────────────────────────────────
(async () => {
  db = await openDB();
  const saved = await dbLoad();
  if (Array.isArray(saved)) {
    elements = saved;
    elements.forEach(e => mountDOM(e));
  }
  updateInfo();
})();

// ── DOM構築 ──────────────────────────────────────────────────────
function buildElement(elem) {
  const div = document.createElement('div');
  div.className = `memo-el memo-${elem.type}`;
  div.dataset.id = elem.id;
  applyPosStyle(div, elem);

  if (elem.type === 'text') {
    const inner = document.createElement('div');
    inner.className = 'el-content';
    inner.contentEditable = 'false';
    inner.textContent = elem.content || '';
    div.appendChild(inner);

    // テキスト変更を即時データに反映
    inner.addEventListener('input', () => {
      const e = getElem(elem.id);
      if (e) { e.content = inner.textContent; scheduleSave(); }
    });
  } else {
    const img = document.createElement('img');
    img.src = elem.content;
    img.draggable = false;
    div.appendChild(img);
  }

  // リサイズハンドル（8方向）
  for (const h of HANDLES) {
    const rh = document.createElement('div');
    rh.className = `rh rh-${h}`;
    rh.dataset.handle = h;
    div.appendChild(rh);
  }

  return div;
}

function mountDOM(elem) {
  const div = buildElement(elem);
  canvasEl.appendChild(div);
  domMap.set(elem.id, div);
}

function unmountDOM(id) {
  domMap.get(id)?.remove();
  domMap.delete(id);
}

function applyPosStyle(div, elem) {
  div.style.left  = elem.x + 'px';
  div.style.top   = elem.y + 'px';
  div.style.width = elem.w + 'px';
  if (elem.type === 'text') {
    div.style.minHeight = elem.h + 'px';
    div.style.height    = '';
  } else {
    div.style.height    = elem.h + 'px';
    div.style.minHeight = '';
  }
}

function syncDOM(id) {
  const elem = getElem(id);
  const div  = domMap.get(id);
  if (elem && div) applyPosStyle(div, elem);
}

// ── 要素操作 ──────────────────────────────────────────────────────
function addElement(type, x, y, w, h, content) {
  const elem = { id: uid(), type, x, y, w, h, content: content || '' };
  elements.push(elem);
  mountDOM(elem);
  scheduleSave();
  updateInfo();
  return elem;
}

function removeElement(id) {
  elements = elements.filter(e => e.id !== id);
  unmountDOM(id);
  if (selectedId === id) selectedId = null;
  if (editingId  === id) editingId  = null;
  scheduleSave();
  updateInfo();
}

// ── 選択 ─────────────────────────────────────────────────────────
function selectEl(id) {
  if (selectedId === id) return;
  if (selectedId) {
    domMap.get(selectedId)?.classList.remove('selected');
  }
  selectedId = id;
  const div = domMap.get(id);
  if (div) {
    div.classList.add('selected');
    div.style.zIndex = ++zCounter;
  }
}

function deselectAll() {
  if (editingId) stopEditing();
  if (selectedId) {
    domMap.get(selectedId)?.classList.remove('selected');
    selectedId = null;
  }
}

// ── テキスト編集 ──────────────────────────────────────────────────
function startEditing(id) {
  if (editingId === id) return;
  stopEditing();
  const div   = domMap.get(id);
  const inner = div?.querySelector('.el-content');
  if (!inner) return;
  editingId = id;
  inner.contentEditable = 'true';
  div.classList.add('editing');
  inner.focus();
  // カーソルを末尾へ
  const range = document.createRange();
  range.selectNodeContents(inner);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function stopEditing() {
  if (!editingId) return;
  const div   = domMap.get(editingId);
  const inner = div?.querySelector('.el-content');
  if (inner) {
    inner.contentEditable = 'false';
    div.classList.remove('editing');
    const elem = getElem(editingId);
    if (elem) {
      elem.content = inner.textContent;
      elem.h = Math.max(MIN_H, div.offsetHeight);
      scheduleSave();
    }
  }
  editingId = null;
}

// ── マウスイベント ────────────────────────────────────────────────
canvasEl.addEventListener('mousedown', e => {
  const rhEl = e.target.closest('.rh');
  const meEl = e.target.closest('.memo-el');

  // リサイズ開始
  if (rhEl && meEl) {
    e.preventDefault();
    e.stopPropagation();
    const id   = meEl.dataset.id;
    const elem = getElem(id);
    selectEl(id);
    resizeState = {
      id,
      handle: rhEl.dataset.handle,
      startMX: e.clientX, startMY: e.clientY,
      startX: elem.x, startY: elem.y,
      startW: elem.w, startH: elem.h,
    };
    return;
  }

  // ドラッグ開始
  if (meEl) {
    if (editingId === meEl.dataset.id) return; // 編集中はドラッグしない
    e.preventDefault();
    const id = meEl.dataset.id;
    selectEl(id);
    const elem = getElem(id);
    dragState = {
      id,
      startMX: e.clientX, startMY: e.clientY,
      startEX: elem.x,    startEY: elem.y,
      hasMoved: false,
    };
    return;
  }

  // キャンバス空白クリック → 選択解除
  deselectAll();
});

canvasEl.addEventListener('dblclick', e => {
  const meEl = e.target.closest('.memo-el');

  // テキスト要素のダブルクリック → 編集モード
  if (meEl?.classList.contains('memo-text')) {
    selectEl(meEl.dataset.id);
    startEditing(meEl.dataset.id);
    return;
  }

  // 空白ダブルクリック → テキストボックス新規作成
  if (!meEl) {
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left - 100;
    const y = e.clientY - rect.top  - 20;
    const elem = addElement('text', Math.max(0, x), Math.max(0, y), 200, MIN_H, '');
    selectEl(elem.id);
    startEditing(elem.id);
  }
});

document.addEventListener('mousemove', e => {
  if (dragState) {
    const dx = e.clientX - dragState.startMX;
    const dy = e.clientY - dragState.startMY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragState.hasMoved = true;
    const elem = getElem(dragState.id);
    elem.x = Math.max(0, dragState.startEX + dx);
    elem.y = Math.max(0, dragState.startEY + dy);
    syncDOM(dragState.id);
    return;
  }

  if (resizeState) {
    const { handle, startMX, startMY, startX, startY, startW, startH } = resizeState;
    const dx = e.clientX - startMX;
    const dy = e.clientY - startMY;
    let x = startX, y = startY, w = startW, h = startH;

    if (handle.includes('e')) { w = Math.max(MIN_W, startW + dx); }
    if (handle.includes('s')) { h = Math.max(MIN_H, startH + dy); }
    if (handle.includes('w')) { w = Math.max(MIN_W, startW - dx); x = startX + startW - w; }
    if (handle.includes('n')) { h = Math.max(MIN_H, startH - dy); y = startY + startH - h; }

    const elem = getElem(resizeState.id);
    elem.x = x; elem.y = y; elem.w = w; elem.h = h;
    syncDOM(resizeState.id);
  }
});

document.addEventListener('mouseup', () => {
  if (dragState || resizeState) scheduleSave();
  dragState   = null;
  resizeState = null;
});

// ── キーボード ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // 編集中は Escape で編集終了のみ
  if (editingId) {
    if (e.key === 'Escape') stopEditing();
    return;
  }

  if (!selectedId) return;

  // 削除
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeElement(selectedId);
    return;
  }

  // 矢印キーで微調整
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const elem = getElem(selectedId);
    if (e.key === 'ArrowUp')    elem.y -= step;
    if (e.key === 'ArrowDown')  elem.y += step;
    if (e.key === 'ArrowLeft')  elem.x -= step;
    if (e.key === 'ArrowRight') elem.x += step;
    elem.x = Math.max(0, elem.x);
    elem.y = Math.max(0, elem.y);
    syncDOM(selectedId);
    scheduleSave();
  }
});

// ── 画像貼り付け（Ctrl+V）────────────────────────────────────────
document.addEventListener('paste', async e => {
  if (editingId) return; // テキスト編集中は通常のペーストに任せる
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find(i => i.type.startsWith('image/'));
  if (imgItem) {
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (file) await insertImageFile(file, null, null);
  }
});

// ── ドラッグ＆ドロップ ────────────────────────────────────────────
let dragCounter = 0;

document.addEventListener('dragenter', e => {
  const hasImg = [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (hasImg) { e.preventDefault(); dragCounter++; dropOverlay.hidden = false; }
});

document.addEventListener('dragleave', () => {
  if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.hidden = true; }
});

document.addEventListener('dragover', e => e.preventDefault());

document.addEventListener('drop', async e => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.hidden = true;
  const rect = canvasEl.getBoundingClientRect();
  const dropX = e.clientX - rect.left;
  const dropY = e.clientY - rect.top;
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  let offsetX = 0;
  for (const file of files) {
    await insertImageFile(file, dropX + offsetX, dropY + offsetX);
    offsetX += 20; // 複数枚は少しずらして配置
  }
});

// ── 画像挿入ユーティリティ ────────────────────────────────────────
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function insertImageFile(file, dropX, dropY) {
  if (!file.type.startsWith('image/')) { alert('画像ファイルのみ対応しています。'); return; }
  if (file.size > MAX_IMG) {
    alert(`1枚最大5MBです（この画像: ${(file.size/1024/1024).toFixed(1)}MB）`);
    return;
  }
  const dataUrl = await fileToDataURL(file);

  // 自然サイズを取得してから追加
  const tmpImg = new Image();
  tmpImg.onload = () => {
    const maxW = canvasEl.offsetWidth  * 0.45;
    const maxH = canvasEl.offsetHeight * 0.70;
    let w = tmpImg.naturalWidth;
    let h = tmpImg.naturalHeight;
    // 収まるように縮小
    if (w > maxW) { h = h * maxW / w; w = maxW; }
    if (h > maxH) { w = w * maxH / h; h = maxH; }
    const x = dropX != null ? dropX - w / 2 : canvasEl.offsetWidth  / 2 - w / 2;
    const y = dropY != null ? dropY - h / 2 : canvasEl.offsetHeight / 2 - h / 2;
    const elem = addElement('image', Math.max(0, x), Math.max(0, y), Math.round(w), Math.round(h), dataUrl);
    selectEl(elem.id);
  };
  tmpImg.src = dataUrl;
}

// ── エクスポート ──────────────────────────────────────────────────
function ts() {
  const n = new Date(), p = v => String(v).padStart(2,'0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}`;
}

function dl(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

btnExportTxt.addEventListener('click', () => {
  const lines = elements.filter(e => e.type === 'text' && e.content.trim()).map(e => e.content);
  if (!lines.length) { alert('テキストがありません。'); return; }
  dl(new Blob([lines.join('\n\n---\n\n')], { type: 'text/plain;charset=utf-8' }), `memo_${ts()}.txt`);
});

btnExportHtml.addEventListener('click', () => {
  if (!elements.length) { alert('メモが空です。'); return; }
  const body = elements.map(e => {
    const s = `position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;`;
    if (e.type === 'text') {
      return `<div style="${s}min-height:${e.h}px;font-family:sans-serif;font-size:14px;line-height:1.75;white-space:pre-wrap;padding:8px 10px;">${escHtml(e.content)}</div>`;
    } else {
      return `<div style="${s}height:${e.h}px;"><img src="${e.content}" style="width:100%;height:100%;object-fit:contain;" /></div>`;
    }
  }).join('\n');
  const maxX = Math.max(...elements.map(e => e.x + e.w), 800);
  const maxY = Math.max(...elements.map(e => e.y + e.h), 600);
  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>Quick Memo エクスポート</title>
<style>body{margin:0;background:#fff;position:relative;width:${maxX}px;height:${maxY}px;}</style>
</head><body>${body}</body></html>`;
  dl(new Blob([html], { type: 'text/html;charset=utf-8' }), `memo_${ts()}.html`);
});

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── クリア ────────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!elements.length) return;
  if (!confirm('すべての要素を削除しますか？\nこの操作は元に戻せません。')) return;
  elements = [];
  domMap.forEach(el => el.remove());
  domMap.clear();
  selectedId = null;
  editingId  = null;
  await dbSave([]);
  setStatus('saved', 'クリアしました');
  setTimeout(() => setStatus('', '保存済み'), 2000);
  updateInfo();
});

// ── ステータス ────────────────────────────────────────────────────
function setStatus(cls, text) {
  saveEl.className  = 'save-status' + (cls ? ` ${cls}` : '');
  saveEl.textContent = text;
}

function updateInfo() {
  const t = elements.filter(e => e.type === 'text').length;
  const i = elements.filter(e => e.type === 'image').length;
  const p = [];
  if (t) p.push(`テキスト ${t}`);
  if (i) p.push(`画像 ${i}`);
  infoEl.textContent = p.join('　/　');
}
