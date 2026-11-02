/* PiP Flutuante — content script
 * - Botão "Flutuar" aparece ao passar o mouse sobre qualquer vídeo.
 * - Abre uma janela Document Picture-in-Picture (sempre por cima de todos os apps)
 *   com player próprio: play/pause, ±10s, anterior/próximo, barra de progresso,
 *   volume, velocidade, legendas, repetir, playlist / "a seguir" do YouTube, pular anúncio.
 * - Resistente a atualizações: quando a extensão é recarregada/atualizada, a versão nova
 *   desliga a antiga sem quebrar a janela que estiver aberta.
 * - Todo o DOM é montado sem innerHTML (compatível com Trusted Types do YouTube).
 */
(() => {
  'use strict';

  // ---------- encerra uma instância anterior (após atualizar/recarregar a extensão) ----------
  try { document.dispatchEvent(new CustomEvent('pipf-teardown')); } catch (_) {}

  const IS_TOP = window === window.top;
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  const S = {
    dead: false,
    pip: null,          // janela PiP aberta
    ctl: null,          // controlador da janela PiP
    lastVideo: null,    // último vídeo sob o mouse
    prefs: { volume: null, muted: null, rate: null },
    pageCleanups: []
  };

  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { console.debug('[PiP Flutuante]', e); } };

  function fmt(s) {
    if (!isFinite(s) || s < 0) return '--:--';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  }

  // Faixa navegável do vídeo. Alguns sites (ex.: Disney+) informam duration = Infinity mesmo em
  // filmes/séries; nesses casos usa a faixa "seekable" (se tiver tamanho de conteúdo, não de buffer curto).
  function timeRange(v) {
    const d = v.duration;
    if (isFinite(d) && d > 0) return { start: 0, end: d };
    try {
      const n = v.seekable ? v.seekable.length : 0;
      if (n) {
        const s = v.seekable.start(0), e = v.seekable.end(n - 1);
        if (isFinite(s) && isFinite(e) && e - s > 30) return { start: s, end: e };
      }
    } catch (_) {}
    return null;
  }

  // ---------- ícones ----------
  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
    r10: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    f10: 'M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z',
    prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    volHigh: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volLow: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4z',
    volMute: 'M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
    cc: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z',
    list: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
    loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    back: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    float: 'M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16.01H3V4.98h18v14.03z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    ambient: 'M5 8h14v9H5V8zm2 2v5h10v-5H7zM11 2h2v3.5h-2zM4.2 3.4l1.4-1.4 2.2 2.2-1.4 1.4zm12 .8 2.2-2.2 1.4 1.4-2.2 2.2zM11 19h2v3h-2z',
    timer: 'M12.34 2.02C6.59 1.82 2 6.42 2 12c0 5.52 4.48 10 10 10 3.71 0 6.93-2.02 8.66-5.02-7.51-.25-12.09-8.43-8.32-14.96zM12 20c-4.41 0-8-3.59-8-8 0-3.05 1.71-5.7 4.22-7.05C8.08 9.1 10.4 14.4 16.4 16.8 15.02 18.79 13.03 20 12 20z',
    speedo: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    chevR: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    chevL: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    translate: 'm12.87 15.07-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z',
    fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'
  };

  function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    if (name === 'r10' || name === 'f10') {
      const t = doc.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', '12'); t.setAttribute('y', '16.2');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'n10');
      t.textContent = '10';
      svg.append(t);
    }
    return svg;
  }

  function h(doc, tag, props, ...kids) {
    const e = doc.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  }

  function addSheet(target, win, css) {
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(css);
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
    } catch (_) {
      const st = (target.ownerDocument || target).createElement('style');
      st.textContent = css;
      (target.head || target).append(st);
    }
  }

  // =====================================================================
  //  BOTÃO "FLUTUAR" SOBRE OS VÍDEOS DA PÁGINA (em shadow DOM isolado)
  // =====================================================================
  const PAGE_CSS = `
    :host { all: initial; }
    .float {
      position: fixed; z-index: 2147483647; pointer-events: auto;
      display: flex; align-items: center; gap: 6px;
      padding: 7px 12px 7px 10px; border: 0; border-radius: 999px; cursor: pointer;
      background: rgba(15,15,15,.82); color: #fff; backdrop-filter: blur(6px);
      font: 600 13px/1 system-ui, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      opacity: 0; transform: translateY(-4px); transition: opacity .15s, transform .15s, background .15s;
    }
    .float.show { opacity: 1; transform: none; }
    .float:hover { background: #0f6cbd; }
    .float svg { width: 18px; height: 18px; fill: currentColor; }
    .toast {
      position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
      z-index: 2147483647; pointer-events: none;
      background: rgba(20,20,20,.92); color: #fff; padding: 10px 16px; border-radius: 10px;
      font: 500 13px/1.4 system-ui, "Segoe UI", Roboto, sans-serif; max-width: 80vw;
      opacity: 0; transition: opacity .2s;
    }
    .toast.show { opacity: 1; }
  `;

  const host = document.createElement('pipf-host');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  addSheet(shadow, window, PAGE_CSS);
  const floatBtn = h(document, 'button', { class: 'float', title: 'Abrir em janela flutuante (Alt+P)' },
    icon(document, 'float'), h(document, 'span', { text: 'Flutuar' }));
  const toastEl = h(document, 'div', { class: 'toast' });
  shadow.append(floatBtn, toastEl);
  (document.documentElement || document.body).append(host);

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  const bigEnough = (r) => r.width >= 200 && r.height >= 110;

  function videoAt(x, y) {
    let list;
    try { list = document.elementsFromPoint(x, y); } catch (_) { return null; }
    for (const el of list) {
      if (el === host) continue;
      if (el.tagName === 'VIDEO' && bigEnough(el.getBoundingClientRect())) return el;
    }
    const lv = S.lastVideo;
    if (lv && lv.isConnected && lv.ownerDocument === document) {
      const r = lv.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && bigEnough(r)) return lv;
    }
    return null;
  }

  let hoverVideo = null, hideTimer, raf = 0, lastX = 0, lastY = 0;

  function placeButton(v) {
    const r = v.getBoundingClientRect();
    const bw = floatBtn.offsetWidth || 96;
    floatBtn.style.left = Math.round(clamp(r.left + r.width / 2 - bw / 2, 4, innerWidth - bw - 4)) + 'px';
    // desce um pouco para não cobrir o nome da página/perfil que Instagram, YouTube etc. desenham no topo do vídeo
    const dy = r.height >= 320 ? 64 : r.height >= 200 ? 40 : 12;
    floatBtn.style.top = Math.round(clamp(r.top + dy, 4, innerHeight - 40)) + 'px';
  }

  const onPointerMove = safe((e) => {
    lastX = e.clientX; lastY = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(safe(() => {
      raf = 0;
      if (S.dead || document.fullscreenElement) { floatBtn.classList.remove('show'); return; }
      if (e.composedPath && e.composedPath().includes(floatBtn)) { clearTimeout(hideTimer); return; }
      const v = videoAt(lastX, lastY);
      if (v && !S.pip) {
        hoverVideo = v; S.lastVideo = v;
        placeButton(v);
        floatBtn.classList.add('show');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => floatBtn.classList.remove('show'), 2500);
      } else {
        floatBtn.classList.remove('show');
      }
    }));
  });

  floatBtn.addEventListener('click', safe((e) => {
    e.preventDefault(); e.stopPropagation();
    floatBtn.classList.remove('show');
    if (hoverVideo) openPip(hoverVideo);
  }));
  floatBtn.addEventListener('mousedown', (e) => e.stopPropagation());

  function pickVideo() {
    const vids = [...document.querySelectorAll('video')].filter(v => v.isConnected);
    if (S.lastVideo && vids.includes(S.lastVideo)) return S.lastVideo;
    const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    const playing = vids.filter(v => !v.paused && v.readyState > 1).sort((a, b) => area(b) - area(a));
    if (playing.length) return playing[0];
    return vids.sort((a, b) => area(b) - area(a))[0] || null;
  }

  const onKey = safe((e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyP')) {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault(); e.stopPropagation();
      togglePip();
    }
  });

  // ---- ponte com a API do player do YouTube (yt-bridge.js, mundo da página) ----
  let reqSeq = 0;
  const pending = new Map();
  const onYtRes = (e) => {
    try {
      const r = JSON.parse(e.detail);
      const cb = r && pending.get(r.id);
      if (cb) { pending.delete(r.id); cb(r.result); }
    } catch (_) {}
  };
  document.addEventListener('pipf-yt-res', onYtRes);
  S.pageCleanups.push(() => document.removeEventListener('pipf-yt-res', onYtRes));
  function ytCall(cmd, args) {
    return new Promise((resolve) => {
      if (!IS_YT) return resolve(null);
      const id = `${Date.now()}-${++reqSeq}-${Math.random().toString(36).slice(2)}`;
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, 1500);
      try { document.dispatchEvent(new CustomEvent('pipf-yt-req', { detail: JSON.stringify({ id, cmd, args: args || {} }) })); }
      catch (_) { pending.delete(id); resolve(null); }
    });
  }

  // preferências salvas (iluminação cinematográfica)
  const store = {
    async get(key, def) {
      if (!alive()) return def;
      try { const o = await chrome.storage.local.get(key); return key in o ? o[key] : def; } catch (_) { return def; }
    },
    set(key, val) { if (alive()) { try { chrome.storage.local.set({ [key]: val }); } catch (_) {} } }
  };

  // ---- abertura automática ao sair da aba / minimizar ----
  // Usa o recurso de PiP automático do Chrome (Media Session "enterpictureinpicture"):
  // quando a aba com vídeo tocando fica oculta, o Chrome chama este handler e libera abrir a janela.
  S.autoPip = true;
  let autoSet = false, autoOpened = false;
  function playingVideo() {
    const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    return [...document.querySelectorAll('video')]
      .filter(v => !v.paused && !v.ended && v.readyState > 1)
      .sort((a, b) => area(b) - area(a))[0] || null;
  }
  function autoEnter() {
    if (S.pip || S.dead || !S.autoPip) return;
    const v = (S.lastVideo && S.lastVideo.isConnected && !S.lastVideo.paused) ? S.lastVideo : playingVideo();
    if (!v) return;
    autoOpened = true;
    openPip(v);
  }
  function syncAutoHandler() {
    if (!IS_TOP || !('mediaSession' in navigator)) return;
    try {
      if (S.autoPip && !S.dead) { navigator.mediaSession.setActionHandler('enterpictureinpicture', autoEnter); autoSet = true; }
      else if (autoSet) { navigator.mediaSession.setActionHandler('enterpictureinpicture', null); autoSet = false; }
    } catch (_) { /* Chrome sem suporte ao PiP automático */ }
  }
  // ao voltar para a aba, fecha a janela que abriu sozinha
  const onVis = () => {
    if (document.visibilityState === 'visible' && autoOpened && S.pip) { try { S.pip.close(); } catch (_) {} }
  };
  document.addEventListener('visibilitychange', onVis);
  const onStore = (ch, area) => {
    if (area === 'local' && ch.autoPip) {
      S.autoPip = ch.autoPip.newValue !== false;
      syncAutoHandler();
      if (S.ctl && S.ctl.refreshMenu) S.ctl.refreshMenu();
    }
  };
  try { chrome.storage.onChanged.addListener(onStore); } catch (_) {}
  // o site pode sobrescrever o handler; registra de novo de tempos em tempos
  const autoT = setInterval(() => { if (!S.dead && alive()) syncAutoHandler(); }, 10000);
  const onYtNav = () => setTimeout(syncAutoHandler, 500);
  document.addEventListener('yt-navigate-finish', onYtNav);
  S.pageCleanups.push(() => {
    clearInterval(autoT);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('yt-navigate-finish', onYtNav);
    try { chrome.storage.onChanged.removeListener(onStore); } catch (_) {}
    if (autoSet && !S.pip) { try { navigator.mediaSession.setActionHandler('enterpictureinpicture', null); } catch (_) {} autoSet = false; }
  });
  store.get('autoPip', true).then(val => { S.autoPip = val !== false; syncAutoHandler(); });
  S.onPipClosed = () => { autoOpened = false; };

  function togglePip() {
    if (S.pip) { S.pip.close(); return; }
    const v = pickVideo();
    if (v) openPip(v); else if (IS_TOP) toast('Nenhum vídeo encontrado nesta página.');
  }

  addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  addEventListener('keydown', onKey, true);
  S.pageCleanups.push(() => {
    removeEventListener('pointermove', onPointerMove, true);
    removeEventListener('keydown', onKey, true);
  });

  const onMsg = (msg) => { if (msg && msg.type === 'pipf-toggle' && !S.dead) safe(togglePip)(); };
  try { chrome.runtime.onMessage.addListener(onMsg); } catch (_) {}
  S.pageCleanups.push(() => { try { chrome.runtime.onMessage.removeListener(onMsg); } catch (_) {} });

  // =====================================================================
  //  INSTAGRAM: botão de baixar vídeo/foto na barra de ações do post
  //  (ao lado do "Salvar"). Pega o arquivo pela API do próprio site, usando a sessão
  //  do usuário, e o download é feito pelo service worker (chrome.downloads).
  // =====================================================================
  const IS_IG = IS_TOP && /(^|\.)instagram\.com$/.test(location.hostname);
  const IG_APP_ID = '936619743392459';
  const IG_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const RE_IG_SAVE = /^(salvar|remover dos salvos|save|unsave|remove|guardar|quitar de guardados)$/i;
  const RE_IG_LIKE = /^(curtir|descurtir|like|unlike|me gusta|ya no me gusta)$/i;
  const RE_IG_CODE = /\/(?:p|reels?|tv)\/(?!audio\b)([\w-]{5,})/;
  const IG_CSS = `
    .dl { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%; cursor: pointer; color: inherit; opacity: .85;
      transition: opacity .15s, background .15s; }
    .dl:hover { opacity: 1; background: rgba(128,128,128,.25); }
    .dl.busy { opacity: .4; cursor: progress; }
    .dl svg { width: 20px; height: 20px; fill: currentColor; }
  `;
  const igBtns = new Map();   // elemento da barra de ações -> { row, save, like, host }

  const igBase = (u) => { try { return new URL(u).pathname.split('/').pop(); } catch (_) { return ''; }; };

  function igIdFromCode(code) {
    const c = code.length > 28 ? code.slice(0, -28) : code;   // posts de conta privada têm um sufixo extra
    let id = 0n;
    for (const ch of c) {
      const i = IG_ALPHA.indexOf(ch);
      if (i < 0) return null;
      id = id * 64n + BigInt(i);
    }
    return id.toString();
  }

  // código do post (…/p/CODIGO/, …/reel/CODIGO/): procura nos links do próprio post;
  // se houver mais de um post no mesmo bloco (lista de reels), usa o endereço da página.
  function igCodeFor(row) {
    let el = row;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      const codes = new Set();
      for (const a of el.querySelectorAll('a[href]')) {
        const m = RE_IG_CODE.exec(a.getAttribute('href') || '');
        if (m) codes.add(m[1]);
      }
      if (codes.size === 1) return [...codes][0];
      if (codes.size > 1) break;
    }
    const m = RE_IG_CODE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // vídeo/foto que está aparecendo no post (o de maior área visível dentro do bloco do post)
  function igVisibleMedia(row) {
    const vw = innerWidth, vh = innerHeight;
    let el = row;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      let best = null, bestA = 0;
      for (const m of el.querySelectorAll('video, img')) {
        const r = m.getBoundingClientRect();
        if (r.width < 180 || r.height < 180) continue;     // ignora foto de perfil, emojis etc.
        const a = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        if (a > bestA) { best = m; bestA = a; }
      }
      if (best) return best;
    }
    return null;
  }

  async function igFromApi(code, media) {
    const id = igIdFromCode(code);
    if (!id) throw new Error('código inválido');
    const r = await fetch(`/api/v1/media/${id}/info/`, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': IG_APP_ID, 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const it = j && j.items && j.items[0];
    if (!it) throw new Error('post não encontrado');

    const area = (x) => (x.width || 0) * (x.height || 0);
    const best = (arr) => (arr || []).filter(x => x && x.url).sort((a, b) => area(b) - area(a))[0];
    const entry = (m) => {
      const img = best(m.image_versions2 && m.image_versions2.candidates);
      const names = ((m.image_versions2 && m.image_versions2.candidates) || []).map(c => igBase(c.url));
      const vid = best(m.video_versions);
      if (vid) return { url: vid.url, ext: 'mp4', video: true, names };
      return img ? { url: img.url, ext: 'jpg', video: false, names } : null;
    };
    let list = (it.carousel_media && it.carousel_media.length ? it.carousel_media : [it]).map(entry).filter(Boolean);
    if (list.length > 1 && media) {
      // carrossel: tenta baixar só o item que está na tela
      const key = media.tagName === 'VIDEO' ? igBase(media.poster || '') : igBase(media.currentSrc || media.src || '');
      let pick = key ? list.filter(e => e.names.includes(key)) : [];
      if (!pick.length && media.tagName === 'VIDEO') {
        const vids = list.filter(e => e.video);
        if (vids.length === 1) pick = vids;
      }
      if (pick.length) list = [pick[0]];
    }
    return { user: (it.user && it.user.username) || (it.owner && it.owner.username) || '', list };
  }

  // plano B: endereço direto que a página já carregou (fotos; vídeos que não sejam blob:)
  function igFromDom(media) {
    if (!media) return [];
    const u = media.currentSrc || media.src || '';
    if (!/^https?:/i.test(u)) return [];
    return [{ url: u, ext: media.tagName === 'VIDEO' ? 'mp4' : 'jpg', video: media.tagName === 'VIDEO' }];
  }

  function igSend(url, filename) {
    return new Promise((resolve) => {
      if (!alive()) return resolve({ ok: false, error: 'extensão atualizada — recarregue a aba (F5)' });
      try {
        chrome.runtime.sendMessage({ type: 'pipf-download', url, filename }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || { ok: false });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }

  async function igDownload(rec) {
    const btn = rec.btn;
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    try {
      const code = igCodeFor(rec.row);
      const media = igVisibleMedia(rec.row);
      let user = '', list = [];
      if (code) {
        try { ({ user, list } = await igFromApi(code, media)); }
        catch (e) { console.debug('[PiP Flutuante] Instagram API:', e); }
      }
      if (!list.length) list = igFromDom(media);
      if (!list.length) { toast('Não consegui obter o arquivo deste post. Abra o post e tente de novo.'); return; }

      const stamp = code || String(Date.now());
      let ok = 0, err = '';
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const nm = `Instagram/${user ? user + '_' : ''}${stamp}${list.length > 1 ? '_' + (i + 1) : ''}.${it.ext}`;
        const res = await igSend(it.url, nm);
        if (res && res.ok) ok++; else err = (res && res.error) || err;
      }
      if (ok) toast(ok > 1 ? `Baixando ${ok} arquivos (pasta Downloads/Instagram)…` : 'Baixando… (pasta Downloads/Instagram)');
      else toast('Falha ao baixar' + (err ? ': ' + err : '.'));
    } finally {
      btn.classList.remove('busy');
    }
  }

  // posiciona o botão ao lado do "Salvar" (barra horizontal) ou acima do "Curtir" (coluna vertical dos reels)
  function igPlace(rec) {
    const s = rec.save.getBoundingClientRect(), l = rec.like.getBoundingClientRect();
    if (!s.width || !s.height) return;
    const SZ = 28;
    let x, y;
    if (Math.abs(s.top - l.top) < s.height) { x = s.left - SZ - 8; y = s.top + (s.height - SZ) / 2; }
    else { x = s.left + (s.width - SZ) / 2; y = l.top - SZ - 10; }
    const base = rec.host.offsetParent || document.documentElement;
    const b = base.getBoundingClientRect();
    const isRoot = base === document.documentElement;
    rec.host.style.left = Math.round(x - b.left - (isRoot ? 0 : base.clientLeft) + (isRoot ? 0 : base.scrollLeft)) + 'px';
    rec.host.style.top = Math.round(y - b.top - (isRoot ? 0 : base.clientTop) + (isRoot ? 0 : base.scrollTop)) + 'px';
    try { rec.host.style.color = getComputedStyle(rec.save).color; } catch (_) {}
  }

  function igScan() {
    if (S.dead) return;
    for (const [row, rec] of [...igBtns]) {
      if (!row.isConnected || !rec.host.isConnected) { rec.host.remove(); igBtns.delete(row); }
    }
    for (const svg of document.querySelectorAll('svg[aria-label]')) {
      if (!RE_IG_SAVE.test(svg.getAttribute('aria-label') || '')) continue;
      // sobe até achar o bloco que também contém o "Curtir": é a barra de ações do post
      let row = svg.parentElement, like = null;
      for (let i = 0; row && i < 8; i++, row = row.parentElement) {
        like = [...row.querySelectorAll('svg[aria-label]')].find(s => RE_IG_LIKE.test(s.getAttribute('aria-label') || ''));
        if (like) break;
      }
      if (!row || !like || igBtns.has(row)) continue;

      const host = document.createElement('pipf-dl');
      host.style.cssText = 'position:absolute;z-index:3;display:block;left:0;top:0;';
      const sh = host.attachShadow({ mode: 'closed' });
      addSheet(sh, window, IG_CSS);
      const btn = h(document, 'button', { class: 'dl', title: 'Baixar vídeo/foto', 'aria-label': 'Baixar vídeo/foto' }, icon(document, 'download'));
      sh.append(btn);
      const rec = { row, save: svg, like, host, btn };
      ['mousedown', 'pointerdown', 'dblclick'].forEach(ev => btn.addEventListener(ev, (e) => e.stopPropagation()));
      btn.addEventListener('click', safe((e) => { e.preventDefault(); e.stopPropagation(); igDownload(rec); }));
      row.append(host);
      igBtns.set(row, rec);
      igPlace(rec);
    }
  }

  if (IS_IG) {
    let igT = 0;
    const igSoon = () => { if (!igT) igT = setTimeout(() => { igT = 0; safe(igScan)(); }, 300); };
    const mo = new MutationObserver(igSoon);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    const igIv = setInterval(safe(() => igBtns.forEach(igPlace)), 1000);
    addEventListener('resize', igSoon);
    S.pageCleanups.push(() => {
      mo.disconnect(); clearInterval(igIv); clearTimeout(igT);
      removeEventListener('resize', igSoon);
      igBtns.forEach(r => r.host.remove()); igBtns.clear();
    });
    igScan();
  }

  // =====================================================================
  //  ABRIR A JANELA FLUTUANTE
  // =====================================================================
  async function openPip(video) {
    if (S.pip) { try { S.pip.focus(); } catch (_) {} return; }
    S.afterPip = null;   // nunca herda uma ação pendente de uma janela anterior
    const hasDocPip = IS_TOP && 'documentPictureInPicture' in window;
    if (!hasDocPip) {
      // iframes / navegadores antigos: PiP nativo do Chrome (controles simples)
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (_) { toast('Não foi possível abrir a janela flutuante neste vídeo.'); }
      return;
    }
    const ar = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
    let w = Math.round(clamp(screen.availWidth * 0.36, 360, 720));
    let hgt = Math.round(w / ar);
    if (hgt > screen.availHeight * 0.6) { hgt = Math.round(screen.availHeight * 0.6); w = Math.round(hgt * ar); }

    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: w, height: hgt });
    } catch (e) {
      toast('Clique no botão "Flutuar" sobre o vídeo (ou use Alt+P) para abrir a janela.');
      return;
    }
    S.pip = pip;
    try {
      S.ctl = mountPip(pip, video);
    } catch (e) {
      console.error('[PiP Flutuante]', e);
      try { pip.close(); } catch (_) {}
      S.pip = null;
      return;
    }
    pip.addEventListener('pagehide', safe(() => {
      try { S.ctl && S.ctl.destroy(); } catch (_) {}
      S.ctl = null; S.pip = null;
      try { S.onPipClosed && S.onPipClosed(); } catch (_) {}
      // ação pedida junto com o fechamento (ex.: tela cheia na aba), depois que o vídeo voltou à página
      const after = S.afterPip; S.afterPip = null;
      if (after) setTimeout(safe(after), 200);
      if (S.dead) finalTeardown();
    }), { once: true });
  }

  // ---- tela cheia na aba (usada pelo botão de tela cheia da janela flutuante) ----
  // Elemento que vai para tela cheia: o player do site (com os controles dele), não só o <video>.
  function fsTarget(video) {
    if (IS_YT) { const mp = document.querySelector('#movie_player'); if (mp) return mp; }
    const vr = video.getBoundingClientRect();
    let el = video;
    for (let i = 0; i < 6 && el.parentElement && el.parentElement !== document.body; i++) {
      const pr = el.parentElement.getBoundingClientRect();
      if (Math.abs(pr.width - vr.width) > 12 || Math.abs(pr.height - vr.height) > 12) break;
      el = el.parentElement;
    }
    return el;
  }
  function enterFs(video) {
    if (IS_YT) { const b = document.querySelector('.ytp-fullscreen-button'); if (b) { b.click(); return; } }
    try { const p = fsTarget(video).requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }
  let disarmFs = null;
  // O Chrome só aceita tela cheia depois de um clique/tecla feito NA aba (o clique na janela flutuante
  // não conta). Se o pedido direto for recusado, o próximo clique ou tecla do usuário entra em tela cheia.
  function armFullscreen(video) {
    if (disarmFs) disarmFs();
    toast('Clique no vídeo (ou aperte uma tecla) para entrar em tela cheia');
    const swallow = (e) => { if (e.isTrusted) { e.stopImmediatePropagation(); e.preventDefault(); } };
    const onClick = (e) => { if (!e.isTrusted) return; swallow(e); disarm(); enterFs(video); };
    const onKeyDown = (e) => {
      if (!e.isTrusted || /^(Shift|Control|Alt|Meta)$/.test(e.key)) return;
      swallow(e); disarm();
      if (e.key !== 'Escape') enterFs(video);
    };
    const swallowEvs = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
    const timer = setTimeout(() => disarm(), 15000);
    function disarm() {
      clearTimeout(timer);
      swallowEvs.forEach(ev => removeEventListener(ev, swallow, true));
      removeEventListener('click', onClick, true);
      removeEventListener('keydown', onKeyDown, true);
      toastEl.classList.remove('show');
      disarmFs = null;
    }
    swallowEvs.forEach(ev => addEventListener(ev, swallow, true));
    addEventListener('click', onClick, true);
    addEventListener('keydown', onKeyDown, true);
    disarmFs = disarm;
  }
  function pageFullscreen(video) {
    if (S.dead || !video || !video.isConnected || document.fullscreenElement) return;
    enterFs(video);
    setTimeout(() => { if (!S.dead && !document.fullscreenElement) armFullscreen(video); }, 400);
  }
  S.pageCleanups.push(() => { if (disarmFs) disarmFs(); });

  // ---- devolver / tirar o vídeo da página ----
  function takeVideo(video) {
    const wasPlaying = !video.paused && !video.ended;
    const ph = document.createElement('div');
    ph.textContent = 'Reproduzindo na janela flutuante';
    const st = ph.style;
    st.display = 'flex'; st.alignItems = 'center'; st.justifyContent = 'center';
    st.background = '#000'; st.color = '#9aa0a6'; st.font = '500 14px system-ui, sans-serif';
    if (IS_YT && video.closest('#movie_player')) {
      st.position = 'absolute'; st.inset = '0';
    } else {
      const r = video.getBoundingClientRect();
      st.width = (r.width || video.offsetWidth) + 'px';
      st.height = (r.height || video.offsetHeight) + 'px';
    }
    const rec = { video, ph, style: video.style.cssText, wasPlaying };
    video.parentNode.insertBefore(ph, video);
    return rec;
  }

  // Facebook/Instagram guardam o "mudo" no estado do próprio site: o <video>.muted pode estar
  // true mesmo com o ícone da página em "som ligado". Lê o botão de som perto do vídeo
  // e devolve true (mudo) / false (com som) / null (não achou).
  const RE_PAGE_MUTED = /\bunmute\b|ativar (o )?(som|[aá]udio)|ligar (o )?som|turn (the )?sound on|audio is muted|[aá]udio (est[aá] )?(silenciado|desativado)|som desativado|sound is off|\bmuted\b|silenciado/i;
  const RE_PAGE_SOUND = /\bmute\b|silenciar|desativar (o )?(som|[aá]udio)|desligar (o )?som|turn (the )?sound off|audio is (on|playing)|[aá]udio (est[aá] )?(ativado|ligado)|som ativado|sound is on/i;
  function pageMutedState(video) {
    if (IS_YT) return null;
    let el = video;
    for (let i = 0; i < 10 && el && el !== document.documentElement; i++, el = el.parentElement) {
      for (const b of el.querySelectorAll('[aria-label], [title]')) {
        if (b === video || b.contains(video)) continue;
        const t = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
        if (!/mute|som|[aá]udio|sound|audio|silenc/i.test(t)) continue;
        if (RE_PAGE_MUTED.test(t)) return true;
        if (RE_PAGE_SOUND.test(t)) return false;
      }
    }
    return null;
  }

  function giveBack(rec, resume, discard) {
    const { video, ph, style } = rec;
    if (discard) { try { video.pause(); } catch (_) {} video.remove(); ph.remove(); return; }
    const playing = !video.paused && !video.ended;
    video.classList.remove('pipf-video');
    video.style.cssText = style;
    if (ph.isConnected) ph.replaceWith(video);
    else video.remove();
    if (resume && playing) video.play().catch(() => {});
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  }

  // =====================================================================
  //  PLAYER DENTRO DA JANELA FLUTUANTE
  // =====================================================================
  const PIP_CSS = `
    :root { --accent: #0f6cbd; --accent-h: #1a7fd6; color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    body { font: 13px/1.35 system-ui, "Segoe UI", Roboto, sans-serif; color: #fff; user-select: none; -webkit-user-select: none; }
    .stage { position: fixed; inset: 0; background: #000; }
    video.pipf-video {
      position: absolute !important; inset: 0 !important; left: 0 !important; top: 0 !important;
      width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      object-fit: contain !important; transform: none !important; margin: 0 !important; background: #000;
    }
    .ov { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between;
      background: linear-gradient(to bottom, rgba(0,0,0,.55), transparent 22%, transparent 62%, rgba(0,0,0,.75));
      transition: opacity .25s; }
    body.idle .ov { opacity: 0; }
    body.idle, body.idle * { cursor: none !important; }
    .top { display: flex; align-items: center; gap: 8px; padding: 8px 10px 0 14px; min-height: 40px; }
    .title { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 3px rgba(0,0,0,.6); }
    .badge { display: none; background: #f2c94c; color: #111; font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 4px; }
    body.ad .badge { display: inline-block; }
    .mid { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 22px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0;
      border: 0; border-radius: 50%; background: transparent; color: #fff; cursor: pointer; flex: none; transition: background .15s, transform .1s; }
    .btn:hover { background: rgba(255,255,255,.14); }
    .btn:active { transform: scale(.92); }
    .btn svg { width: 22px; height: 22px; fill: currentColor; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
    .btn svg .n10 { font: 700 6.6px system-ui, sans-serif; fill: currentColor; }
    .btn.on { color: #6cb6ff; }
    .btn[hidden] { display: none; }
    .btn.big { width: 56px; height: 56px; background: var(--accent); box-shadow: 0 4px 18px rgba(0,0,0,.4); }
    .btn.big:hover { background: var(--accent-h); }
    .btn.big svg { width: 28px; height: 28px; }
    .btn.seek svg { width: 26px; height: 26px; }
    .btn.txt { width: auto; min-width: 34px; padding: 0 8px; border-radius: 17px; font: 700 12px system-ui, sans-serif; }
    .spin { display: none; position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px;
      border: 3px solid rgba(255,255,255,.18); border-top-color: #fff; border-radius: 50%; animation: sp .9s linear infinite; pointer-events: none; }
    body.wait .spin { display: block; }
    body.wait .mid .big { opacity: 0; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .bot { padding: 0 10px 8px; }
    .row1 { display: flex; align-items: center; gap: 6px; }
    .prog { position: relative; flex: 1; height: 22px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
    .track { position: relative; width: 100%; height: 4px; border-radius: 2px; background: rgba(255,255,255,.28); transition: height .12s; }
    .prog:hover .track, .prog.drag .track { height: 6px; }
    .buf, .played { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; }
    .buf { background: rgba(255,255,255,.4); }
    .played { background: var(--accent-h); }
    .thumb { position: absolute; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%; background: #fff; transform: scale(.7); transition: transform .12s; box-shadow: 0 0 4px rgba(0,0,0,.5); }
    .prog:hover .thumb, .prog.drag .thumb { transform: scale(1); }
    .tip { position: absolute; bottom: 24px; transform: translateX(-50%); background: rgba(20,20,20,.92); padding: 3px 7px; border-radius: 5px; font: 600 12px system-ui, sans-serif; white-space: nowrap; display: none; pointer-events: none; }
    .prog:hover .tip, .prog.drag .tip { display: block; }
    body.live .prog { visibility: hidden; }
    .row2 { display: flex; align-items: center; gap: 2px; margin-top: 2px; }
    .time { font: 600 12px system-ui, sans-serif; font-variant-numeric: tabular-nums; padding: 0 6px; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
    .time .live { color: #ff4e45; }
    .grow { flex: 1; }
    .volw { display: flex; align-items: center; }
    .vol { -webkit-appearance: none; appearance: none; width: 0; opacity: 0; height: 4px; margin: 0; border-radius: 2px; cursor: pointer; transition: width .18s, opacity .18s, margin .18s;
      background: linear-gradient(to right, #fff var(--p, 100%), rgba(255,255,255,.3) var(--p, 100%)); }
    .volw:hover .vol, .vol:focus { width: 72px; opacity: 1; margin: 0 6px 0 2px; }
    .vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 0; }
    .menu { position: absolute; right: 10px; bottom: 74px; width: min(320px, calc(100% - 20px)); max-height: calc(100% - 92px); overflow-y: auto;
      background: rgba(28,28,28,.96); border-radius: 12px; padding: 8px 0; display: none; z-index: 6; box-shadow: 0 8px 28px rgba(0,0,0,.55);
      scrollbar-width: thin; scrollbar-color: #555 transparent; }
    .menu.open { display: block; }
    .menu .row { display: flex; align-items: center; gap: 14px; width: 100%; border: 0; background: transparent; color: #fff; padding: 9px 14px;
      font: 500 13.5px system-ui, "Segoe UI", Roboto, sans-serif; text-align: left; cursor: pointer; }
    .menu .row:hover { background: rgba(255,255,255,.1); }
    .menu .row:disabled { opacity: .4; cursor: default; }
    .menu .row svg { width: 22px; height: 22px; fill: currentColor; flex: none; }
    .menu .row .lbl { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .menu .row .val { color: #ccc; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 52%; }
    .menu .row .chev { width: 18px; height: 18px; opacity: .75; margin-left: -8px; }
    .menu .hd { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; border-bottom: 1px solid rgba(255,255,255,.14); background: transparent; color: #fff;
      padding: 4px 14px 10px; margin-bottom: 6px; font: 600 14px system-ui, "Segoe UI", Roboto, sans-serif; text-align: left; cursor: pointer; }
    .menu .hd svg { width: 22px; height: 22px; fill: currentColor; }
    .menu .opt .ck { visibility: hidden; }
    .menu .opt.sel .ck { visibility: visible; }
    .menu .opt.sel .lbl { font-weight: 700; }
    .menu .note { color: #999; font-size: 11.5px; padding: 6px 14px 4px; }
    .sw { position: relative; width: 36px; height: 20px; border-radius: 10px; background: #717171; flex: none; transition: background .15s; }
    .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
    .sw.on { background: var(--accent-h); }
    .sw.on::after { left: 18px; }
    .btn.gear svg { transition: transform .25s; }
    .btn.gear.on svg { transform: rotate(30deg); }
    .amb { position: absolute; left: -8%; top: -8%; width: 116%; height: 116%; filter: blur(34px) saturate(1.6) brightness(.9); opacity: 0; transition: opacity .5s; pointer-events: none; }
    body.ambient .amb { opacity: .9; }
    body.ambient video.pipf-video { inset: auto !important; right: auto !important; bottom: auto !important; left: 4% !important; top: 5% !important; width: 92% !important; height: 90% !important;
      background: transparent !important; border-radius: 10px; }
    .tbadge { display: none; font: 700 11px system-ui, sans-serif; background: rgba(255,255,255,.16); padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
    body.sleeping .tbadge { display: inline-block; }
    .skip { position: absolute; right: 12px; bottom: 76px; display: none; border: 1px solid rgba(255,255,255,.4); background: rgba(0,0,0,.7); color: #fff; padding: 8px 14px; font: 600 13px system-ui, sans-serif; border-radius: 6px; cursor: pointer; }
    .skip:hover { background: rgba(255,255,255,.15); }
    body.canskip .skip { display: block; }
    .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 88%); background: rgba(14,14,14,.97); display: flex; flex-direction: column;
      transform: translateX(105%); transition: transform .22s ease; box-shadow: -8px 0 28px rgba(0,0,0,.5); z-index: 5; }
    .panel.open { transform: none; }
    .ph { display: flex; align-items: flex-start; gap: 8px; padding: 12px 8px 10px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .ph .t { flex: 1; min-width: 0; }
    .ph .t b { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ph .t small { color: #aaa; font-size: 12px; }
    .items { flex: 1; overflow-y: auto; padding: 6px; scrollbar-width: thin; scrollbar-color: #444 transparent; }
    .it { display: flex; gap: 10px; align-items: flex-start; padding: 6px; border-radius: 8px; cursor: pointer; position: relative; }
    .it:hover { background: rgba(255,255,255,.08); }
    .it.cur { background: rgba(15,108,189,.28); }
    .it .n { width: 18px; flex: none; text-align: center; color: #aaa; font-size: 11px; padding-top: 18px; }
    .it.cur .n { color: #6cb6ff; }
    .it .th { position: relative; width: 104px; height: 58px; flex: none; border-radius: 6px; overflow: hidden; background: #222; }
    .it .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .it .th span { position: absolute; right: 3px; bottom: 3px; background: rgba(0,0,0,.8); font: 600 11px system-ui, sans-serif; padding: 1px 4px; border-radius: 3px; }
    .it .m { min-width: 0; flex: 1; }
    .it .m b { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; font-weight: 600; }
    .it .m small { display: block; color: #aaa; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { color: #aaa; padding: 24px 16px; text-align: center; }
    .subs { position: absolute; left: 0; right: 0; bottom: 16px; padding: 0 6%; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; transition: bottom .25s; }
    body:not(.idle) .subs { bottom: 84px; }
    .subs .ln { max-width: 100%; background: rgba(8,8,8,.78); color: #fff; padding: 1px 8px; border-radius: 3px; text-align: center; white-space: pre-wrap;
      font: 500 clamp(13px, 5.2vh, 34px)/1.3 "YouTube Noto", Roboto, Arial, sans-serif; }
    .flash { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); background: rgba(0,0,0,.7); padding: 6px 12px; border-radius: 16px; font: 700 13px system-ui, sans-serif; opacity: 0; transition: opacity .2s; pointer-events: none; }
    .flash.show { opacity: 1; }
    @media (max-width: 380px) { .opt { display: none !important; } .mid { gap: 10px; } .btn.big { width: 46px; height: 46px; } }
    @media (max-height: 200px) { .mid .seek { display: none; } .top { display: none; } }
  `;

  function pageTitle() {
    if (IS_YT) {
      const t = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, h1.ytd-video-primary-info-renderer');
      const s = t && t.textContent.trim();
      if (s) return s;
      return document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
    }
    return document.title || location.hostname;
  }

  const ytBtn = (sel) => {
    const b = document.querySelector(sel);
    if (!b) return null;
    const cs = getComputedStyle(b);
    if (cs.display === 'none' || cs.visibility === 'hidden' || b.getAttribute('aria-disabled') === 'true') return null;
    return b;
  };

  function vidId(href) {
    try { return new URL(href, location.href).searchParams.get('v') || ''; } catch (_) { return ''; }
  }

  function readQueue() {
    if (!IS_YT) return null;
    const panels = [...document.querySelectorAll('ytd-playlist-panel-renderer')]
      .filter(p => p.querySelector('ytd-playlist-panel-video-renderer'));
    const panel = panels.find(p => p.offsetParent) || panels[0];
    const txt = (root, sel) => { const n = root.querySelector(sel); return n ? n.textContent.replace(/\s+/g, ' ').trim() : ''; };
    if (panel) {
      const items = [...panel.querySelectorAll('ytd-playlist-panel-video-renderer')].map((r, i) => {
        const a = r.querySelector('a#wc-endpoint') || r.querySelector('a[href*="watch"]');
        return {
          id: vidId(a ? a.href : ''), a,
          title: txt(r, '#video-title'),
          sub: txt(r, '#byline, #channel-name'),
          dur: txt(r, 'ytd-thumbnail-overlay-time-status-renderer #text, .yt-badge-shape__text, badge-shape'),
          cur: r.hasAttribute('selected'),
          n: i + 1
        };
      }).filter(x => x.id);
      return {
        kind: 'playlist',
        title: txt(panel, '#header-description h3 yt-formatted-string, .title') || 'Playlist',
        sub: txt(panel, '.index-message, #publisher-container .index-message') || `${items.length} vídeos`,
        items
      };
    }
    const nodes = document.querySelectorAll(
      'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, ytd-watch-next-secondary-results-renderer yt-lockup-view-model, #related ytd-compact-video-renderer, #related yt-lockup-view-model');
    const seen = new Set(), items = [];
    for (const n of nodes) {
      const a = n.querySelector('a[href*="/watch?v="]');
      const id = a ? vidId(a.href) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id, a,
        title: txt(n, '#video-title, .yt-lockup-metadata-view-model__title, .yt-lockup-metadata-view-model-wiz__title, h3'),
        sub: txt(n, 'ytd-channel-name #text, .yt-content-metadata-view-model__metadata-text, .yt-content-metadata-view-model-wiz__metadata-text'),
        dur: txt(n, 'ytd-thumbnail-overlay-time-status-renderer #text, .yt-badge-shape__text, badge-shape'),
        cur: false, n: items.length + 1
      });
      if (items.length >= 25) break;
    }
    return { kind: 'next', title: 'A seguir', sub: 'Sugestões do YouTube', items };
  }

  function mountPip(pip, firstVideo) {
    const d = pip.document;
    const H = (...a) => h(d, ...a);
    addSheet(d, pip, PIP_CSS);
    d.title = pageTitle();

    const B = (name, title, cls) => {
      const b = H('button', { class: 'btn' + (cls ? ' ' + cls : ''), title, 'aria-label': title });
      b.append(icon(d, name));
      b._icon = name;
      return b;
    };
    const setIcon = (b, name) => { if (b._icon !== name) { b.replaceChildren(icon(d, name)); b._icon = name; } };

    // ---- montagem ----
    const ui = {
      stage: H('div', { class: 'stage' }),
      ov: H('div', { class: 'ov' }),
      title: H('div', { class: 'title' }),
      badge: H('span', { class: 'badge', text: 'Anúncio' }),
      back: B('back', 'Voltar para a aba'),
      r10: B('r10', 'Voltar 10s (J)', 'seek'),
      play: B('play', 'Reproduzir (Espaço)', 'big'),
      f10: B('f10', 'Avançar 10s (L)', 'seek'),
      spin: H('div', { class: 'spin' }),
      prev: B('prev', 'Anterior (Shift+P)'),
      next: B('next', 'Próximo (Shift+N)'),
      prog: H('div', { class: 'prog' }),
      track: H('div', { class: 'track' }),
      buf: H('div', { class: 'buf' }),
      played: H('div', { class: 'played' }),
      thumb: H('div', { class: 'thumb' }),
      tip: H('div', { class: 'tip' }),
      time: H('div', { class: 'time' }),
      loop: B('loop', 'Repetir vídeo', 'opt'),
      gear: B('gear', 'Configurações', 'gear'),
      full: B('fullscreen', 'Tela cheia na aba (F)'),
      amb: H('canvas', { class: 'amb', width: '48', height: '27' }),
      tbadge: H('span', { class: 'tbadge', title: 'Timer de suspensão' }),
      list: B('list', 'Playlist / A seguir'),
      cc: B('cc', 'Legendas (C)'),
      mute: B('volHigh', 'Silenciar (M)'),
      vol: H('input', { type: 'range', min: '0', max: '1', step: '0.01', class: 'vol', 'aria-label': 'Volume' }),
      menu: H('div', { class: 'menu' }),
      skip: H('button', { class: 'skip', text: 'Pular anúncio  ⏭' }),
      flash: H('div', { class: 'flash' }),
      subs: H('div', { class: 'subs', 'aria-live': 'polite' }),
      panel: H('aside', { class: 'panel' }),
      pTitle: H('b'), pSub: H('small'),
      pClose: B('close', 'Fechar lista'),
      items: H('div', { class: 'items' })
    };

    ui.track.append(ui.buf, ui.played, ui.thumb);
    ui.prog.append(ui.track, ui.tip);
    ui.ov.append(
      H('div', { class: 'top' }, ui.title, ui.tbadge, ui.badge, ui.back),
      H('div', { class: 'mid' }, ui.r10, ui.play, ui.f10),
      H('div', { class: 'bot' },
        H('div', { class: 'row1' }, ui.prev, ui.prog, ui.next),
        H('div', { class: 'row2' }, ui.time, H('div', { class: 'grow' }), ui.loop, ui.list, H('div', { class: 'volw' }, ui.vol, ui.mute), ui.cc, ui.gear, ui.full))
    );
    ui.panel.append(H('div', { class: 'ph' }, H('div', { class: 't' }, ui.pTitle, ui.pSub), ui.pClose), ui.items);
    ui.stage.append(ui.amb, ui.spin, ui.subs, ui.ov, ui.flash, ui.skip, ui.menu, ui.panel);
    d.body.append(ui.stage);

    if (!IS_YT) { ui.next.hidden = true; ui.list.hidden = true; ui.prev.title = 'Reiniciar'; }

    // ---- estado ----
    let v = null, rec = null, ac = null, dragging = false, idleT = 0, flashT = 0, queueSig = '';
    const cls = (c, on) => d.body.classList.toggle(c, !!on);

    function attach(video) {
      if (ac) ac.abort();
      ac = new AbortController();
      const o = { signal: ac.signal };
      rec = takeVideo(video);
      v = video;
      v.classList.add('pipf-video');
      ui.amb.after(v);
      if (rec.wasPlaying) v.play().catch(() => {});
      ['play', 'pause', 'playing', 'waiting', 'canplay', 'ended', 'seeked'].forEach(ev => v.addEventListener(ev, syncPlay, o));
      ['timeupdate', 'durationchange', 'progress', 'loadedmetadata', 'emptied'].forEach(ev => v.addEventListener(ev, syncTime, o));
      v.addEventListener('volumechange', syncVol, o);
      v.addEventListener('ratechange', syncRate, o);
      v.addEventListener('loadedmetadata', reapply, o);
      reapply();   // <video> novo (o YouTube recria): mantém o volume/velocidade que o usuário escolheu
      syncAll();
    }

    function detach(resume, discard) {
      if (ac) { ac.abort(); ac = null; }
      if (rec) { giveBack(rec, resume, discard); rec = null; }
      v = null;
    }

    function reapply() {
      if (!v) return;
      const p = S.prefs;
      if (p.volume != null && Math.abs(v.volume - p.volume) > 0.01) v.volume = p.volume;
      if (p.muted != null && v.muted !== p.muted) v.muted = p.muted;
      if (p.rate != null && !d.body.classList.contains('ad') && v.playbackRate !== p.rate) v.playbackRate = p.rate;
      d.title = pageTitle();
      queueSig = '';
    }

    // ---- sincronização da interface ----
    function syncPlay() {
      if (!v) return;
      const paused = v.paused || v.ended;
      setIcon(ui.play, paused ? 'play' : 'pause');
      ui.play.title = paused ? 'Reproduzir (Espaço)' : 'Pausar (Espaço)';
      cls('wait', !paused && v.readyState < 3);
      if (paused) showUI(); else bumpIdle();
    }

    function syncTime() {
      if (!v) return;
      const dur = v.duration, cur = v.currentTime;
      const rng = timeRange(v);
      // fora do YouTube, "duration = Infinity" só é ao vivo se não houver uma faixa navegável longa (Disney+ etc.)
      const live = IS_YT
        ? (dur === Infinity || (document.querySelector('.ytp-live-badge:not([disabled])') && !isFinite(dur)))
        : (dur === Infinity && !rng);
      cls('live', live);
      if (live) {
        ui.time.replaceChildren(H('span', { class: 'live', text: '● AO VIVO' }));
        return;
      }
      const start = rng ? rng.start : 0, len = rng ? rng.end - rng.start : 0;
      if (!dragging) {
        const p = len > 0 ? clamp((cur - start) / len, 0, 1) : 0;
        ui.played.style.width = (p * 100) + '%';
        ui.thumb.style.left = (p * 100) + '%';
      }
      let bufEnd = 0;
      try {
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= cur + 0.5) bufEnd = Math.max(bufEnd, v.buffered.end(i));
        }
      } catch (_) {}
      ui.buf.style.width = (len > 0 ? clamp((bufEnd - start) / len, 0, 1) * 100 : 0) + '%';
      ui.time.textContent = rng ? `${fmt(cur - start)} / ${fmt(len)}` : `${fmt(cur)} / ${fmt(dur)}`;
    }

    let volFixes = 0, volFixT = 0;
    function syncVol() {
      if (!v) return;
      // o site mexeu no volume por conta própria (ex.: YouTube reaplica o antigo ao trocar de vídeo/anúncio):
      // devolve o que o usuário escolheu. Não interfere no fade do timer de suspensão.
      // No máximo 5 correções por segundo: se o site insistir, desiste para não entrar em laço de eventos.
      const p = S.prefs;
      if (!sleep.fading && p.volume != null && (Math.abs(v.volume - p.volume) > 0.01 || (p.muted != null && v.muted !== p.muted))) {
        const now = Date.now();
        if (now - volFixT > 1000) { volFixT = now; volFixes = 0; }
        if (volFixes++ < 5) {
          v.volume = p.volume;
          if (p.muted != null) v.muted = p.muted;
          return;   // o evento gerado por essa correção volta aqui já com tudo certo
        }
      }
      const muted = v.muted || v.volume === 0;
      setIcon(ui.mute, muted ? 'volMute' : v.volume < 0.5 ? 'volLow' : 'volHigh');
      ui.mute.title = muted ? 'Ativar som (M)' : 'Silenciar (M)';
      const val = muted ? 0 : v.volume;
      ui.vol.value = String(val);
      ui.vol.style.setProperty('--p', Math.round(val * 100) + '%');
    }

    function syncRate() {
      if (!v) return;
      const r = v.playbackRate;
      if (ui.menu.classList.contains('open') && (menuView === 'main' || menuView === 'speed')) renderMenu();
      void r;
    }

    function syncAll() { syncPlay(); syncTime(); syncVol(); syncRate(); tick(); }

    function flash(msg) {
      ui.flash.textContent = msg;
      ui.flash.classList.add('show');
      clearTimeout(flashT);
      flashT = setTimeout(() => ui.flash.classList.remove('show'), 700);
    }

    // ---- ações ----
    const togglePlay = () => { if (!v) return; (v.paused || v.ended) ? v.play().catch(() => {}) : v.pause(); };
    const seekBy = (s) => {
      if (!v) return;
      const rng = timeRange(v);
      // sem faixa conhecida (ao vivo / site que não informa): tenta mesmo assim, sem passar de 0
      v.currentTime = rng ? clamp(v.currentTime + s, rng.start, rng.end - 0.1) : Math.max(0, v.currentTime + s);
      flash((s > 0 ? '+' : '−') + Math.abs(s) + 's');
    };
    // As preferências (S.prefs) são atualizadas ANTES do evento volumechange chegar; assim syncVol
    // consegue distinguir "o usuário mexeu" de "o site (YouTube) reaplicou o volume antigo".
    const setVol = (x) => {
      if (!v) return;
      x = clamp(Math.round(x * 100) / 100, 0, 1);
      S.prefs.volume = x; S.prefs.muted = x === 0;
      v.volume = x; v.muted = x === 0;
      flash('Volume ' + Math.round(x * 100) + '%');
    };
    const toggleMute = () => {
      if (!v) return;
      if (v.muted || v.volume === 0) { if (v.volume === 0) v.volume = 0.5; S.prefs.muted = false; v.muted = false; }
      else { S.prefs.muted = true; v.muted = true; }
      S.prefs.volume = v.volume;
    };
    const goNext = () => {
      if (!IS_YT) return;
      const b = ytBtn('.ytp-next-button');
      if (b) { b.click(); flash('Próximo ⏭'); }
    };
    const goPrev = () => {
      if (!v) return;
      const b = IS_YT && ytBtn('.ytp-prev-button');
      if (b && v.currentTime < 3) { b.click(); flash('⏮ Anterior'); }
      else { v.currentTime = 0; flash('⏮ Início'); }
    };
    const toggleCC = () => {
      if (IS_YT) {
        const b = ytBtn('.ytp-subtitles-button');
        if (b) { b.click(); setTimeout(tick, 150); }
        return;
      }
      const tracks = v ? [...v.textTracks].filter(t => t.kind === 'subtitles' || t.kind === 'captions') : [];
      if (!tracks.length) return;
      const on = tracks.some(t => t.mode === 'showing');
      tracks.forEach((t, i) => { t.mode = !on && i === 0 ? 'showing' : 'hidden'; });
      tick();
    };

    // ---- tela cheia ----
    // O Chrome não deixa a janela flutuante entrar em tela cheia nem passar de 80% da tela.
    // Então "tela cheia" = devolve o vídeo para a aba e pede a tela cheia lá (veja pageFullscreen).
    function toggleFull() {
      if (!v) return;
      const video = v;
      S.afterPip = () => pageFullscreen(video);
      if (alive()) { try { chrome.runtime.sendMessage({ type: 'pipf-focus-tab' }); } catch (_) {} }
      try { pip.close(); } catch (_) { S.afterPip = null; }
    }

    // ---- eventos da interface ----
    const on = (el, ev, fn, opt) => el.addEventListener(ev, safe(fn), opt);
    on(ui.full, 'click', (e) => { e.stopPropagation(); toggleFull(); });
    on(ui.play, 'click', togglePlay);
    on(ui.r10, 'click', () => seekBy(-10));
    on(ui.f10, 'click', () => seekBy(10));
    on(ui.prev, 'click', goPrev);
    on(ui.next, 'click', goNext);
    on(ui.cc, 'click', toggleCC);
    on(ui.mute, 'click', toggleMute);
    on(ui.vol, 'input', () => setVol(Number(ui.vol.value)));
    on(ui.loop, 'click', () => { if (!v) return; v.loop = !v.loop; ui.loop.classList.toggle('on', v.loop); flash(v.loop ? 'Repetir: ligado' : 'Repetir: desligado'); });
    on(ui.back, 'click', () => {
      if (alive()) { try { chrome.runtime.sendMessage({ type: 'pipf-focus-tab' }); } catch (_) {} }
      pip.close();
    });
    on(ui.skip, 'click', () => { const b = ytBtn('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button'); if (b) b.click(); });
    on(ui.ov, 'click', (e) => {
      if (e.target === ui.ov || e.target.classList.contains('mid') || e.target.classList.contains('top')) {
        if (ui.menu.classList.contains('open') || ui.panel.classList.contains('open')) closePopups();
        else togglePlay();
      }
    });

    // duplo clique no vídeo = tela cheia (os dois cliques do play/pause se anulam)
    on(ui.ov, 'dblclick', (e) => {
      if (e.target === ui.ov || e.target.classList.contains('mid') || e.target.classList.contains('top')) toggleFull();
    });

    // =================== CONFIGURAÇÕES (engrenagem) ===================
    let menuView = 'main', menuGen = 0;
    const QLABEL = { highres: '4320p', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };
    const sleep = { until: 0, end: false, fading: false, label: '' };
    let ambientOn = false, ambT = 0;

    const menuOpen = () => ui.menu.classList.contains('open');
    function openMenu(view) {
      ui.panel.classList.remove('open'); ui.list.classList.remove('on');
      menuView = view || 'main';
      ui.menu.classList.add('open'); ui.gear.classList.add('on');
      renderMenu();
    }
    function closeMenu() { ui.menu.classList.remove('open'); ui.gear.classList.remove('on'); menuView = 'main'; }

    const row = (iconName, label, value, onClick, opts = {}) => {
      const b = H('button', { class: 'row' + (opts.cls ? ' ' + opts.cls : '') });
      if (iconName) b.append(icon(d, iconName));
      b.append(H('span', { class: 'lbl', text: label }));
      if (opts.toggle != null) b.append(H('span', { class: 'sw' + (opts.toggle ? ' on' : '') }));
      else if (value != null) b.append(H('span', { class: 'val', text: value }));
      if (opts.chev) { const c = icon(d, 'chevR'); c.classList.add('chev'); b.append(c); }
      if (opts.disabled) b.disabled = true;
      on(b, 'click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    const opt = (label, selected, onClick, value) => {
      const b = row(null, label, value != null ? value : null, onClick, { cls: 'opt' + (selected ? ' sel' : '') });
      const ck = icon(d, 'check'); ck.classList.add('ck'); b.prepend(ck);
      return b;
    };
    const header = (title) => {
      const b = H('button', { class: 'hd' }, icon(d, 'chevL'), H('span', { text: title }));
      on(b, 'click', (e) => { e.stopPropagation(); menuView = 'main'; renderMenu(); });
      return b;
    };

    // --- legendas ---
    function ytCcOn() { const b = document.querySelector('.ytp-subtitles-button'); return !!b && b.getAttribute('aria-pressed') === 'true'; }
    function nativeTracks() { return v ? [...v.textTracks].filter(t => t.kind === 'subtitles' || t.kind === 'captions') : []; }
    function ccLabel(info) {
      if (IS_YT) {
        const t = info && info.track;
        if (!t || !ytCcOn()) return 'Desativadas';
        const base = (info.tracks.find(x => (t.vss_id && x.vss_id === t.vss_id) || (x.languageCode === t.languageCode && x.kind === t.kind)) || {}).name || t.name;
        return t.translationLanguage ? `${base} » ${t.translationLanguage.languageName}` : base;
      }
      const on = nativeTracks().find(t => t.mode === 'showing');
      return on ? (on.label || on.language || 'Ativadas') : 'Desativadas';
    }
    async function setCaptionsOff() {
      if (IS_YT) {
        const b = ytBtn('.ytp-subtitles-button');
        if (b && ytCcOn()) b.click(); else await ytCall('captionsOff');
      } else nativeTracks().forEach(t => { t.mode = 'hidden'; });
      flash('Legendas desativadas');
    }
    async function setYtTrack(track, translation) {
      const want = { languageCode: track.languageCode, kind: track.kind, vss_id: track.vss_id, translationLanguage: translation || null };
      await ytCall('setTrack', { track: want });
      flash(translation ? `Legendas: ${translation.languageName}` : `Legendas: ${track.name}`);
    }

    // --- qualidade ---
    function qualityLabel(info) {
      if (!info || !info.qualities || !info.qualities.length) return '';
      const cur = info.qualityLabel || QLABEL[info.quality] || '';
      return info.preferred && info.preferred !== 'auto' && info.preferred !== 'unknown'
        ? ((info.qualities.find(q => q.q === info.preferred) || {}).label || QLABEL[info.preferred] || cur)
        : (cur ? `Automático (${cur})` : 'Automático');
    }

    // --- timer de suspensão ---
    function sleepLabel() {
      if (sleep.end) return 'Fim do vídeo';
      if (!sleep.until) return 'Desat.';
      return fmt(Math.max(0, (sleep.until - Date.now()) / 1000));
    }
    function setSleep(min) {
      sleep.until = 0; sleep.end = false;
      if (min === 'end') { sleep.end = true; flash('Timer: pausa no fim do vídeo'); }
      else if (min) { sleep.until = Date.now() + min * 60000; flash(`Timer: ${min} min`); }
      else flash('Timer desativado');
      cls('sleeping', sleep.end || sleep.until);
      updateSleepBadge();
    }
    function updateSleepBadge() {
      ui.tbadge.textContent = sleep.end ? '☾ fim do vídeo' : sleep.until ? '☾ ' + sleepLabel() : '';
    }
    function doSleep(now) {
      sleep.until = 0; sleep.end = false; cls('sleeping', false);
      if (!v) return;
      if (now) { v.pause(); flash('Timer de suspensão: pausado'); return; }
      sleep.fading = true;
      const vid = v, vol0 = vid.volume;
      let k = 0;
      const t = setInterval(() => {
        k++;
        try { vid.volume = Math.max(0, vol0 * (1 - k / 20)); } catch (_) {}
        if (k >= 20) {
          clearInterval(t);
          try { vid.pause(); vid.volume = vol0; } catch (_) {}
          sleep.fading = false;
          flash('Timer de suspensão: pausado');
        }
      }, 200);
    }
    function sleepTick() {
      if (!v || sleep.fading) return;
      if (sleep.until) {
        updateSleepBadge();
        if (Date.now() >= sleep.until) doSleep(false);
      } else if (sleep.end && !v.paused) {
        const rng = timeRange(v);
        if (rng && rng.end - v.currentTime < 1.2) doSleep(true);
      }
      if (menuOpen() && menuView === 'main' && ui.sleepVal) ui.sleepVal.textContent = sleepLabel();
    }

    // --- iluminação cinematográfica ---
    function setAmbient(onOff, silent) {
      ambientOn = !!onOff;
      cls('ambient', ambientOn);
      clearInterval(ambT);
      if (ambientOn) {
        const ctx = ui.amb.getContext('2d');
        const draw = () => { try { if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, ui.amb.width, ui.amb.height); } catch (_) {} };
        draw();
        ambT = setInterval(draw, 140);
      }
      if (!silent) { store.set('ambient', ambientOn); flash(ambientOn ? 'Iluminação cinematográfica: ativada' : 'Iluminação cinematográfica: desativada'); }
    }
    store.get('ambient', false).then(val => { if (val) setAmbient(true, true); });

    // --- renderização do menu ---
    async function renderMenu() {
      const gen = ++menuGen, view = menuView;
      const info = IS_YT ? await ytCall('info') : null;
      if (gen !== menuGen || !menuOpen()) return;
      const items = [];
      ui.sleepVal = null;

      if (view === 'main') {
        items.push(row('ambient', 'Iluminação cinematográfica', null, () => { setAmbient(!ambientOn); renderMenu(); }, { toggle: ambientOn }));
        if (IS_TOP) items.push(row('float', 'Abrir sozinha ao sair da aba', null, () => {
          S.autoPip = !S.autoPip;
          store.set('autoPip', S.autoPip);
          syncAutoHandler();
          flash(S.autoPip ? 'Abertura automática: ativada' : 'Abertura automática: desativada');
          renderMenu();
        }, { toggle: S.autoPip }));
        const hasCC = IS_YT ? !!(info && info.tracks && info.tracks.length) || !!document.querySelector('.ytp-subtitles-button') : nativeTracks().length > 0;
        if (hasCC) items.push(row('cc', 'Legendas/CC', ccLabel(info), () => { menuView = 'cc'; renderMenu(); }, { chev: true }));
        const sr = row('timer', 'Timer de suspensão', sleepLabel(), () => { menuView = 'sleep'; renderMenu(); }, { chev: true });
        ui.sleepVal = sr.querySelector('.val');
        items.push(sr);
        const rate = v ? v.playbackRate : 1;
        items.push(row('speedo', 'Velocidade da reprodução', rate === 1 ? 'Normal' : rate + 'x', () => { menuView = 'speed'; renderMenu(); }, { chev: true }));
        const ql = qualityLabel(info);
        if (ql) items.push(row('tune', 'Qualidade', ql, () => { menuView = 'quality'; renderMenu(); }, { chev: true }));
      }

      else if (view === 'speed') {
        items.push(header('Velocidade da reprodução'));
        const cur = v ? v.playbackRate : 1;
        for (const r of RATES) items.push(opt(r === 1 ? 'Normal' : r + 'x', Math.abs(cur - r) < 0.001, () => {
          if (v) { v.playbackRate = r; S.prefs.rate = r; flash(r === 1 ? 'Velocidade normal' : r + 'x'); }
          closeMenu();
        }));
      }

      else if (view === 'sleep') {
        items.push(header('Timer de suspensão'));
        const curMin = sleep.until ? null : undefined;
        items.push(opt('Desativado', !sleep.until && !sleep.end, () => { setSleep(0); closeMenu(); }));
        for (const m of [10, 15, 20, 30, 45, 60, 90]) items.push(opt(`${m} minutos`, false, () => { setSleep(m); closeMenu(); }));
        items.push(opt('Fim do vídeo', sleep.end, () => { setSleep('end'); closeMenu(); }));
        if (sleep.until) items.push(H('div', { class: 'note', text: `Pausa em ${sleepLabel()} (o som vai abaixando antes).` }));
        void curMin;
      }

      else if (view === 'quality') {
        items.push(header('Qualidade'));
        if (info && info.qualities && info.qualities.length) {
          const pref = info.preferred && info.preferred !== 'unknown' ? info.preferred : 'auto';
          for (const q of info.qualities) items.push(opt(q.label, pref === q.q, async () => {
            await ytCall('setQuality', { q: q.q }); flash('Qualidade: ' + q.label);
            closeMenu();
          }));
          const cur = info.qualityLabel || QLABEL[info.quality] || '';
          items.push(opt('Automático', pref === 'auto', async () => {
            await ytCall('setQuality', { q: 'auto' }); flash('Qualidade: automática');
            closeMenu();
          }, pref === 'auto' && cur ? cur : null));
        } else items.push(H('div', { class: 'note', text: 'Qualidade indisponível neste vídeo.' }));
      }

      else if (view === 'cc') {
        items.push(header('Legendas/CC'));
        if (IS_YT) {
          const t = info && info.track && ytCcOn() ? info.track : null;
          items.push(opt('Desativadas', !t, async () => { await setCaptionsOff(); closeMenu(); }));
          for (const tr of (info && info.tracks) || []) {
            const sel = !!t && !t.translationLanguage && ((t.vss_id && t.vss_id === tr.vss_id) || (t.languageCode === tr.languageCode && t.kind === tr.kind));
            items.push(opt(tr.name, sel, async () => { await setYtTrack(tr, null); closeMenu(); }));
          }
          if (info && info.translations && info.translations.length && info.tracks.length) {
            const tl = t && t.translationLanguage;
            items.push(row('translate', 'Traduzir automaticamente', tl ? tl.languageName : null, () => { menuView = 'translate'; renderMenu(); }, { chev: true }));
          }
          if (!info) items.push(H('div', { class: 'note', text: 'Recarregue a aba do YouTube (F5) uma vez para liberar a escolha de idioma.' }));
        } else {
          const tracks = nativeTracks();
          const showing = tracks.find(x => x.mode === 'showing');
          items.push(opt('Desativadas', !showing, () => { setCaptionsOff(); closeMenu(); }));
          tracks.forEach((tr, i) => items.push(opt(tr.label || tr.language || `Faixa ${i + 1}`, tr === showing, () => {
            tracks.forEach(x => { x.mode = x === tr ? 'showing' : 'hidden'; });
            flash('Legendas: ' + (tr.label || tr.language || `Faixa ${i + 1}`));
            closeMenu();
          })));
        }
      }

      else if (view === 'translate') {
        items.push(header('Traduzir automaticamente'));
        const t = info && info.track && ytCcOn() ? info.track : null;
        // usa a faixa ativa como origem; se nenhuma estiver ligada, prefere uma faixa manual, senão a automática
        const src = (t && info.tracks.find(x => (t.vss_id && x.vss_id === t.vss_id) || (x.languageCode === t.languageCode && x.kind === t.kind)))
          || (info && (info.tracks.find(x => x.kind !== 'asr') || info.tracks[0]));
        const langs = ((info && info.translations) || []).slice();
        const pt = langs.findIndex(l => l.languageCode === 'pt');
        if (pt > 0) langs.unshift(langs.splice(pt, 1)[0]);
        const curTl = t && t.translationLanguage && t.translationLanguage.languageCode;
        for (const l of langs) items.push(opt(l.languageName, curTl === l.languageCode, async () => {
          if (src) await setYtTrack(src, { languageCode: l.languageCode, languageName: l.languageName });
          closeMenu();
        }));
      }

      ui.menu.replaceChildren(...items);
      if (view !== 'main') {
        const sel = ui.menu.querySelector('.opt.sel');
        if (sel && view === 'translate') sel.scrollIntoView({ block: 'center' }); else ui.menu.scrollTop = 0;
      }
    }

    on(ui.gear, 'click', (e) => { e.stopPropagation(); menuOpen() ? closeMenu() : openMenu('main'); });

    // playlist
    on(ui.list, 'click', (e) => {
      e.stopPropagation();
      closeMenu();
      const open = !ui.panel.classList.contains('open');
      ui.panel.classList.toggle('open', open);
      ui.list.classList.toggle('on', open);
      if (open) { queueSig = ''; renderQueue(true); }
    });
    on(ui.pClose, 'click', () => { ui.panel.classList.remove('open'); ui.list.classList.remove('on'); });

    function closePopups() {
      closeMenu();
      ui.panel.classList.remove('open');
      ui.list.classList.remove('on');
    }
    on(d, 'click', (e) => { if (menuOpen() && !ui.menu.contains(e.target) && !ui.gear.contains(e.target)) closeMenu(); });

    function renderQueue(scroll) {
      if (!ui.panel.classList.contains('open')) return;
      const q = readQueue();
      if (!q) return;
      const sig = q.kind + '|' + q.title + '|' + q.sub + '|' + q.items.map(i => i.id + (i.cur ? '*' : '')).join(',');
      if (sig === queueSig) return;
      queueSig = sig;
      ui.pTitle.textContent = q.title;
      ui.pSub.textContent = q.sub;
      if (!q.items.length) {
        ui.items.replaceChildren(H('div', { class: 'empty', text: 'Nada na fila. Abra uma playlist no YouTube para ver os vídeos aqui.' }));
        return;
      }
      let curEl = null;
      const els = q.items.map(it => {
        const img = H('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', src: `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg` });
        const row = H('div', { class: 'it' + (it.cur ? ' cur' : ''), title: it.title },
          H('div', { class: 'n', text: it.cur ? '▶' : String(it.n) }),
          H('div', { class: 'th' }, img, it.dur && /\d:\d/.test(it.dur) ? H('span', { text: it.dur }) : null),
          H('div', { class: 'm' }, H('b', { text: it.title || '(sem título)' }), it.sub ? H('small', { text: it.sub }) : null));
        on(row, 'click', () => {
          let a = it.a && it.a.isConnected ? it.a : null;
          if (!a) { const f = readQueue(); const m = f && f.items.find(x => x.id === it.id); a = m && m.a; }
          if (a) { a.click(); flash('Carregando…'); queueSig = ''; }
        });
        if (it.cur) curEl = row;
        return row;
      });
      ui.items.replaceChildren(...els);
      if (curEl && scroll) curEl.scrollIntoView({ block: 'center' });
    }

    // barra de progresso (clicar e arrastar)
    const ratioAt = (e) => { const r = ui.track.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    const preview = (e) => {
      if (!v) return;
      const p = ratioAt(e);
      ui.tip.style.left = (p * 100) + '%';
      const rng = timeRange(v);
      ui.tip.textContent = fmt(rng ? p * (rng.end - rng.start) : NaN);
      if (dragging) { ui.played.style.width = (p * 100) + '%'; ui.thumb.style.left = (p * 100) + '%'; }
    };
    on(ui.prog, 'pointerdown', (e) => {
      if (!v || !timeRange(v) || e.button !== 0) return;
      dragging = true; ui.prog.classList.add('drag');
      ui.prog.setPointerCapture(e.pointerId);
      preview(e);
    });
    on(ui.prog, 'pointermove', preview);
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false; ui.prog.classList.remove('drag');
      const rng = v && timeRange(v);
      if (rng) v.currentTime = rng.start + ratioAt(e) * (rng.end - rng.start);
    };
    on(ui.prog, 'pointerup', endDrag);
    on(ui.prog, 'pointercancel', () => { dragging = false; ui.prog.classList.remove('drag'); syncTime(); });

    // roda do mouse = volume
    on(ui.stage, 'wheel', (e) => {
      if (ui.panel.contains(e.target) || ui.menu.contains(e.target)) return;
      e.preventDefault();
      if (v) setVol(v.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });

    // esconder controles quando parado
    function showUI() { cls('idle', false); clearTimeout(idleT); }
    function bumpIdle() {
      showUI();
      idleT = setTimeout(() => {
        if (v && !v.paused && !dragging && !ui.menu.classList.contains('open') && !ui.panel.classList.contains('open')) cls('idle', true);
      }, 2500);
    }
    on(d, 'pointermove', bumpIdle);
    on(d.documentElement, 'pointerleave', () => { if (v && !v.paused && !dragging) { clearTimeout(idleT); idleT = setTimeout(() => cls('idle', true), 600); } });

    // atalhos de teclado
    on(d, 'keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT' && /Arrow/.test(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      switch (e.key) {
        case ' ': case 'k': case 'K': togglePlay(); break;
        case 'ArrowLeft': seekBy(-5); break;
        case 'ArrowRight': seekBy(5); break;
        case 'j': case 'J': seekBy(-10); break;
        case 'l': case 'L': seekBy(10); break;
        case 'ArrowUp': if (v) setVol(v.volume + 0.05); break;
        case 'ArrowDown': if (v) setVol(v.volume - 0.05); break;
        case 'm': case 'M': toggleMute(); break;
        case 'c': case 'C': toggleCC(); break;
        case 'N': if (e.shiftKey) goNext(); else handled = false; break;
        case 'P': if (e.shiftKey) goPrev(); else handled = false; break;
        case '>': if (v) { const i = RATES.indexOf(v.playbackRate); const r = RATES[Math.min(RATES.length - 1, (i < 0 ? 3 : i) + 1)]; v.playbackRate = r; S.prefs.rate = r; flash(r + 'x'); } break;
        case '<': if (v) { const i = RATES.indexOf(v.playbackRate); const r = RATES[Math.max(0, (i < 0 ? 3 : i) - 1)]; v.playbackRate = r; S.prefs.rate = r; flash(r + 'x'); } break;
        case 'f': case 'F': toggleFull(); break;
        case 'Escape': closePopups(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); bumpIdle(); }
    });

    // ---- verificação periódica: anúncios, legendas, título, troca de <video>, fila ----
    let n = 0;
    function tick() {
      if (!v) return;
      n++;
      if (IS_YT) {
        // o YouTube às vezes cria um novo <video>: troca para ele sem fechar a janela
        const cur = document.querySelector('#movie_player video.html5-main-video, #movie_player video');
        if (cur && cur !== v && cur.isConnected && cur.ownerDocument === document) {
          detach(false, true);
          attach(cur);
          return;
        }
        const mp = document.querySelector('#movie_player');
        cls('ad', mp && mp.classList.contains('ad-showing'));
        cls('canskip', !!ytBtn('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button'));
        const ccb = ytBtn('.ytp-subtitles-button');
        ui.cc.hidden = !ccb;
        ui.cc.classList.toggle('on', !!ccb && ccb.getAttribute('aria-pressed') === 'true');
        ui.next.disabled = !ytBtn('.ytp-next-button');
        ui.next.style.opacity = ui.next.disabled ? '.35' : '';
      } else {
        const tracks = [...v.textTracks].filter(t => t.kind === 'subtitles' || t.kind === 'captions');
        ui.cc.hidden = !tracks.length;
        ui.cc.classList.toggle('on', tracks.some(t => t.mode === 'showing'));
      }
      ui.loop.classList.toggle('on', v.loop);
      watchSubs();
      sleepTick();
      const t = pageTitle();
      if (ui.title.textContent !== t) { ui.title.textContent = t; d.title = t; }
      if (n % 3 === 0) renderQueue(false);
    }
    // ---- legendas do YouTube: o YouTube desenha o texto no próprio player (não usa textTracks),
    //      então espelhamos esse texto dentro da janela flutuante ----
    let subObs = null, subTarget = null, subSig = '';
    function syncSubs() {
      const lines = [];
      if (subTarget && subTarget.isConnected) {
        for (const w of subTarget.querySelectorAll('.caption-window')) {
          if (getComputedStyle(w).display === 'none') continue;
          const vis = w.querySelectorAll('.caption-visual-line');
          if (vis.length) {
            vis.forEach(l => { const t = [...l.querySelectorAll('.ytp-caption-segment')].map(x => x.textContent).join('') || l.textContent; if (t.trim()) lines.push(t.trim()); });
          } else {
            w.textContent.split('\n').forEach(t => { if (t.trim()) lines.push(t.trim()); });
          }
        }
      }
      const sig = lines.join('\n');
      if (sig === subSig) return;
      subSig = sig;
      ui.subs.replaceChildren(...lines.map(t => H('span', { class: 'ln', text: t })));
    }
    function watchSubs() {
      if (!IS_YT) return;
      const c = document.querySelector('#movie_player .ytp-caption-window-container');
      if (c !== subTarget) {
        if (subObs) subObs.disconnect();
        subObs = null; subTarget = c;
        if (c) {
          subObs = new MutationObserver(safe(syncSubs));
          subObs.observe(c, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
        }
      }
      syncSubs();
    }

    const tickT = setInterval(safe(tick), 500);
    const onNav = safe(() => { queueSig = ''; setTimeout(safe(() => { reapply(); renderQueue(true); }), 400); });
    document.addEventListener('yt-navigate-finish', onNav);

    // som: o que vale ao abrir é o estado da página, não preferências de uma abertura anterior
    S.prefs.volume = null; S.prefs.muted = null;
    const pageMuted = pageMutedState(firstVideo);
    attach(firstVideo);
    if (pageMuted === false && firstVideo.muted) {
      // a página mostra "som ligado" mas o <video> está mudo (e o site pode re-mutar ao perder o vídeo):
      // desmuta e reforça por alguns segundos, até o usuário mexer no som
      let userTouched = false, tries = 0;
      const markTouched = () => { userTouched = true; };
      ui.mute.addEventListener('click', markTouched, { once: true });
      ui.vol.addEventListener('input', markTouched, { once: true });
      const fixT = setInterval(safe(() => {
        if (userTouched || S.prefs.muted === true || !v || ++tries > 12) { clearInterval(fixT); return; }
        if (v.muted) { v.muted = false; if (v.volume === 0) v.volume = 1; }
      }), 250);
      S.pageCleanups.push(() => clearInterval(fixT));
      firstVideo.muted = false;
      if (firstVideo.volume === 0) firstVideo.volume = 1;
    }
    bumpIdle();

    return {
      refreshMenu() { if (menuOpen()) renderMenu(); },
      destroy() {
        clearInterval(tickT);
        clearInterval(ambT);
        if (subObs) subObs.disconnect();
        clearTimeout(idleT);
        document.removeEventListener('yt-navigate-finish', onNav);
        detach(true);
      }
    };
  }

  // =====================================================================
  //  CICLO DE VIDA (atualização da extensão sem quebrar)
  // =====================================================================
  function stopPage() {
    if (S.dead) return;
    S.dead = true;
    S.pageCleanups.forEach(f => { try { f(); } catch (_) {} });
    try { host.remove(); } catch (_) {}
    clearInterval(aliveT);
  }
  function finalTeardown() { stopPage(); }

  // uma versão nova foi injetada: desliga a interface desta, mas mantém a janela PiP aberta até o usuário fechar
  const onTeardown = () => { document.removeEventListener('pipf-teardown', onTeardown); stopPage(); };
  document.addEventListener('pipf-teardown', onTeardown);

  // extensão removida/desativada: limpa sozinho
  const aliveT = setInterval(() => { if (!alive() && !S.pip) { document.removeEventListener('pipf-teardown', onTeardown); stopPage(); } }, 5000);
})();
