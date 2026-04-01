'use strict';

const memoArea   = document.getElementById('memo-area');
const charCount  = document.getElementById('char-count');
const saveStatus = document.getElementById('save-status');
const btnExport  = document.getElementById('btn-export');
const btnClear   = document.getElementById('btn-clear');

let saveTimer = null;

// ── 起動時：保存済みメモを読み込む ──────────────────────────
chrome.storage.local.get('memoText', (result) => {
  const text = result.memoText || '';
  memoArea.value = text;
  updateCharCount(text);
});

// ── 入力のたびに自動保存（300ms デバウンス） ──────────────────
memoArea.addEventListener('input', () => {
  const text = memoArea.value;
  updateCharCount(text);

  setSaveStatus('saving', '保存中...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ memoText: text }, () => {
      setSaveStatus('saved', '保存済み');
      setTimeout(() => setSaveStatus('', '保存済み'), 2000);
    });
  }, 300);
});

// ── エクスポート（.txt ダウンロード） ─────────────────────────
btnExport.addEventListener('click', () => {
  const text = memoArea.value;
  if (!text.trim()) {
    alert('メモが空です。');
    return;
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const now  = new Date();
  const pad  = (n) => String(n).padStart(2, '0');
  const filename = `memo_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

// ── クリア ─────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
  if (!memoArea.value.trim()) return;
  if (!confirm('メモをすべて削除しますか？\nこの操作は元に戻せません。')) return;

  memoArea.value = '';
  updateCharCount('');
  chrome.storage.local.set({ memoText: '' }, () => {
    setSaveStatus('saved', 'クリアしました');
    setTimeout(() => setSaveStatus('', '保存済み'), 2000);
  });
});

// ── ユーティリティ ─────────────────────────────────────────
function updateCharCount(text) {
  charCount.textContent = `${text.length.toLocaleString()} 文字`;
}

function setSaveStatus(cls, text) {
  saveStatus.className = 'save-status' + (cls ? ` ${cls}` : '');
  saveStatus.textContent = text;
}
