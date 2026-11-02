// PiP Flutuante — service worker
// 1) Ao instalar/atualizar/recarregar a extensão, reinjeta o script em todas as abas abertas,
//    assim nada "quebra" e não é preciso dar F5 nas páginas.
// 2) Clique no ícone da extensão = abre/fecha a janela flutuante na aba atual.
// 3) Botão "voltar para a aba" dentro da janela flutuante.

const MATCHES = ['http://*/*', 'https://*/*'];

async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js']
    });
    return true;
  } catch (_) {
    return false; // abas protegidas (Web Store, páginas de erro etc.)
  }
}

const YT = /^https:\/\/(www|m|music)\.youtube\.com\//;

async function injectBridge(tab) {
  if (!YT.test(tab.url || '')) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['yt-bridge.js'], world: 'MAIN' });
  } catch (_) {}
}

async function reinjectAll() {
  const tabs = await chrome.tabs.query({ url: MATCHES });
  await Promise.all(tabs.map(async t => {
    if (t.discarded) return;
    await injectBridge(t);
    await injectInto(t.id);
  }));
}

// ---- menu do botão direito no ícone: ligar/desligar a abertura automática ----
const AUTO_ID = 'pipf-auto';
// onStartup e onInstalled podem disparar juntos: as chamadas são enfileiradas para não criar o item duas vezes.
let menuQueue = Promise.resolve();
function setupMenu() {
  menuQueue = menuQueue.then(async () => {
    const { autoPip } = await chrome.storage.local.get('autoPip');
    await new Promise((resolve) => {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        chrome.contextMenus.create({
          id: AUTO_ID, type: 'checkbox', contexts: ['action'],
          title: 'Abrir janela flutuante ao sair da aba / minimizar',
          checked: autoPip !== false
        }, () => { void chrome.runtime.lastError; resolve(); });
      });
    });
  }).catch(() => {});
  return menuQueue;
}
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === AUTO_ID) chrome.storage.local.set({ autoPip: !!info.checked });
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && 'autoPip' in ch) {
    chrome.contextMenus.update(AUTO_ID, { checked: ch.autoPip.newValue !== false }).catch?.(() => {});
  }
});
chrome.runtime.onStartup.addListener(setupMenu);

chrome.runtime.onInstalled.addListener(() => { setupMenu(); reinjectAll(); });

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const msg = { type: 'pipf-toggle' };
  try {
    await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch (_) {
    // script ainda não estava na aba: injeta e tenta de novo
    await injectBridge(tab);
    if (await injectInto(tab.id)) {
      try { await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }); } catch (_) {}
    }
  }
});

// ---- download de mídia do Instagram (botão na barra de ações do post) ----
// Só aceita endereços https do CDN do Instagram/Facebook.
const DL_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'pipf-focus-tab' && sender.tab) {
    chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
    chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  if (msg?.type === 'pipf-download') {
    let u = null;
    try { u = new URL(msg.url); } catch (_) {}
    if (!u || u.protocol !== 'https:' || !DL_HOSTS.test(u.hostname)) {
      sendResponse({ ok: false, error: 'endereço não permitido' });
      return;
    }
    const filename = String(msg.filename || '')
      .replace(/[<>:"\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/^\/+/, '')
      .slice(0, 150);
    chrome.downloads.download({ url: u.href, filename: filename || undefined, conflictAction: 'uniquify' }, (id) => {
      const err = chrome.runtime.lastError;
      sendResponse(err || id == null ? { ok: false, error: err ? err.message : 'falha ao iniciar' } : { ok: true });
    });
    return true; // resposta assíncrona
  }
});
