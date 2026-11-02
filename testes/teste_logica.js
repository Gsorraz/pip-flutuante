// Testes de lógica da extensão PiP Flutuante (v1.4.0, yt-bridge V=3). Roda só com Node, SEM navegador e SEM janelas.
// Uso:  node testes\teste_logica.js      (ou testes\rodar_testes.ps1)
// Estilo igual ao Atualizador de Apps: chk(condição, "descrição"). Última linha: "RESULTADO ok=N falhas=M avisos=K".
// aviso(...) = risco observado que NÃO conta como falha (ex.: laço possível se o site brigar pelo volume).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const SRC = ler('content.js');
const SRC_BG = ler('background.js');
const SRC_BR = ler('yt-bridge.js');

let ok = 0, falhas = 0, avisos = 0;
function chk(cond, desc) {
  if (cond) { ok++; } else { falhas++; console.log('FALHA ' + desc); }
}
function aviso(condRisco, desc) {
  if (condRisco) { avisos++; console.log('AVISO ' + desc); } else { ok++; }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const perto = (a, b) => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------- utilitários de extração
function casarChaves(src, ini) {
  let j = src.indexOf('{', ini), prof = 0;
  if (j < 0) throw new Error('sem chave a partir de ' + ini);
  for (; j < src.length; j++) {
    if (src[j] === '{') prof++;
    else if (src[j] === '}') { prof--; if (prof === 0) return j; }
  }
  throw new Error('chaves não balanceadas');
}
function extrairFuncao(src, nome) {
  const i = src.indexOf('function ' + nome + '(');
  if (i < 0) throw new Error('função não encontrada: ' + nome);
  return src.slice(i, casarChaves(src, i) + 1);
}
function extrairConst(src, nome) {
  const i = src.indexOf('const ' + nome + ' = ');
  if (i < 0) throw new Error('const não encontrada: ' + nome);
  let f = casarChaves(src, i) + 1;
  if (src[f] === ';') f++;
  return src.slice(i, f);
}
function criarTimers() {
  let seq = 0; const lista = [];
  return {
    setTimeout(fn, ms) { const t = { id: ++seq, fn, ms, ativo: true }; lista.push(t); return t.id; },
    clearTimeout(id) { const t = lista.find((x) => x.id === id); if (t) t.ativo = false; },
    pendentes() { return lista.filter((t) => t.ativo); },
    disparar(ms) { for (const t of lista.filter((x) => x.ativo && x.ms <= ms)) { t.ativo = false; t.fn(); } }
  };
}
function criarRegistro() {
  const m = new Map();
  const cap = (c) => (c === true || !!(c && c.capture)) ? 1 : 0;
  const k = (t, c) => t + '|' + cap(c);
  return {
    add(t, f, c) { const key = k(t, c); if (!m.has(key)) m.set(key, new Set()); m.get(key).add(f); },
    remove(t, f, c) { const s = m.get(k(t, c)); if (s) s.delete(f); },
    total() { let n = 0; for (const s of m.values()) n += s.size; return n; },
    fire(t, e) { for (const f of [...(m.get(k(t, true)) || [])]) f(e); }
  };
}
function ev(p) {
  return Object.assign({
    isTrusted: true, key: '', stopped: false, prevented: false,
    stopImmediatePropagation() { this.stopped = true; },
    preventDefault() { this.prevented = true; }
  }, p);
}

// ================================================================ 0. sintaxe (node --check)
for (const f of ['content.js', 'background.js', 'yt-bridge.js', 'testes/teste_logica.js']) {
  const r = cp.spawnSync(process.execPath, ['--check', path.join(RAIZ, f)], { encoding: 'utf8', windowsHide: true });
  chk(r.status === 0, 'node --check ' + f + (r.status === 0 ? '' : ' :: ' + (r.stderr || '').split('\n').slice(0, 4).join(' | ')));
}

// ================================================================ 5. manifest.json
{
  let mf = null;
  try { mf = JSON.parse(ler('manifest.json')); } catch (e) { mf = null; }
  chk(!!mf, 'manifest.json é JSON válido');
  if (mf) {
    chk(mf.manifest_version === 3, 'manifest: manifest_version 3');
    chk(mf.version === '1.4.0', 'manifest: versão 1.4.0 (achou ' + mf.version + ')');
    for (const p of ['scripting', 'storage', 'contextMenus', 'downloads']) chk((mf.permissions || []).includes(p), 'manifest: permissão ' + p);
    chk(fs.existsSync(path.join(RAIZ, mf.background.service_worker)), 'manifest: service_worker existe');
    const cs = mf.content_scripts || [];
    chk(cs.length === 2, 'manifest: 2 content_scripts');
    const principal = cs.find((c) => (c.js || []).includes('content.js'));
    const ponte = cs.find((c) => (c.js || []).includes('yt-bridge.js'));
    chk(!!principal && principal.all_frames === true, 'manifest: content.js em todos os frames');
    chk(!!ponte && ponte.world === 'MAIN', 'manifest: yt-bridge.js no mundo MAIN');
    chk(!!ponte && ponte.matches.every((m) => /youtube\.com/.test(m)), 'manifest: yt-bridge só no YouTube');
    for (const c of cs) for (const j of c.js) chk(fs.existsSync(path.join(RAIZ, j)), 'manifest: arquivo ' + j + ' existe');
    for (const [sz, f] of Object.entries(mf.icons || {})) chk(fs.existsSync(path.join(RAIZ, f)), 'manifest: ícone ' + sz + ' existe');
    chk(parseInt(mf.minimum_chrome_version, 10) >= 116, 'manifest: Chrome mínimo >= 116 (Document PiP / world MAIN)');
    chk(!mf.action || !mf.action.default_popup, 'manifest: sem popup (action.onClicked precisa disparar)');
    const usadas = new Set([...SRC_BG.matchAll(/chrome\.(\w+)\./g)].map((m) => m[1]));
    const livres = new Set(['runtime', 'action', 'tabs', 'windows']);
    for (const a of usadas) chk(livres.has(a) || (mf.permissions || []).includes(a), 'manifest: API chrome.' + a + ' tem permissão');
    chk(!/chrome\.downloads\./.test(SRC), 'content.js não usa chrome.downloads (só o service worker pode)');
  }
}
chk(/const V = 3;/.test(SRC_BR), 'yt-bridge.js: V = 3');
chk(!/setVolume/.test(SRC_BR), 'yt-bridge.js: comando setVolume removido');
chk(!/pushYtVol|ytVolT|'setVolume'/.test(SRC), 'content.js: sem pushYtVol/ytVolT/ytCall setVolume (removidos)');

// ================================================================ 1. timeRange / fmt / live / seekBy
const corpoUtil = [
  SRC.match(/const clamp = [^\n]+\n/)[0],
  extrairFuncao(SRC, 'fmt'),
  extrairFuncao(SRC, 'timeRange'),
  extrairFuncao(SRC, 'igIdFromCode'),
  SRC.match(/const IG_ALPHA = [^\n]+\n/)[0]
].join('\n');
const U = vm.runInNewContext(corpoUtil + '\n({ clamp, fmt, timeRange, igIdFromCode, IG_ALPHA });');

function vid(duration, faixas, extra) {
  const seekable = faixas === undefined ? undefined : {
    length: faixas.length,
    start: (i) => faixas[i][0],
    end: (i) => faixas[i][1]
  };
  return Object.assign({ duration, seekable }, extra || {});
}
{
  const t = U.timeRange;
  chk(igual(t(vid(120, [])), { start: 0, end: 120 }), 'timeRange: duração finita 120 -> {0,120}');
  chk(igual(t(vid(0.5, [])), { start: 0, end: 0.5 }), 'timeRange: duração finita curta 0.5');
  chk(igual(t(vid(Infinity, [[0, 7200]])), { start: 0, end: 7200 }), 'timeRange: Infinity + seekable longo (Disney+) -> faixa');
  chk(igual(t(vid(Infinity, [[100, 5000]])), { start: 100, end: 5000 }), 'timeRange: Infinity + seekable começando em 100');
  chk(t(vid(Infinity, [[0, 20]])) === null, 'timeRange: Infinity + seekable curto (20s) -> null (ao vivo)');
  chk(t(vid(Infinity, [[0, 30]])) === null, 'timeRange: seekable exatamente 30s -> null (limite é > 30)');
  chk(t(vid(Infinity, [[0, 30.01]])) !== null, 'timeRange: seekable 30.01s -> faixa');
  chk(t(vid(Infinity, [])) === null, 'timeRange: Infinity + seekable vazio -> null');
  chk(t(vid(Infinity, undefined)) === null, 'timeRange: Infinity sem propriedade seekable -> null');
  chk(t(vid(NaN, [])) === null, 'timeRange: NaN + seekable vazio -> null');
  chk(igual(t(vid(NaN, [[0, 600]])), { start: 0, end: 600 }), 'timeRange: NaN + seekable longo -> usa seekable (comportamento atual)');
  chk(t(vid(0, [])) === null, 'timeRange: duração 0 sem seekable -> null');
  chk(t(vid(-1, [])) === null, 'timeRange: duração negativa -> null');
  chk(igual(t(vid(Infinity, [[0, 10], [50, 900]])), { start: 0, end: 900 }), 'timeRange: várias faixas usa start(0)..end(último)');
  chk(t(vid(Infinity, [[0, Infinity]])) === null, 'timeRange: seekable.end infinito -> null');
  const quebrado = { duration: Infinity, get seekable() { throw new Error('boom'); } };
  chk(t(quebrado) === null, 'timeRange: seekable que lança exceção -> null (sem propagar)');

  chk(U.fmt(NaN) === '--:--' && U.fmt(Infinity) === '--:--' && U.fmt(-1) === '--:--', 'fmt: NaN/Infinity/negativo -> --:--');
  chk(U.fmt(65) === '1:05' && U.fmt(3661) === '1:01:01' && U.fmt(0) === '0:00', 'fmt: 65 -> 1:05; 3661 -> 1:01:01; 0 -> 0:00');
}
{
  const mLive = SRC.match(/const live = ([\s\S]*?);\s*cls\('live', live\);/);
  chk(!!mLive, 'syncTime: expressão "live" encontrada no código');
  if (mLive) {
    const f = new Function('IS_YT', 'dur', 'rng', 'document', 'return !!(' + mLive[1] + ');');
    const docBadge = { querySelector: () => ({}) }, docSem = { querySelector: () => null };
    const r = { start: 0, end: 600 };
    chk(f(false, Infinity, null, docSem) === true, 'live (fora do YT): Infinity sem faixa = ao vivo');
    chk(f(false, Infinity, r, docSem) === false, 'live (fora do YT): Infinity com faixa longa (Disney+) = NÃO é ao vivo');
    chk(f(false, 120, r, docSem) === false, 'live (fora do YT): duração finita = não ao vivo');
    chk(f(false, NaN, null, docSem) === false, 'live (fora do YT): NaN = não ao vivo (ainda carregando)');
    chk(f(true, Infinity, null, docSem) === true, 'live (YT): Infinity = ao vivo');
    chk(f(true, Infinity, r, docSem) === true, 'live (YT): Infinity = ao vivo mesmo com seekable (DVR)');
    chk(f(true, 300, r, docBadge) === false, 'live (YT): duração finita com badge = não ao vivo');
    chk(f(true, NaN, null, docBadge) === true, 'live (YT): NaN + badge ao vivo = ao vivo');
    chk(f(true, NaN, null, docSem) === false, 'live (YT): NaN sem badge = não ao vivo');
  }
  const mSeek = SRC.match(/v\.currentTime = (rng \? clamp\([^\n]*?\) : Math\.max\(0, v\.currentTime \+ s\));\n/);
  chk(!!mSeek, 'seekBy: expressão de salto encontrada no código');
  if (mSeek) {
    const f = new Function('rng', 'v', 's', 'clamp', 'return (' + mSeek[1] + ');');
    const r = { start: 0, end: 100 };
    chk(perto(f(r, { currentTime: 50 }, 10, U.clamp), 60), 'seekBy: +10 em 50 -> 60');
    chk(perto(f(r, { currentTime: 95 }, 10, U.clamp), 99.9), 'seekBy: não passa de end-0.1');
    chk(perto(f(r, { currentTime: 3 }, -10, U.clamp), 0), 'seekBy: não vai abaixo do início');
    chk(perto(f({ start: 100, end: 5000 }, { currentTime: 105 }, -10, U.clamp), 100), 'seekBy: respeita start da faixa (seekable começando em 100)');
    chk(perto(f(null, { currentTime: 5 }, 10, U.clamp), 15), 'seekBy sem faixa (ao vivo): tenta currentTime+10');
    chk(perto(f(null, { currentTime: 5 }, -10, U.clamp), 0), 'seekBy sem faixa: mínimo 0');
    chk(perto(f(null, { currentTime: 500 }, -10, U.clamp), 490), 'seekBy sem faixa: volta 10s no meio do stream');
  }
  chk(/if \(!v \|\| !timeRange\(v\) \|\| e\.button !== 0\) return;/.test(SRC), 'barra: pointerdown só com faixa (timeRange)');
  chk(/rng\.start \+ ratioAt\(e\) \* \(rng\.end - rng\.start\)/.test(SRC), 'barra: endDrag calcula a partir de rng.start/end');
  chk(/ui\.tip\.textContent = fmt\(rng \? p \* \(rng\.end - rng\.start\) : NaN\)/.test(SRC), 'barra: preview usa rng (NaN -> --:--)');
  chk(/const rng = timeRange\(v\);\s*if \(rng && rng\.end - v\.currentTime < 1\.2\) doSleep\(true\);/.test(SRC), 'sleepTick: fim do vídeo usa timeRange');
  chk((SRC.match(/\.duration/g) || []).length === 2, 'content.js: só timeRange e syncTime leem .duration direto');
}

// ================================================================ 2. yt-bridge V=3 (sem setVolume) e substituição de V=1/V=2
function ambienteBridge(player) {
  const ls = {}, despachados = [];
  const document = {
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    removeEventListener(t, f) { ls[t] = (ls[t] || []).filter((x) => x !== f); },
    getElementById(id) { return id === 'movie_player' ? player : null; },
    dispatchEvent(e) { despachados.push(e); return true; }
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const window = {};
  const ctx = vm.createContext({ window, document, CustomEvent });
  return { ctx, ls, despachados, window };
}
function pedirBridge(env, cmd, args) {
  const id = 'id' + Math.random();
  const n = env.despachados.length;
  for (const f of (env.ls['pipf-yt-req'] || []).slice()) f({ detail: JSON.stringify({ id, cmd, args }) });
  return env.despachados.slice(n).map((e) => JSON.parse(e.detail)).find((r) => r.id === id);
}
{
  const pl = { rng: null, q: null, un: false, setPlaybackQualityRange(a, b) { this.rng = [a, b]; }, setPlaybackQuality(q) { this.q = q; }, unloadModule() { this.un = true; } };
  const env = ambienteBridge(pl);
  vm.runInContext(SRC_BR, env.ctx);
  chk(env.window.__pipfBridge && env.window.__pipfBridge.v === 3, 'bridge: instalado com v=3');
  chk((env.ls['pipf-yt-req'] || []).length === 1, 'bridge: 1 listener registrado');
  vm.runInContext(SRC_BR, env.ctx);
  chk((env.ls['pipf-yt-req'] || []).length === 1, 'bridge: segunda injeção da mesma versão não duplica listener');
  let r = pedirBridge(env, 'setVolume', { volume: 0.5, muted: false });
  chk(r && r.result === null && r.error === null, 'bridge V=3: setVolume não existe mais (result null, sem erro)');
  r = pedirBridge(env, 'setQuality', { q: 'hd720' });
  chk(r && r.result === true && igual(pl.rng, ['hd720', 'hd720']) && pl.q === 'hd720', 'bridge: setQuality continua funcionando');
  r = pedirBridge(env, 'setQuality', { q: 'auto' });
  chk(igual(pl.rng, ['auto', 'auto']), 'bridge: setQuality auto');
  r = pedirBridge(env, 'captionsOff', {});
  chk(r && r.result === true && pl.un === true, 'bridge: captionsOff continua funcionando');
  r = pedirBridge(env, 'comandoInexistente', {});
  chk(r && r.result === null && r.error === null, 'bridge: comando desconhecido -> result null');

  const semPlayer = ambienteBridge(null);
  vm.runInContext(SRC_BR, semPlayer.ctx);
  chk(pedirBridge(semPlayer, 'info', {}).result === null, 'bridge sem player: info -> null');
  chk(pedirBridge(semPlayer, 'captionsOff', {}).result === false, 'bridge sem player: captionsOff -> false');
  chk(pedirBridge(semPlayer, 'setQuality', { q: 'auto' }).result === false, 'bridge sem player: setQuality -> false');
}
for (const antiga of [1, 2]) {
  // versão antiga instalada é substituída pela V=3
  const env = ambienteBridge(null);
  let chamouOff = false, recebeu = false;
  const velho = () => { recebeu = true; };
  env.ls['pipf-yt-req'] = [velho];
  env.window.__pipfBridge = { v: antiga, off() { chamouOff = true; env.ls['pipf-yt-req'] = env.ls['pipf-yt-req'].filter((f) => f !== velho); } };
  vm.runInContext(SRC_BR, env.ctx);
  chk(chamouOff, 'bridge V=' + antiga + ' instalado: off() da versão antiga é chamado');
  chk(env.window.__pipfBridge.v === 3, 'bridge V=' + antiga + ' instalado: window.__pipfBridge.v passa a 3');
  chk(env.ls['pipf-yt-req'].length === 1 && env.ls['pipf-yt-req'][0] !== velho, 'bridge V=' + antiga + ' instalado: só o listener novo fica');
  pedirBridge(env, 'info', {});
  chk(!recebeu, 'bridge V=' + antiga + ': listener antigo não recebe mais pedidos');
}
{
  const env4 = ambienteBridge(null);
  const marca = { v: 4, off() {} };
  env4.window.__pipfBridge = marca;
  vm.runInContext(SRC_BR, env4.ctx);
  chk(env4.window.__pipfBridge === marca, 'bridge: versão maior já instalada não é rebaixada');

  const envq = ambienteBridge(null);
  envq.window.__pipfBridge = { v: 2, off() { throw new Error('off quebrado'); } };
  let lancou = false;
  try { vm.runInContext(SRC_BR, envq.ctx); } catch (e) { lancou = true; }
  chk(!lancou && envq.window.__pipfBridge.v === 3, 'bridge: off() antigo que lança não impede a instalação do V=3');
}

// ================================================================ 2b. VOLUME: setVol / toggleMute / syncVol (código real) com <video> assíncrono
// <video> de mentira que imita o navegador: setar volume/muted com valor DIFERENTE enfileira um evento
// 'volumechange' (assíncrono, nunca síncrono); valor igual não gera evento.
function videoAsync(volume, muted) {
  const o = { _vol: volume, _mut: muted, fila: 0, sets: { volume: 0, muted: 0 }, handlers: [] };
  Object.defineProperty(o, 'volume', {
    get() { return this._vol; },
    set(x) {
      if (!(x >= 0 && x <= 1)) throw new RangeError('IndexSizeError');
      this.sets.volume++;
      if (x !== this._vol) { this._vol = x; this.fila++; }
    }
  });
  Object.defineProperty(o, 'muted', {
    get() { return this._mut; },
    set(x) { this.sets.muted++; x = !!x; if (x !== this._mut) { this._mut = x; this.fila++; } }
  });
  // dispara os eventos pendentes (inclusive os novos gerados pelos handlers) até esvaziar ou bater no limite
  o.flush = function (max) {
    max = max || 1000;
    let n = 0;
    while (this.fila > 0 && n < max) { this.fila--; n++; for (const h of this.handlers.slice()) h(); }
    return n;
  };
  return o;
}
function montarVol(video, prefsIni, opts) {
  opts = opts || {};
  const S = { prefs: Object.assign({ volume: null, muted: null, rate: null }, prefsIni || {}) };
  const sleep = { fading: !!opts.fading };
  const ui = { mute: { title: '' }, vol: { value: '', style: { props: {}, setProperty(k, val) { this.props[k] = val; } } } };
  const ch = { icones: [], flash: [] };
  const corpo = [
    'let v = state.v;',
    'let volFixes = 0, volFixT = 0;',   // contadores que, no content.js, ficam logo acima de syncVol
    extrairFuncao(SRC, 'syncVol'), extrairConst(SRC, 'setVol'), extrairConst(SRC, 'toggleMute'),
    'return { syncVol, setVol, toggleMute, setV(x) { v = x; } };'
  ].join('\n');
  const api = new Function('state', 'S', 'sleep', 'ui', 'setIcon', 'clamp', 'flash', corpo)(
    { v: video }, S, sleep, ui, (b, n) => ch.icones.push(n), U.clamp, (m) => ch.flash.push(m));
  video.handlers.push(api.syncVol);   // o content.js liga syncVol ao 'volumechange'
  return { api, S, sleep, ui, ch, video };
}
{
  // (1) usuário muda 0.2 -> 0.35 -> 0.8 em sequência (sem esperar eventos): sem correção indevida
  let v = videoAsync(1, false);
  let m = montarVol(v);
  m.api.setVol(0.2); m.api.setVol(0.35); m.api.setVol(0.8);
  let n = v.flush();
  chk(v.volume === 0.8 && m.S.prefs.volume === 0.8 && m.S.prefs.muted === false, '(1) 0.2->0.35->0.8 em rajada: valor final 0.8');
  chk(v.sets.volume === 3, '(1) rajada: só as 3 escritas do usuário, nenhuma correção (escritas: ' + v.sets.volume + ')');
  chk(n === 3, '(1) rajada: apenas 3 eventos, sem eventos extras (' + n + ')');
  chk(m.ui.vol.value === '0.8' && m.ui.vol.style.props['--p'] === '80%', '(1) interface mostra 0.8 / 80%');
  // idem, esperando cada evento entre os passos
  v = videoAsync(1, false); m = montarVol(v);
  m.api.setVol(0.2); v.flush(); m.api.setVol(0.35); v.flush(); m.api.setVol(0.8); n = v.flush();
  chk(v.volume === 0.8 && v.sets.volume === 3, '(1) com eventos entre os passos: final 0.8 e sem correções');
  // arredondamento da roda do mouse (0.05) não gera correção
  v = videoAsync(0.5, false); m = montarVol(v);
  m.api.setVol(0.5 + 0.05); v.flush(); m.api.setVol(v.volume + 0.05); v.flush();
  chk(v.sets.volume === 2 && perto(v.volume, 0.6), '(1) passos de 0.05 da roda: sem correções (escritas ' + v.sets.volume + ', vol ' + v.volume + ')');

  // (2) site reaplica o volume antigo depois do usuário escolher 0.8: volta para 0.8
  v = videoAsync(1, false); m = montarVol(v);
  m.api.setVol(0.8); v.flush();
  v.sets.volume = 0; v.sets.muted = 0;
  v.volume = 0.5;                     // o site mexe (conta 1 escrita)
  n = v.flush();
  chk(v.volume === 0.8, '(2) site reaplicou 0.5: volta para 0.8');
  chk(v.sets.volume === 2, '(2) exatamente 1 correção (escritas: site + correção = ' + v.sets.volume + ')');
  chk(n <= 3 && m.ui.vol.value === '0.8', '(2) estabiliza em poucos eventos (' + n + ') e a interface mostra 0.8');
  // site silencia
  v.muted = true; v.flush();
  chk(v.muted === false && v.volume === 0.8, '(2b) site silenciou: som é devolvido');
  // diferença dentro da tolerância (<= 0.01) não é "briga"
  v.sets.volume = 0; v.volume = 0.805; v.flush();
  chk(v.sets.volume === 1 && v.volume === 0.805, '(2c) diferença de 0.005 é tolerada (sem correção)');

  // (3) sem prefs: nada é forçado
  v = videoAsync(1, false); m = montarVol(v);
  v.volume = 0.5; v.muted = true; v.sets.volume = 0; v.sets.muted = 0;
  n = v.flush();
  chk(v.volume === 0.5 && v.muted === true && v.sets.volume === 0 && v.sets.muted === 0, '(3) S.prefs.volume == null: nada é forçado');
  chk(m.ui.vol.value === '0' && m.ch.icones[m.ch.icones.length - 1] === 'volMute', '(3) interface reflete o estado do vídeo (mudo)');
  // sincronização inicial (syncAll) também não força
  m.api.syncVol();
  chk(v.sets.volume === 0, '(3) syncVol direto sem prefs não escreve no vídeo');

  // (4) durante sleep.fading o fade não é revertido
  v = videoAsync(1, false); m = montarVol(v);
  m.api.setVol(0.8); v.flush();
  m.sleep.fading = true;
  const baixou = [];
  for (let k = 1; k <= 20; k++) { v.volume = Math.max(0, 0.8 * (1 - k / 20)); baixou.push(v.volume); v.flush(); }
  chk(v.volume === 0 || perto(v.volume, 0), '(4) fade chega a 0 sem ser revertido pelo syncVol');
  chk(baixou.every((x, i) => i === 0 || x <= baixou[i - 1]), '(4) fade monotônico (nenhuma volta ao 0.8 no meio)');
  m.sleep.fading = false;
  v.volume = 0.8; n = v.flush();   // o fim do fade restaura vol0
  chk(v.volume === 0.8 && n <= 2, '(4) fim do fade: restaura 0.8 e fica consistente (' + n + ' eventos)');
  // com fade ativo a interface continua sendo atualizada
  m.sleep.fading = true; v.volume = 0.3; v.flush();
  chk(m.ui.vol.value === '0.3', '(4) durante o fade a barra de volume acompanha o vídeo');

  // (5) mudo / ativar som
  v = videoAsync(1, false); m = montarVol(v);
  m.api.setVol(0.6); v.flush();
  v.sets.volume = 0; v.sets.muted = 0;
  m.api.toggleMute(); n = v.flush();
  chk(v.muted === true && m.S.prefs.muted === true && m.S.prefs.volume === 0.6 && v.volume === 0.6, '(5) mudo: vídeo e prefs consistentes, volume preservado em 0.6');
  chk(v.sets.volume === 0 && v.sets.muted === 1, '(5) mudo: nenhuma correção extra (escritas muted=' + v.sets.muted + ')');
  chk(m.ui.vol.value === '0' && m.ch.icones[m.ch.icones.length - 1] === 'volMute', '(5) mudo: slider em 0 e ícone de mudo');
  m.api.toggleMute(); n = v.flush();
  chk(v.muted === false && v.volume === 0.6 && m.S.prefs.muted === false, '(5) ativar som: volta a 0.6 sem mudo');
  chk(m.ui.vol.value === '0.6' && m.ch.icones[m.ch.icones.length - 1] === 'volHigh', '(5) ativar som: slider 0.6 e ícone alto');
  // setVol(0) = mudo; M depois sobe para 0.5
  m.api.setVol(0); v.flush();
  chk(v.muted === true && v.volume === 0 && m.S.prefs.volume === 0 && m.S.prefs.muted === true, '(5) setVol(0): mudo e prefs 0/true');
  v.sets.volume = 0; v.sets.muted = 0;
  m.api.toggleMute(); n = v.flush();
  chk(v.volume === 0.5 && v.muted === false && m.S.prefs.volume === 0.5 && m.S.prefs.muted === false, '(5) M com volume 0: sobe para 0.5 e desmuta, prefs batem');
  chk(v.sets.volume === 1 && n <= 2, '(5) M com volume 0: sem correções extras (' + v.sets.volume + ' escrita, ' + n + ' eventos)');
  // site "desmuta" depois do usuário mutar: devolve o mudo
  m.api.toggleMute(); v.flush();
  v.muted = false; v.flush();
  chk(v.muted === true, '(5) usuário mutou e o site desmutou: mudo é restaurado');
  // setVol volta de 0 para valor > 0 desmuta
  m.api.setVol(0.4); v.flush();
  chk(v.muted === false && v.volume === 0.4, '(5) setVol(0.4) depois de mudo: desmuta e fica 0.4');
  // volume do vídeo fora de faixa nunca é escrito
  chk(!m.S.prefs.volume || (m.S.prefs.volume >= 0 && m.S.prefs.volume <= 1), '(5) prefs.volume sempre dentro de 0..1');

  // sem vídeo
  v = videoAsync(1, false); m = montarVol(v); m.api.setV(null);
  let lancou = false;
  try { m.api.setVol(0.5); m.api.toggleMute(); m.api.syncVol(); } catch (e) { lancou = true; }
  chk(!lancou && v.sets.volume === 0, 'sem vídeo (v null): setVol/toggleMute/syncVol não fazem nada nem lançam');

  // (6) laços de eventos
  // 6a: site reaplica UMA vez -> converge
  v = videoAsync(1, false); m = montarVol(v);
  m.api.setVol(0.8); v.flush();
  v.volume = 0.5; n = v.flush(50);
  chk(n < 50 && v.volume === 0.8, '(6a) site reaplica uma vez: converge em ' + n + ' eventos');
  // 6b: site que reaplica 3 vezes e depois desiste -> converge
  let resta = 3;
  v.handlers.push(() => { if (resta > 0 && v.volume !== 0.5) { resta--; v.volume = 0.5; } });
  v.volume = 0.5; n = v.flush(200);
  chk(n < 200 && v.volume === 0.8 && resta === 0, '(6b) site briga 3 vezes e desiste: converge em 0.8 (' + n + ' eventos)');
  // 6c: site que reaplica SEMPRE (a cada volumechange): sem limite de correções no código = laço de eventos
  v = videoAsync(1, false); m = montarVol(v);
  m.api.setVol(0.8); v.flush();
  v.handlers.push(() => { if (v.volume !== 0.5) v.volume = 0.5; });
  v.volume = 0.5;
  n = v.flush(500);
  aviso(n >= 500, '(6c) site que reaplica o volume a CADA volumechange gera laço infinito de eventos (500 eventos sem estabilizar; syncVol não tem limite/backoff de correções)');
  // 6d: nenhuma recursão síncrona dentro do syncVol (setar volume não dispara handler na mesma pilha)
  const src = extrairFuncao(SRC, 'syncVol');
  chk(/return;\s*\/\/ o evento gerado/.test(src), '(6d) syncVol retorna logo após corrigir (não atualiza UI com estado transitório)');
  // 6e: syncVol não mexe em prefs (não "aprende" o volume do site)
  chk(!/S\.prefs\.\w+\s*=[^=]/.test(src) && !/p\.(volume|muted)\s*=[^=]/.test(src), '(6e) syncVol nunca escreve em S.prefs');
  // 6f: setVol/toggleMute gravam S.prefs ANTES de mexer no vídeo
  const sv = extrairConst(SRC, 'setVol'), tm = extrairConst(SRC, 'toggleMute');
  chk(sv.indexOf('S.prefs.volume = x') < sv.indexOf('v.volume = x'), '(6f) setVol: prefs antes de v.volume');
  chk(tm.indexOf('S.prefs.muted = false; v.muted = false') > 0 && tm.indexOf('S.prefs.muted = true; v.muted = true') > 0, '(6f) toggleMute: prefs.muted antes de v.muted nos dois ramos');
  chk(tm.indexOf('v.volume = 0.5') < tm.indexOf('S.prefs.volume = v.volume'), '(6f) toggleMute: prefs.volume gravado depois de v.volume = 0.5 (no mesmo tick, antes do evento)');
}
{
  // (7) interação com o reforço de "som ligado" de mountPip (fixT): setVol(0) pelo teclado/roda não marca userTouched
  const iFix = SRC.indexOf('const fixT = setInterval');
  const trecho = SRC.slice(iFix, iFix + 400);
  const marcaPorTeclado = /markTouched/.test(SRC.slice(iFix - 400, iFix)) && /ui\.mute\.addEventListener\('click', markTouched/.test(SRC) && /ui\.vol\.addEventListener\('input', markTouched/.test(SRC);
  // corrigido: fixT também para quando o usuário silencia (S.prefs.muted === true), mesmo pela roda/teclado
  chk(marcaPorTeclado && /S\.prefs\.muted === true/.test(trecho),
    '(7) fixT para quando S.prefs.muted === true (setVol(0) pela roda/teclado não alterna mais com syncVol)');
  // limite de correções do syncVol (evita laço infinito de eventos se o site insistir)
  chk(/volFixes\+\+ < 5/.test(extrairFuncao(SRC, 'syncVol')), '(7b) syncVol limita as correções (máx. 5 por segundo)');
}

// ================================================================ 2c. reapply (código real)
function montarReapply(v, prefs, ad) {
  const st = { v, ad: !!ad };
  const d = { title: '', body: { classList: { contains: (c) => st.ad && c === 'ad' } } };
  const S = { prefs };
  const corpo = 'let v = state.v, queueSig = "x";\n' + extrairFuncao(SRC, 'reapply') +
    '\nreturn { reapply, setV(x) { v = x; }, sig: () => queueSig };';
  const api = new Function('state', 'S', 'd', 'pageTitle', corpo)(st, S, d, () => 'Titulo');
  return { api, d };
}
function videoEspiao(volume, muted, rate) {
  const o = { sets: 0, _vol: volume, _mut: muted, _rate: rate };
  Object.defineProperty(o, 'volume', { get() { return this._vol; }, set(x) { this._vol = x; this.sets++; } });
  Object.defineProperty(o, 'muted', { get() { return this._mut; }, set(x) { this._mut = x; } });
  Object.defineProperty(o, 'playbackRate', { get() { return this._rate; }, set(x) { this._rate = x; } });
  return o;
}
{
  let v = videoEspiao(1, false, 1);
  let r = montarReapply(v, { volume: 0.3, muted: true, rate: 1.5 });
  r.api.reapply();
  chk(v.volume === 0.3 && v.muted === true && v.playbackRate === 1.5, 'reapply: aplica volume, mudo e velocidade de S.prefs');
  chk(r.d.title === 'Titulo' && r.api.sig() === '', 'reapply: atualiza título e zera queueSig');

  const novo = videoEspiao(0.9, false, 1);
  r.api.setV(novo); r.api.reapply();
  chk(novo.volume === 0.3 && novo.muted === true && novo.playbackRate === 1.5, 'reapply após troca de <video>: reaplica S.prefs no novo vídeo');

  v = videoEspiao(0.8, false, 1);
  r = montarReapply(v, { volume: null, muted: null, rate: null });
  r.api.reapply();
  chk(v.volume === 0.8 && v.muted === false && v.playbackRate === 1, 'reapply com prefs nulas: não mexe no vídeo (primeira abertura)');

  v = videoEspiao(0.505, false, 1);
  r = montarReapply(v, { volume: 0.5, muted: null, rate: null });
  r.api.reapply();
  chk(v.sets === 0, 'reapply: diferença <= 0.01 não reatribui o volume');

  v = videoEspiao(1, false, 1);
  r = montarReapply(v, { volume: null, muted: null, rate: 2 }, true);
  r.api.reapply();
  chk(v.playbackRate === 1, 'reapply: durante anúncio (classe ad) não aplica velocidade');

  r = montarReapply(null, { volume: 0.5, muted: false, rate: 1 });
  let lancou = false; try { r.api.reapply(); } catch (e) { lancou = true; }
  chk(!lancou, 'reapply com v = null: não lança');
  chk(/reapply\(\);\s*\/\/ <video> novo/.test(SRC), 'attach(): chama reapply() (fonte)');
  chk(/addEventListener\('loadedmetadata', reapply, o\)/.test(SRC), 'attach(): reapply também em loadedmetadata');
  chk(/v\.addEventListener\('volumechange', syncVol, o\)/.test(SRC), 'attach(): volumechange -> syncVol');
}

// ================================================================ 3. tela cheia: armFullscreen / pageFullscreen / toggleFull
function montarArm() {
  const timers = criarTimers(), reg = criarRegistro();
  const ch = { enterFs: [], toast: [], toastOcultado: 0 };
  const toastEl = { classList: { remove() { ch.toastOcultado++; } } };
  const corpo = 'let disarmFs = null;\n' + extrairFuncao(SRC, 'armFullscreen') + '\nreturn { armFullscreen, estado: () => disarmFs };';
  const api = new Function('addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', 'toast', 'toastEl', 'enterFs', corpo)(
    reg.add, reg.remove, timers.setTimeout, timers.clearTimeout, (m) => ch.toast.push(m), toastEl, (v) => ch.enterFs.push(v));
  return { api, reg, timers, ch };
}
{
  let a = montarArm();
  a.api.armFullscreen('V1');
  chk(a.reg.total() === 6, 'armFullscreen: registra 6 listeners (4 de engolir + click + keydown)');
  chk(a.timers.pendentes().length === 1 && a.timers.pendentes()[0].ms === 15000, 'armFullscreen: timer de 15 s');
  chk(a.ch.toast.length === 1, 'armFullscreen: avisa o usuário (toast)');
  const down = ev({});
  a.reg.fire('pointerdown', down);
  chk(down.stopped && down.prevented && a.reg.total() === 6, 'pointerdown confiável é engolido e continua armado');
  const click = ev({});
  a.reg.fire('click', click);
  chk(a.ch.enterFs.length === 1 && a.ch.enterFs[0] === 'V1', 'clique confiável: entra em tela cheia com o vídeo certo');
  chk(a.reg.total() === 0 && a.api.estado() === null, 'clique confiável: todos os listeners removidos e disarmFs = null (sem vazamento)');
  chk(a.timers.pendentes().length === 0 && a.ch.toastOcultado === 1, 'clique confiável: timer cancelado e aviso escondido');

  a = montarArm(); a.api.armFullscreen('V');
  const fake = ev({ isTrusted: false });
  a.reg.fire('click', fake); a.reg.fire('pointerdown', fake); a.reg.fire('keydown', Object.assign(fake, { key: 'a' }));
  chk(a.ch.enterFs.length === 0 && a.reg.total() === 6 && !fake.stopped, 'eventos NÃO confiáveis (isTrusted=false) são ignorados');

  a = montarArm(); a.api.armFullscreen('V');
  a.reg.fire('keydown', ev({ key: 'Escape' }));
  chk(a.ch.enterFs.length === 0 && a.reg.total() === 0 && a.api.estado() === null, 'Esc cancela: sem tela cheia e sem listeners');

  a = montarArm(); a.api.armFullscreen('V');
  a.reg.fire('keydown', ev({ key: 'Shift' })); a.reg.fire('keydown', ev({ key: 'Control' })); a.reg.fire('keydown', ev({ key: 'Alt' })); a.reg.fire('keydown', ev({ key: 'Meta' }));
  chk(a.ch.enterFs.length === 0 && a.reg.total() === 6, 'teclas modificadoras sozinhas não disparam nem desarmam');
  a.reg.fire('keydown', ev({ key: 'a' }));
  chk(a.ch.enterFs.length === 1 && a.reg.total() === 0, 'tecla comum confiável: entra em tela cheia e desarma');

  a = montarArm(); a.api.armFullscreen('V');
  a.timers.disparar(15000);
  chk(a.reg.total() === 0 && a.api.estado() === null, 'timeout de 15 s desarma e remove os listeners');

  a = montarArm(); a.api.armFullscreen('V1'); a.api.armFullscreen('V2');
  chk(a.reg.total() === 6 && a.timers.pendentes().length === 1, 'armar duas vezes não acumula listeners nem timers');
  a.reg.fire('click', ev({}));
  chk(a.ch.enterFs.length === 1 && a.ch.enterFs[0] === 'V2', 'armar duas vezes: vale o último vídeo');
}
function montarPage(opts) {
  const timers = criarTimers();
  const ch = { enter: [], arm: [] };
  const S = { dead: !!opts.dead };
  const document = { fullscreenElement: opts.fs ? {} : null };
  const f = new Function('S', 'document', 'enterFs', 'armFullscreen', 'setTimeout', extrairFuncao(SRC, 'pageFullscreen') + '\nreturn pageFullscreen;')(
    S, document, (v) => ch.enter.push(v), (v) => ch.arm.push(v), timers.setTimeout);
  return { f, timers, ch, S, document };
}
{
  const video = { isConnected: true };
  let p = montarPage({});
  p.f(video);
  chk(p.ch.enter.length === 1 && p.timers.pendentes().length === 1 && p.timers.pendentes()[0].ms === 400, 'pageFullscreen: pede tela cheia e confere após 400 ms');
  p.timers.disparar(400);
  chk(p.ch.arm.length === 1, 'pageFullscreen: se não entrou em tela cheia, arma o clique');
  p = montarPage({}); p.f(video); p.document.fullscreenElement = {}; p.timers.disparar(400);
  chk(p.ch.arm.length === 0, 'pageFullscreen: se entrou em tela cheia, não arma');
  p = montarPage({}); p.f(video); p.S.dead = true; p.timers.disparar(400);
  chk(p.ch.arm.length === 0, 'pageFullscreen: instância morta (S.dead) não arma');
  p = montarPage({ dead: true }); p.f(video);
  chk(p.ch.enter.length === 0, 'pageFullscreen: S.dead -> nada');
  p = montarPage({}); p.f({ isConnected: false }); p.f(null);
  chk(p.ch.enter.length === 0, 'pageFullscreen: vídeo desconectado/nulo -> nada');
  p = montarPage({ fs: true }); p.f(video);
  chk(p.ch.enter.length === 0, 'pageFullscreen: já em tela cheia -> nada');
}
function montarToggle(vInicial, opts) {
  opts = opts || {};
  const S = {};
  const ch = { fullscreen: [], close: 0, msgs: [] };
  const pip = { close() { ch.close++; } };
  const chrome = { runtime: { sendMessage(m) { if (opts.msgLanca) throw new Error('x'); ch.msgs.push(m); } } };
  const corpo = 'let v = state.v;\n' + extrairFuncao(SRC, 'toggleFull') + '\nreturn { toggleFull, setV(x) { v = x; } };';
  const api = new Function('state', 'S', 'pageFullscreen', 'alive', 'chrome', 'pip', corpo)(
    { v: vInicial }, S, (v) => ch.fullscreen.push(v), () => true, chrome, pip);
  return { api, S, ch };
}
{
  const video = { id: 'original' };
  let t = montarToggle(video);
  t.api.toggleFull();
  chk(typeof t.S.afterPip === 'function' && t.ch.close === 1, 'toggleFull: define S.afterPip e fecha a PiP');
  chk(t.ch.msgs.length === 1 && t.ch.msgs[0].type === 'pipf-focus-tab', 'toggleFull: pede foco na aba');
  t.api.setV({ id: 'outro' });
  t.S.afterPip();
  chk(t.ch.fullscreen.length === 1 && t.ch.fullscreen[0] === video, 'afterPip usa o vídeo capturado no clique (não o atual)');

  t = montarToggle(null); t.api.toggleFull();
  chk(t.S.afterPip === undefined && t.ch.close === 0, 'toggleFull sem vídeo: não fecha nem arma afterPip');

  t = montarToggle(video, { msgLanca: true }); t.api.toggleFull();
  chk(t.ch.close === 1 && typeof t.S.afterPip === 'function', 'toggleFull: falha no sendMessage não impede fechar a PiP');

  const tf = extrairFuncao(SRC, 'toggleFull');
  chk(tf.indexOf('S.afterPip =') >= 0 && tf.indexOf('S.afterPip =') < tf.indexOf('pip.close()'), 'toggleFull: S.afterPip é definido ANTES de pip.close()');
  chk(/const after = S\.afterPip; S\.afterPip = null;\s*if \(after\) setTimeout\(safe\(after\), 200\);/.test(SRC), 'pagehide: consome S.afterPip (zera) e executa após 200 ms');
  const iPage = SRC.indexOf("pip.addEventListener('pagehide'");
  chk(iPage > 0 && SRC.indexOf('S.afterPip', iPage) > iPage && SRC.indexOf('S.afterPip', iPage) < SRC.indexOf('if (S.dead) finalTeardown()', iPage), 'pagehide: afterPip tratado antes do finalTeardown');
  chk((SRC.match(/S\.afterPip/g) || []).length === 5, 'S.afterPip: 5 referências (set, leitura, zera) - nenhuma sobrando (achou ' + (SRC.match(/S\.afterPip/g) || []).length + ')');
  chk(/S\.pageCleanups\.push\(\(\) => \{ if \(disarmFs\) disarmFs\(\); \}\);/.test(SRC), 'limpeza da página também desarma o armFullscreen');
}
{
  for (const nome of ['growWindow', 'shrinkWindow', 'syncFull', 'fullscreenExit']) {
    chk(!new RegExp('\\b' + nome + '\\b').test(SRC), 'sem referência a ' + nome);
  }
  chk(!/(^|[^.\w'"-])big\b/m.test(SRC.replace(/\/\/[^\n]*/g, '')), 'sem referência solta ao identificador "big" (CSS .big e rótulo "big" ficam)');
  chk(!/resizeTo|resizeBy|moveTo\(/.test(SRC), 'sem resizeTo/resizeBy/moveTo (janela PiP não redimensiona por script)');
  chk(!/fullscreenchange/.test(SRC), 'sem listener fullscreenchange sobrando');
}

// ================================================================ 4. Instagram
{
  const alvo = (c) => {
    let bits = '';
    for (const ch of c) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(ch).toString(2).padStart(6, '0');
    return BigInt('0b' + bits).toString();
  };
  chk(U.IG_ALPHA === 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', 'IG_ALPHA é o alfabeto base64url');
  const id = U.igIdFromCode;
  chk(id('CxYZa') === '46499418', 'igIdFromCode("CxYZa") = 46499418 (conta feita à mão: ((((2*64+49)*64+24)*64+25)*64+26)');
  chk(id('CxYZa') === alvo('CxYZa'), 'igIdFromCode("CxYZa") confere com referência por concatenação de bits');
  chk(id('A') === '0' && id('B') === '1' && id('_') === '63' && id('-') === '62', 'igIdFromCode: A=0, B=1, "-"=62, "_"=63');
  chk(id('-_') === '4031', 'igIdFromCode("-_") = 62*64+63 = 4031');
  chk(id('BAAAAAAAAAA') === '1152921504606846976', 'igIdFromCode("B"+10x"A") = 2^60 (precisa de BigInt)');
  chk(id('___________') === '73786976294838206463', 'igIdFromCode(11x"_") = 2^66-1 (acima de 2^53: BigInt)');
  for (const c of ['CxYZabcdefg', 'DABCDEFGHIJ', 'C0-_aZ9xYz1']) chk(id(c) === alvo(c), 'igIdFromCode("' + c + '") confere com a referência');
  chk(id('abc$efgh') === null && id('abc.defg') === null && id('abc defg') === null, 'igIdFromCode: caractere inválido -> null');
  const longo = 'CxYZabcdefg' + 'x'.repeat(28);
  chk(longo.length === 39 && id(longo) === id('CxYZabcdefg'), 'igIdFromCode: código de conta privada (>28) descarta os últimos 28');
  const c28 = 'A'.repeat(27) + 'B';
  chk(c28.length === 28 && id(c28) === alvo(c28), 'igIdFromCode: exatamente 28 caracteres NÃO é cortado');
  chk(typeof id('CxYZa') === 'string', 'igIdFromCode devolve string (vai direto na URL da API)');
}
{
  const RE = vm.runInNewContext(SRC.match(/const RE_IG_CODE = (.*);\n/)[1]);
  const cod = (p) => { const m = RE.exec(p); return m ? m[1] : null; };
  chk(cod('/p/CxYZabcdefg/') === 'CxYZabcdefg', 'RE_IG_CODE: /p/CODE/');
  chk(cod('/reel/C0-_aZ9xYz1/') === 'C0-_aZ9xYz1', 'RE_IG_CODE: /reel/CODE/ com - e _');
  chk(cod('/reels/CxYZabcdefg/') === 'CxYZabcdefg', 'RE_IG_CODE: /reels/CODE/');
  chk(cod('/fulano/reel/CxYZabcdefg/') === 'CxYZabcdefg', 'RE_IG_CODE: /usuario/reel/CODE/');
  chk(cod('/tv/CxYZabcdefg/') === 'CxYZabcdefg', 'RE_IG_CODE: /tv/CODE/');
  chk(cod('/reels/audio/123456789/') === null, 'RE_IG_CODE: /reels/audio/ não é post');
  chk(cod('/p/abc/') === null && cod('/explore/') === null && cod('/') === null, 'RE_IG_CODE: curto/outras rotas -> null');

  const RS = vm.runInNewContext(SRC.match(/const RE_IG_SAVE = (.*);\n/)[1]);
  const RL = vm.runInNewContext(SRC.match(/const RE_IG_LIKE = (.*);\n/)[1]);
  chk(['Salvar', 'Save', 'Remover dos salvos', 'Unsave'].every((s) => RS.test(s)), 'RE_IG_SAVE: Salvar/Save/Remover dos salvos/Unsave');
  chk(!RS.test('Salvar coleção') && !RS.test('Compartilhar'), 'RE_IG_SAVE: não casa rótulos parecidos');
  chk(['Curtir', 'Descurtir', 'Like', 'Unlike'].every((s) => RL.test(s)) && !RL.test('Comentar'), 'RE_IG_LIKE: Curtir/Descurtir/Like/Unlike');

  const mk = (hrefs, pai) => ({ parentElement: pai || null, querySelectorAll() { return hrefs.map((h) => ({ getAttribute: () => h })); } });
  const montar = (pathname) => new Function('location', 'RE_IG_CODE', extrairFuncao(SRC, 'igCodeFor') + '\nreturn igCodeFor;')({ pathname }, RE);
  const post = mk(['/p/CxYZabcdefg/', '/p/CxYZabcdefg/', '/fulano/']);
  const row = mk([], post);
  chk(montar('/')(row) === 'CxYZabcdefg', 'igCodeFor: um único código (repetido) no bloco do post');
  const lista = mk(['/reel/AAAAAAAAAAA/', '/reel/BBBBBBBBBBB/']);
  chk(montar('/reel/CCCCCCCCCCC/')(mk([], lista)) === 'CCCCCCCCCCC', 'igCodeFor: bloco com 2 posts -> usa o endereço da página');
  chk(montar('/')(mk([], mk([]))) === null, 'igCodeFor: nada achado e página sem código -> null');
}

// ================================================================ 4b. background.js (chrome.* de mentira)
function ambienteBg() {
  const ls = { onMessage: [], onInstalled: [], onStartup: [] };
  const e = { ls, downloads: [], menus: new Map(), erros: [], tabsUpdate: [], winUpdate: [], modo: 'ok', lastError: null };
  e.chrome = {
    runtime: {
      get lastError() { return e.lastError; },
      onMessage: { addListener: (f) => ls.onMessage.push(f) },
      onInstalled: { addListener: (f) => ls.onInstalled.push(f) },
      onStartup: { addListener: (f) => ls.onStartup.push(f) }
    },
    contextMenus: {
      onClicked: { addListener() {} },
      removeAll(cb) { setTimeout(() => { e.menus.clear(); if (cb) cb(); }, 5); },
      create(opts, cb) {
        setTimeout(() => {
          if (e.menus.has(opts.id)) { e.lastError = { message: 'Cannot create item with duplicate id ' + opts.id }; e.erros.push(e.lastError.message); }
          else e.menus.set(opts.id, opts);
          if (cb) cb();
          e.lastError = null;
        }, 5);
        return opts.id;
      },
      update() { return Promise.resolve(); }
    },
    storage: { local: { get: async () => ({}), set() {} }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [], sendMessage: async () => {},
      update(id, p) { e.tabsUpdate.push([id, p]); return Promise.resolve(); }
    },
    windows: { update(id, p) { e.winUpdate.push([id, p]); return Promise.resolve(); } },
    scripting: { executeScript: async () => {} },
    action: { onClicked: { addListener() {} } },
    downloads: {
      download(opts, cb) {
        e.downloads.push(opts);
        if (e.modo === 'erro') { e.lastError = { message: 'Download invalido' }; cb(undefined); e.lastError = null; }
        else if (e.modo === 'semid') cb(undefined);
        else cb(7);
      }
    }
  };
  e.ctx = vm.createContext({ chrome: e.chrome, URL });
  vm.runInContext(SRC_BG, e.ctx, { filename: 'background.js' });
  e.enviar = (msg, sender) => new Promise((resolve) => {
    const ret = ls.onMessage[0](msg, sender === undefined ? { tab: { id: 5, windowId: 9 } } : sender, resolve);
    if (ret !== true) setTimeout(() => resolve({ semResposta: true }), 20);
  });
  return e;
}
async function testesBackground() {
  const bg = ambienteBg();
  chk(bg.ls.onMessage.length === 1 && bg.ls.onInstalled.length === 1 && bg.ls.onStartup.length === 1, 'background: registra onMessage/onInstalled/onStartup');

  const ctrl = ambienteBg();
  for (let i = 0; i < 2; i++) ctrl.chrome.contextMenus.removeAll(() => ctrl.chrome.contextMenus.create({ id: 'pipf-auto' }, () => {}));
  await esperar(60);
  chk(ctrl.erros.length > 0, 'controle: o mock realmente acusa "duplicate id" quando duas criações correm em paralelo');
  bg.ls.onStartup[0](); bg.ls.onInstalled[0]();
  await esperar(250);
  chk(bg.erros.length === 0, 'setupMenu: onStartup + onInstalled juntos NÃO geram "duplicate id" (erros: ' + bg.erros.join(',') + ')');
  chk(bg.menus.size === 1 && bg.menus.has('pipf-auto') && bg.menus.get('pipf-auto').checked === true, 'setupMenu: exatamente 1 item pipf-auto, marcado por padrão');
  bg.ls.onInstalled[0](); bg.ls.onInstalled[0](); bg.ls.onStartup[0]();
  await esperar(300);
  chk(bg.erros.length === 0 && bg.menus.size === 1, 'setupMenu: 3 chamadas seguidas continuam sem duplicata');

  await bg.enviar({ type: 'pipf-focus-tab' });
  chk(igual(bg.tabsUpdate, [[5, { active: true }]]) && igual(bg.winUpdate, [[9, { focused: true }]]), 'pipf-focus-tab: ativa a aba e foca a janela do remetente');
  bg.tabsUpdate.length = 0;
  await bg.enviar({ type: 'pipf-focus-tab' }, {});
  chk(bg.tabsUpdate.length === 0, 'pipf-focus-tab sem sender.tab: ignora');
  let r = await bg.enviar(undefined);
  chk(r && r.semResposta === true, 'mensagem undefined: ignorada sem lançar');
  r = await bg.enviar({ type: 'qualquer-outra' });
  chk(r && r.semResposta === true, 'mensagem desconhecida: ignorada');

  const permitidos = [
    'https://scontent.cdninstagram.com/ok.jpg',
    'https://scontent-gru2-1.cdninstagram.com/v/t51/foto.jpg?x=1&y=2',
    'https://cdninstagram.com/a.jpg',
    'https://instagram.fgru1-1.fna.fbcdn.net/v/t.mp4',
    'https://scontent.xx.fbcdn.net/v/video.mp4',
    'https://fbcdn.net/x',
    'https://SCONTENT.CDNINSTAGRAM.COM/UP.jpg'
  ];
  const negados = [
    'https://evil.com/a.jpg',
    'http://x.cdninstagram.com/a.jpg',
    'http://scontent.cdninstagram.com/ok.jpg',
    'https://cdninstagram.com.evil.com/a.jpg',
    'https://fbcdn.net.evil.com/a.jpg',
    'https://evilcdninstagram.com/a.jpg',
    'https://notfbcdn.net/a.jpg',
    'https://scontent.cdninstagram.com@evil.com/a.jpg',
    'https://evil.com/?u=scontent.cdninstagram.com',
    'https://evil.com#.cdninstagram.com',
    'https://x.cdninstagram.com./a.jpg',
    'ftp://x.cdninstagram.com/a.jpg',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///C:/Windows/win.ini',
    'blob:https://www.instagram.com/abc',
    '//scontent.cdninstagram.com/a.jpg',
    'não é url',
    '',
    undefined,
    null,
    { toString() { return 'https://evil.com'; } }
  ];
  for (const u of permitidos) {
    bg.downloads.length = 0;
    r = await bg.enviar({ type: 'pipf-download', url: u, filename: 'Instagram/a.jpg' });
    chk(r && r.ok === true && bg.downloads.length === 1, 'download PERMITIDO: ' + u);
  }
  for (const u of negados) {
    bg.downloads.length = 0;
    r = await bg.enviar({ type: 'pipf-download', url: u, filename: 'Instagram/a.jpg' });
    chk(r && r.ok === false && r.error === 'endereço não permitido' && bg.downloads.length === 0, 'download NEGADO: ' + String(u && u.toString ? u.toString() : u));
  }
  bg.downloads.length = 0;
  await bg.enviar({ type: 'pipf-download', url: 'https://scontent.cdninstagram.com/ok.jpg', filename: 'Instagram/a.jpg' });
  chk(bg.downloads[0].url === 'https://scontent.cdninstagram.com/ok.jpg' && bg.downloads[0].conflictAction === 'uniquify', 'download: usa u.href e conflictAction=uniquify');

  const nome = async (fn) => {
    bg.downloads.length = 0;
    await bg.enviar({ type: 'pipf-download', url: 'https://scontent.cdninstagram.com/ok.jpg', filename: fn });
    return bg.downloads.length ? bg.downloads[0].filename : '(sem download)';
  };
  chk(await nome('Instagram/fulano_CxYZabcdefg.mp4') === 'Instagram/fulano_CxYZabcdefg.mp4', 'filename normal passa intacto (subpasta Instagram/ preservada)');
  let n = await nome('../../Windows/evil.exe');
  chk(!/\.\./.test(n) && !/^[\\/]/.test(n), 'filename: ".." removido (' + n + ')');
  n = await nome('/abs/path.jpg');
  chk(n === 'abs/path.jpg', 'filename: barra inicial removida (' + n + ')');
  n = await nome('///x.jpg');
  chk(n === 'x.jpg', 'filename: várias barras iniciais removidas (' + n + ')');
  n = await nome('/../x.jpg');
  chk(!/\.\./.test(n) && !/^[\\/]/.test(n), 'filename: "/../x" não vira caminho absoluto nem sobe pasta (' + n + ')');
  n = await nome('a/..\\..\\b.jpg');
  chk(!/\.\./.test(n) && !/\\/.test(n), 'filename: "..\\" com barra invertida neutralizado (' + n + ')');
  n = await nome('a<b>c:d"e\\f|g?h*i.jpg');
  chk(n === 'a_b_c_d_e_f_g_h_i.jpg', 'filename: caracteres proibidos viram _ (' + n + ')');
  n = await nome('C:\\Windows\\x.jpg');
  chk(!/:/.test(n) && !/\\/.test(n), 'filename: letra de unidade/backslash neutralizados (' + n + ')');
  n = await nome('a\u0000b\u001fc.jpg');
  chk(n === 'a_b_c.jpg', 'filename: caracteres de controle viram _ (' + JSON.stringify(n) + ')');
  n = await nome('....');
  chk(n === '_', 'filename: "...." vira "_" (' + n + ')');
  n = await nome('x'.repeat(300));
  chk(n.length === 150, 'filename: truncado em 150 (' + n.length + ')');
  for (const vazio of ['', undefined, null]) {
    n = await nome(vazio);
    chk(n === undefined, 'filename vazio/ausente -> undefined (Chrome escolhe o nome) [' + String(vazio) + ']');
  }
  n = await nome(12345);
  chk(n === '12345', 'filename numérico vira string');

  bg.modo = 'erro';
  r = await bg.enviar({ type: 'pipf-download', url: 'https://scontent.cdninstagram.com/ok.jpg', filename: 'a.jpg' });
  chk(r && r.ok === false && r.error === 'Download invalido', 'download: lastError do Chrome é repassado em { ok:false, error }');
  bg.modo = 'semid';
  r = await bg.enviar({ type: 'pipf-download', url: 'https://scontent.cdninstagram.com/ok.jpg', filename: 'a.jpg' });
  chk(r && r.ok === false && r.error === 'falha ao iniciar', 'download: id indefinido -> "falha ao iniciar"');
  bg.modo = 'ok';
  const ret = bg.ls.onMessage[0]({ type: 'pipf-download', url: 'https://scontent.cdninstagram.com/ok.jpg' }, { tab: { id: 1 } }, () => {});
  chk(ret === true, 'download válido: handler devolve true (resposta assíncrona)');
}

// ================================================================ execução
(async () => {
  try { await testesBackground(); } catch (e) { falhas++; console.log('FALHA testesBackground lançou: ' + (e && e.stack || e)); }
  console.log('RESULTADO ok=' + ok + ' falhas=' + falhas + ' avisos=' + avisos);
  process.exit(falhas ? 1 : 0);
})();
