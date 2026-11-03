/**
 * dsh-btw — client half (browser bundle).
 *
 * One button in `conversation.input.right`, one floating window in
 * `shell.overlay` (DSH's only frame-wide floating layer). The window can be
 * dragged by its header and resized from its right/bottom edges and bottom-right
 * corner; its last geometry is remembered in localStorage. The dialog keeps its
 * turns in a module-level store and streams answers from the host half's
 * `/btw/ask` SSE route; nothing here touches the conversation transcript.
 *
 * B scope: a context bar (range + snapshot stats + refresh) previews what the
 * host would send before asking; the SSE `meta` frame repeats it so a range
 * changed at send time cannot make the badge lie. Cold (persisted, not open)
 * conversations are read from the log by the host.
 * TODO(C): model picker + usage display + settings panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-btw-plugin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    let React = null
    try { React = require('react') } catch { React = null }
    if (!React || typeof React.createElement !== 'function') {
      // No shell React: the plugin cannot render anything, but keeping the
      // factory valid avoids breaking the boot graph.
      exports.apply = function noop() {}
      exports.inject = []
      return module.exports
    }
    const h = React.createElement

    // Debug marker: lets you confirm from DevTools which build the shell loaded.
    //   __DSH_BTW__  -> { version, loadedAt }
    try { window.__DSH_BTW__ = { version: '0.5.5', loadedAt: Date.now() } } catch { /* ignore */ }

    /* ----------------------------------------------- optional shell extras */

    // Shared shell primitives are resolved LAZILY: activation must not touch a
    // shared module at all, so a broken/missing optional dependency can never
    // poison boot-time module evaluation for other plugins.
    let primitivesCache
    let primitivesResolved = false
    function primitivesOf() {
      if (!primitivesResolved) {
        primitivesResolved = true
        try { primitivesCache = require('@deepseek-ai/dsh-client-ui-primitives') } catch { primitivesCache = null }
      }
      return primitivesCache
    }
    const MD_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
      },
      footnotes: '',
    }

    /* ------------------------------------------------------------- styles */

    const CSS = `
      .btw-trigger {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 34px; height: 26px; padding: 0 8px; border-radius: 7px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        background: transparent; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .02em;
        cursor: pointer; line-height: 1;
      }
      .btw-trigger:hover {
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        border-color: var(--dsw-alias-border-l3, rgba(127,127,127,.6));
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
      }

      /* frame-wide click-through layer; only the window itself takes input */
      .btw-layer {
        position: fixed; inset: 0; z-index: 60; pointer-events: none;
      }
      .btw-window {
        position: fixed; display: flex; flex-direction: column;
        min-width: 420px; min-height: 300px; pointer-events: auto;
        border-radius: 12px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-2, light-dark(#ffffff, #26282c));
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
        box-shadow: 0 18px 60px light-dark(rgba(15, 23, 42, .18), rgba(0, 0, 0, .5));
      }
      .btw-head {
        flex: 0 0 auto; display: flex; align-items: flex-start; gap: 10px;
        padding: 10px 12px 8px;
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
        cursor: grab; user-select: none; touch-action: none;
      }
      .btw-window.is-dragging .btw-head { cursor: grabbing; }
      .btw-head-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .btw-title { font-size: 13px; font-weight: 600; }
      .btw-head-hint { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6)); }
      .btw-close {
        flex: 0 0 auto; border: 0; background: transparent; cursor: pointer;
        color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px;
      }
      .btw-close:hover { background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.2)); color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); }

      .btw-list {
        flex: 1 1 auto; min-height: 0; overflow-y: auto;
        display: flex; flex-direction: column; gap: 8px; padding: 10px 14px;
      }
      .btw-empty {
        color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6)); font-size: 12px; line-height: 1.6;
        padding: 12px 10px; border: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        border-radius: 8px;
      }
      .btw-msg { padding: 8px 10px; border-radius: 8px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
      .btw-msg-user { align-self: flex-end; max-width: 88%; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16)); }
      .btw-msg-assistant { align-self: stretch; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); }
      .btw-msg-assistant.is-error { border-color: var(--dsw-alias-state-error-primary, rgba(255,110,110,.5)); }
      .btw-msg-error { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #ff8a8a); }
      .btw-msg-streaming::after { content: '●'; margin-left: 2px; opacity: .7; animation: btw-blink 1s steps(1) infinite; }
      @keyframes btw-blink { 50% { opacity: 0; } }

      .btw-compose {
        flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
        background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02));
      }
      .btw-input-row { display: flex; gap: 8px; align-items: flex-end; }
      .btw-input {
        flex: 1 1 auto; resize: none; min-height: 46px; max-height: 160px;
        padding: 8px 10px; border-radius: 8px; font: inherit; font-size: 13px; line-height: 1.5;
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.04));
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        outline: none;
      }
      .btw-input:focus { border-color: var(--dsw-alias-border-l3, rgba(127,127,127,.7)); }
      .btw-input::placeholder, .btw-transfer-text::placeholder {
        color: var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96));
        opacity: 1;
      }
      .btw-btn {
        flex: 0 0 auto; height: 34px; padding: 0 14px; border-radius: 8px; font: inherit; font-size: 12px;
        cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
      }
      .btw-btn:disabled { opacity: .45; cursor: default; }
      .btw-btn-primary { background: var(--dsw-alias-label-primary-bluish, light-dark(#2563c9, #4c8dff)); border-color: transparent; color: #fff; }
      .btw-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6)); line-height: 1.5; }

      /* 送入主会话: header action + review panel */
      .btw-transfer-btn {
        flex: 0 0 auto; height: 24px; padding: 0 10px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-label-primary-bluish, light-dark(#2563c9, #4c8dff));
        background: transparent; color: var(--dsw-alias-label-primary-bluish, light-dark(#2563c9, #4c8dff));
        font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;
      }
      .btw-transfer-btn:hover:not(:disabled) { background: light-dark(rgba(37, 99, 201, .10), rgba(76, 141, 255, .12)); }
      .btw-transfer-btn:disabled { opacity: .4; cursor: default; }
      .btw-transfer-btn.is-sent {
        border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        color: var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96));
      }
      .btw-transfer-panel {
        flex: 1 1 auto; min-height: 0; overflow-y: auto;
        display: flex; flex-direction: column; gap: 10px; padding: 12px 14px;
      }
      .btw-transfer-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .btw-transfer-title { font-size: 13px; color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); }
      .btw-transfer-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96)); }
      .btw-transfer-loading {
        flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
        font-size: 12px; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
      }
      .btw-transfer-text {
        flex: 1 1 auto; min-height: 180px; width: 100%; resize: none;
        padding: 10px; border-radius: 8px; font: inherit; font-size: 12.5px; line-height: 1.6;
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.04));
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        outline: none; white-space: pre-wrap;
      }
      .btw-transfer-text:focus { border-color: var(--dsw-alias-border-l3, rgba(127,127,127,.7)); }
      .btw-transfer-note { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6)); }
      .btw-transfer-warn { font-size: 11px; line-height: 1.5; color: light-dark(#8a5a00, #d8a14a); }
      .btw-transfer-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary, #ff8a8a); }
      .btw-transfer-ok { font-size: 12px; line-height: 1.5; color: light-dark(#1a7f37, #58c07a); }
      .btw-transfer-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
      .btw-transfer-foot .btw-grow { flex: 1 1 auto; }

      /* assistant body: shared markdown renderer, with a plain-text fallback */
      .btw-msg-assistant { white-space: normal; }
      .btw-msg-body { font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
      .btw-msg-body > :first-child { margin-top: 0; }
      .btw-msg-body > :last-child { margin-bottom: 0; }
      .btw-msg-body p { margin: 0 0 8px; }
      .btw-msg-body ul, .btw-msg-body ol { margin: 0 0 8px; padding-left: 20px; }
      .btw-msg-body li { margin: 2px 0; }
      .btw-msg-body h1, .btw-msg-body h2, .btw-msg-body h3, .btw-msg-body h4 {
        margin: 12px 0 6px; font-size: 14px; line-height: 1.4;
      }
      .btw-msg-body h1 { font-size: 16px; }
      .btw-msg-body code {
        font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
        font-size: 12px;
      }
      .btw-msg-body pre {
        margin: 8px 0; padding: 8px 10px; border-radius: 6px; overflow: auto;
        background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, .25));
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .22));
      }
      .btw-msg-body pre code { font-size: 12px; }
      .btw-msg-body a { color: var(--dsw-alias-label-primary-bluish, #6cb0ff); text-decoration: none; }
      .btw-msg-body a:hover { text-decoration: underline; }
      .btw-msg-body blockquote {
        margin: 0 0 8px; padding-left: 10px;
        border-left: 2px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, .6));
        color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
      }
      .btw-msg-body table { border-collapse: collapse; margin: 0 0 8px; font-size: 12px; }
      .btw-msg-body th, .btw-msg-body td {
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .3));
        padding: 4px 8px; text-align: left;
      }
      .btw-msg-body hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .25)); margin: 10px 0; }
      .btw-plain { white-space: pre-wrap; }

      .btw-actions { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
      .btw-action {
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .35));
        background: transparent; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        border-radius: 5px; font: inherit; font-size: 11px; line-height: 1; padding: 4px 7px; cursor: pointer;
      }
      .btw-action:hover {
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .12));
      }
      .btw-meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6)); }

      /* context bar: range selector + snapshot stats + refresh */
      .btw-context {
        flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
        padding: 6px 12px; font-size: 11px; line-height: 1.4;
        color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .18));
        background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, .02));
      }
      .btw-select {
        flex: 0 0 auto; height: 24px; max-width: 186px; padding: 0 6px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .35));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .14));
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); font: inherit; font-size: 11px; outline: none;
      }
      .btw-ctx-stats {
        flex: 1 1 auto; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .btw-ctx-stats.is-error { color: var(--dsw-alias-state-error-primary, #ff8a8a); }
      .btw-refresh {
        flex: 0 0 auto;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .35));
        background: transparent; color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        border-radius: 5px; font: inherit; font-size: 11px; line-height: 1; padding: 4px 7px; cursor: pointer;
      }
      .btw-refresh:hover {
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .12));
      }
      .btw-refresh:disabled { opacity: .5; cursor: default; }
      .btw-model { max-width: 214px; }
      .btw-custom { gap: 6px; }
      .btw-custom-input {
        flex: 1 1 0; min-width: 0; height: 24px; padding: 0 6px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .35));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .14));
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); font: inherit; font-size: 11px; outline: none;
      }
      .btw-gear { font-size: 13px; line-height: 1; padding: 2px 6px; }
      .btw-gear.is-active {
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed));
        border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, .6));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .14));
      }

      /* focus: a text selection carried with the ask */
      .btw-focus {
        flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
        padding: 5px 12px; font-size: 11px; line-height: 1.4;
        color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .18));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .08));
      }
      .btw-focus-label { flex: 0 0 auto; font-weight: 600; color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); }
      .btw-focus-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .btw-focus-clear {
        flex: 0 0 auto; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96));
        font: inherit; font-size: 14px; line-height: 1; cursor: pointer; padding: 0 2px;
      }
      .btw-focus-clear:hover { color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); }

      /* C tier: per-call settings popover */
      .btw-settings {
        flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
        padding: 8px 12px; font-size: 11px; line-height: 1.4;
        color: var(--dsw-alias-label-secondary, light-dark(#475467, #9aa0a6));
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .18));
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .06));
      }
      .btw-field { display: flex; align-items: center; gap: 6px; }
      .btw-field input[type="number"], .btw-field select {
        height: 24px; padding: 0 6px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .35));
        background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, .12));
        color: var(--dsw-alias-label-primary, light-dark(#1f2328, #e8eaed)); font: inherit; font-size: 11px; outline: none;
      }
      .btw-field input[type="number"] { width: 78px; }
      .btw-field-wide { flex: 1 1 100%; }
      .btw-settings-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .btw-settings-note { font-size: 10px; color: var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96)); }

      /* resize handles: right edge, bottom edge, bottom-right corner */
      .btw-resize { position: absolute; touch-action: none; }
      .btw-resize-e { top: 48px; right: 0; bottom: 14px; width: 6px; cursor: ew-resize; }
      .btw-resize-s { left: 14px; right: 14px; bottom: 0; height: 6px; cursor: ns-resize; }
      .btw-resize-se {
        right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;
        background:
          linear-gradient(135deg, transparent 0 45%, var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96)) 45% 52%, transparent 52% 64%, var(--dsw-alias-label-tertiary, light-dark(#667085, #8b8f96)) 64% 71%, transparent 71%);
        opacity: .75;
      }
      .btw-resize-se:hover { opacity: 1; }
    `

    function installStyles() {
      try {
        let style = document.getElementById('dsh-btw-css')
        if (!style) {
          style = document.createElement('style')
          style.id = 'dsh-btw-css'
          ;(document.head || document.documentElement).appendChild(style)
        }
        style.textContent = CSS
      } catch { /* SSR / test environments have no document */ }
    }

    /* ---------------------------------------------------- window geometry */

    const WIN_KEY = 'dsh-btw:window'
    const MIN_W = 420
    const MIN_H = 300

    function viewport() {
      try {
        return {
          w: Math.max(640, window.innerWidth || 1280),
          h: Math.max(480, window.innerHeight || 860),
        }
      } catch {
        return { w: 1280, h: 860 }
      }
    }

    function clampGeometry(geometry) {
      const vp = viewport()
      const maxW = Math.max(MIN_W, vp.w - 16)
      const maxH = Math.max(MIN_H, vp.h - 16)
      const w = Math.min(Math.max(Math.round(geometry.w), MIN_W), maxW)
      const height = Math.min(Math.max(Math.round(geometry.h), MIN_H), maxH)
      const x = Math.min(Math.max(Math.round(geometry.x), 8), Math.max(8, vp.w - w - 8))
      const y = Math.min(Math.max(Math.round(geometry.y), 8), Math.max(8, vp.h - height - 8))
      return { x, y, w, h: height }
    }

    function loadSavedGeometry() {
      try {
        const raw = window.localStorage.getItem(WIN_KEY)
        if (!raw) return null
        const value = JSON.parse(raw)
        if (!value || typeof value !== 'object') return null
        if (![value.x, value.y, value.w, value.h].every(number => typeof number === 'number' && Number.isFinite(number))) return null
        return value
      } catch {
        return null
      }
    }

    function saveGeometry(geometry) {
      try {
        window.localStorage.setItem(WIN_KEY, JSON.stringify(geometry))
      } catch { /* storage may be disabled */ }
    }

    function initialGeometry() {
      const saved = loadSavedGeometry()
      if (saved) return clampGeometry(saved)
      const vp = viewport()
      const w = Math.min(760, Math.max(MIN_W, vp.w - 120))
      const height = Math.min(600, Math.max(MIN_H, vp.h - 180))
      return clampGeometry({
        x: Math.round((vp.w - w) / 2),
        y: Math.max(48, Math.round((vp.h - height) / 3)),
        w,
        h: height,
      })
    }

    /* --------------------------------------------------------------- range */

    // Mirrors the host's normaliseRange(): the value lives in localStorage and
    // is sent as-is; the host always re-validates it.
    const RANGE_KEY = 'dsh-btw:range'
    // Optional entry point: the composer button can be hidden (the `/btw`
    // command stays available either way). localStorage['dsh-btw:button']='0'.
    const BUTTON_KEY = 'dsh-btw:button'
    const MODEL_KEY = 'dsh-btw:model'
    const SETTINGS_KEY = 'dsh-btw:settings'

    function buttonVisible() {
      try { return window.localStorage.getItem(BUTTON_KEY) !== '0' } catch { return true }
    }

    function loadJson(key) {
      try { return JSON.parse(window.localStorage.getItem(key) || 'null') } catch { return null }
    }

    function saveJson(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage may be disabled */ }
    }

    function loadModel() {
      const raw = loadJson(MODEL_KEY)
      return raw && typeof raw.provider === 'string' && typeof raw.model === 'string' && raw.provider && raw.model
        ? { provider: raw.provider, model: raw.model }
        : null
    }

    function loadSettings() {
      const raw = loadJson(SETTINGS_KEY)
      const value = raw && typeof raw === 'object' ? raw : {}
      return {
        temperature: typeof value.temperature === 'number' && value.temperature >= 0 && value.temperature <= 2
          ? value.temperature : null,
        maxTokens: Number.isInteger(value.maxTokens) && value.maxTokens > 0 ? value.maxTokens : null,
        reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
      }
    }

    const REASONING_OPTIONS = [
      { value: '', label: '推理强度：默认' },
      { value: 'none', label: '推理强度：none' },
      { value: 'low', label: '推理强度：low' },
      { value: 'medium', label: '推理强度：medium' },
      { value: 'high', label: '推理强度：high' },
      { value: 'max', label: '推理强度：max' },
    ]

    const RANGE_OPTIONS = [
      { value: 'auto', label: '自动（最近对话）', mode: 'auto', recentMessages: 0 },
      { value: 'recent:40', label: '最近 40 条', mode: 'recent', recentMessages: 40 },
      { value: 'recent:120', label: '最近 120 条', mode: 'recent', recentMessages: 120 },
      { value: 'all', label: '全部历史', mode: 'all', recentMessages: 0 },
      { value: 'no-tools', label: '全部 · 不含工具输出', mode: 'no-tools', recentMessages: 0 },
    ]

    function rangePayload(value) {
      const found = RANGE_OPTIONS.find((option) => option.value === value)
      return found ? { mode: found.mode, recentMessages: found.recentMessages } : { mode: 'auto' }
    }

    function loadRange() {
      try {
        const raw = window.localStorage.getItem(RANGE_KEY)
        return RANGE_OPTIONS.some((option) => option.value === raw) ? raw : 'auto'
      } catch {
        return 'auto'
      }
    }

    function saveRange(value) {
      try { window.localStorage.setItem(RANGE_KEY, value) } catch { /* storage may be disabled */ }
    }

    /* --------------------------------------------------------------- focus */

    const FOCUS_MAX_CHARS = 2000

    /**
     * Read the current text selection. Returns null for a missing or trivial
     * selection.
     */
    function readSelection() {
      try {
        const selection = window.getSelection ? window.getSelection() : null
        const text = String(selection ? selection.toString() : '').trim()
        if (text.length < 2) return null
        return { kind: 'selection', text: text.slice(0, FOCUS_MAX_CHARS) }
      } catch {
        return null
      }
    }

    // Chromium can clear the document selection before a click handler runs
    // (focus moves to the button). Keep the last real selection around briefly
    // so the button can still quote it.
    const lastSelection = { focus: null, at: 0 }

    function rememberSelection() {
      const focus = readSelection()
      if (!focus) return
      lastSelection.focus = focus
      lastSelection.at = Date.now()
    }

    /** Current selection, or one made within the last few seconds. */
    function captureSelection() {
      const focus = readSelection()
      if (focus) {
        lastSelection.focus = focus
        lastSelection.at = Date.now()
        return focus
      }
      if (lastSelection.focus && Date.now() - lastSelection.at < 5000) {
        return { kind: 'selection', text: lastSelection.focus.text }
      }
      return null
    }

    /** Quote block inlined into the request (the host keeps the dialog private). */
    function focusPreamble(focus) {
      if (!focus || typeof focus !== 'object' || typeof focus.text !== 'string') return ''
      const text = focus.text.trim()
      if (text === '') return ''
      return [
        '[btw] 用户正在针对用户选中的文本提问，引用如下：',
        '"""',
        text.slice(0, FOCUS_MAX_CHARS),
        '"""',
        '请优先解释或回答与此段内容相关的问题；如果会话快照不足以回答，请明确说明。',
      ].join('\n')
    }

    function clearFocus() {
      if (!state.focus) return
      state.focus = null
      emit()
    }

    function focusPreview(focus) {
      if (!focus || typeof focus.text !== 'string') return ''
      return focus.text.length > 120 ? `${focus.text.slice(0, 120)}…` : focus.text
    }

    /* -------------------------------------------------------------- store */

    const state = {
      open: false,
      sessionId: null,
      // Session whose composer button is currently mounted. A dialog opened in
      // another session is hidden while this differs (its conversation is stashed).
      activeSession: null,
      // Per-session stashed conversations: switching away hides the dialog but
      // keeps its messages here, so switching back can restore them.
      stash: new Map(),
      messages: [],
      streaming: false,
      abort: null,
      win: null,
      prevWin: null,
      // "送入主会话": the review panel, its generated text and write status.
      transferOpen: false,
      transferPhase: 'idle', // idle | loading | ready | sending | sent | error
      transferText: '',
      transferError: null,
      transferWarning: null,
      transferUsage: null,
      transferTurns: 0,
      transferAbort: null,
      sentSignature: '',
      // Optional quoted selection: `{ kind: 'selection', text }`, captured from
      // the composer button or the /btw command, inlined into the question.
      focus: null,
      rangeValue: loadRange(),
      // What /btw/context (or the SSE meta frame) last reported for this ask.
      context: { loading: false, stats: null, dropped: 0, cold: false, error: null },
      contextRequest: 0,
      // C-tier: per-dialog model pick and one-off call settings.
      model: loadModel(),
      models: { loading: false, providers: [], default: null, current: null, error: null },
      customOpen: false,
      customDraft: { provider: '', model: '' },
      settings: loadSettings(),
      settingsOpen: false,
    }
    const listeners = new Set()

    function emit() {
      for (const listener of Array.from(listeners)) {
        try { listener() } catch { /* a broken subscriber must not break the store */ }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /* One dialog at a time, but its conversation survives session switches:
     * switching away hides the window and stashes its messages; switching back
     * restores them. Only the close button (×) clears a conversation. */

    function snapshotDialog() {
      return {
        messages: state.messages,
        focus: state.focus,
        rangeValue: state.rangeValue,
        context: state.context,
        win: state.win,
        prevWin: state.prevWin,
        transferOpen: state.transferOpen,
        transferPhase: state.transferPhase,
        transferText: state.transferText,
        transferError: state.transferError,
        transferWarning: state.transferWarning,
        transferUsage: state.transferUsage,
        transferTurns: state.transferTurns,
        sentSignature: state.sentSignature,
      }
    }

    function blankTransfer() {
      return {
        transferOpen: false,
        transferPhase: 'idle',
        transferText: '',
        transferError: null,
        transferWarning: null,
        transferUsage: null,
        transferTurns: 0,
        transferAbort: null,
      }
    }

    function resetVisibleDialog() {
      Object.assign(state, {
        open: false,
        sessionId: null,
        messages: [],
        streaming: false,
        abort: null,
        focus: null,
        context: { loading: false, stats: null, dropped: 0, cold: false, error: null },
        settingsOpen: false,
        ...blankTransfer(),
      })
    }

    function stashDialog() {
      if (!state.open || !state.sessionId) return
      abortCurrent()
      if (state.transferAbort) {
        try { state.transferAbort.abort() } catch { /* already finished */ }
        state.transferAbort = null
      }
      // A summary request cannot outlive the visible dialog; a write may have
      // reached the host already, so say so instead of pretending it failed.
      if (state.transferPhase === 'loading') {
        state.transferPhase = 'idle'
        state.transferOpen = false
      } else if (state.transferPhase === 'sending') {
        state.transferPhase = 'error'
        state.transferError = '已切换会话，写入结果未知；切回后可重新送入（可能重复）'
      }
      state.streaming = false
      state.abort = null
      const last = state.messages[state.messages.length - 1]
      if (last && last.role === 'assistant' && last.state === 'streaming') {
        last.state = 'done'
        if (!last.text) last.text = '（已切换会话，已停止）'
      }
      state.stash.set(state.sessionId, snapshotDialog())
    }

    function restoreDialog(sessionId) {
      const saved = state.stash.get(sessionId)
      if (!saved) return false
      state.stash.delete(sessionId)
      Object.assign(state, {
        open: true,
        sessionId,
        messages: saved.messages,
        streaming: false,
        abort: null,
        focus: saved.focus || null,
        rangeValue: saved.rangeValue || loadRange(),
        context: saved.context || { loading: false, stats: null, dropped: 0, cold: false, error: null },
        win: saved.win || state.win || initialGeometry(),
        prevWin: saved.prevWin || null,
        settingsOpen: false,
        transferOpen: saved.transferOpen === true,
        transferPhase: saved.transferPhase || 'idle',
        transferText: saved.transferText || '',
        transferError: saved.transferError || null,
        transferWarning: saved.transferWarning || null,
        transferUsage: saved.transferUsage || null,
        transferTurns: saved.transferTurns || 0,
        transferAbort: null,
        sentSignature: saved.sentSignature || '',
      })
      emit()
      refreshContext()
      return true
    }

    function openFor(sessionId, focus = null) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (state.open && state.sessionId === sessionId) return
      // The dialog belongs to another session: stash that conversation for
      // when the user switches back, then open this session's own dialog.
      if (state.open) stashDialog()
      if (restoreDialog(sessionId)) {
        if (focus && typeof focus === 'object') state.focus = focus
        emit()
        return
      }
      abortCurrent()
      Object.assign(state, {
        open: true,
        sessionId,
        messages: [],
        streaming: false,
        abort: null,
        win: state.win || initialGeometry(),
        prevWin: null,
        focus: focus && typeof focus === 'object' ? focus : null,
        context: { loading: true, stats: null, dropped: 0, cold: false, error: null },
        settingsOpen: false,
        ...blankTransfer(),
      })
      emit()
      refreshContext()
      loadModels()
    }

    function close() {
      // Explicit close is the only thing that forgets a conversation.
      if (state.sessionId) state.stash.delete(state.sessionId)
      abortCurrent()
      if (state.transferAbort) {
        try { state.transferAbort.abort() } catch { /* already finished */ }
      }
      Object.assign(state, {
        open: false,
        sessionId: null,
        messages: [],
        streaming: false,
        abort: null,
        win: null,
        prevWin: null,
        focus: null,
        context: { loading: false, stats: null, dropped: 0, cold: false, error: null },
        settingsOpen: false,
        ...blankTransfer(),
      })
      emit()
    }

    /** Hide a dialog opened from another session; restore it on return. */
    function noteActiveSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (state.activeSession === sessionId) return
      state.activeSession = sessionId
      if (state.open && state.sessionId && state.sessionId !== sessionId) {
        stashDialog()
        resetVisibleDialog()
      }
      if (!state.open) restoreDialog(sessionId)
      emit()
    }

    /** A stable fingerprint of the finished dialog, used to prevent double sends. */
    function dialogSignature() {
      let hash = 2166136261
      for (const message of state.messages) {
        const line = `${message.role}:${typeof message.text === 'string' ? message.text : ''}\n`
        for (let index = 0; index < line.length; index += 1) {
          hash ^= line.charCodeAt(index)
          hash = Math.imul(hash, 16777619)
        }
      }
      return (hash >>> 0).toString(36)
    }

    function canTransfer() {
      return !state.streaming && state.messages.some((message) => message.role === 'assistant'
        && message.state === 'done' && typeof message.text === 'string' && message.text.trim() !== '')
    }

    function dialogTranscript() {
      return state.messages
        .filter((message) => (message.role === 'user' || message.role === 'assistant')
          && typeof message.text === 'string' && message.text.trim() !== '' && message.state !== 'streaming')
        .map((message) => ({ role: message.role, text: message.text }))
    }

    function openTransfer() {
      if (!state.open || !state.sessionId || state.streaming || !canTransfer()) return
      const transcript = dialogTranscript()
      Object.assign(state, {
        transferOpen: true,
        transferPhase: 'loading',
        transferText: '',
        transferError: null,
        transferWarning: null,
        transferUsage: null,
        transferTurns: transcript.filter((message) => message.role === 'user').length,
      })
      emit()
      summarizeTransfer(transcript)
    }

    function closeTransfer() {
      if (state.transferAbort) {
        try { state.transferAbort.abort() } catch { /* already finished */ }
        state.transferAbort = null
      }
      Object.assign(state, blankTransfer())
      emit()
    }

    function updateTransferText(text) {
      state.transferText = text
      if (state.transferPhase === 'sent') state.transferPhase = 'ready'
      if (state.transferError) state.transferError = null
      emit()
    }

    async function postJson(path, payload, signal) {
      let response
      try {
        response = await fetch(apiUrl(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        throw new Error('无法连接 btw 服务（host 路由未就绪？）')
      }
      let body = null
      try { body = await response.json() } catch { /* non-JSON error body */ }
      if (!response.ok) {
        const message = body && body.error && typeof body.error.message === 'string'
          ? body.error.message
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body || {}
    }

    async function summarizeTransfer(transcript) {
      const sessionId = state.sessionId
      const controller = new AbortController()
      state.transferAbort = controller
      try {
        const payload = {
          sessionId,
          messages: transcript,
          focus: state.focus && typeof state.focus.text === 'string' ? { text: state.focus.text } : null,
        }
        if (state.model && typeof state.model.provider === 'string' && typeof state.model.model === 'string') {
          payload.provider = state.model.provider
          payload.model = state.model.model
        }
        const body = await postJson('btw/summarize', payload, controller.signal)
        if (state.sessionId !== sessionId || !state.transferOpen) return
        const summary = typeof body.summary === 'string' ? body.summary : ''
        if (summary.trim() === '') throw new Error('摘要为空')
        state.transferText = summary
        state.transferPhase = 'ready'
        state.transferWarning = typeof body.warning === 'string' ? body.warning : null
        state.transferUsage = body.usage || null
      } catch (error) {
        if (controller.signal.aborted) return
        if (state.sessionId !== sessionId || !state.transferOpen) return
        state.transferPhase = 'error'
        state.transferError = errorText(error)
      } finally {
        if (state.transferAbort === controller) state.transferAbort = null
        if (state.sessionId === sessionId) emit()
      }
    }

    async function commitTransfer() {
      const text = state.transferText.trim()
      if (!text || !state.sessionId || state.transferPhase === 'loading' || state.transferPhase === 'sending') return
      const sessionId = state.sessionId
      state.transferPhase = 'sending'
      state.transferError = null
      emit()
      try {
        await postJson('btw/commit', {
          sessionId,
          summary: text,
          turns: state.transferTurns,
          focus: !!state.focus,
          at: new Date().toISOString(),
        })
        if (state.sessionId !== sessionId) return
        state.transferPhase = 'sent'
        state.transferError = null
        state.sentSignature = dialogSignature()
      } catch (error) {
        if (state.sessionId !== sessionId) return
        state.transferPhase = 'error'
        state.transferError = errorText(error)
      } finally {
        if (state.sessionId === sessionId) emit()
      }
    }

    /** Double-click the title bar: fill the viewport, or restore. */
    function toggleMaximize() {
      if (!state.win) return
      if (state.prevWin) {
        state.win = clampGeometry(state.prevWin)
        state.prevWin = null
      } else {
        const vp = viewport()
        state.prevWin = state.win
        state.win = clampGeometry({ x: 12, y: 12, w: vp.w - 24, h: vp.h - 24 })
      }
      emit()
      commitWindow()
    }

    function abortCurrent() {
      if (state.abort) {
        try { state.abort.abort() } catch { /* ignore */ }
      }
    }

    function stop() {
      abortCurrent()
      state.streaming = false
      state.abort = null
      const last = state.messages[state.messages.length - 1]
      if (last && last.role === 'assistant' && last.state === 'streaming') {
        last.state = 'done'
        if (!last.text) last.text = '（已停止）'
      }
      emit()
    }

    function setWindow(geometry) {
      if (!state.win) return
      state.win = clampGeometry({ ...state.win, ...geometry })
      emit()
    }

    function commitWindow() {
      if (state.win) saveGeometry(state.prevWin || state.win)
    }

    function refitWindow() {
      if (!state.win) return
      state.win = clampGeometry(state.win)
      emit()
      saveGeometry(state.prevWin || state.win)
    }

    /* -------------------------------------------------------- context preview */

    async function fetchContext(sessionId, rangeValue) {
      let response
      try {
        response = await fetch(apiUrl('btw/context'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, range: rangePayload(rangeValue) }),
        })
      } catch {
        throw new Error('无法连接 btw 服务（host 路由未就绪？）')
      }
      let body = null
      try { body = await response.json() } catch { body = null }
      if (!response.ok) {
        const detail = body && body.error && typeof body.error.message === 'string' && body.error.message
          ? body.error.message
          : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return body || {}
    }

    /** Ask the host how much history the selected range would send. */
    async function refreshContext() {
      const sessionId = state.sessionId
      if (!sessionId) return
      const requestId = state.contextRequest + 1
      state.contextRequest = requestId
      state.context = { ...state.context, loading: true, error: null }
      emit()
      try {
        const data = await fetchContext(sessionId, state.rangeValue)
        if (state.sessionId !== sessionId || state.contextRequest !== requestId) return
        state.context = {
          loading: false,
          stats: data.stats || null,
          dropped: Number.isFinite(data.dropped) ? data.dropped : 0,
          cold: data.cold === true,
          error: null,
        }
      } catch (error) {
        if (state.sessionId !== sessionId || state.contextRequest !== requestId) return
        state.context = { loading: false, stats: null, dropped: 0, cold: false, error: errorText(error) }
      }
      emit()
    }

    function setRangeValue(value) {
      if (!RANGE_OPTIONS.some((option) => option.value === value)) return
      state.rangeValue = value
      saveRange(value)
      emit()
      refreshContext()
    }

    /* ------------------------------------------------------------- C: models */

    function routeMatches(route, providers) {
      if (!route || typeof route.provider !== 'string') return false
      const provider = providers.find((entry) => entry.id === route.provider)
      return !!provider && provider.models.some((model) => model.id === route.model)
    }

    /** Load the provider/model catalog and settle on an initial route. */
    async function loadModels() {
      const sessionId = state.sessionId
      if (!sessionId) return
      state.models = { ...state.models, loading: true, error: null }
      emit()
      try {
        const response = await fetch(apiUrl(`btw/models?sessionId=${encodeURIComponent(sessionId)}`), {
          signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(8000)
            : undefined,
        })
        let body = null
        try { body = await response.json() } catch { body = null }
        if (state.sessionId !== sessionId) return
        if (!response.ok) {
          const detail = body && body.error && typeof body.error.message === 'string' ? body.error.message : `HTTP ${response.status}`
          throw new Error(detail)
        }
        const listed = Array.isArray(body && body.providers)
          ? body.providers.filter((entry) => entry && typeof entry.id === 'string' && Array.isArray(entry.models))
          : []
        // Adapters that are not catalog-driven report no models; keep the routes
        // the host already knows about (session route, harness default, saved
        // pick) selectable so the control never ends up empty.
        const providers = mergeKnownRoutes(listed, [
          body && body.current,
          body && body.default,
          state.model,
        ])
        const current = body && body.current && routeMatches(body.current, providers) ? body.current : null
        state.models = {
          loading: false,
          providers,
          default: body && body.default ? body.default : null,
          current,
          error: null,
        }
      } catch (error) {
        if (state.sessionId !== sessionId) return
        const providers = mergeKnownRoutes([], [state.models.current, state.models.default, state.model])
        state.models = { loading: false, providers, default: state.models.default, current: state.models.current, error: errorText(error) }
      }
      emit()
    }

    function mergeKnownRoutes(providers, routes) {
      const out = providers.map((provider) => ({ ...provider, models: [...provider.models] }))
      for (const route of routes) {
        if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') continue
        if (!route.provider || !route.model) continue
        let entry = out.find((provider) => provider.id === route.provider)
        if (!entry) {
          entry = { id: route.provider, name: route.provider, models: [] }
          out.push(entry)
        }
        if (!entry.models.some((model) => model.id === route.model)) {
          entry.models.push({ id: route.model, name: route.model })
        }
      }
      return out
    }

    function openCustomModel() {
      state.customOpen = true
      state.customDraft = state.model
        ? { provider: state.model.provider, model: state.model.model }
        : { provider: state.models.current?.provider || '', model: state.models.current?.model || '' }
      emit()
    }

    function updateCustomDraft(patch) {
      state.customDraft = { ...state.customDraft, ...patch }
      emit()
    }

    function applyCustomModel() {
      const provider = String(state.customDraft.provider || '').trim()
      const model = String(state.customDraft.model || '').trim()
      if (!provider || !model) return
      state.models = { ...state.models, providers: mergeKnownRoutes(state.models.providers, [{ provider, model }]) }
      state.customOpen = false
      setModel(provider, model)
    }

    function setModel(provider, model) {
      if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) {
        state.model = null
        try { window.localStorage.removeItem(MODEL_KEY) } catch { /* storage disabled */ }
        emit()
        return
      }
      state.model = { provider, model }
      saveJson(MODEL_KEY, state.model)
      emit()
    }

    function updateSettings(patch) {
      state.settings = { ...state.settings, ...patch }
      saveJson(SETTINGS_KEY, state.settings)
      emit()
    }

    function resetSettings() {
      state.settings = { temperature: null, maxTokens: null, reasoningEffort: '' }
      saveJson(SETTINGS_KEY, state.settings)
      emit()
    }

    function toggleSettings() {
      state.settingsOpen = !state.settingsOpen
      emit()
    }

    function modelLabel() {
      if (state.models.loading) return '读取模型…'
      if (state.model) return `${state.model.provider}/${state.model.model}`
      if (state.models.error) return '模型读取失败'
      return '跟随会话模型'
    }

    function usageText(usage) {
      if (!usage || typeof usage !== 'object') return ''
      const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : null
      const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : null
      if (input === null && output === null) return ''
      const parts = []
      if (input !== null) parts.push(`↑ ${input}`)
      if (output !== null) parts.push(`↓ ${output}`)
      if (Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens > 0) parts.push(`推理 ${usage.reasoningTokens}`)
      return parts.join(' ')
    }

    /** The ask route's first SSE frame is authoritative for the badge. */
    function applyMeta(meta) {
      if (!meta || typeof meta !== 'object') return
      state.context = {
        loading: false,
        stats: meta.stats || state.context.stats,
        dropped: Number.isFinite(meta.dropped) ? meta.dropped : state.context.dropped,
        cold: meta.cold === true,
        error: null,
      }
      emit()
    }

    function contextSummary(context) {
      if (!context) return ''
      if (context.loading) return '读取快照…'
      if (context.error) return `快照失败：${context.error}`
      const stats = context.stats
      if (!stats) return ''
      const parts = [`${stats.messages} 条消息`, `约 ${stats.tokens} tokens`]
      if (context.dropped > 0) parts.push(`省略 ${context.dropped} 条`)
      if (context.cold) parts.push('已保存会话')
      return parts.join(' · ')
    }

    /** Earlier completed dialog turns, sent back with the next question. */
    function completedPairs(messages) {
      const pairs = []
      for (let index = 0; index < messages.length; index += 1) {
        const user = messages[index]
        const assistant = messages[index + 1]
        if (user && user.role === 'user' && assistant && assistant.role === 'assistant' && assistant.state === 'done') {
          pairs.push(
            { role: 'user', text: user.text },
            { role: 'assistant', text: assistant.text, provider: assistant.provider, model: assistant.model },
          )
          index += 1
        }
      }
      return pairs
    }

    async function send(question) {
      const text = typeof question === 'string' ? question.trim() : ''
      if (!text || state.streaming || !state.sessionId) return
      if (state.transferOpen && state.transferPhase !== 'sending') closeTransfer()

      const sessionId = state.sessionId
      const priorTurns = completedPairs(state.messages)
      // Hold the array locally: switching sessions resets `state.messages`, and
      // late stream callbacks must not write into another dialog's transcript.
      const messages = [
        ...state.messages,
        { role: 'user', text, state: 'done' },
        { role: 'assistant', text: '', state: 'streaming' },
      ]
      state.messages = messages
      const assistantIndex = messages.length - 1
      const abort = new AbortController()
      Object.assign(state, { streaming: true, abort })
      emit()

      const patch = (fields) => {
        const message = messages[assistantIndex]
        if (!message) return
        Object.assign(message, fields)
        emit()
      }

      try {
        const done = await streamAsk({
          sessionId,
          question: text,
          priorTurns,
          range: rangePayload(state.rangeValue),
          model: state.model,
          settings: state.settings,
          focus: state.focus,
          signal: abort.signal,
          onMeta: (meta) => {
            if (state.sessionId === sessionId) applyMeta(meta)
          },
          onUsage: (usage) => patch({ usage }),
          onText: (chunk) => {
            const message = messages[assistantIndex]
            if (!message) return
            message.text += chunk
            emit()
          },
        })
        if (state.sessionId !== sessionId) return
        const message = messages[assistantIndex]
        if (message && !message.text && done && typeof done.text === 'string') message.text = done.text
        patch({
          state: 'done',
          provider: done?.provider ?? null,
          model: done?.model ?? null,
          usage: done?.usage ?? message?.usage,
          truncated: done?.truncated === true,
        })
      } catch (error) {
        if (abort.signal.aborted) {
          patch({ state: 'done', text: messages[assistantIndex]?.text || '（已停止）' })
        } else {
          patch({ state: 'error', error: errorText(error), question: text })
        }
      } finally {
        if (state.abort === abort) state.abort = null
        // A stashed dialog was already marked idle; don't clear another
        // session's streaming flag when this request finishes late.
        if (state.sessionId === sessionId) {
          state.streaming = false
          emit()
        }
      }
    }

    function errorText(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message
      return String(error)
    }

    /* ------------------------------------------------------------ transport */

    function apiUrl(path) {
      try {
        return new URL(path, document.baseURI).toString()
      } catch {
        return path
      }
    }

    /**
     * POST /btw/ask and consume the SSE response. Resolves with the `done`
     * payload; rejects with a readable message for HTTP and SSE errors.
     */
    async function streamAsk({ sessionId, question, priorTurns, range, model, settings, focus, signal, onText, onMeta, onUsage }) {
      // The quote travels inside the question itself: this keeps the feature
      // working against hosts that predate the `focus` field, and needs no
      // second code path on the host.
      const preamble = focusPreamble(focus)
      const asked = preamble ? `${preamble}\n\n${question}` : question
      const payload = { sessionId, question: asked, priorTurns, range }
      if (model && typeof model.provider === 'string' && typeof model.model === 'string') {
        payload.provider = model.provider
        payload.model = model.model
      }
      if (settings && typeof settings === 'object') {
        if (Number.isFinite(settings.temperature)) payload.temperature = settings.temperature
        if (Number.isInteger(settings.maxTokens)) payload.maxTokens = settings.maxTokens
        if (typeof settings.reasoningEffort === 'string' && settings.reasoningEffort !== '') {
          payload.reasoningEffort = settings.reasoningEffort
        }
      }
      let response
      try {
        response = await fetch(apiUrl('btw/ask'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        throw new Error('无法连接 btw 服务（host 路由未就绪？）')
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          const body = await response.json()
          if (body && body.error && typeof body.error.message === 'string' && body.error.message) detail = body.error.message
        } catch { /* non-JSON error body */ }
        throw new Error(detail)
      }
      if (!response.body) throw new Error('响应不支持流式读取')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let donePayload = null
      let streamError = null

      const handleFrame = (frame) => {
        const parsed = parseFrame(frame)
        if (!parsed) return
        if (parsed.event === 'delta') {
          const data = parsed.data || {}
          if (data.kind === 'reasoning') return
          if (typeof data.text === 'string' && data.text) onText(data.text)
        } else if (parsed.event === 'meta') {
          if (typeof onMeta === 'function') onMeta(parsed.data || {})
        } else if (parsed.event === 'usage') {
          if (typeof onUsage === 'function') onUsage(parsed.data || {})
        } else if (parsed.event === 'done') {
          donePayload = parsed.data || {}
        } else if (parsed.event === 'error') {
          streamError = parsed.data || {}
        }
      }

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          handleFrame(frame)
        }
      }
      if (buffer.trim() !== '') handleFrame(buffer)

      if (streamError) {
        throw new Error(streamError.message || streamError.code || 'btw 请求失败')
      }
      return donePayload || {}
    }

    function parseFrame(frame) {
      const lines = String(frame).split('\n')
      let event = 'message'
      const dataLines = []
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length === 0) return null
      const raw = dataLines.join('\n')
      try {
        return { event, data: JSON.parse(raw) }
      } catch {
        return null
      }
    }

    /* --------------------------------------------------------------- hooks */

    function useStore() {
      const [, forceRender] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => subscribe(forceRender), [])
      return state
    }

    /* ------------------------------------------------------------------ UI */

    function BtwButton(props) {
      useStore()
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
      const useInput = props && props.useInput
      const inputState = typeof useInput === 'function' ? useInput((snapshot) => snapshot) : null
      const draftRef = React.useRef('')
      draftRef.current = inputState && typeof inputState.draft === 'string' ? inputState.draft : ''
      // mouse-down collapses the selection, so remember it before the click.
      const selectionRef = React.useRef(null)

      // Track the visible session: a dialog opened elsewhere is hidden here and
      // restored when its own session comes back.
      React.useEffect(() => {
        if (!sessionId) return
        noteActiveSession(sessionId)
      }, [sessionId])

      if (!sessionId || !buttonVisible()) return null
      return h('button', {
        type: 'button',
        className: 'btw-trigger',
        title: 'btw · 基于当前会话的临时旁问（也可输入 /btw）',
        'aria-label': '打开 btw 旁问',
        // Prevent the button from stealing focus before the click fires; that
        // focus change is what used to collapse the selection first.
        onPointerDown: (event) => {
          selectionRef.current = captureSelection()
          try { event.preventDefault() } catch { /* synthetic events may not allow it */ }
        },
        onMouseDown: (event) => {
          selectionRef.current = selectionRef.current || captureSelection()
          try { event.preventDefault() } catch { /* synthetic events may not allow it */ }
        },
        onClick: () => openFor(sessionId, selectionRef.current || captureSelection()),
      }, 'btw')
    }

    function MessageBody({ message, streaming }) {
      if (message.text) {
        const markdown = primitivesOf()
        const MarkdownText = markdown && typeof markdown.MarkdownText === 'function' ? markdown.MarkdownText : null
        if (MarkdownText) {
          return h('div', { className: 'btw-msg-body' },
            h(MarkdownText, { text: message.text, labels: MD_LABELS }))
        }
        return h('div', { className: 'btw-plain' }, message.text)
      }
      return streaming ? '思考中…' : ''
    }

    function MessageActions({ message }) {
      if (message.state === 'error') {
        return h('div', { className: 'btw-actions' },
          message.question ? h('button', {
            type: 'button',
            className: 'btw-action',
            onClick: () => send(message.question),
          }, '重试') : null)
      }
      if (message.state === 'streaming' || !message.text) return null
      const meta = []
      if (message.usage) meta.push(h('span', { key: 'usage', className: 'btw-meta', title: '本次调用的 token 用量' }, usageText(message.usage)))
      if (message.model) meta.push(h('span', { key: 'model', className: 'btw-meta' }, `${message.provider || ''}/${message.model}`))
      return meta.length ? h('div', { className: 'btw-actions' }, ...meta) : null
    }

    function MessageList({ current, listRef }) {
      if (current.messages.length === 0) {
        return h('div', { className: 'btw-list', ref: listRef },
          h('div', { className: 'btw-empty' },
            '基于当前会话问一个临时问题。回答只存在于这个窗口里；确认「送入主会话」后，只写入一份压缩摘要（不会自动写入）。'))
      }
      return h('div', { className: 'btw-list', ref: listRef },
        current.messages.map((message, index) => {
          if (message.role === 'user') {
            return h('div', { key: index, className: 'btw-msg btw-msg-user' }, message.text)
          }
          const streaming = message.state === 'streaming'
          const className = 'btw-msg btw-msg-assistant'
            + (message.state === 'error' ? ' is-error' : '')
            + (streaming ? ' btw-msg-streaming' : '')
          return h('div', { key: index, className },
            h(MessageBody, { message, streaming }),
            message.error ? h('div', { className: 'btw-msg-error' }, message.error) : null,
            h(MessageActions, { message }))
        }))
    }

    function transferButton(current) {
      const sent = !!current.sentSignature && current.sentSignature === dialogSignature()
      const busy = current.transferPhase === 'loading' || current.transferPhase === 'sending'
      const label = current.transferOpen
        ? (busy ? '处理中…' : sent ? '完成' : '收起')
        : sent ? '已送入 ✓' : '送入主会话'
      const disabled = busy || (!current.transferOpen && (!canTransfer() || sent))
      return h('button', {
        type: 'button',
        className: 'btw-transfer-btn' + (sent ? ' is-sent' : ''),
        disabled,
        title: sent
          ? '这段旁问已送入主会话；没有新的问答前不会重复写入'
          : canTransfer()
            ? '把整段旁问压缩成一份记录，预览后再送入主会话'
            : '先让 btw 回答完一轮',
        onPointerDown: (event) => event.stopPropagation(),
        onClick: () => {
          if (current.transferOpen && !busy) closeTransfer()
          else openTransfer()
        },
      }, label)
    }

    function TransferPanel({ current }) {
      const phase = current.transferPhase
      const busy = phase === 'loading' || phase === 'sending'
      const chars = current.transferText.length
      const usage = current.transferUsage ? usageText(current.transferUsage) : ''
      const canCommit = current.transferText.trim() !== '' && phase !== 'sending' && phase !== 'loading'
      return h('div', { className: 'btw-transfer-panel' },
        h('div', { className: 'btw-transfer-head' },
          h('strong', { className: 'btw-transfer-title' }, '送入主会话'),
          h('span', { className: 'btw-transfer-sub' }, '只写入这份压缩摘要；主会话之后能读到它，现在不会立刻回复。')),
        phase === 'loading' ? h('div', { className: 'btw-transfer-loading' }, '正在压缩这次旁问…') : null,
        phase === 'sending' ? h('div', { className: 'btw-transfer-loading' }, '正在写入主会话…') : null,
        phase === 'sent' ? h('div', { className: 'btw-transfer-ok' }, '✓ 已写入主会话。之后的对话会带着这份摘要，但不会触发回复。') : null,
        (phase === 'ready' || phase === 'error' || phase === 'sending') ? h('textarea', {
          className: 'btw-transfer-text',
          rows: 8,
          value: current.transferText,
          disabled: busy,
          onChange: (event) => updateTransferText(event.target.value),
        }) : null,
        current.transferWarning ? h('div', { className: 'btw-transfer-warn' }, current.transferWarning) : null,
        current.transferError ? h('div', { className: 'btw-transfer-error' }, current.transferError) : null,
        h('div', { className: 'btw-transfer-foot' },
          h('span', { className: 'btw-transfer-note' },
            `${current.transferTurns} 轮旁问 · ${chars} 字${usage ? ` · ${usage}` : ''}`),
          h('span', { className: 'btw-grow' }),
          phase === 'sent'
            ? h('button', { type: 'button', className: 'btw-action', onClick: closeTransfer }, '完成')
            : h('button', { type: 'button', className: 'btw-action', onClick: closeTransfer }, '取消'),
          phase !== 'sent' ? h('button', {
            type: 'button',
            className: 'btw-action',
            disabled: busy,
            title: '重新压缩（会覆盖当前预览）',
            onClick: openTransfer,
          }, '重新生成') : null,
          phase !== 'sent' ? h('button', {
            type: 'button',
            className: 'btw-btn btw-btn-primary',
            disabled: !canCommit,
            onClick: commitTransfer,
          }, phase === 'sending' ? '写入中…' : phase === 'error' ? '重试写入' : '确认送入') : null))
    }

    function BtwDialog() {
      const current = useStore()
      const [draft, setDraft] = React.useState('')
      const [dragging, setDragging] = React.useState(false)
      const listRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const canSend = !current.streaming && draft.trim() !== ''

      // Follow the bottom as the answer streams in.
      React.useEffect(() => {
        const node = listRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [current.open, current.messages, current.streaming])

      // Keep the window inside the viewport when the frame is resized.
      React.useEffect(() => {
        if (!current.open) return undefined
        const onResize = () => refitWindow()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [current.open])

      // Escape closes, but only while focus is inside our floating window.
      React.useEffect(() => {
        if (!current.open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          const root = rootRef.current
          if (!root) return
          const active = document.activeElement
          if (!(active && root.contains(active)) && !root.contains(event.target)) return
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [current.open])

      if (!current.open || !current.win) return null
      // A dialog opened from another session is hidden, not closed: its context
      // and selection belong to that session. It reappears when the user
      // switches back; the store keeps its messages meanwhile.
      if (current.activeSession && current.sessionId && current.activeSession !== current.sessionId) return null

      const beginPointerDrag = (event, mode) => {
        if (event.button !== 0 || !current.win) return
        event.preventDefault()
        event.stopPropagation()
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* older engines */ }
        dragRef.current = {
          mode,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: current.win.x,
          originY: current.win.y,
          originW: current.win.w,
          originH: current.win.h,
        }
        setDragging(true)
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        event.preventDefault()
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (drag.mode === 'move') {
          setWindow({ x: drag.originX + dx, y: drag.originY + dy })
        } else if (drag.mode === 'se') {
          setWindow({ w: drag.originW + dx, h: drag.originH + dy })
        } else if (drag.mode === 'e') {
          setWindow({ w: drag.originW + dx })
        } else if (drag.mode === 's') {
          setWindow({ h: drag.originH + dy })
        }
      }

      const endPointerDrag = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
        commitWindow()
      }

      const submit = () => {
        const text = draft.trim()
        if (!text || current.streaming) return
        setDraft('')
        send(text)
      }

      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return
        const composing = event.nativeEvent && event.nativeEvent.isComposing === true
        if (composing) return
        event.preventDefault()
        submit()
      }

      // Every handle shares the same move/up plumbing (pointer capture keeps
      // events flowing even when the pointer leaves the tiny handle).
      const pointerHandlers = {
        onPointerMove,
        onPointerUp: endPointerDrag,
        onPointerCancel: endPointerDrag,
        onLostPointerCapture: endPointerDrag,
      }

      return h('div', { className: 'btw-layer', ref: rootRef },
        h('div', {
          className: 'btw-window' + (dragging ? ' is-dragging' : ''),
          style: {
            left: `${current.win.x}px`,
            top: `${current.win.y}px`,
            width: `${current.win.w}px`,
            height: `${current.win.h}px`,
          },
          role: 'dialog',
          'aria-modal': 'false',
          'aria-label': 'btw 旁问',
        },
        h('div', Object.assign({
          className: 'btw-head',
          onPointerDown: (event) => beginPointerDrag(event, 'move'),
          onDoubleClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            toggleMaximize()
          },
          title: '拖动移动 · 双击最大化/还原',
        }, pointerHandlers),
        h('div', { className: 'btw-head-text' },
          h('strong', { className: 'btw-title' }, 'btw · 旁问'),
          h('span', { className: 'btw-head-hint' }, '基于主会话已提交内容 · 回答默认不写入，可压缩后送入 · 拖动移动，拖边角改大小')),
        transferButton(current),
        h('button', {
          type: 'button',
          className: 'btw-close',
          'aria-label': '关闭',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: close,
        }, '×')),
        h('div', { className: 'btw-context' },
          h('select', {
            className: 'btw-select',
            value: current.rangeValue,
            disabled: current.streaming,
            title: '选择随问题发给 btw 的会话历史范围',
            onChange: (event) => setRangeValue(event.target.value),
          }, RANGE_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
          h('select', {
            className: 'btw-select btw-model',
            value: current.model ? `${current.model.provider}\u0000${current.model.model}` : '',
            disabled: current.streaming,
            title: current.models.error
              ? `模型目录读取失败：${current.models.error}（可选「自定义模型…」直接填 provider/model）`
              : '只影响 btw 这次旁问，不改变主会话模型；目录里没有的模型可选「自定义模型…」',
            onChange: (event) => {
              const raw = event.target.value
              if (raw === '__custom__') return openCustomModel()
              if (!raw) return setModel(null, null)
              const at = raw.indexOf('\u0000')
              if (at > 0) setModel(raw.slice(0, at), raw.slice(at + 1))
            },
          },
          h('option', { key: '', value: '' }, current.models.loading ? '读取模型…' : '跟随会话模型'),
          current.models.providers.filter((provider) => provider.models.length > 0).map((provider) => h('optgroup', {
            key: provider.id,
            label: provider.name || provider.id,
          }, provider.models.map((model) => h('option', {
            key: `${provider.id}\u0000${model.id}`,
            value: `${provider.id}\u0000${model.id}`,
          }, model.name || model.id)))),
          h('option', { key: '__custom__', value: '__custom__' }, '自定义模型…')),
          h('span', {
            className: 'btw-ctx-stats' + (current.context.error ? ' is-error' : ''),
            title: '本次旁问会携带的会话快照',
          }, contextSummary(current.context)),
          h('button', {
            type: 'button',
            className: 'btw-refresh',
            disabled: current.context.loading || current.streaming,
            title: '重新读取当前会话快照',
            onClick: refreshContext,
          }, current.context.loading ? '…' : '刷新'),
          h('button', {
            type: 'button',
            className: 'btw-refresh btw-gear' + (current.settingsOpen ? ' is-active' : ''),
            title: 'btw 设置（仅影响本窗口的调用）',
            'aria-expanded': current.settingsOpen ? 'true' : 'false',
            onClick: toggleSettings,
          }, '⚙')),
        current.focus ? h('div', { className: 'btw-focus' },
          h('span', { className: 'btw-focus-label' }, '引用选中文本'),
          h('span', { className: 'btw-focus-text', title: focusPreview(current.focus) }, focusPreview(current.focus)),
          h('button', {
            type: 'button',
            className: 'btw-focus-clear',
            title: '清除引用',
            'aria-label': '清除引用',
            onClick: clearFocus,
          }, '×')) : null,
        current.customOpen ? h('div', { className: 'btw-context btw-custom' },
          h('input', {
            className: 'btw-custom-input',
            value: current.customDraft.provider,
            placeholder: 'provider（如 opencode-go）',
            onChange: (event) => updateCustomDraft({ provider: event.target.value }),
            onKeyDown: (event) => { if (event.key === 'Enter') applyCustomModel() },
          }),
          h('input', {
            className: 'btw-custom-input',
            value: current.customDraft.model,
            placeholder: 'model（如 deepseek-v4.1-flash）',
            onChange: (event) => updateCustomDraft({ model: event.target.value }),
            onKeyDown: (event) => { if (event.key === 'Enter') applyCustomModel() },
          }),
          h('button', {
            type: 'button',
            className: 'btw-refresh',
            disabled: !current.customDraft.provider.trim() || !current.customDraft.model.trim(),
            title: '目录里没有列出的模型也可以直接填 provider/model',
            onClick: applyCustomModel,
          }, '应用'),
          h('button', {
            type: 'button',
            className: 'btw-refresh',
            onClick: () => { state.customOpen = false; emit() },
          }, '取消')) : null,
        current.settingsOpen ? h('div', { className: 'btw-settings' },
          h('div', { className: 'btw-field' },
            h('span', {}, '温度'),
            h('input', {
              type: 'number', min: 0, max: 2, step: 0.1, placeholder: '默认',
              value: current.settings.temperature === null ? '' : String(current.settings.temperature),
              onChange: (event) => {
                const raw = event.target.value
                const value = raw === '' ? null : Number(raw)
                updateSettings({ temperature: Number.isFinite(value) && value >= 0 && value <= 2 ? value : null })
              },
            })),
          h('div', { className: 'btw-field' },
            h('span', {}, '最大输出'),
            h('input', {
              type: 'number', min: 1, max: 32768, step: 1, placeholder: '默认',
              value: current.settings.maxTokens === null ? '' : String(current.settings.maxTokens),
              onChange: (event) => {
                const raw = event.target.value
                const value = Number(raw)
                updateSettings({ maxTokens: raw !== '' && Number.isInteger(value) && value > 0 ? Math.min(value, 32768) : null })
              },
            })),
          h('div', { className: 'btw-field' },
            h('select', {
              value: current.settings.reasoningEffort,
              title: '只对支持推理强度的模型生效',
              onChange: (event) => updateSettings({ reasoningEffort: event.target.value }),
            }, REASONING_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
          h('label', { className: 'btw-field btw-field-wide' },
            h('input', {
              type: 'checkbox',
              checked: buttonVisible(),
              onChange: (event) => {
                try {
                  if (event.target.checked) window.localStorage.removeItem(BUTTON_KEY)
                  else window.localStorage.setItem(BUTTON_KEY, '0')
                } catch { /* storage disabled */ }
                emit()
              },
            }),
            h('span', {}, '在输入框旁显示 btw 按钮（/btw 始终可用）')),
          h('div', { className: 'btw-settings-actions' },
            h('span', { className: 'btw-settings-note' }, '只影响 btw，不改主会话'),
            h('button', { type: 'button', className: 'btw-action', onClick: resetSettings }, '恢复默认'))) : null,
        current.transferOpen ? h(TransferPanel, { current }) : h(MessageList, { current, listRef }),
        h('div', { className: 'btw-compose' },
          h('div', { className: 'btw-input-row' },
            h('textarea', {
              className: 'btw-input',
              value: draft,
              rows: 2,
              autoFocus: true,
              placeholder: '问当前会话一个临时问题…（Enter 发送 / Shift+Enter 换行）',
              disabled: current.streaming,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown,
            }),
            current.streaming
              ? h('button', { type: 'button', className: 'btw-btn', onClick: stop }, '停止')
              : h('button', {
                type: 'button',
                className: 'btw-btn btw-btn-primary',
                disabled: !canSend,
                onClick: submit,
              }, '发送')),
          h('div', { className: 'btw-hint' },
            current.streaming ? '生成中… 可点「停止」中止' : '切到别的会话时隐藏、切回恢复；点 × 才清空 · 回答不会自动进入主会话，确认「送入」后只写入压缩摘要')),
        h('div', Object.assign({ className: 'btw-resize btw-resize-e', onPointerDown: (event) => beginPointerDrag(event, 'e') }, pointerHandlers)),
        h('div', Object.assign({ className: 'btw-resize btw-resize-s', onPointerDown: (event) => beginPointerDrag(event, 's') }, pointerHandlers)),
        h('div', Object.assign({ className: 'btw-resize btw-resize-se', onPointerDown: (event) => beginPointerDrag(event, 'se') }, pointerHandlers)),
        ))
    }

    /* --------------------------------------------------------------- apply */

    function serviceOf(scope, name) {
      if (!scope) return null
      if (typeof scope.get === 'function') {
        try {
          const service = scope.get(name)
          if (service) return service
        } catch { /* fall through to the property */ }
      }
      return scope[name] || null
    }

    function warn(label, error) {
      try { console.warn('[dsh-btw] ' + label, error) } catch { /* console may be unavailable */ }
    }

    function apply(ctx) {
      try { installStyles() } catch (error) { warn('style injection failed', error) }
      if (!ctx || typeof ctx.inject !== 'function') return

      // Keep the last real selection so a click that collapses it still quotes
      // the text the user picked moments ago.
      try {
        const install = () => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {}
          document.addEventListener('selectionchange', rememberSelection)
          return () => document.removeEventListener('selectionchange', rememberSelection)
        }
        if (typeof ctx.effect === 'function') ctx.effect(install, 'btw: selection cache')
      } catch (error) { warn('selection listener failed', error) }

      // Defensive rule for every registration: a throw here must fail only this
      // plugin entry, never the core plugin whose slot is being declared (a slot
      // inject callback runs inside the declaring plugin's activation).
      try {
        ctx.inject(['slots'], (scope) => {
          const slots = serviceOf(scope, 'slots')
          if (!slots) return
          const register = (slotName, options, Component, label) => {
            scope.effect(() => slots.inject(slotName, () => {
              try {
                return slots.register(options, Component)
              } catch (error) {
                warn(`${label} registration failed`, error)
                return () => {}
              }
            }))
          }
          register('conversation.input.right',
            { name: 'conversation.input.right', id: 'btw:button', order: 40 }, BtwButton, 'input.right')
          register('shell.overlay',
            { name: 'shell.overlay', id: 'btw:dialog', order: 50 }, BtwDialog, 'shell.overlay')
        })
      } catch (error) { warn('slots activation failed', error) }

      // Ctrl+Alt+B is deliberately NOT registered: DSH core already binds it to
      // sidebar.left.toggle / sidebar.right.toggle, and the shortcut registry
      // rejects duplicate default bindings at boot (which used to fail core
      // layout activation). The button and `/btw` remain the two entry points.

      // `/btw` in the composer command menu. The action callback receives the
      // session it was invoked from, so this path needs no lastSessionId.
      try {
        ctx.inject(['commandUi'], (scope) => {
          const commandUi = serviceOf(scope, 'commandUi')
          if (!commandUi || typeof commandUi.register !== 'function') return
          scope.effect(() => {
            try {
              return commandUi.register({
                name: 'btw',
                label: () => 'btw 旁问',
                available: (session) => !!session && typeof session.sessionId === 'string',
                ui: {
                  kind: 'action',
                  run: (session) => {
                    if (session && typeof session.sessionId === 'string') {
                      openFor(session.sessionId, captureSelection())
                    }
                  },
                },
              })
            } catch (error) {
              warn('commandUi registration failed', error)
              return () => {}
            }
          })
        })
      } catch (error) { warn('commandUi activation failed', error) }
    }

    exports.apply = apply
    // Only `slots` gates activation; commandUi is picked up lazily below so an
    // older shell without it still gets the button and dialog.
    exports.inject = ['slots']
    return module.exports
  },
})
