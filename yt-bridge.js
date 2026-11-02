// PiP Flutuante — ponte com o player do YouTube (roda no "mundo" da página).
// O script principal da extensão fica isolado e não enxerga a API interna do player
// (qualidade, faixas de legenda, tradução). Esta ponte recebe pedidos por eventos e responde.
(() => {
  'use strict';
  const V = 3;
  if (window.__pipfBridge && window.__pipfBridge.v >= V) return;
  try { window.__pipfBridge && window.__pipfBridge.off(); } catch (_) {}

  const P = () => document.getElementById('movie_player');
  const LABEL = {
    highres: '4320p', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
    hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Automático'
  };
  const txt = (n) => (n && (n.simpleText || (n.runs || []).map(r => r.text).join(''))) || '';

  function captionLists(p) {
    let resp = null;
    try { resp = p.getPlayerResponse && p.getPlayerResponse(); } catch (_) {}
    const r = resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer;
    return {
      tracks: ((r && r.captionTracks) || []).map(t => ({
        languageCode: t.languageCode, name: txt(t.name) || t.languageCode, kind: t.kind || '', vss_id: t.vssId || ''
      })),
      translations: ((r && r.translationLanguages) || []).map(t => ({
        languageCode: t.languageCode, languageName: txt(t.languageName) || t.languageCode
      }))
    };
  }

  function currentTrack(p) {
    let t = null;
    try { t = p.getOption('captions', 'track'); } catch (_) {}
    if (!t || !t.languageCode) return null;
    return {
      languageCode: t.languageCode, kind: t.kind || '', vss_id: t.vss_id || '',
      name: t.displayName || t.languageName || t.languageCode,
      translationLanguage: t.translationLanguage
        ? { languageCode: t.translationLanguage.languageCode, languageName: t.translationLanguage.languageName }
        : null
    };
  }

  function applyTrack(p, want) {
    let list = [];
    try { list = p.getOption('captions', 'tracklist') || []; } catch (_) {}
    const found = list.find(t => want.vss_id && t.vss_id === want.vss_id)
      || list.find(t => t.languageCode === want.languageCode && (t.kind || '') === (want.kind || ''))
      || list.find(t => t.languageCode === want.languageCode);
    const obj = Object.assign({}, found || { languageCode: want.languageCode, kind: want.kind, vss_id: want.vss_id });
    if (want.translationLanguage) obj.translationLanguage = want.translationLanguage;
    else delete obj.translationLanguage;
    p.setOption('captions', 'track', obj);
    return !!found;
  }

  const cmds = {
    info() {
      const p = P();
      if (!p || !p.getAvailableQualityLevels) return null;
      let qualities = [];
      try {
        qualities = ((p.getAvailableQualityData && p.getAvailableQualityData()) || [])
          .filter(q => q.quality && q.quality !== 'auto')
          .map(q => ({ q: q.quality, label: q.qualityLabel || LABEL[q.quality] || q.quality, playable: q.isPlayable !== false }));
      } catch (_) {}
      if (!qualities.length) {
        qualities = (p.getAvailableQualityLevels() || []).filter(l => l !== 'auto')
          .map(l => ({ q: l, label: LABEL[l] || l, playable: true }));
      }
      const cur = p.getPlaybackQuality ? p.getPlaybackQuality() : '';
      let preferred = 'auto';
      try { preferred = (p.getPreferredQuality && p.getPreferredQuality()) || 'auto'; } catch (_) {}
      const curLabel = (qualities.find(x => x.q === cur) || {}).label || LABEL[cur] || cur || '';
      const lists = captionLists(p);
      return { qualities, quality: cur, qualityLabel: curLabel, preferred, track: currentTrack(p), tracks: lists.tracks, translations: lists.translations };
    },

    setQuality({ q }) {
      const p = P();
      if (!p) return false;
      if (q === 'auto') {
        try { p.setPlaybackQualityRange('auto', 'auto'); } catch (_) {}
        try { p.setPlaybackQuality && p.setPlaybackQuality('auto'); } catch (_) {}
      } else {
        try { p.setPlaybackQualityRange(q, q); } catch (_) {}
        try { p.setPlaybackQuality && p.setPlaybackQuality(q); } catch (_) {}
      }
      return true;
    },

    setTrack({ track }) {
      const p = P();
      if (!p || !track) return false;
      try { p.loadModule('captions'); } catch (_) {}
      if (!applyTrack(p, track)) {
        // a lista de faixas pode demorar um instante para carregar depois do loadModule
        setTimeout(() => { try { applyTrack(p, track); } catch (_) {} }, 350);
      }
      return true;
    },

    captionsOff() {
      const p = P();
      if (!p) return false;
      try { p.unloadModule('captions'); } catch (_) {}
      return true;
    }
  };

  const onReq = (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (_) { return; }
    if (!req || !req.id) return;
    let result = null, error = null;
    try { result = cmds[req.cmd] ? cmds[req.cmd](req.args || {}) : null; } catch (err) { error = String(err); }
    document.dispatchEvent(new CustomEvent('pipf-yt-res', { detail: JSON.stringify({ id: req.id, result, error }) }));
  };
  document.addEventListener('pipf-yt-req', onReq);
  window.__pipfBridge = { v: V, off() { document.removeEventListener('pipf-yt-req', onReq); } };
})();
