## CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Quick Memo" — a Chrome Manifest V3 extension. There is no build step, no bundler, no package manager, and no test suite. Source files are loaded as-is by Chrome.

## Common commands

- **Load the extension**: open `chrome://extensions`, enable Developer Mode, "Load unpacked" → select this folder. After editing files, press the reload button on the extension card (or reopen the new tab) to pick up changes.
- **Regenerate icons**: `node generate-icons.js` — pure Node.js (uses only `zlib`); no `npm install` needed. Writes `icons/icon{16,48,128}.png`.
- There is no lint/test/build command; do not invent one.

## Architecture

The extension exposes **two independent surfaces, each with its own persistence layer**. They do not share data — editing one does not affect the other.

### 1. New Tab override (`newtab.html` / `newtab.css` / `newtab.js`)

Registered via `manifest.json` → `chrome_url_overrides.newtab`. This is the primary surface (manifest version 2.0.0).

- **Data model**: `elements: Array<{id, type, x, y, w, h, content}>` where `type` is `'text'` or `'image'`. Image `content` is a data-URL string (≤ 5 MB enforced by `MAX_IMG`).
- **Storage**: IndexedDB — DB `QuickMemoDB`, object store `canvas`, single key `'main'` holding the whole array JSON-stringified. `DB_VERSION = 3` (the comment notes the migration to "canvas mode"); bump it and handle `onupgradeneeded` if the schema changes.
- **DOM mirror**: `domMap: Map<id, HTMLElement>` is kept in sync with `elements`. Mutations go through `addElement` / `removeElement` / `syncDOM` so state and DOM never drift. Each element gets eight resize handles (`HANDLES = ['nw','n','ne','e','se','s','sw','w']`).
- **Interaction model**: a single delegated `mousedown`/`mousemove`/`mouseup` state machine on the canvas drives both drag (`dragState`) and resize (`resizeState`). Double-click on empty canvas creates a text box; double-click on a text element enters edit mode (`contentEditable`). Ctrl+V and drag-drop insert images via `insertImageFile`, which scales to fit `0.45 × canvasW` / `0.70 × canvasH` before adding.
- **Auto-save**: every mutating path calls `scheduleSave()` — a 600 ms debounced write of the whole array. The status pill in the footer reflects `saving` / `saved`.
- **Export**: TXT joins text elements with `\n\n---\n\n`. HTML emits a standalone absolutely-positioned document sized to `max(x+w)` / `max(y+h)`; image elements embed the data URL inline.

### 2. Toolbar popup (`popup.html` / `popup.css` / `popup.js`)

A single `<textarea>` memo. Note that the popup is **not registered in `manifest.json`** (no `action.default_popup`) — the toolbar icon currently opens the new-tab page instead. The popup files are still present and functional if reattached.

- **Storage**: `chrome.storage.local` under key `memoText` (300 ms debounced save). Completely separate from the new-tab IndexedDB.

### Icon generation (`generate-icons.js`)

A self-contained PNG encoder (CRC32 + IHDR/IDAT/IEND chunks via `zlib.deflateSync`). Drawing is per-pixel into an RGBA buffer — rounded rect background + three white horizontal lines. If you change icon visuals, edit `drawIcon()` and rerun the script; the generated PNGs are committed (see `.gitignore` comment).

## Conventions

- Plain ES2017+ vanilla JS, `'use strict'`, no modules, no framework, no TypeScript. Keep it that way unless the user asks otherwise.
- All comments and UI strings are in Japanese; match that style when editing existing files.
- The README's "ファイル構成" section is out of date (it lists only the popup files and omits `newtab.*`). If you touch the README, update it accordingly.
- When modifying the new-tab data shape, update `DB_VERSION` and the `onupgradeneeded` handler in `openDB()` — existing users have data persisted under the current schema.
