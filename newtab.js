'use strict';

// ── 設定 ───────────────────────────────────────────────────────────
const DB_NAME    = 'QuickMemoDB';
const DB_VERSION = 3;             // キャンバスモードへ移行
const STORE      = 'canvas';
const MAX_IMG    = 5 * 1024 * 1024;
const SAVE_DELAY = 600;
const MIN_W      = 80;
const MIN_H      = 36;
const APP_VERSION = '2.7.0';
const CANVAS_SIZE = 5000;
const HANDLES    = ['nw','n','ne','e','se','s','sw','w'];
const MIN_SCALE  = 0.25;
const MAX_SCALE  = 4;
const HISTORY_MAX = 50;
const GUIDE_THRESHOLD = 6;

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
const minimapEl     = document.getElementById('minimap');
const minimapToggle = document.getElementById('minimap-toggle');
const minimapStage  = document.getElementById('minimap-stage');
const minimapContent  = document.getElementById('minimap-content');
const minimapViewport = document.getElementById('minimap-viewport');

// 検索バー DOM refs
const searchBar       = document.getElementById('search-bar');
const searchInput     = document.getElementById('search-input');
const searchCount     = document.getElementById('search-count');
const btnSearchPrev   = document.getElementById('btn-search-prev');
const btnSearchNext   = document.getElementById('btn-search-next');
const btnSearchClose  = document.getElementById('btn-search-close');

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

// 検索状態
let matchedIds  = [];
let searchIndex = -1;


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
let tabDragId = null;
let tabPointerDrag = null;
let suppressTabClick = false;
let minimapDragging = false;

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
  updateMinimap();
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
function syncConfigFromView() {
  const currentTab = config.tabs.find(t => t.id === config.activeTabId);
  if (currentTab) {
    currentTab.scale = scale;
    currentTab.tx = tx;
    currentTab.ty = ty;
  }
  config.gridSize = gridSize;
}

function scheduleConfigSave() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(async () => {
    configSaveTimer = null;
    syncConfigFromView();
    try {
      await dbSaveConfig(config);
    } catch (err) {
      console.error('設定の保存に失敗:', err);
    }
  }, 1000);
}

async function saveConfigNow() {
  clearTimeout(configSaveTimer);
  configSaveTimer = null;
  syncConfigFromView();
  await dbSaveConfig(config);
}

function flushConfigSave() {
  clearTimeout(configSaveTimer);
  configSaveTimer = null;
  syncConfigFromView();
  dbSaveConfig(config).catch(err => console.error('設定の保存に失敗:', err));
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

    div.addEventListener('click', () => {
      if (suppressTabClick) return;
      switchTab(tab.id);
    });
    div.addEventListener('dblclick', () => renameTab(tab.id));
    div.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      tabPointerDrag = { id: tab.id, startX: e.clientX, startY: e.clientY, dragging: false };
    });
    div.addEventListener('dragstart', e => {
      tabDragId = tab.id;
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.id);
    });
    div.addEventListener('dragover', e => {
      if (!tabDragId || tabDragId === tab.id) return;
      e.preventDefault();
      div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => {
      div.classList.remove('drag-over');
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      reorderTab(tabDragId, tab.id);
    });
    div.addEventListener('dragend', () => {
      tabDragId = null;
      tabsContainer.querySelectorAll('.tab-item').forEach(item => {
        item.classList.remove('dragging', 'drag-over');
      });
    });

    tabsContainer.appendChild(div);
  });
}

function reorderTab(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const sourceIdx = config.tabs.findIndex(t => t.id === sourceId);
  const targetIdx = config.tabs.findIndex(t => t.id === targetId);
  if (sourceIdx < 0 || targetIdx < 0) return;
  const [moved] = config.tabs.splice(sourceIdx, 1);
  config.tabs.splice(targetIdx, 0, moved);
  renderTabs();
  dbSaveConfig(config).catch(console.error);
}

document.addEventListener('mousemove', e => {
  if (!tabPointerDrag) return;
  const moved = Math.abs(e.clientX - tabPointerDrag.startX) > 6 || Math.abs(e.clientY - tabPointerDrag.startY) > 6;
  if (!moved && !tabPointerDrag.dragging) return;
  tabPointerDrag.dragging = true;
  suppressTabClick = true;
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tab-item');
  const targetId = target?.dataset.id;
  if (targetId && targetId !== tabPointerDrag.id) {
    reorderTab(tabPointerDrag.id, targetId);
  }
});

document.addEventListener('mouseup', () => {
  if (!tabPointerDrag) return;
  const wasDragging = tabPointerDrag.dragging;
  tabPointerDrag = null;
  if (wasDragging) {
    setTimeout(() => { suppressTabClick = false; }, 0);
  }
});

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
  const ok = await showConfirm('このページを削除しますか？\nページ内のすべてのメモが消去されます。');
  if (!ok) return;

  const targetIdx = config.tabs.findIndex(t => t.id === tabId);

  let nextTabId = config.activeTabId;
  if (tabId === config.activeTabId) {
    const nextActive = config.tabs[targetIdx + 1] || config.tabs[targetIdx - 1];
    nextTabId = nextActive.id;
  }

  config.tabs = config.tabs.filter(t => t.id !== tabId);

  // トランザクション完了を待機してからタブ切替・設定保存
  await new Promise((resolve, reject) => {
    const deleteTx = db.transaction(STORE, 'readwrite');
    deleteTx.objectStore(STORE).delete('elements_' + tabId);
    deleteTx.oncomplete = resolve;
    deleteTx.onerror = e => reject(e.target.error);
  });

  tabHistories.delete(tabId);

  if (tabId === config.activeTabId) {
    await switchTab(nextTabId);
  } else {
    renderTabs();
    await dbSaveConfig(config);
  }
}

async function renameTab(tabId) {
  const tab = config.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const newName = await showPrompt('ページ名を入力してください:', tab.name);
  if (newName && newName.trim()) {
    tab.name = newName.trim().slice(0, 20);
    renderTabs();
    dbSaveConfig(config).catch(console.error);
  }
}

async function switchTab(tabId) {
  if (tabId === config.activeTabId) return;

  closeSearch();
  await flushSaveAsync();

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
let pendingSavePromise = null; // flushSave 用: 保留中の書き込みPromise

function scheduleSave() {
  setStatus('saving', '保存中...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
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
    saveTimer = null;
    // 即座に書き込みを実行し、Promise を保持する
    pendingSavePromise = dbSave(elements, 'elements_' + config.activeTabId)
      .then(() => { pendingSavePromise = null; setStatus('', '保存済み'); })
      .catch(err => {
        pendingSavePromise = null;
        setStatus('', 'エラー: 保存失敗');
        console.error(err);
      });
  }
}

// flushSave の非同期版（書き込み完了を待つ必要がある場面用）
async function flushSaveAsync() {
  flushSave();
  if (pendingSavePromise) await pendingSavePromise;
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushSave();
    flushConfigSave();
  }
});

window.addEventListener('pagehide', () => {
  flushSave();
  flushConfigSave();
});

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
// カード背景色プリセット
const CARD_COLORS = [
  { name: 'デフォルト', value: null },
  { name: '黄色',     value: '#fff9c4' },
  { name: '緑',       value: '#c8e6c9' },
  { name: '青',       value: '#bbdefb' },
  { name: 'ピンク',   value: '#f8bbd0' },
  { name: 'オレンジ', value: '#ffe0b2' },
  { name: '紫',       value: '#e1bee7' },
  { name: '赤',       value: '#ffcdd2' },
];
// ダークモード用の背景色マッピング
const CARD_COLORS_DARK = {
  '#fff9c4': '#4a4520',
  '#c8e6c9': '#1b3a1e',
  '#bbdefb': '#1a2f4a',
  '#f8bbd0': '#4a1a2e',
  '#ffe0b2': '#4a3520',
  '#e1bee7': '#3a1b45',
  '#ffcdd2': '#4a1a1a',
};

function getCardBgColor(bgColor) {
  if (!bgColor) return '';
  // ダーク or セピアテーマ時は暗めの色を使う
  const theme = document.documentElement.getAttribute('data-theme');
  const isDark = theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (isDark) return CARD_COLORS_DARK[bgColor] || bgColor;
  return bgColor;
}

function applyBgColor(div, elem) {
  const bg = getCardBgColor(elem.bgColor);
  div.style.backgroundColor = bg || '';
}

function buildElement(elem) {
  const div = document.createElement('div');
  div.className = `memo-el memo-${elem.type}`;
  if (elem.locked) div.classList.add('locked');
  div.dataset.id = elem.id;
  applyPosStyle(div, elem);
  applyBgColor(div, elem);

  if (elem.type === 'text') {
    const inner = document.createElement('div');
    inner.className = 'el-content';
    inner.contentEditable = 'false';
    inner.textContent = elem.content || '';
    div.appendChild(inner);

    // テキスト変更を即時データに反映 + 高さも即時更新（B6修正）
    inner.addEventListener('input', () => {
      const e = getElem(elem.id);
      if (e) {
        e.content = inner.textContent;
        e.h = Math.max(MIN_H, div.offsetHeight);
        scheduleSave();
      }
    });
  } else {
    const img = document.createElement('img');
    img.src = elem.content;
    img.draggable = false;
    div.appendChild(img);
  }

  // ロックバッジ
  const badge = document.createElement('span');
  badge.className = 'lock-badge';
  badge.textContent = '\uD83D\uDD12';
  div.appendChild(badge);

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
function addElement(type, x, y, w, h, content, opts = {}) {
  const elem = { id: uid(), type, x, y, w, h, content: content || '' };
  if (opts.bgColor) elem.bgColor = opts.bgColor;
  if (opts.locked) elem.locked = true;
  elements.push(elem);
  mountDOM(elem);
  scheduleSave();
  updateInfo();
  if (!opts.skipHistory) pushHistory();
  return elem;
}

// 複数要素をバッチで追加（pushHistory を 1 回だけ呼ぶ）
function addElementsBatch(elemDefs) {
  const added = [];
  for (const def of elemDefs) {
    const elem = { id: uid(), type: def.type, x: def.x, y: def.y, w: def.w, h: def.h, content: def.content || '' };
    if (def.bgColor) elem.bgColor = def.bgColor;
    if (def.locked) elem.locked = true;
    elements.push(elem);
    mountDOM(elem);
    added.push(elem);
  }
  scheduleSave();
  updateInfo();
  pushHistory();
  return added;
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

// ── スナップガイド ────────────────────────────────────────────────
let snapGuideV = null;
let snapGuideH = null;

function getOrCreateSnapGuides() {
  if (!snapGuideV) {
    snapGuideV = document.createElement('div');
    snapGuideV.className = 'snap-guide snap-guide-v';
    snapGuideV.hidden = true;
    canvasInnerEl.appendChild(snapGuideV);
  }
  if (!snapGuideH) {
    snapGuideH = document.createElement('div');
    snapGuideH.className = 'snap-guide snap-guide-h';
    snapGuideH.hidden = true;
    canvasInnerEl.appendChild(snapGuideH);
  }
}

function hideSnapGuides() {
  if (snapGuideV) snapGuideV.hidden = true;
  if (snapGuideH) snapGuideH.hidden = true;
}

function getDragBounds(ids, starts, dx, dy) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const start = starts.get(id);
    const elem = getElem(id);
    if (!start || !elem) continue;
    minX = Math.min(minX, start.x + dx);
    minY = Math.min(minY, start.y + dy);
    maxX = Math.max(maxX, start.x + dx + elem.w);
    maxY = Math.max(maxY, start.y + dy + elem.h);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function findGuideSnap(ids, starts, dx, dy) {
  let bestX = null;
  let bestY = null;
  const bounds = getDragBounds(ids, starts, dx, dy);
  const movingX = [
    { key: 'left', value: bounds.minX },
    { key: 'center', value: bounds.cx },
    { key: 'right', value: bounds.maxX },
  ];
  const movingY = [
    { key: 'top', value: bounds.minY },
    { key: 'middle', value: bounds.cy },
    { key: 'bottom', value: bounds.maxY },
  ];

  for (const elem of elements) {
    if (ids.includes(elem.id)) continue;
    const targetX = [elem.x, elem.x + elem.w / 2, elem.x + elem.w];
    const targetY = [elem.y, elem.y + elem.h / 2, elem.y + elem.h];
    for (const source of movingX) {
      for (const target of targetX) {
        const diff = target - source.value;
        if (Math.abs(diff) <= GUIDE_THRESHOLD && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
          bestX = { diff, x: target, y1: Math.min(bounds.minY, elem.y), y2: Math.max(bounds.maxY, elem.y + elem.h) };
        }
      }
    }
    for (const source of movingY) {
      for (const target of targetY) {
        const diff = target - source.value;
        if (Math.abs(diff) <= GUIDE_THRESHOLD && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
          bestY = { diff, y: target, x1: Math.min(bounds.minX, elem.x), x2: Math.max(bounds.maxX, elem.x + elem.w) };
        }
      }
    }
  }
  return { dx: dx + (bestX?.diff || 0), dy: dy + (bestY?.diff || 0), xGuide: bestX, yGuide: bestY };
}

function showSnapGuides(xGuide, yGuide) {
  getOrCreateSnapGuides();
  if (xGuide) {
    snapGuideV.hidden = false;
    snapGuideV.style.left = xGuide.x + 'px';
    snapGuideV.style.top = Math.max(0, xGuide.y1 - 24) + 'px';
    snapGuideV.style.height = Math.min(CANVAS_SIZE, xGuide.y2 - xGuide.y1 + 48) + 'px';
  } else {
    snapGuideV.hidden = true;
  }
  if (yGuide) {
    snapGuideH.hidden = false;
    snapGuideH.style.top = yGuide.y + 'px';
    snapGuideH.style.left = Math.max(0, yGuide.x1 - 24) + 'px';
    snapGuideH.style.width = Math.min(CANVAS_SIZE, yGuide.x2 - yGuide.x1 + 48) + 'px';
  } else {
    snapGuideH.hidden = true;
  }
}

// ── テキスト編集 ──────────────────────────────────────────────────
function startEditing(id) {
  if (editingId === id) return;
  stopEditing();
  const div   = domMap.get(id);
  if (!div) return;
  const inner = div.querySelector('.el-content');
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
    const id   = meEl.dataset.id;
    const elem = getElem(id);
    if (elem?.locked) return; // ロック中はリサイズ不可
    e.preventDefault();
    e.stopPropagation();
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
    const clickedElem = getElem(meEl.dataset.id);
    if (clickedElem?.locked) {
      // ロック中: 選択はできるがドラッグはしない
      selectEl(meEl.dataset.id, e.shiftKey);
      return;
    }
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
    // 選択中のうち、ロックされていない要素だけを移動対象にする
    const ids = [...selectedIds].filter(sid => !getElem(sid)?.locked);
    if (!ids.length) {
      flash('ロック中の要素は移動できません');
      return;
    }
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
    const clickedElem = getElem(meEl.dataset.id);
    if (clickedElem?.locked) { flash('ロック中の要素は編集できません'); return; }
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
  if (minimapDragging) {
    panFromMinimap(e.clientX, e.clientY);
    return;
  }

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
    if (!e.shiftKey) {
      const guideSnap = findGuideSnap(dragState.ids, dragState.starts, dx, dy);
      dx = guideSnap.dx;
      dy = guideSnap.dy;
      showSnapGuides(guideSnap.xGuide, guideSnap.yGuide);
    } else {
      hideSnapGuides();
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
    updateMinimap();
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
    updateMinimap();
  }
});

document.addEventListener('mouseup', e => {
  if (minimapDragging) {
    minimapDragging = false;
    scheduleConfigSave();
    return;
  }
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
  hideSnapGuides();
  if (dragChanged || resizeChanged) pushHistory();
});

// ── キーボード ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Ctrl+F または Cmd+F で検索バーを表示
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }

  // 検索バーが表示されている場合、Escapeキーで閉じる
  if (e.key === 'Escape' && !searchBar.hidden) {
    e.preventDefault();
    closeSearch();
    return;
  }

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

  // 削除（選択中の全要素、ロック中を除く）
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const deletable = [...selectedIds].filter(id => !getElem(id)?.locked);
    if (deletable.length) {
      removeElements(deletable);
    } else {
      flash('ロック中の要素は削除できません');
    }
    return;
  }

  // 矢印キーで微調整（選択中の全要素を同じだけ動かす）
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const movableIds = [...selectedIds].filter(id => !getElem(id)?.locked);
    if (!movableIds.length) {
      flash('ロック中の要素は移動できません');
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp')    dy = -step;
    if (e.key === 'ArrowDown')  dy =  step;
    if (e.key === 'ArrowLeft')  dx = -step;
    if (e.key === 'ArrowRight') dx =  step;
    // 0 を割らないように全体クランプ
    let minX = Infinity, minY = Infinity;
    for (const id of movableIds) {
      const elem = getElem(id);
      if (elem) {
        minX = Math.min(minX, elem.x + dx);
        minY = Math.min(minY, elem.y + dy);
      }
    }
    if (minX < 0) dx -= minX;
    if (minY < 0) dy -= minY;
    for (const id of movableIds) {
      const elem = getElem(id);
      if (!elem) continue;
      elem.x += dx;
      elem.y += dy;
      syncDOM(id);
    }
    updateMinimap();
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
  // ズームの中心点をキャンバス範囲内に制限して、範囲外を起点にした無駄な拡大縮小を防ぐ
  cx = Math.max(0, Math.min(CANVAS_SIZE, cx));
  cy = Math.max(0, Math.min(CANVAS_SIZE, cy));

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

// ── 右クリックコンテキストメニュー（画像コピー / 背景色変更 / ロック切替）──
let activeContextMenu = null;

function hideContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

// 他の場所をクリックしたらコンテキストメニューを閉じる
document.addEventListener('mousedown', e => {
  if (activeContextMenu?.contains(e.target)) return;
  hideContextMenu();
});

canvasInnerEl.addEventListener('contextmenu', async e => {
  // テキスト編集中はブラウザ既定の右クリックメニュー（コピー・ペースト等）を優先する
  if (editingId) return;

  const meEl = e.target.closest('.memo-el');
  if (!meEl) return;
  e.preventDefault();
  hideContextMenu();

  const id = meEl.dataset.id;
  const elem = getElem(id);
  if (!elem) return;

  // 選択状態にする
  if (!selectedIds.has(id)) selectEl(id);

  // コンテキストメニューを構築
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.addEventListener('mousedown', e => e.stopPropagation());

  // テキスト要素の場合: 編集ボタン
  if (elem.type === 'text' && !elem.locked) {
    const editBtn = document.createElement('div');
    editBtn.className = 'context-menu-item';
    editBtn.textContent = '📝 編集';
    editBtn.addEventListener('click', () => {
      hideContextMenu();
      startEditing(id);
    });
    menu.appendChild(editBtn);
  }

  // 画像要素の場合: コピーボタン、サイズ変更ボタン、編集ボタン
  if (elem.type === 'image') {
    const copyBtn = document.createElement('div');
    copyBtn.className = 'context-menu-item';
    copyBtn.textContent = '\uD83D\uDCCB 画像をコピー';
    copyBtn.addEventListener('click', async () => {
      hideContextMenu();
      try {
        const blob = await dataUrlToPngBlob(elem.content);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flash('画像をコピーしました');
      } catch (err) {
        flash('コピー失敗: ' + err.message);
        console.error(err);
      }
    });
    menu.appendChild(copyBtn);

    if (!elem.locked) {
      const resizeBtn = document.createElement('div');
      resizeBtn.className = 'context-menu-item';
      resizeBtn.textContent = '📐 サイズ変更...';
      resizeBtn.addEventListener('click', () => {
        hideContextMenu();
        openResizeModal(elem);
      });
      menu.appendChild(resizeBtn);

      const editBtn = document.createElement('div');
      editBtn.className = 'context-menu-item';
      editBtn.textContent = '✏️ 編集...';
      editBtn.addEventListener('click', () => {
        hideContextMenu();
        openEditModal(elem);
      });
      menu.appendChild(editBtn);
    }
  }

  // ロック/アンロック
  const lockBtn = document.createElement('div');
  lockBtn.className = 'context-menu-item';
  lockBtn.textContent = elem.locked ? '\uD83D\uDD13 ロック解除' : '\uD83D\uDD12 ロック';
  lockBtn.addEventListener('click', () => {
    hideContextMenu();
    toggleLock(id);
  });
  menu.appendChild(lockBtn);

  // 背景色セクション
  const colorSection = document.createElement('div');
  colorSection.className = 'context-menu-colors';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'context-menu-label';
  colorLabel.textContent = '背景色:';
  colorSection.appendChild(colorLabel);

  const swatches = document.createElement('div');
  swatches.className = 'context-menu-swatches';

  for (const c of CARD_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    if (c.value === (elem.bgColor || null)) swatch.classList.add('active');
    swatch.style.backgroundColor = c.value || 'var(--el-bg)';
    if (!c.value) {
      swatch.style.background = 'linear-gradient(135deg, var(--el-bg) 45%, var(--border) 45%, var(--border) 55%, var(--el-bg) 55%)';
    }
    swatch.title = c.name;
    swatch.addEventListener('click', () => {
      hideContextMenu();
      setCardColor(id, c.value);
    });
    swatches.appendChild(swatch);
  }
  colorSection.appendChild(swatches);
  menu.appendChild(colorSection);

  // メニューの位置をマウスカーソル近くに配置（画面座標）
  const canvasRect = canvasEl.getBoundingClientRect();
  menu.style.left = (e.clientX - canvasRect.left) + 'px';
  menu.style.top  = (e.clientY - canvasRect.top) + 'px';
  canvasEl.appendChild(menu);
  activeContextMenu = menu;

  // メニューが画面外にはみ出ないよう調整
  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > canvasRect.right - 8) {
      menu.style.left = Math.max(4, (e.clientX - canvasRect.left - menuRect.width)) + 'px';
    }
    if (menuRect.bottom > canvasRect.bottom - 8) {
      menu.style.top = Math.max(4, (e.clientY - canvasRect.top - menuRect.height)) + 'px';
    }
  });
});

function setCardColor(id, color) {
  const elem = getElem(id);
  if (!elem) return;
  // 選択中の全要素に適用
  const targets = selectedIds.size > 1 ? [...selectedIds] : [id];
  for (const tid of targets) {
    const e = getElem(tid);
    if (!e) continue;
    if (color) {
      e.bgColor = color;
    } else {
      delete e.bgColor;
    }
    const div = domMap.get(tid);
    if (div) applyBgColor(div, e);
  }
  scheduleSave();
  pushHistory();
  const count = targets.length;
  flash(count > 1 ? `${count} 個の要素の背景色を変更しました` : '背景色を変更しました');
}

function toggleLock(id) {
  // 選択中の全要素に適用
  const targets = selectedIds.size > 1 ? [...selectedIds] : [id];
  const elem = getElem(id);
  const newLocked = !elem?.locked;
  for (const tid of targets) {
    const e = getElem(tid);
    if (!e) continue;
    e.locked = newLocked;
    const div = domMap.get(tid);
    if (div) {
      div.classList.toggle('locked', newLocked);
    }
  }
  scheduleSave();
  pushHistory();
  flash(newLocked ? 'ロックしました' : 'ロック解除しました');
}

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

if (minimapToggle) {
  minimapToggle.addEventListener('click', () => {
    minimapEl.classList.toggle('collapsed');
    minimapToggle.textContent = minimapEl.classList.contains('collapsed') ? '表示' : '全体';
    updateMinimap();
  });
}

if (minimapStage) {
  minimapStage.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    minimapDragging = true;
    panFromMinimap(e.clientX, e.clientY);
  });
}

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
  // 2. 内部クリップボードに要素があれば +20px ずらして複製（バッチで追加し履歴は1回）
  if (elementClipboard?.length) {
    e.preventDefault();
    clearSelection();
    const defs = elementClipboard.map(c => ({
      type: c.type, x: c.x + 20, y: c.y + 20, w: c.w, h: c.h, content: c.content,
      bgColor: c.bgColor, locked: c.locked
    }));
    const added = addElementsBatch(defs);
    for (const el of added) selectEl(el.id, true);
  }
});

// ── ドラッグ＆ドロップ ────────────────────────────────────────────
let dragCounter = 0;

// ドロップ可能なファイル（画像またはテキスト）が含まれているか判定
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.csv', '.log', '.json', '.xml', '.yaml', '.yml'];
function isTextFile(file) {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  const name = file.name.toLowerCase();
  return TEXT_EXTENSIONS.some(ext => name.endsWith(ext));
}

function hasDroppableFile(items) {
  return [...(items || [])].some(i => {
    if (i.kind !== 'file') return false;
    if (i.type.startsWith('image/')) return true;
    if (i.type.startsWith('text/')) return true;
    if (i.type === 'application/json' || i.type === 'application/xml') return true;
    return false;
  });
}

document.addEventListener('dragenter', e => {
  if (hasDroppableFile(e.dataTransfer?.items)) {
    e.preventDefault(); dragCounter++; dropOverlay.hidden = false;
  }
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

  const allFiles = [...e.dataTransfer.files];
  const imageFiles = allFiles.filter(f => f.type.startsWith('image/'));
  const textFiles  = allFiles.filter(f => !f.type.startsWith('image/') && isTextFile(f));

  let offsetX = 0;
  // 画像ファイルの処理
  for (const file of imageFiles) {
    await insertImageFile(file, dropX + offsetX, dropY + offsetX);
    offsetX += 20;
  }
  // テキストファイルの処理
  for (const file of textFiles) {
    await insertTextFile(file, dropX + offsetX, dropY + offsetX);
    offsetX += 20;
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

// テキストファイルをテキストカードとして挿入
async function insertTextFile(file, dropX, dropY) {
  try {
    const text = await file.text();
    if (!text.trim()) { flash('空のテキストファイルです'); return; }
    // ファイル名を先頭行として付与
    const content = `[\u{1F4C4} ${file.name}]\n${text}`;
    // 文字数に応じてカード幅を調整（最大400px）
    const w = Math.min(400, Math.max(200, text.length * 2));
    const h = Math.max(MIN_H, Math.min(300, text.split('\n').length * 24 + 40));
    const x = dropX != null ? Math.max(0, dropX - w / 2) : 100;
    const y = dropY != null ? Math.max(0, dropY - h / 2) : 100;
    const elem = addElement('text', x, y, w, h, content);
    selectEl(elem.id);
    flash(`${file.name} をテキストカードとして追加しました`);
  } catch (err) {
    flash('ファイルの読み込みに失敗: ' + err.message);
    console.error(err);
  }
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

// 画像の content が安全な data: URI であることを検証する
function isSafeDataUrl(url) {
  return typeof url === 'string' && /^data:image\/[a-z+]+;base64,/i.test(url);
}

btnExportHtml.addEventListener('click', () => {
  if (!elements.length) { flash('メモが空です'); return; }
  const body = elements.map(e => {
    const s = `left:${e.x}px;top:${e.y}px;width:${e.w}px;`;
    if (e.type === 'text') {
      return `<div class="card card-text" style="${s}min-height:${e.h}px;">${escHtml(e.content)}</div>`;
    } else {
      // XSS 対策: data:image/ で始まる安全な URI のみ埋め込む
      const safeSrc = isSafeDataUrl(e.content) ? e.content : '';
      return `<div class="card card-image" style="${s}height:${e.h}px;"><img src="${safeSrc}" /></div>`;
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
  await flushSaveAsync();
  await saveConfigNow();

  const backupData = {
    version: APP_VERSION,
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

      const ok = await showConfirm('インポートを実行しますか？\nすべてのページとメモの内容が上書きされます。\n\n※ インポート実行前にバックアップが自動ダウンロードされます。');
      if (!ok) {
        inputImport.value = '';
        return;
      }

      // インポート前にバックアップを自動ダウンロード（取り消し手段として）
      try {
        await flushSaveAsync();
        await saveConfigNow();
        const preBackup = { version: APP_VERSION, config: config, tabElements: {} };
        for (const tab of config.tabs) {
          preBackup.tabElements[tab.id] = await dbLoad('elements_' + tab.id);
        }
        const backupBlob = new Blob([JSON.stringify(preBackup, null, 2)], { type: 'application/json;charset=utf-8' });
        dl(backupBlob, `quickmemo_pre_import_backup_${ts()}.json`);
      } catch (backupErr) {
        console.error('インポート前バックアップに失敗:', backupErr);
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
  const ok = await showConfirm('すべての要素を削除しますか？\n（戻る または Ctrl+Z で取り消せます）');
  if (!ok) return;
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

// ── 検索バー イベントリスナー ──────────────────────────────────────
searchInput.addEventListener('input', e => {
  performSearch(e.target.value);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      navigateToHit(searchIndex - 1);
    } else {
      navigateToHit(searchIndex + 1);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});

btnSearchPrev.addEventListener('click', () => {
  navigateToHit(searchIndex - 1);
});

btnSearchNext.addEventListener('click', () => {
  navigateToHit(searchIndex + 1);
});

btnSearchClose.addEventListener('click', () => {
  closeSearch();
});

// ── ステータス ────────────────────────────────────────────────────
function setStatus(cls, text) {
  saveEl.className  = 'save-status' + (cls ? ` ${cls}` : '');
  saveEl.textContent = text;
}

// 一時メッセージを 2 秒間ステータスバーに表示
let flashTimer = null;
function flash(text) {
  setStatus('', text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashTimer = null; setStatus('', '保存済み'); }, 2000);
}

function updateInfo() {
  const t = elements.filter(e => e.type === 'text').length;
  const i = elements.filter(e => e.type === 'image').length;
  const p = [];
  if (t) p.push(`テキスト ${t}`);
  if (i) p.push(`画像 ${i}`);
  infoEl.textContent = p.join('　/　');
  updateMinimap();
}

// ── ミニマップ ────────────────────────────────────────────────────
function updateMinimap() {
  if (!minimapEl || !minimapStage || !minimapContent || !minimapViewport || minimapEl.classList.contains('collapsed')) return;
  const stageW = minimapStage.clientWidth || 180;
  const stageH = minimapStage.clientHeight || 128;
  const pad = 8;
  const miniScale = Math.min((stageW - pad * 2) / CANVAS_SIZE, (stageH - pad * 2) / CANVAS_SIZE);

  minimapContent.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const elem of elements) {
    const item = document.createElement('div');
    item.className = `minimap-item minimap-${elem.type}`;
    item.style.left = (pad + elem.x * miniScale) + 'px';
    item.style.top = (pad + elem.y * miniScale) + 'px';
    item.style.width = Math.max(2, elem.w * miniScale) + 'px';
    item.style.height = Math.max(2, elem.h * miniScale) + 'px';
    fragment.appendChild(item);
  }
  minimapContent.appendChild(fragment);

  const viewX = Math.max(0, -tx / scale);
  const viewY = Math.max(0, -ty / scale);
  const viewW = canvasEl.clientWidth / scale;
  const viewH = canvasEl.clientHeight / scale;
  minimapViewport.style.left = (pad + viewX * miniScale) + 'px';
  minimapViewport.style.top = (pad + viewY * miniScale) + 'px';
  minimapViewport.style.width = Math.min(stageW - pad * 2, Math.max(6, viewW * miniScale)) + 'px';
  minimapViewport.style.height = Math.min(stageH - pad * 2, Math.max(6, viewH * miniScale)) + 'px';
}

function panFromMinimap(clientX, clientY) {
  if (!minimapStage) return;
  const rect = minimapStage.getBoundingClientRect();
  const pad = 8;
  const miniScale = Math.min((rect.width - pad * 2) / CANVAS_SIZE, (rect.height - pad * 2) / CANVAS_SIZE);
  const cx = Math.max(0, Math.min(CANVAS_SIZE, (clientX - rect.left - pad) / miniScale));
  const cy = Math.max(0, Math.min(CANVAS_SIZE, (clientY - rect.top - pad) / miniScale));
  tx = canvasEl.clientWidth / 2 - cx * scale;
  ty = canvasEl.clientHeight / 2 - cy * scale;
  applyTransform();
  scheduleConfigSave();
}

// ── 検索・フィルタ機能（Ctrl+F） ──────────────────────────────────
function openSearch() {
  if (editingId) stopEditing();
  deselectAll();
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
  if (searchInput.value) {
    performSearch(searchInput.value);
  }
}

function closeSearch() {
  searchBar.hidden = true;
  clearSearchHighlight();
  matchedIds = [];
  searchIndex = -1;
  canvasEl.focus();
}

function clearSearchHighlight() {
  domMap.forEach(div => {
    div.classList.remove('search-hit', 'search-hit-active');
  });
}

function performSearch(query) {
  clearSearchHighlight();
  if (!query || !query.trim()) {
    matchedIds = [];
    searchIndex = -1;
    searchCount.textContent = '0 / 0';
    return;
  }

  const q = query.trim().toLowerCase();
  matchedIds = elements
    .filter(e => e.type === 'text' && e.content && e.content.toLowerCase().includes(q))
    .map(e => e.id);

  if (matchedIds.length === 0) {
    searchIndex = -1;
    searchCount.textContent = '0 / 0';
    return;
  }

  matchedIds.forEach(id => {
    domMap.get(id)?.classList.add('search-hit');
  });

  if (searchIndex < 0 || searchIndex >= matchedIds.length) {
    searchIndex = 0;
  }

  navigateToHit(searchIndex);
}

let smoothPanTimer = null;
function navigateToHit(index) {
  if (matchedIds.length === 0) return;

  searchIndex = (index + matchedIds.length) % matchedIds.length;

  domMap.forEach(div => div.classList.remove('search-hit-active'));

  const activeId = matchedIds[searchIndex];
  const activeDiv = domMap.get(activeId);
  if (!activeDiv) return;

  activeDiv.classList.add('search-hit-active');
  searchCount.textContent = `${searchIndex + 1} / ${matchedIds.length}`;

  const elem = getElem(activeId);
  if (!elem) return;

  const vw = canvasEl.offsetWidth;
  const vh = canvasEl.offsetHeight;
  const cx = elem.x + elem.w / 2;
  const cy = elem.y + elem.h / 2;

  if (scale < 0.75) {
    scale = 1.0;
  }

  tx = vw / 2 - cx * scale;
  ty = vh / 2 - cy * scale;

  clearTimeout(smoothPanTimer);
  canvasInnerEl.classList.add('smooth-transform');
  applyTransform();
  scheduleConfigSave();

  smoothPanTimer = setTimeout(() => {
    canvasInnerEl.classList.remove('smooth-transform');
  }, 350);
}

// ── カスタムモーダルダイアログ ────────────────────────────────────
// confirm() / prompt() の代替。UX統一のためアプリ内モーダルを使用する。
function getOrCreateModal() {
  let overlay = document.getElementById('modal-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-dialog">
      <p class="modal-message" id="modal-message"></p>
      <input type="text" class="modal-input" id="modal-input" hidden />
      <div class="modal-actions">
        <button class="btn modal-btn-cancel" id="modal-cancel">キャンセル</button>
        <button class="btn modal-btn-ok" id="modal-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = getOrCreateModal();
    const msgEl   = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const btnOk   = document.getElementById('modal-ok');
    const btnCancel = document.getElementById('modal-cancel');

    msgEl.textContent = message;
    inputEl.hidden = true;
    overlay.hidden = false;
    btnOk.focus();

    function cleanup(result) {
      overlay.hidden = true;
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    }
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
  });
}

function showPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = getOrCreateModal();
    const msgEl   = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const btnOk   = document.getElementById('modal-ok');
    const btnCancel = document.getElementById('modal-cancel');

    msgEl.textContent = message;
    inputEl.hidden = false;
    inputEl.value = defaultValue;
    overlay.hidden = false;
    inputEl.focus();
    inputEl.select();

    function cleanup(result) {
      overlay.hidden = true;
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(inputEl.value); }
    function onCancel() { cleanup(null); }
    function onOverlay(e) { if (e.target === overlay) cleanup(null); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); cleanup(inputEl.value); }
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
    }
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
  });
}

// ── デバッグ用グローバルエラーハンドラー ──────────────────────────
window.addEventListener('error', e => {
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
});

// ── サイズ変更モーダル ─────────────────────────────────────────────
function openResizeModal(elem) {
  try {
    if (elem.locked) {
      flash('ロック中の要素はサイズ変更できません');
      return;
    }
    const dlg  = document.getElementById('resize-dialog');
    const wIn  = document.getElementById('resize-w');
    const hIn  = document.getElementById('resize-h');
    const lock = document.getElementById('resize-lock');
    const origW = elem.w, origH = elem.h;
    let natW = elem.w, natH = elem.h;

    const tmpImg = new Image();
    tmpImg.onload = () => { natW = tmpImg.naturalWidth; natH = tmpImg.naturalHeight; };
    tmpImg.src = elem.content;

    wIn.value = Math.round(elem.w);
    hIn.value = Math.round(elem.h);

    wIn.oninput = () => {
      if (lock.checked) hIn.value = Math.round(Number(wIn.value) * origH / origW);
    };
    hIn.oninput = () => {
      if (lock.checked) wIn.value = Math.round(Number(hIn.value) * origW / origH);
    };

    dlg.querySelectorAll('.preset-size-btn').forEach(btn => {
      btn.onclick = () => {
        const f = btn.dataset.factor;
        if (f === 'original') {
          wIn.value = Math.round(natW);
          hIn.value = Math.round(natH);
        } else {
          const factor = Number(f);
          wIn.value = Math.round(origW * factor);
          hIn.value = Math.round(origH * factor);
        }
      };
    });

    const closeModal = () => dlg.close();
    document.getElementById('resize-cancel').onclick = closeModal;
    document.getElementById('resize-close').onclick  = closeModal;

    document.getElementById('resize-ok').onclick = () => {
      const nw = Math.max(10, Number(wIn.value) || 10);
      const nh = Math.max(10, Number(hIn.value) || 10);
      if (nw === elem.w && nh === elem.h) {
        dlg.close();
        return;
      }
      elem.w = nw; elem.h = nh;
      syncDOM(elem.id);
      scheduleSave();
      pushHistory();
      updateMinimap();
      dlg.close();
    };

    dlg.showModal();
  } catch (err) {
    flash("サイズ変更起動エラー: " + err.message);
    console.error(err);
  }
}

// ── 画像編集モーダル ──────────────────────────────────────────────
function openEditModal(elem) {
  try {
    if (elem.locked) {
      flash('ロック中の要素は編集できません');
      return;
    }
    const dlg     = document.getElementById('edit-dialog');
    const editCvs = document.getElementById('edit-canvas');
    const overCvs = document.getElementById('edit-overlay');
    const ctx     = editCvs.getContext('2d');
    const ovCtx   = overCvs.getContext('2d');

    let undoStack = [], redoStack = [];
    const EDIT_UNDO_MAX = 20;

    function saveEditState() {
      undoStack.push(ctx.getImageData(0, 0, editCvs.width, editCvs.height));
      if (undoStack.length > EDIT_UNDO_MAX) undoStack.shift();
      redoStack = [];
      refreshEditUndoButtons();
    }

    function refreshEditUndoButtons() {
      document.getElementById('et-undo').disabled = undoStack.length === 0;
      document.getElementById('et-redo').disabled = redoStack.length === 0;
    }

    // 初期ツール状態をリセット
    let currentTool = 'pen';
    dlg.querySelectorAll('.edit-tool').forEach(b => b.classList.remove('active'));
    dlg.querySelector('[data-tool="pen"]').classList.add('active');
    document.getElementById('et-crop-apply').disabled = true;
    document.getElementById('et-num-select').style.display = 'none';

    let drawing = false, startX = 0, startY = 0;
    let cropRect = null;
    let textRect  = null;
    let dispScale = 1;

    // 画像ロード
    const img = new Image();
    img.onload = () => {
      editCvs.width  = img.naturalWidth  || 400;
      editCvs.height = img.naturalHeight || 300;
      overCvs.width  = editCvs.width;
      overCvs.height = editCvs.height;
      ctx.drawImage(img, 0, 0);
      positionEditorCanvas();
      refreshEditUndoButtons();
    };
    img.src = elem.content;

    function positionEditorCanvas() {
      const wrap = dlg.querySelector('.edit-canvas-wrap');
      const maxW = (wrap.clientWidth  || window.innerWidth)  - 40;
      const maxH = (wrap.clientHeight || window.innerHeight - 50) - 40;
      dispScale = Math.min(1, maxW / editCvs.width, maxH / editCvs.height);
      const dw = editCvs.width  * dispScale;
      const dh = editCvs.height * dispScale;
      editCvs.style.width  = overCvs.style.width  = dw + 'px';
      editCvs.style.height = overCvs.style.height = dh + 'px';
      const cx = Math.max(0, ((wrap.clientWidth  || window.innerWidth)  - dw) / 2);
      const cy = Math.max(0, ((wrap.clientHeight || window.innerHeight - 50) - dh) / 2);
      editCvs.style.left = overCvs.style.left = cx + 'px';
      editCvs.style.top  = overCvs.style.top  = cy + 'px';
    }

    // ツール選択
    dlg.querySelectorAll('.edit-tool').forEach(btn => {
      btn.onclick = () => {
        currentTool = btn.dataset.tool;
        dlg.querySelectorAll('.edit-tool').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cropRect = null;
        ovCtx.clearRect(0, 0, overCvs.width, overCvs.height);
        document.getElementById('et-crop-apply').disabled = true;
        document.getElementById('et-num-select').style.display =
          currentTool === 'num' ? 'inline-block' : 'none';
        // text 以外のツールに切り替えたら未確定テキストを自動確定して閉じる
        if (currentTool !== 'text') {
          const ta = document.getElementById('edit-text-overlay');
          if (ta.style.display !== 'none' && ta.value.trim()) {
            confirmText();
          } else {
            ta.style.display = 'none'; ta.value = ''; textRect = null;
          }
        }
        overCvs.style.display = 'block';
      };
    });

    // canvas 座標変換（CSS スケール考慮）
    function getCanvasXY(e) {
      const rect   = overCvs.getBoundingClientRect();
      const scaleX = editCvs.width  / rect.width;
      const scaleY = editCvs.height / rect.height;
      return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
    }

    // 変換ヘルパー（rotate/flip）
    function transformCanvas(fn) {
      saveEditState();
      const tmp = document.createElement('canvas');
      fn(tmp, editCvs);
      editCvs.width  = tmp.width;
      editCvs.height = tmp.height;
      overCvs.width  = tmp.width;
      overCvs.height = tmp.height;
      ctx.drawImage(tmp, 0, 0);
      positionEditorCanvas();
    }

    document.getElementById('et-rot-l').onclick = () => transformCanvas((t, s) => {
      t.width = s.height; t.height = s.width;
      const tc = t.getContext('2d');
      tc.translate(0, t.height); tc.rotate(-Math.PI / 2);
      tc.drawImage(s, 0, 0);
    });
    document.getElementById('et-rot-r').onclick = () => transformCanvas((t, s) => {
      t.width = s.height; t.height = s.width;
      const tc = t.getContext('2d');
      tc.translate(t.width, 0); tc.rotate(Math.PI / 2);
      tc.drawImage(s, 0, 0);
    });
    document.getElementById('et-flip-h').onclick = () => transformCanvas((t, s) => {
      t.width = s.width; t.height = s.height;
      const tc = t.getContext('2d');
      tc.translate(t.width, 0); tc.scale(-1, 1);
      tc.drawImage(s, 0, 0);
    });
    document.getElementById('et-flip-v').onclick = () => transformCanvas((t, s) => {
      t.width = s.width; t.height = s.height;
      const tc = t.getContext('2d');
      tc.translate(0, t.height); tc.scale(1, -1);
      tc.drawImage(s, 0, 0);
    });

    // undo/redo
    document.getElementById('et-undo').onclick = () => {
      if (!undoStack.length) return;
      redoStack.push(ctx.getImageData(0, 0, editCvs.width, editCvs.height));
      ctx.putImageData(undoStack.pop(), 0, 0);
      refreshEditUndoButtons();
    };
    document.getElementById('et-redo').onclick = () => {
      if (!redoStack.length) return;
      undoStack.push(ctx.getImageData(0, 0, editCvs.width, editCvs.height));
      ctx.putImageData(redoStack.pop(), 0, 0);
      refreshEditUndoButtons();
    };

    // overlay でのマウス操作
    overCvs.onmousedown = e => {
      if (e.button !== 0) return;
      const ta = document.getElementById('edit-text-overlay');
      if (ta.style.display !== 'none' && ta.value.trim()) confirmText();
      const { x, y } = getCanvasXY(e);
      drawing = true; startX = x; startY = y;
      if (currentTool === 'pen') {
        saveEditState();
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.strokeStyle = document.getElementById('et-color').value;
        ctx.lineWidth   = Number(document.getElementById('et-line-width').value);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      }
    };
    overCvs.onmousemove = e => {
      if (!drawing) return;
      const { x, y } = getCanvasXY(e);
      if (currentTool === 'pen') {
        ctx.lineTo(x, y); ctx.stroke();
        return;
      }
      if (['circle', 'rect', 'triangle', 'crop', 'text'].includes(currentTool)) {
        ovCtx.clearRect(0, 0, overCvs.width, overCvs.height);
        const color = document.getElementById('et-color').value;
        const lw    = Number(document.getElementById('et-line-width').value);
        const isDashed = currentTool === 'crop' || currentTool === 'text';
        ovCtx.strokeStyle = isDashed ? '#5ba3e8' : color;
        ovCtx.lineWidth   = isDashed ? 1 : lw;
        ovCtx.setLineDash(isDashed ? [4, 4] : []);
        const w = x - startX, h = y - startY;
        ovCtx.beginPath();
        if      (currentTool === 'circle')   { ovCtx.ellipse(startX + w / 2, startY + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI); }
        else if (currentTool === 'rect')     { ovCtx.rect(startX, startY, w, h); }
        else if (currentTool === 'triangle') { ovCtx.moveTo(startX + w / 2, startY); ovCtx.lineTo(startX + w, startY + h); ovCtx.lineTo(startX, startY + h); ovCtx.closePath(); }
        else if (currentTool === 'crop')     { ovCtx.rect(startX, startY, w, h); }
        else if (currentTool === 'text')     { ovCtx.rect(startX, startY, w, h); }
        ovCtx.stroke();
      }
    };
    overCvs.onmouseup = e => {
      if (!drawing) return;
      drawing = false;
      const { x, y } = getCanvasXY(e);
      if (currentTool === 'pen') { ctx.closePath(); return; }
      if (currentTool === 'crop') {
        cropRect = { x: Math.min(startX, x), y: Math.min(startY, y), w: Math.abs(x - startX), h: Math.abs(y - startY) };
        document.getElementById('et-crop-apply').disabled = (cropRect.w < 2 || cropRect.h < 2);
        return;
      }
      if (currentTool === 'text') {
        textRect = { x: Math.min(startX, x), y: Math.min(startY, y), w: Math.abs(x - startX), h: Math.abs(y - startY) };
        ovCtx.clearRect(0, 0, overCvs.width, overCvs.height);
        if (textRect.w < 10 || textRect.h < 10) return;
        const ta       = document.getElementById('edit-text-overlay');
        const wrapRect = dlg.querySelector('.edit-canvas-wrap').getBoundingClientRect();
        const cvRect   = editCvs.getBoundingClientRect();
        ta.style.left     = (cvRect.left - wrapRect.left + textRect.x * dispScale) + 'px';
        ta.style.top      = (cvRect.top  - wrapRect.top  + textRect.y * dispScale) + 'px';
        ta.style.width    = (textRect.w * dispScale) + 'px';
        ta.style.height   = (textRect.h * dispScale) + 'px';
        const fs = Number(document.getElementById('et-font-size').value);
        ta.style.fontSize   = (fs * dispScale) + 'px';
        ta.style.lineHeight = (fs * dispScale * 1.4) + 'px';
        ta.style.display = 'block'; ta.value = ''; ta.focus();
        return;
      }
      if (currentTool === 'num') {
        saveEditState();
        const numChar  = document.getElementById('et-num-select').value;
        const fontSize = Number(document.getElementById('et-font-size').value);
        ctx.font      = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = document.getElementById('et-color').value;
        ctx.fillText(numChar, x, y);
        ovCtx.clearRect(0, 0, overCvs.width, overCvs.height);
        return;
      }
      // 図形を確定描画
      saveEditState();
      const color = document.getElementById('et-color').value;
      const lw    = Number(document.getElementById('et-line-width').value);
      ctx.strokeStyle = color;
      ctx.fillStyle   = color + '44';
      ctx.lineWidth   = lw;
      ctx.setLineDash([]);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const w = x - startX, h = y - startY;
      ctx.beginPath();
      if      (currentTool === 'circle')   { ctx.ellipse(startX + w / 2, startY + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI); }
      else if (currentTool === 'rect')     { ctx.rect(startX, startY, w, h); }
      else if (currentTool === 'triangle') { ctx.moveTo(startX + w / 2, startY); ctx.lineTo(startX + w, startY + h); ctx.lineTo(startX, startY + h); ctx.closePath(); }
      ctx.fill(); ctx.stroke();
      ovCtx.clearRect(0, 0, overCvs.width, overCvs.height);
    };

    // テキスト確定：textarea の内容を canvas に描画
    function confirmText() {
      const ta   = document.getElementById('edit-text-overlay');
      const text = ta.value;
      ta.style.display = 'none'; ta.value = '';
      if (!text || !textRect) return;
      saveEditState();
      const fontSize = Number(document.getElementById('et-font-size').value);
      ctx.font      = `${fontSize}px sans-serif`;
      ctx.fillStyle = document.getElementById('et-color').value;
      const lineH = Math.round(fontSize * 1.4);
      let cy = textRect.y + fontSize;
      for (const line of text.split('\n')) {
        if (cy > textRect.y + textRect.h) break;
        ctx.fillText(line, textRect.x + 2, cy, textRect.w - 4);
        cy += lineH;
      }
      textRect = null;
    }

    const textOverlay = document.getElementById('edit-text-overlay');
    textOverlay.onkeydown = e => {
      if (e.key === 'Enter' && e.ctrlKey) { confirmText(); e.preventDefault(); }
      if (e.key === 'Escape') {
        textOverlay.style.display = 'none'; textOverlay.value = ''; textRect = null;
      }
    };

    // 切り抜き適用
    document.getElementById('et-crop-apply').onclick = () => {
      if (!cropRect || cropRect.w < 2 || cropRect.h < 2) return;
      saveEditState();
      const tmp = document.createElement('canvas');
      tmp.width  = Math.round(cropRect.w);
      tmp.height = Math.round(cropRect.h);
      tmp.getContext('2d').drawImage(editCvs, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, tmp.width, tmp.height);
      editCvs.width  = tmp.width;
      editCvs.height = tmp.height;
      overCvs.width  = tmp.width;
      overCvs.height = tmp.height;
      ctx.drawImage(tmp, 0, 0);
      cropRect = null;
      document.getElementById('et-crop-apply').disabled = true;
      ovCtx.clearRect(0, 0, overCvs.width, overCvs.height);
      positionEditorCanvas();
    };

    // キャンセル・確定
    document.getElementById('edit-cancel').onclick = () => { cleanupEditModal(); dlg.close(); };

    document.getElementById('edit-ok').onclick = () => {
      const newDataUrl = editCvs.toDataURL('image/png');
      elem.content = newDataUrl;
      const imgTag = domMap.get(elem.id)?.querySelector('img');
      if (imgTag) imgTag.src = newDataUrl;
      // 切り抜きでアスペクト比が変わった場合、高さも更新
      const newRatio = editCvs.width / editCvs.height;
      const oldRatio = elem.w / elem.h;
      if (Math.abs(newRatio - oldRatio) > 0.01) {
        elem.h = Math.round(elem.w / newRatio);
        syncDOM(elem.id);
      }
      scheduleSave();
      pushHistory();
      updateMinimap();
      cleanupEditModal(); dlg.close();
    };

    function cleanupEditModal() {
      overCvs.onmousedown = overCvs.onmousemove = overCvs.onmouseup = null;
      editCvs.onclick = null;
      overCvs.style.display = 'block';
      ['et-rot-l','et-rot-r','et-flip-h','et-flip-v','et-undo','et-redo','et-crop-apply','edit-cancel','edit-ok']
        .forEach(id => { const el = document.getElementById(id); if (el) el.onclick = null; });
      dlg.querySelectorAll('.edit-tool').forEach(b => { b.onclick = null; });
      const ta = document.getElementById('edit-text-overlay');
      ta.style.display = 'none'; ta.value = ''; ta.onkeydown = null;
      textRect = null;
      document.getElementById('et-num-select').style.display = 'none';
      undoStack = []; redoStack = [];
    }

    dlg.showModal();
  } catch (err) {
    flash("画像編集起動エラー: " + err.message);
    console.error(err);
  }
}

