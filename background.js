'use strict';

// ツールバーの拡張機能アイコンをクリックした際に新しいタブを開く
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({});
});
