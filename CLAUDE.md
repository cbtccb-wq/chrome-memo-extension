# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

"Quick Memo" is a Chrome Extension (Manifest V3) that replaces the new tab page with a freeform canvas memo board. There is no build system — all files are plain HTML/CSS/JS loaded directly by Chrome.

## Development Workflow

**Loading the extension in Chrome:**
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. After editing any file, click the reload button on `chrome://extensions` or press `R` there, then open a new tab

**Regenerating icons** (only needed if icon design changes):
```bash
node generate-icons.js
```
This script has no npm dependencies — it uses only Node.js built-ins (`fs`, `path`, `zlib`).

There is no linter, test runner, or build step.

## Architecture

### Two Separate UIs

The extension has two distinct interfaces that share no code and use different storage backends:

| File | Purpose | Storage |
|------|---------|---------|
| `newtab.html/js/css` | Replaces the new tab page; freeform canvas board | IndexedDB (`QuickMemoDB`) |
| `popup.html/js/css` | Simple textarea memo | `chrome.storage.local` |

**Important:** `popup.html` is not wired up in `manifest.json` — the `action` field has no `default_popup`. The popup files exist but are not currently accessible from the extension toolbar. The manifest also lacks a `permissions` field, meaning `chrome.storage.local` (used in `popup.js`) is undeclared; if the popup is ever re-enabled, `"storage"` must be added to `permissions`.

### New Tab Canvas (`newtab.js`)

The core data model is an in-memory array `elements[]` where each entry has the shape:
```js
{ id, type, x, y, w, h, content }
// type: 'text' | 'image'
// content: string for text, base64 data URL for images
```

A parallel `domMap` (Map from id → DOM element) keeps the DOM in sync. The pattern throughout is:
1. Mutate `elements[]` directly
2. Call `syncDOM(id)` to push position/size changes to the DOM
3. Call `scheduleSave()` to debounce-persist to IndexedDB (600 ms delay)

**Element lifecycle:** `addElement()` → `mountDOM()` → `buildElement()` creates the DOM node with 8 resize handles (`.rh-nw`, `.rh-n`, etc.) and attaches it to `#canvas`. `removeElement()` → `unmountDOM()` cleans both arrays.

**Interaction state machines:**
- `dragState` — set on `mousedown` on a `.memo-el`, cleared on `mouseup`; `hasMoved` distinguishes click from drag to avoid triggering edit mode
- `resizeState` — set on `mousedown` on a `.rh` handle, stores start geometry for delta calculations
- `editingId` — tracks which text element has `contentEditable = 'true'`; `Escape` or clicking away calls `stopEditing()` which also snapshots the element height

**Image handling:** Images are read as data URLs via `FileReader`, capped at 5 MB, and scaled to fit within 45% of canvas width / 70% of canvas height before insertion. They are stored in full as base64 in IndexedDB.

**Export:** TXT export joins all text element contents; HTML export serialises every element with absolute `position:absolute` inline styles, embedding images as data URLs.

### IndexedDB Schema

- DB name: `QuickMemoDB`, version `3`
- Single object store: `canvas`
- Single record key: `'main'`
- Value: JSON-stringified `elements[]`
