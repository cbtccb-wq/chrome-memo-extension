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
const MIN_SCALE  = 0.25;
const MAX_SCALE  = 4;
const HISTORY_MAX = 50;

// ── DOM refs ──────────────────────────────────────────────────────
const canvasEl      = document.getElementById('canvas');
const canvasInnerEl = document.getElementById('canvas-inner');
const dropOverlay   = document.getElementById('drop-overlay');
const infoEl        = document.getElementById('info');
const saveEl        = document.getElementById('save-status');
const btnUndo       = document.getElementById('btn-undo');
const btnRedo       = document.getElementById('btn-redo');
const btnTheme      = document.getElementById('btn-theme');
const btnExportTxt  = document.getElementById('btn-export-txt');
const btnExportHtml = document.getElementById('btn-export-html');
const btnExportJson = document.getElementById('btn-export-json');
const btnImportJson = document.getElementById('btn-import-json');
const inputImport   = document.getElementById('input-import');
const btnClear      = document.getElementById('btn-clear');
const zoomPill      = document.getElementById('zoom-pill');
const marqueeEl     = document.getElementById('marquee');
const gridPill      = document.getElementById('grid-pill');
const btnAddTab     = document.getElementById('btn-add-tab');
const tabsContainer = document.getElementById('tabs-container');

// ── アプリ状態 ────────────────────────────────────────────────────
let elements    = [];       // [{id, type, x, y, w, h, content}]
let config      = {
  theme: 'system',
  gridSize: 24,
  tabs: [{ id: 'tab_default', name: 'メモ 1', scale: 1, tx: 0, ty: 0 }],
  activeTabId: 'tab_default'
};
let domMap      = new Map();// id → DOM要素
let gridSize    = 24;
let tabHistories = new Map(); // tabId -> { history, historyIdx }
let selectedIds = new Set();// 選択中の要素 ID（複数選択対応）
let primaryId   = null;     // プライマリ選択（リサイズハンドルはこれだけ表示）
let editingId   = null;
let db;

// ドラッグ状態（複数選択をまとめて移動）
let dragState  = null;
// { ids, startMX, startMY, starts: Map<id,{x,y}>, hasMoved }

// リサイズ状態（プライマリ要素のみが対象）
let resizeState = null;
// { id, handle, startMX, startMY, startX, startY, startW, startH }

// 矩形選択（マーキー）状態
let marqueeState = null;
// { startSX, startSY, additive }

// ズーム状態（永続化しない）
let scale = 1;
let tx    = 0;
let ty    = 0;

// パン状態
let panState  = null;  // { startMX, startMY, startTX, startTY }
let spaceHeld = false;

// Undo/Redo 履歴
let history    = [];   // 各要素は elements の浅いコピー配列
let historyIdx = -1;
let editingStartContent = null; // テキスト編集前の content（変更検出用）
let arrowKeyTimer   = null;     // 矢印キー履歴コミットのデバウンス

// 要素のコピー&ペースト用（システムクリップボードとは別の内部バッファ）
let elementClipboard = null;

// ── ユーティリティ ────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getElem(id) {
  return elements.find(e => e.id === id);
}

// 画面座標 → キャンバス（論理）座標
function screenToCanvas(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (clientX - rect.left - tx) / scale,
    y: (clientY - rect.top  - ty) / scale,
  };
}

// ズーム/パンを transform に反映
function applyTransform() {
  canvasInnerEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  zoomPill.textContent = `${Math.round(scale * 100)}%`;
}

function resetView() {
  scale = 1;
  tx = 0;
  ty = 0;
  applyTransform();
  scheduleConfigSave();
}

// ── Undo/Redo ─────────────────────────────────────────────────────
function snapshotElements() {
  // 各 elem は浅くコピー。content 文字列は immutable なので参照共有 OK
  return elements.map(e => ({ ...e }));
}

function pushHistory() {
  // redo スタックを切り捨て
  history = history.slice(0, historyIdx + 1);
  history.push(snapshotElements());
  if (history.length > HISTORY_MAX) {
    history.shift();
  } else {
    historyIdx++;
  }
  updateUndoRedoButtons();
}

function restoreSnapshot(snap) {
  // 既存 DOM を全消去して再構築
  domMap.forEach(el => el.remove());
  domMap.clear();
  selectedIds.clear();
  primaryId = null;
  editingId = null;
  elements = snap.map(e => ({ ...e }));
  elements.forEach(e => mountDOM(e));
  scheduleSave();
  updateInfo();
}

function undo() {
  if (editingId) stopEditing();
  if (historyIdx <= 0) return;
  historyIdx--;
  restoreSnapshot(history[historyIdx]);
  updateUndoRedoButtons();
}

function redo() {
  if (editingId) stopEditing();
  if (historyIdx >= history.length - 1) return;
  historyIdx++;
  restoreSnapshot(history[historyIdx]);
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  btnUndo.disabled = historyIdx <= 0;
  btnRedo.disabled = historyIdx >= history.length - 1;
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

function dbSave(data, key = 'main') {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.stringify(data), key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbLoad(key = 'main') {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = e => {
      try { resolve(JSON.parse(e.target.result || '[]')); }
      catch { resolve([]); }
    };
    req.onerror = e => reject(e.target.error);
  });
}

function dbSaveConfig(configData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.stringify(configData), 'config');
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbLoadConfig() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('config');
    req.onsuccess = e => {
      try { resolve(JSON.parse(e.target.result || '{}')); }
      catch { resolve({}); }
    };
    req.onerror = e => reject(e.target.error);
  });
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (theme === 'sepia') {
    document.documentElement.setAttribute('data-theme', 'sepia');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

let configSaveTimer = null;
function scheduleConfigSave() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(async () => {
    const currentTab = config.tabs.find(t => t.id === config.activeTabId);
    if (currentTab) {
      currentTab.scale = scale;
      currentTab.tx = tx;
      currentTab.ty = ty;
    }
    config.gridSize = gridSize;
    try {
      await dbSaveConfig(config);
    } catch (err) {
      console.error('設定の保存に失敗:', err);
    }
  }, 1000);
}

function applyGridStyle() {
  if (gridSize === 0) {
    canvasInnerEl.style.backgroundImage = 'none';
  } else {
    canvasInnerEl.style.backgroundImage = `radial-gradient(circle, var(--grid-dot) 1.2px, transparent 1.2px)`;
    canvasInnerEl.style.backgroundSize = `${gridSize}px ${gridSize}px`;
  }
}

function updateGridPill() {
  if (gridSize === 0) {
    gridPill.textContent = 'グリッド: なし';
  } else {
    gridPill.textContent = `グリッド: ${gridSize}px`;
  }
}

function renderTabs() {
  tabsContainer.innerHTML = '';
  config.tabs.forEach(tab => {
    const isActive = tab.id === config.activeTabId;
    const div = document.createElement('div');
    div.className = `tab-item${isActive ? ' active' : ''}`;
    div.dataset.id = tab.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = tab.name;
    nameSpan.title = 'ダブルクリックで名前変更';
    div.appendChild(nameSpan);

    if (config.tabs.length > 1) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'ページを削除';
      closeBtn.addEventListener('click', e => closeTab(tab.id, e));
      div.appendChild(closeBtn);
    }

    div.addEventListener('click', () => switchTab(tab.id));
    div.addEventListener('dblclick', () => renameTab(tab.id));

    tabsContainer.appendChild(div);
  });
}

function addTab() {
  const tabId = 'tab_' + uid();
  const newTab = { id: tabId, name: `メモ ${config.tabs.length + 1}`, scale: 1, tx: 0, ty: 0 };
  config.tabs.push(newTab);
  switchTab(tabId);
}

async function closeTab(tabId, event) {
  event.stopPropagation();
  if (config.tabs.length <= 1) {
    flash('最後のページは削除できません');
    return;
  }
  if (!confirm('このページを削除しますか？\n（ページ内のすべてのメモが消去されます）')) {
    return;
  }

  const activeIdx = config.tabs.findIndex(t => t.id === config.activeTabId);
  const targetIdx = config.tabs.findIndex(t => t.id === tabId);

  let nextTabId = config.activeTabId;
  if (tabId === config.activeTabId) {
    const nextActive = config.tabs[targetIdx + 1] || config.tabs[targetIdx - 1];
    nextTabId = nextActive.id;
  }

  config.tabs = config.tabs.filter(t => t.id !== tabId);

  const deleteTx = db.transaction(STORE, 'readwrite');
  deleteTx.objectStore(STORE).delete('elements_' + tabId);

  tabHistories.delete(tabId);

  if (tabId === config.activeTabId) {
    await switchTab(nextTabId);
  } else {
    renderTabs();
    await dbSaveConfig(config);
  }
}

function renameTab(tabId) {
  const tab = config.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const newName = prompt('ページ名を入力してください:', tab.name);
  if (newName && newName.trim()) {
    tab.name = newName.trim().slice(0, 20);
    renderTabs();
    dbSaveConfig(config).catch(console.error);
  }
}

async function switchTab(tabId) {
  if (tabId === config.activeTabId) return;

  flushSave();

  const currentTab = config.tabs.find(t => t.id === config.activeTabId);
  if (currentTab) {
    currentTab.scale = scale;
    currentTab.tx = tx;
    currentTab.ty = ty;
    tabHistories.set(config.activeTabId, { history, historyIdx });
  }

  config.activeTabId = tabId;
  await dbSaveConfig(config);

  domMap.forEach(el => el.remove());
  domMap.clear();
  selectedIds.clear();
  primaryId = null;
  editingId = null;

  const saved = await dbLoad('elements_' + tabId);
  elements = Array.isArray(saved) ? saved : [];
  elements.forEach(elem => mountDOM(elem));

  const newTab = config.tabs.find(t => t.id === tabId);
  scale = newTab.scale ?? 1;
  tx = newTab.tx ?? 0;
  ty = newTab.ty ?? 0;
  applyTransform();

  const savedHist = tabHistories.get(tabId) || { history: [], historyIdx: -1 };
  history = savedHist.history;
  historyIdx = savedHist.historyIdx;
  if (history.length === 0) {
    pushHistory();
  }
  updateUndoRedoButtons();

  renderTabs();
  updateInfo();
}

// ── 自動保存 ──────────────────────────────────────────────────────
let saveTimer = null;

function scheduleSave() {
  setStatus('saving', '保存中...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await dbSave(elements, 'elements_' + config.activeTabId);
      setStatus('saved', '保存済み');
      setTimeout(() => setStatus('', '保存済み'), 2000);
    } catch(err) {
      setStatus('', 'エラー: 保存失敗');
      console.error(err);
    }
  }, SAVE_DELAY);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    dbSave(elements, 'elements_' + config.activeTabId)
      .then(() => setStatus('', '保存済み'))
      .catch(err => {
        setStatus('', 'エラー: 保存失敗');
        console.error(err);
      });
  }
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushSave();
  }
});

window.addEventListener('pagehide', flushSave);

// ── 起動時読み込み ────────────────────────────────────────────────
(async () => {
  db = await openDB();

  // 設定の読み込みと適用
  const savedConfig = await dbLoadConfig();
  const hasTabs = savedConfig.tabs && savedConfig.tabs.length > 0;

  config = {
    theme: 'system',
    gridSize: 24,
    tabs: [{ id: 'tab_default', name: 'メモ 1', scale: 1, tx: 0, ty: 0 }],
    activeTabId: 'tab_default',
    ...savedConfig
  };

  // 既存データ（main）からの移行処理
  if (!hasTabs) {
    const mainElements = await dbLoad('main');
    if (mainElements && mainElements.length > 0) {
      await dbSave(mainElements, 'elements_tab_default');
      config.tabs[0].scale = savedConfig.scale || 1;
      config.tabs[0].tx = savedConfig.tx || 0;
      config.tabs[0].ty = savedConfig.ty || 0;
      await dbSaveConfig(config);
    }
  }

  // テーマとグリッドの適用
  applyTheme(config.theme);
  gridSize = config.gridSize ?? 24;
  applyGridStyle();
  updateGridPill();

  // アクティブなタブの要素読み込みと復元
  const activeTabId = config.activeTabId;
  const saved = await dbLoad('elements_' + activeTabId);
  if (Array.isArray(saved)) {
    elements = saved;
    elements.forEach(e => mountDOM(e));
  }

  // アクティブなタブのズーム/パン位置の復元
  const activeTab = config.tabs.find(t => t.id === activeTabId) || config.tabs[0];
  scale = activeTab.scale ?? 1;
  tx = activeTab.tx ?? 0;
  ty = activeTab.ty ?? 0;
  applyTransform();

  // タブバーの描画
  renderTabs();
  updateInfo();

  // 初期状態を履歴の起点として記録
  pushHistory();
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
  canvasInnerEl.appendChild(div);
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

function bringMultipleToFront(ids) {
  if (!ids || !ids.length) return;
  let changed = false;
  for (const id of ids) {
    const idx = elements.findIndex(e => e.id === id);
    if (idx > -1) {
      const [elem] = elements.splice(idx, 1);
      elements.push(elem);
      const div = domMap.get(id);
      if (div && div.parentNode) {
        div.parentNode.appendChild(div);
      }
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// ── 要素操作 ──────────────────────────────────────────────────────
function addElement(type, x, y, w, h, content) {
  const elem = { id: uid(), type, x, y, w, h, content: content || '' };
  elements.push(elem);
  mountDOM(elem);
  scheduleSave();
  updateInfo();
  pushHistory();
  return elem;
}

function removeElement(id) {
  elements = elements.filter(e => e.id !== id);
  unmountDOM(id);
  selectedIds.delete(id);
  if (primaryId === id) primaryId = pickFallbackPrimary();
  if (editingId === id) editingId = null;
  scheduleSave();
  updateInfo();
  pushHistory();
}

function removeElements(ids) {
  if (!ids.length) return;
  elements = elements.filter(e => !ids.includes(e.id));
  for (const id of ids) {
    unmountDOM(id);
    selectedIds.delete(id);
    if (editingId === id) editingId = null;
  }
  if (!selectedIds.has(primaryId)) primaryId = pickFallbackPrimary();
  scheduleSave();
  updateInfo();
  pushHistory();
}

function pickFallbackPrimary() {
  // selectedIds の任意の 1 つ（無ければ null）
  return selectedIds.size ? selectedIds.values().next().value : null;
}

// ── 矩形選択（マーキー） ──────────────────────────────────────────
function showMarquee(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const minX = Math.min(marqueeState.startSX, sx);
  const minY = Math.min(marqueeState.startSY, sy);
  const w = Math.abs(sx - marqueeState.startSX);
  const h = Math.abs(sy - marqueeState.startSY);
  if (w < 3 && h < 3) { marqueeEl.hidden = true; return; }
  marqueeEl.hidden = false;
  marqueeEl.style.left   = minX + 'px';
  marqueeEl.style.top    = minY + 'px';
  marqueeEl.style.width  = w + 'px';
  marqueeEl.style.height = h + 'px';
}

function hideMarqueeDom() {
  marqueeEl.hidden = true;
}

function finalizeMarquee(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const minSX = Math.min(marqueeState.startSX, sx);
  const minSY = Math.min(marqueeState.startSY, sy);
  const maxSX = Math.max(marqueeState.startSX, sx);
  const maxSY = Math.max(marqueeState.startSY, sy);
  // 3px 未満の動きは「空白クリック」とみなす
  if ((maxSX - minSX) < 3 && (maxSY - minSY) < 3) {
    if (!marqueeState.additive) deselectAll();
    return;
  }
  // 画面座標 → キャンバス座標へ変換して交差判定
  const cMinX = (minSX - tx) / scale;
  const cMinY = (minSY - ty) / scale;
  const cMaxX = (maxSX - tx) / scale;
  const cMaxY = (maxSY - ty) / scale;
  if (!marqueeState.additive) clearSelection();
  const newlySelected = [];
  for (const elem of elements) {
    const ex2 = elem.x + elem.w;
    const ey2 = elem.y + elem.h;
    const intersects = !(ex2 < cMinX || elem.x > cMaxX || ey2 < cMinY || elem.y > cMaxY);
    if (intersects && !selectedIds.has(elem.id)) {
      selectedIds.add(elem.id);
      const div = domMap.get(elem.id);
      if (div) {
        div.classList.add('selected');
      }
      newlySelected.push(elem.id);
      setPrimary(elem.id);
    }
  }
  if (newlySelected.length) {
    bringMultipleToFront(newlySelected);
  }
}

// ── 選択 ─────────────────────────────────────────────────────────
function selectEl(id, additive = false) {
  if (additive) {
    // Shift+クリック等: トグル
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      domMap.get(id)?.classList.remove('selected', 'primary');
      if (primaryId === id) {
        primaryId = pickFallbackPrimary();
        if (primaryId) domMap.get(primaryId)?.classList.add('primary');
      }
    } else {
      selectedIds.add(id);
      const div = domMap.get(id);
      if (div) {
        div.classList.add('selected');
      }
      bringMultipleToFront([id]);
      setPrimary(id);
    }
  } else {
    // 単独選択: 既に primary なら何もしない、違うなら全置換
    if (primaryId === id && selectedIds.size === 1) return;
    clearSelection();
    selectedIds.add(id);
    const div = domMap.get(id);
    if (div) {
      div.classList.add('selected');
    }
    bringMultipleToFront([id]);
    setPrimary(id);
  }
}

function setPrimary(id) {
  if (primaryId === id) return;
  if (primaryId) domMap.get(primaryId)?.classList.remove('primary');
  primaryId = id;
  if (id) domMap.get(id)?.classList.add('primary');
}

function clearSelection() {
  for (const id of selectedIds) {
    domMap.get(id)?.classList.remove('selected', 'primary');
  }
  selectedIds.clear();
  primaryId = null;
}

function deselectAll() {
  if (editingId) stopEditing();
  clearSelection();
}

// ── テキスト編集 ──────────────────────────────────────────────────
function startEditing(id) {
  if (editingId === id) return;
  stopEditing();
  const div   = domMap.get(id);
  const inner = div?.querySelector('.el-content');
  if (!inner) return;
  editingId = id;
  editingStartContent = getElem(id)?.content ?? '';
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
  let changed = false;
  if (inner) {
    inner.contentEditable = 'false';
    div.classList.remove('editing');
    const elem = getElem(editingId);
    if (elem) {
      changed = (editingStartContent !== inner.textContent);
      elem.content = inner.textContent;
      elem.h = Math.max(MIN_H, div.offsetHeight);
      scheduleSave();
    }
  }
  editingId = null;
  editingStartContent = null;
  if (changed) pushHistory();
}

// ── マウスイベント ────────────────────────────────────────────────
canvasEl.addEventListener('mousedown', e => {
  // パン開始（Space+左クリック または 中ボタン）
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    panState = {
      startMX: e.clientX, startMY: e.clientY,
      startTX: tx,        startTY: ty,
    };
    canvasEl.classList.add('panning');
    return;
  }

  if (e.button !== 0) return;

  const rhEl = e.target.closest('.rh');
  const meEl = e.target.closest('.memo-el');

  // リサイズ開始（プライマリ要素のみハンドルが効く）
  if (rhEl && meEl) {
    e.preventDefault();
    e.stopPropagation();
    const id   = meEl.dataset.id;
    const elem = getElem(id);
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
    // Shift+クリック → トグル追加。すでに選択済みなら維持、未選択なら単独選択。
    if (e.shiftKey) {
      selectEl(id, true);
    } else if (!selectedIds.has(id)) {
      selectEl(id, false);
    } else {
      // 既に選択済み: プライマリだけ更新して全体は維持
      setPrimary(id);
    }
    // 選択中の全要素の開始位置を記録（複数まとめて移動）
    const ids = [...selectedIds];
    const starts = new Map();
    for (const sid of ids) {
      const se = getElem(sid);
      if (se) starts.set(sid, { x: se.x, y: se.y });
    }
    dragState = {
      ids,
      startMX: e.clientX, startMY: e.clientY,
      starts,
      hasMoved: false,
    };
    return;
  }

  // 空白での mousedown → 矩形選択開始（Shift で追加選択）
  e.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  marqueeState = {
    startSX: e.clientX - rect.left,
    startSY: e.clientY - rect.top,
    additive: e.shiftKey,
  };
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
    const { x: cx, y: cy } = screenToCanvas(e.clientX, e.clientY);
    const elem = addElement('text', Math.max(0, cx - 100), Math.max(0, cy - 20), 200, MIN_H, '');
    selectEl(elem.id);
    startEditing(elem.id);
  }
});

document.addEventListener('mousemove', e => {
  if (panState) {
    tx = panState.startTX + (e.clientX - panState.startMX);
    ty = panState.startTY + (e.clientY - panState.startMY);
    applyTransform();
    return;
  }

  if (dragState) {
    // ズーム時は画面差分をスケールで割って論理座標差分にする
    let dx = (e.clientX - dragState.startMX) / scale;
    let dy = (e.clientY - dragState.startMY) / scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragState.hasMoved = true;
    // グリッドサイズが設定されている場合はスナップ。Shift 押下中はスナップを無効化（フリードラッグ）
    if (gridSize > 0 && !e.shiftKey && primaryId) {
      const ps = dragState.starts.get(primaryId);
      if (ps) {
        const targetX = Math.max(0, Math.round((ps.x + dx) / gridSize) * gridSize);
        const targetY = Math.max(0, Math.round((ps.y + dy) / gridSize) * gridSize);
        dx = targetX - ps.x;
        dy = targetY - ps.y;
      }
    }
    // 全要素を相対移動（最小座標が 0 を割らないようクランプ）
    let minX = Infinity, minY = Infinity;
    for (const id of dragState.ids) {
      const s = dragState.starts.get(id);
      if (!s) continue;
      minX = Math.min(minX, s.x + dx);
      minY = Math.min(minY, s.y + dy);
    }
    if (minX < 0) dx -= minX;
    if (minY < 0) dy -= minY;
    for (const id of dragState.ids) {
      const s = dragState.starts.get(id);
      const elem = getElem(id);
      if (!s || !elem) continue;
      elem.x = s.x + dx;
      elem.y = s.y + dy;
      syncDOM(id);
    }
    return;
  }

  if (marqueeState) {
    showMarquee(e.clientX, e.clientY);
    return;
  }

  if (resizeState) {
    const { handle, startMX, startMY, startX, startY, startW, startH } = resizeState;
    const dx = (e.clientX - startMX) / scale;
    const dy = (e.clientY - startMY) / scale;
    let x = startX, y = startY, w = startW, h = startH;

    if (handle.includes('e')) { w = Math.max(MIN_W, startW + dx); }
    if (handle.includes('s')) { h = Math.max(MIN_H, startH + dy); }
    if (handle.includes('w')) { w = Math.max(MIN_W, startW - dx); x = startX + startW - w; }
    if (handle.includes('n')) { h = Math.max(MIN_H, startH - dy); y = startY + startH - h; }

    // Shift+コーナーハンドルで縦横比を固定
    const isCorner = handle.length === 2;
    if (isCorner && e.shiftKey) {
      const aspect = startW / startH;
      const wRatio = Math.abs(w - startW) / startW;
      const hRatio = Math.abs(h - startH) / startH;
      if (wRatio >= hRatio) {
        h = Math.max(MIN_H, w / aspect);
      } else {
        w = Math.max(MIN_W, h * aspect);
      }
      // w/n ハンドルは原点側を再計算
      if (handle.includes('w')) x = startX + startW - w;
      if (handle.includes('n')) y = startY + startH - h;
    }

    const elem = getElem(resizeState.id);
    elem.x = x; elem.y = y; elem.w = w; elem.h = h;
    syncDOM(resizeState.id);
  }
});

document.addEventListener('mouseup', e => {
  if (panState) {
    panState = null;
    canvasEl.classList.remove('panning');
    scheduleConfigSave();
    return;
  }
  if (marqueeState) {
    finalizeMarquee(e.clientX, e.clientY);
    marqueeState = null;
    hideMarqueeDom();
    return;
  }
  const dragChanged   = dragState?.hasMoved;
  const resizeChanged = !!resizeState;
  if (dragState || resizeState) scheduleSave();
  dragState   = null;
  resizeState = null;
  if (dragChanged || resizeChanged) pushHistory();
});

// ── キーボード ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Undo/Redo（編集中は contentEditable のネイティブ挙動に任せる）
  if (!editingId && (e.ctrlKey || e.metaKey)) {
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); return; }
  }

  // Space を押下中はパンモード（編集中は除外）
  if (!editingId && e.code === 'Space' && !e.repeat) {
    spaceHeld = true;
    canvasEl.classList.add('space-held');
    e.preventDefault();
    return;
  }

  // 編集中は Escape で編集終了のみ
  if (editingId) {
    if (e.key === 'Escape') stopEditing();
    return;
  }

  if (!selectedIds.size) return;

  // 削除（選択中の全要素）
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeElements([...selectedIds]);
    return;
  }

  // 矢印キーで微調整（選択中の全要素を同じだけ動かす）
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp')    dy = -step;
    if (e.key === 'ArrowDown')  dy =  step;
    if (e.key === 'ArrowLeft')  dx = -step;
    if (e.key === 'ArrowRight') dx =  step;
    // 0 を割らないように全体クランプ
    let minX = Infinity, minY = Infinity;
    for (const id of selectedIds) {
      const elem = getElem(id);
      if (elem) {
        minX = Math.min(minX, elem.x + dx);
        minY = Math.min(minY, elem.y + dy);
      }
    }
    if (minX < 0) dx -= minX;
    if (minY < 0) dy -= minY;
    for (const id of selectedIds) {
      const elem = getElem(id);
      if (!elem) continue;
      elem.x += dx;
      elem.y += dy;
      syncDOM(id);
    }
    scheduleSave();
    // 連打時の履歴ノイズを抑えるため、最終押下から 500ms 経過後に 1 回 push
    clearTimeout(arrowKeyTimer);
    arrowKeyTimer = setTimeout(() => { arrowKeyTimer = null; pushHistory(); }, 500);
  }
});

document.addEventListener('keyup', e => {
  if (e.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    canvasEl.classList.remove('space-held');
  }
});

// タブ切り替え等で Space が押されっぱなしになるのを防ぐ
window.addEventListener('blur', () => {
  if (spaceHeld) {
    spaceHeld = false;
    canvasEl.classList.remove('space-held');
  }
});

// ドキュメントクリック時の編集終了
document.addEventListener('mousedown', e => {
  if (editingId) {
    const activeEl = domMap.get(editingId);
    if (activeEl && !activeEl.contains(e.target)) {
      stopEditing();
    }
  }
});

// ── ホイールズーム（Ctrl+ホイールでマウス位置を中心に拡大縮小）──
canvasEl.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // ズーム前のキャンバス座標
  let cx = (mx - tx) / scale;
  let cy = (my - ty) / scale;
  // ズームの中心点をテーブル範囲内 (0〜5000) に制限して、範囲外を起点にした無駄な拡大縮小を防ぐ
  cx = Math.max(0, Math.min(5000, cx));
  cy = Math.max(0, Math.min(5000, cy));

  const screenX = tx + cx * scale;
  const screenY = ty + cy * scale;

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  if (newScale === scale) return;

  scale = newScale;
  tx = screenX - cx * scale;
  ty = screenY - cy * scale;
  applyTransform();
  scheduleConfigSave();
}, { passive: false });

// ── 画像の右クリックでコピー ──────────────────────────────────────
canvasInnerEl.addEventListener('contextmenu', async e => {
  const meEl = e.target.closest('.memo-image');
  if (!meEl) return;
  e.preventDefault();
  const elem = getElem(meEl.dataset.id);
  if (!elem || elem.type !== 'image') return;
  try {
    const blob = await dataUrlToPngBlob(elem.content);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flash('画像をコピーしました');
  } catch (err) {
    flash('コピー失敗: ' + err.message);
    console.error(err);
  }
});

async function dataUrlToPngBlob(dataUrl) {
  // ClipboardItem は image/png が確実なので canvas で PNG 化する
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return await new Promise(r => c.toBlob(r, 'image/png'));
}

// ── Undo/Redo ボタン ──────────────────────────────────────────────
btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

// ── ズームピル（クリックでビューリセット） ────────────────────────
zoomPill.addEventListener('click', resetView);

// ── テーマ切り替え ────────────────────────────────────────────────
btnTheme.addEventListener('click', () => {
  let nextTheme = 'system';
  if (config.theme === 'system') {
    nextTheme = 'light';
  } else if (config.theme === 'light') {
    nextTheme = 'dark';
  } else if (config.theme === 'dark') {
    nextTheme = 'sepia';
  } else {
    nextTheme = 'system';
  }
  config.theme = nextTheme;
  applyTheme(nextTheme);

  let label = 'システム連動';
  if (nextTheme === 'light') label = 'ライト';
  if (nextTheme === 'dark') label = 'ダーク';
  if (nextTheme === 'sepia') label = 'セピア';
  flash(`テーマを ${label} に変更しました`);

  dbSaveConfig(config).catch(err => console.error(err));
});

// ── グリッド切り替え ────────────────────────────────────────────────
gridPill.addEventListener('click', () => {
  if (gridSize === 24) {
    gridSize = 12;
  } else if (gridSize === 12) {
    gridSize = 48;
  } else if (gridSize === 48) {
    gridSize = 0;
  } else {
    gridSize = 24;
  }
  config.gridSize = gridSize;
  applyGridStyle();
  updateGridPill();
  dbSaveConfig(config).catch(err => console.error(err));
});

// ── 新規タブ追加 ──────────────────────────────────────────────────
btnAddTab.addEventListener('click', addTab);

// ── コピー&ペースト ──────────────────────────────────────────────
document.addEventListener('copy', e => {
  if (editingId || !selectedIds.size) return;
  // 選択中の要素をすべて配列としてコピー
  elementClipboard = [...selectedIds].map(id => {
    const elem = getElem(id);
    return elem ? { ...elem } : null;
  }).filter(Boolean);
  e.preventDefault();
  flash(elementClipboard.length === 1
    ? '要素をコピーしました'
    : `${elementClipboard.length} 個の要素をコピーしました`);
});

document.addEventListener('paste', async e => {
  if (editingId) return; // テキスト編集中は通常のペーストに任せる
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find(i => i.type.startsWith('image/'));
  // 1. システムクリップボードに画像があればそれを優先
  if (imgItem) {
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (file) await insertImageFile(file, null, null);
    return;
  }
  // 2. 内部クリップボードに要素があれば +20px ずらして複製
  if (elementClipboard?.length) {
    e.preventDefault();
    clearSelection();
    for (const c of elementClipboard) {
      const newEl = addElement(c.type, c.x + 20, c.y + 20, c.w, c.h, c.content);
      selectEl(newEl.id, true);
    }
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
  const { x: dropX, y: dropY } = screenToCanvas(e.clientX, e.clientY);
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  let offsetX = 0;
  for (const file of files) {
    await insertImageFile(file, dropX + offsetX, dropY + offsetX);
    offsetX += 20; // 複数枚は少しずらして配置（論理座標）
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
  if (!file.type.startsWith('image/')) { flash('画像ファイルのみ対応しています'); return; }
  if (file.size > MAX_IMG) {
    flash(`1枚最大5MB（この画像: ${(file.size/1024/1024).toFixed(1)}MB）`);
    return;
  }
  const dataUrl = await fileToDataURL(file);

  // 自然サイズを取得してから追加（ズーム中も視覚的に同じ割合に収まるよう論理座標で計算）
  const tmpImg = new Image();
  tmpImg.onload = () => {
    const maxW = (canvasEl.offsetWidth  / scale) * 0.45;
    const maxH = (canvasEl.offsetHeight / scale) * 0.70;
    let w = tmpImg.naturalWidth;
    let h = tmpImg.naturalHeight;
    // 収まるように縮小
    if (w > maxW) { h = h * maxW / w; w = maxW; }
    if (h > maxH) { w = w * maxH / h; h = maxH; }
    let x, y;
    if (dropX != null) {
      x = dropX - w / 2;
      y = dropY - h / 2;
    } else {
      // 表示中ビューポートの中心を論理座標で求める
      const center = screenToCanvas(
        canvasEl.getBoundingClientRect().left + canvasEl.offsetWidth  / 2,
        canvasEl.getBoundingClientRect().top  + canvasEl.offsetHeight / 2
      );
      x = center.x - w / 2;
      y = center.y - h / 2;
    }
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
  if (!lines.length) { flash('テキストがありません'); return; }
  dl(new Blob([lines.join('\n\n---\n\n')], { type: 'text/plain;charset=utf-8' }), `memo_${ts()}.txt`);
});

btnExportHtml.addEventListener('click', () => {
  if (!elements.length) { flash('メモが空です'); return; }
  const body = elements.map(e => {
    const s = `left:${e.x}px;top:${e.y}px;width:${e.w}px;`;
    if (e.type === 'text') {
      return `<div class="card card-text" style="${s}min-height:${e.h}px;">${escHtml(e.content)}</div>`;
    } else {
      return `<div class="card card-image" style="${s}height:${e.h}px;"><img src="${e.content}" /></div>`;
    }
  }).join('\n');
  const maxX = Math.max(...elements.map(e => e.x + e.w), 800) + 100;
  const maxY = Math.max(...elements.map(e => e.y + e.h), 600) + 100;
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Quick Memo エクスポート</title>
  <style>
    body {
      margin: 0;
      background: #f7f7f7;
      position: relative;
      width: ${maxX}px;
      height: ${maxY}px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif;
    }
    .card {
      position: absolute;
      background: #ffffff;
      border: 1.5px solid transparent;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.10);
      box-sizing: border-box;
    }
    .card-text {
      font-size: 14px;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
      padding: 8px 10px;
      color: #1a1a1a;
    }
    .card-image {
      overflow: hidden;
    }
    .card-image img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; }
      .card {
        background: #2a2a2a;
        border-color: #333333;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .card-text { color: #e2e2e2; }
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
  dl(new Blob([html], { type: 'text/html;charset=utf-8' }), `memo_${ts()}.html`);
});

btnExportJson.addEventListener('click', async () => {
  if (!config.tabs || !config.tabs.length) { flash('データがありません'); return; }

  const backupData = {
    version: '2.4.0',
    config: config,
    tabElements: {}
  };

  try {
    for (const tab of config.tabs) {
      const tabElements = await dbLoad('elements_' + tab.id);
      backupData.tabElements[tab.id] = tabElements;
    }
    backupData.elements = elements; // 後方互換性のためにアクティブな要素も入れる

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json;charset=utf-8' });
    dl(blob, `quickmemo_backup_${ts()}.json`);
  } catch (err) {
    flash('エクスポートに失敗しました: ' + err.message);
    console.error(err);
  }
});

btnImportJson.addEventListener('click', () => {
  inputImport.click();
});

inputImport.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async event => {
    try {
      const data = JSON.parse(event.target.result);
      if (!data) {
        throw new Error('インポート用データが空です');
      }

      let importedConfig = {};
      let importedTabElements = {};

      if (data.tabElements) {
        importedTabElements = data.tabElements;
        importedConfig = data.config || {};
      } else if (Array.isArray(data.elements)) {
        importedConfig = data.config || {};
        importedConfig.tabs = [{ id: 'tab_default', name: 'インポートされたメモ', scale: importedConfig.scale || 1, tx: importedConfig.tx || 0, ty: importedConfig.ty || 0 }];
        importedConfig.activeTabId = 'tab_default';
        importedTabElements['tab_default'] = data.elements;
      } else {
        throw new Error('インポート用データの構造が正しくありません');
      }

      const confirmMsg = 'インポートを実行しますか？\nすべてのページとメモの内容が上書きされます。\n（インポート後も 戻る または Ctrl+Z で取り消せます）';
      if (!confirm(confirmMsg)) {
        inputImport.value = '';
        return;
      }

      flushSave();

      // データベース内の古い要素データを削除し、新しいデータを保存する処理を同一トランザクションで行う
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        if (config.tabs) {
          for (const t of config.tabs) {
            store.delete('elements_' + t.id);
          }
        }
        for (const tabId in importedTabElements) {
          store.put(JSON.stringify(importedTabElements[tabId]), 'elements_' + tabId);
        }
        tx.oncomplete = resolve;
        tx.onerror = e => reject(e.target.error);
      });

      config = {
        theme: 'system',
        gridSize: 24,
        tabs: [{ id: 'tab_default', name: 'メモ 1', scale: 1, tx: 0, ty: 0 }],
        activeTabId: 'tab_default',
        ...importedConfig
      };

      domMap.forEach(el => el.remove());
      domMap.clear();
      selectedIds.clear();
      primaryId = null;
      editingId = null;
      tabHistories.clear();

      await dbSaveConfig(config);

      const activeTabId = config.activeTabId;
      const activeElements = importedTabElements[activeTabId] || [];
      elements = activeElements;
      elements.forEach(elem => mountDOM(elem));

      const activeTabObj = config.tabs.find(t => t.id === activeTabId) || config.tabs[0];
      scale = activeTabObj.scale ?? 1;
      tx = activeTabObj.tx ?? 0;
      ty = activeTabObj.ty ?? 0;
      applyTransform();

      applyTheme(config.theme);
      gridSize = config.gridSize ?? 24;
      applyGridStyle();
      updateGridPill();

      updateInfo();
      renderTabs();
      pushHistory();

      flash('インポートが完了しました');
      inputImport.value = '';
    } catch (err) {
      flash('インポート失敗: ' + err.message);
      console.error(err);
      inputImport.value = '';
    }
  };
  reader.onerror = () => {
    flash('ファイルの読み込みに失敗しました');
    inputImport.value = '';
  };
  reader.readAsText(file);
});

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── クリア ────────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!elements.length) return;
  if (!confirm('すべての要素を削除しますか？\n（戻る または Ctrl+Z で取り消せます）')) return;
  elements = [];
  domMap.forEach(el => el.remove());
  domMap.clear();
  selectedIds.clear();
  primaryId = null;
  editingId = null;
  await dbSave([], 'elements_' + config.activeTabId);
  setStatus('saved', 'クリアしました');
  setTimeout(() => setStatus('', '保存済み'), 2000);
  updateInfo();
  pushHistory();
});

// ── ステータス ────────────────────────────────────────────────────
function setStatus(cls, text) {
  saveEl.className  = 'save-status' + (cls ? ` ${cls}` : '');
  saveEl.textContent = text;
}

// 一時メッセージを 2 秒間ステータスバーに表示
function flash(text) {
  setStatus('', text);
  setTimeout(() => setStatus('', '保存済み'), 2000);
}

function updateInfo() {
  const t = elements.filter(e => e.type === 'text').length;
  const i = elements.filter(e => e.type === 'image').length;
  const p = [];
  if (t) p.push(`テキスト ${t}`);
  if (i) p.push(`画像 ${i}`);
  infoEl.textContent = p.join('　/　');
}
