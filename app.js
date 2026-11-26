/* Thunai app logic. Works in any modern browser and inside the Android shell (window.ThunaiNative). */
(() => {
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('thunai.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('thunai.' + k, JSON.stringify(v)); } catch (e) {} }
};
const NATIVE = window.ThunaiNative || null;
const arr = v => Array.isArray(v) ? v : [];
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ================= i18n ================= */
let LANG = store.get('lang', (navigator.language || '').toLowerCase().startsWith('ta') ? 'ta' : 'en');
const t = (k, vars) => {
  let s = (I18N[LANG] && I18N[LANG][k]) ?? I18N.en[k] ?? k;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
  return s;
};
const hooks = [];
const onLang = f => { hooks.push(f); };
function translate(root) {
  (root || document).querySelectorAll('[data-t]').forEach(e => { e.textContent = t(e.dataset.t); });
  (root || document).querySelectorAll('[data-tp]').forEach(e => { e.placeholder = t(e.dataset.tp); });
}
function applyLang() {
  document.documentElement.lang = LANG;
  document.body.classList.toggle('ta', LANG === 'ta');
  translate();
  $('#lEn').setAttribute('aria-pressed', LANG === 'en'); $('#lTa').setAttribute('aria-pressed', LANG === 'ta');
  $('#sEn').setAttribute('aria-pressed', LANG === 'en'); $('#sTa').setAttribute('aria-pressed', LANG === 'ta');
  hooks.forEach(f => { try { f(); } catch (e) { console.error(e); } });
}
function setLang(l) { if (l === LANG) return; LANG = l; store.set('lang', l); stopSpeak(); applyLang(); }
$('#lEn').onclick = () => setLang('en'); $('#lTa').onclick = () => setLang('ta');
$('#sEn').onclick = () => setLang('en'); $('#sTa').onclick = () => setLang('ta');
const aiLang = () => LANG === 'ta'
  ? 'Write every human-readable text value in simple, everyday spoken Tamil (தமிழ் script), the way a kind neighbour in Chennai would explain it. Keep JSON keys and enum values in English.'
  : 'Write every human-readable text value in simple, plain English that an elderly person understands.';

/* ================= UI helpers ================= */
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2800); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
const icon = (n, s = 18) => `<svg width="${s}" height="${s}"><use href="#i-${n}"/></svg>`;
async function busy(btn, errEl, fn) {
  const html = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span><span>${esc(t('c.thinking'))}</span>`;
  if (errEl) errEl.innerHTML = '';
  try { await fn(); }
  catch (e) {
    console.error(e);
    if (errEl) { errEl.innerHTML = esc(errText(e)) + (e && (e.code === 'nokey' || e.code === 'badkey' || e.code === 'model') ? ` <a href="#settings">${esc(t('nav.settings'))} →</a>` : ''); }
  }
  finally { btn.disabled = false; btn.innerHTML = html; translate(btn); }
}
window.addEventListener('scroll', () => $('#top').classList.toggle('scrolled', scrollY > 8), { passive: true });

function filePicker(inputId) {
  let f = null; const input = $('#' + inputId), label = input.closest('.pick'), thumb = label.querySelector('.thumb');
  input.addEventListener('change', () => {
    f = input.files[0] || null;
    if (f) { const u = URL.createObjectURL(f); thumb.innerHTML = `<img alt="" src="${u}">`; }
  });
  return { get: () => f, clear() { f = null; input.value = ''; thumb.innerHTML = icon('camera', 26); } };
}
async function shrink(file) {
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', .86));
  } catch (e) { return file; }
}
const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
async function imgPart(file) { const b = await shrink(file); return { inlineData: { mimeType: b.type || 'image/jpeg', data: await blobToB64(b) } }; }

/* ================= native bridges with web fallbacks ================= */
function share(text) {
  if (NATIVE && NATIVE.share) { NATIVE.share(String(text)); return; }
  if (navigator.share) { navigator.share({ text: String(text) }).catch(() => {}); return; }
  copy(text);
}
async function copy(text) {
  if (NATIVE && NATIVE.copy) { NATIVE.copy(String(text)); toast(t('c.copied')); return; }
  try { await navigator.clipboard.writeText(String(text)); toast(t('c.copied')); }
  catch (e) { const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast(t('c.copied')); } catch (e2) {} ta.remove(); }
}
function openExt(url) { if (NATIVE && NATIVE.openUrl) { NATIVE.openUrl(url); return; } window.open(url, '_blank', 'noopener'); }
document.addEventListener('click', e => { const a = e.target.closest('a[data-ext]'); if (a) { e.preventDefault(); openExt(a.getAttribute('href')); } });

/* ----- voice output ----- */
let audioEl = null, speakingBtn = null, speakSeq = 0;
const ttsCache = new Map();
function setSpeakBtn(btn) {
  if (speakingBtn && speakingBtn !== btn) { speakingBtn.innerHTML = icon('speak') + `<span>${esc(t('c.readAloud'))}</span>`; }
  speakingBtn = btn || null;
  if (btn) btn.innerHTML = icon('pause') + `<span>${esc(t('c.stop'))}</span>`;
}
window.__thunaiSpeakDone = () => setSpeakBtn(null);
function stopSpeak() {
  speakSeq++;
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
  if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; }
  if (NATIVE && NATIVE.stopSpeaking) { try { NATIVE.stopSpeaking(); } catch (e) {} }
  setSpeakBtn(null);
}
let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; } }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
async function speak(text, btn) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!text) return;
  stopSpeak();                       // stops anything playing and invalidates older requests
  const my = speakSeq, alive = () => my === speakSeq;
  setSpeakBtn(btn);
  const ta = /[\u0B80-\u0BFF]/.test(text), lang = ta ? 'ta-IN' : 'en-IN';
  const done = () => { if (alive() && speakingBtn === btn) setSpeakBtn(null); };
  const gemFirst = ta && store.get('gemVoice', true) && key();
  if (gemFirst) { try { await geminiSpeak(text, done, alive); return; } catch (e) { if (!alive()) return; console.warn('gemini tts', e); } }
  if (!alive()) return;
  if (NATIVE && NATIVE.speak) { try { if (NATIVE.speak(text, lang) === 'ok') { setTimeout(done, Math.min(90000, 1500 + text.length * 80)); return; } } catch (e) {} }
  if ('speechSynthesis' in window) {
    if (!voices.length) loadVoices();
    const v = voices.find(v => v.lang.toLowerCase().replace('_', '-').startsWith(ta ? 'ta' : 'en-in')) || (!ta ? voices.find(v => /^en/i.test(v.lang)) : null);
    if (v || !ta) { const u = new SpeechSynthesisUtterance(text); if (v) u.voice = v; u.lang = lang; u.onend = done; u.onerror = done; speechSynthesis.speak(u); return; }
  }
  if (key() && !gemFirst) { try { await geminiSpeak(text, done, alive); return; } catch (e) { if (!alive()) return; } }
  if (alive()) { done(); toast(t('err.voice')); }
}
function sayBtn(textFn, extraCls = 'soft') {
  const b = el('button', 'btn ' + extraCls + ' saybtn', icon('speak') + `<span>${esc(t('c.readAloud'))}</span>`);
  b.onclick = () => { if (speakingBtn === b) stopSpeak(); else speak(typeof textFn === 'function' ? textFn() : textFn, b); };
  return b;
}
async function geminiSpeak(text, onEnd, alive) {
  let url = ttsCache.get(text);
  if (!url) { url = URL.createObjectURL(await fetchTTS(text)); ttsCache.set(text, url); }
  if (alive && !alive()) return;     // a newer request or Stop came in while we were fetching
  if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  const a = new Audio(url); audioEl = a;
  a.onended = onEnd; a.onerror = onEnd;
  await a.play();
}
async function fetchTTS(text) {
  const H = { 'Content-Type': 'application/json', 'x-goog-api-key': key() };
  for (const m of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts']) {
    try {
      const r = await fetch(`${BASE}/models/${m}:generateContent`, { method: 'POST', headers: H, body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } }) });
      if (r.ok) { const a = findAudio(await r.json()); if (a) return toAudioBlob(a); }
    } catch (e) {}
  }
  try {
    const r = await fetch(`${BASE}/interactions`, { method: 'POST', headers: H, body: JSON.stringify({
      model: 'gemini-3.8-flash-tts', input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Kore' }] } }) });
    if (r.ok) { const a = findAudio(await r.json()); if (a) return toAudioBlob(a); }
  } catch (e) {}
  throw new Error('tts unavailable');
}
function findAudio(o, d = 0) {
  if (!o || typeof o !== 'object' || d > 14) return null;
  const id = o.inlineData || o.inline_data;
  if (id && typeof id.data === 'string') return { data: id.data, mime: id.mimeType || id.mime_type || '' };
  const mime = o.mime_type || o.mimeType || '';
  if (typeof o.data === 'string' && o.data.length > 200 && (o.type === 'audio' || /audio/.test(mime))) return { data: o.data, mime };
  for (const v of (Array.isArray(o) ? o : Object.values(o))) { const f = findAudio(v, d + 1); if (f) return f; }
  return null;
}
function toAudioBlob({ data, mime }) {
  const bin = atob(data), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) return new Blob([u], { type: 'audio/wav' });
  if (/mpeg|mp3|ogg|opus|aac/.test(mime)) return new Blob([u], { type: mime.split(';')[0] });
  const rate = num((mime.match(/rate=(\d+)/) || [])[1], 24000);
  const h = new DataView(new ArrayBuffer(44)), w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + u.length, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, u.length, true);
  return new Blob([h.buffer, u], { type: 'audio/wav' });
}

/* ----- voice input ----- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micOK = () => !!(NATIVE && NATIVE.listen) || !!SR;
let recog = null;
function listen(onText, btn) {
  const lang = LANG === 'ta' ? 'ta-IN' : 'en-IN';
  const live = on => btn && btn.classList.toggle('live', on);
  if (NATIVE && NATIVE.listen) {
    window.__thunaiSpeech = txt => { live(false); if (txt) onText(String(txt)); };
    window.__thunaiSpeechErr = () => live(false);
    live(true); NATIVE.listen(lang); return;
  }
  if (!SR) { toast(t('err.mic')); return; }
  if (recog) { recog.stop(); return; }
  recog = new SR(); recog.lang = lang; recog.interimResults = false; recog.maxAlternatives = 1;
  recog.onresult = e => onText(e.results[0][0].transcript);
  recog.onend = () => { recog = null; live(false); };
  recog.onerror = () => { recog = null; live(false); };
  live(true); toast(t('c.listening')); recog.start();
}
let lastInputByVoice = false;
$$('[data-mic]').forEach(b => {
  if (micOK()) b.hidden = false;
  b.addEventListener('click', () => listen(txt => {
    const inp = $('#' + b.dataset.mic); inp.value = (inp.value ? inp.value + ' ' : '') + txt;
    if (b.dataset.autosend) { lastInputByVoice = true; $('#chatForm').requestSubmit(); }
  }, b));
});

/* ================= Gemini ================= */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const key = () => store.get('key', '');
const model = () => store.get('model', 'gemini-3.8-flash');
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash'];
class AIError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
function errText(e) {
  const c = e && e.code;
  if (c && I18N.en['err.' + c]) return t('err.' + c);
  return t('err.generic');
}
async function gemini({ system, parts, contents, json = true }) {
  const k = key(); if (!k) throw new AIError('nokey');
  if (navigator.onLine === false) throw new AIError('net');
  const body = { contents: contents || [{ role: 'user', parts }], generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const list = [model(), ...MODELS.filter(m => m !== model())];
  let last = new AIError('generic');
  for (const m of list) {
    let r;
    try { r = await fetch(`${BASE}/models/${m}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k }, body: JSON.stringify(body) }); }
    catch (e) { throw new AIError('net'); }
    if (r.status === 429) throw new AIError('quota');
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      if (/API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|unregistered callers/i.test(txt)) throw new AIError('badkey');
      if (r.status === 404 || /not found|is not supported|unsupported/i.test(txt)) { last = new AIError('model'); continue; }
      if (r.status >= 500) { last = new AIError('generic'); continue; }
      throw new AIError('generic', txt);
    }
    const j = await r.json();
    if (m !== model()) store.set('model', m);
    const c = j.candidates && j.candidates[0];
    const text = c && c.content ? arr(c.content.parts).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('') : '';
    if (!text) throw new AIError('blocked');
    return json ? parseJSON(text) : text;
  }
  throw last;
}
function parseJSON(s) {
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  throw new AIError('generic', 'bad json');
}
async function ask(prompt, file) {
  const parts = [{ text: prompt }];
  if (file) parts.push(await imgPart(file));
  return gemini({ parts });
}

/* ================= routing between screens ================= */
const MODS = [
  { id: 'flood', grp: 'grp.safe' }, { id: 'scam', grp: 'grp.safe' }, { id: 'near', grp: 'grp.safe' }, { id: 'med', grp: 'grp.health' }, { id: 'health', grp: 'grp.health' },
  { id: 'sch', grp: 'grp.help' }, { id: 'doc', grp: 'grp.help' }, { id: 'energy', grp: 'grp.save' }, { id: 'green', grp: 'grp.save' }, { id: 'lake', grp: 'grp.city' }
];
const VIEWS = ['home', ...MODS.map(m => m.id), 'ask', 'sos', 'settings'];
let keepSpeech = false;
const NAV = [['home', 'home'], ['flood', 'flood'], ['sos', 'sos'], ['med', 'med'], ['settings', 'settings']];
const TOPNAV = ['home', 'flood', 'scam', 'med', 'sos'];
let current = 'home';
function show() {
  const h = location.hash.slice(1), v = VIEWS.includes(h) ? h : 'home';
  if (v !== current && !keepSpeech) stopSpeak();
  keepSpeech = false;
  current = v;
  $$('.view').forEach(e => e.classList.toggle('on', e.id === 'v-' + v));
  $$('#bnav a, #topnav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + v));
  window.scrollTo(0, 0);
  if (v === 'flood') { initFlood(); loadRain(false); startLive(); } else stopLive();
  if (v === 'lake') initLake();
  if (v === 'home') { renderHome(); loadRain(false); }
  if (v === 'med') renderBox();
  if (v === 'near') initNear();
  if (v === 'health') renderHealth();
  if (v === 'ask') askIntro();
}
window.addEventListener('hashchange', show);
$$('.back').forEach(b => b.addEventListener('click', () => { if (history.length > 1 && current !== 'home') history.back(); else location.hash = 'home'; }));
window.thunaiBack = () => { if (current !== 'home') { location.hash = 'home'; return true; } return false; };

function renderNav() {
  const html = NAV.map(([id, ic]) => id === 'sos'
    ? `<a href="#sos" class="sos${current === id ? ' on' : ''}"><span class="i">SOS</span><span>${esc(t('nav.sos'))}</span></a>`
    : `<a href="#${id}"${current === id ? ' class="on"' : ''}><span class="i">${icon(ic, 22)}</span><span>${esc(t('nav.' + id))}</span></a>`).join('');
  $('#bnav').innerHTML = html;
  $('#topnav').innerHTML = TOPNAV.map(id => `<a href="#${id}"${current === id ? ' class="on"' : ''}>${esc(t(id === 'scam' ? 'm.scam.t' : 'nav.' + id))}</a>`).join('');
}
function renderHome() {
  const h = new Date().getHours();
  $('#greet').textContent = t(h < 12 ? 'greet.morning' : h < 17 ? 'greet.afternoon' : 'greet.evening') + ' 👋';
  const on = !!key();
  $('#aiChip').classList.toggle('on', on); $('#aiChipTxt').textContent = t(on ? 'ai.on' : 'ai.off');
  $('#aiNotice').hidden = on;
  $('#quick').innerHTML = [['flood', 'qa.flood'], ['scam', 'qa.scam'], ['med', 'qa.med'], ['sch', 'qa.sch']]
    .map(([id, k]) => `<a href="#${id}" style="--c:var(--c-${id})"><span class="q">${icon(id, 26)}</span>${esc(t(k))}</a>`).join('');
  $('#tiles').innerHTML = MODS.map(m => `<a class="tile" href="#${m.id}" style="--c:var(--c-${m.id})"><span class="top"><span class="ic">${icon(m.id, 24)}</span><span class="grp">${esc(t(m.grp))}</span></span><b>${esc(t('m.' + m.id + '.t'))}</b><span class="d">${esc(t('m.' + m.id + '.d'))}</span></a>`).join('');
}
$('#aiChip').onclick = () => { location.hash = 'settings'; };
const elderOn = () => store.get('elder', false);
function renderElder() {
  document.body.classList.toggle('elder', elderOn());
  const g = $('#elderHome'); g.hidden = !elderOn();
  if (!elderOn()) return;
  g.innerHTML = `<a href="#ask" class="wide" style="--c:var(--c-ask)">${icon('ask', 40)}<span>${esc(t('ask.hero'))}</span></a>` + [['sos', 'el.sos', '--bad'], ['scam', 'el.scam', '--c-scam'], ['med', 'el.med', '--c-med'], ['flood', 'el.flood', '--c-flood']]
    .map(([id, k, c]) => `<a href="#${id}" style="--c:var(${c})">${id === 'sos' ? '<b style="font-size:34px">SOS</b>' : icon(id, 44)}<span>${esc(t(k))}</span></a>`).join('') +
    `<button class="exit" id="elderExit">${esc(t('el.exit'))}</button>`;
  $('#elderExit').onclick = () => { store.set('elder', false); renderElder(); renderSettings(); };
}
onLang(renderElder);
onLang(renderNav); onLang(renderHome);

/* ================= FLOOD ================= */
const VEH = { walk: { lim: 30, prof: 'routed-foot' }, two: { lim: 15, prof: 'routed-car' }, car: { lim: 25, prof: 'routed-car' } };
let veh = store.get('veh', 'two'); if (!VEH[veh]) veh = 'two';
let fromPt = { lat: 12.926056, lng: 80.117389, k: 'place.tbm' }, toPt = { lat: 12.93694, lng: 80.13056, k: 'place.tbmsan' };
let reports = arr(store.get('reports', [])), repPt = null, tapMode = null;
let fmap = null, L_ = {}, bestRoute = null, blockedRoute = null, routeSeq = 0, lastStatus = null, fitDone = false;
const ptLabel = p => p.k ? t(p.k) : (p.name || t('fl.pinned'));
const depthCol = d => d > 30 ? '#e11d48' : d >= 15 ? '#2563eb' : '#38bdf8';
const saveReports = () => store.set('reports', reports);
let remote = [];
const allReports = () => [...reports, ...remote];

function tiles(map) {
  const base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tl-base', attribution: '© OpenStreetMap contributors' });
  let errs = 0, swapped = false;
  base.on('tileerror', () => {
    if (++errs < 6 || swapped) return;
    swapped = true; map.removeLayer(base);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, className: 'tl-base', attribution: 'Tiles © Esri — OpenStreetMap contributors and others' }).addTo(map).bringToBack();
  });
  return base;
}
const pinIcon = (col, txt) => L.divIcon({ className: '', html: `<div class="pin" style="background:${col}"><b>${txt}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });

function initFlood() {
  if (fmap) { setTimeout(() => fmap.invalidateSize(), 60); return; }
  if (!window.L) { setStatus('fl.routeErr', 'bad'); return; }
  fmap = L.map('fmap', { zoomControl: false, attributionControl: true }).setView([12.931, 80.124], 15);
  L.control.zoom({ position: 'bottomright' }).addTo(fmap);
  tiles(fmap).addTo(fmap);
  L_.reports = L.layerGroup().addTo(fmap);
  L_.from = L.marker([fromPt.lat, fromPt.lng], { icon: pinIcon('#10b981', 'A'), draggable: true }).addTo(fmap);
  L_.to = L.marker([toPt.lat, toPt.lng], { icon: pinIcon('#e11d48', 'B'), draggable: true }).addTo(fmap);
  L_.from.on('dragend', e => { const ll = e.target.getLatLng(); fromPt = { lat: ll.lat, lng: ll.lng }; syncPts(); computeRoute(); });
  L_.to.on('dragend', e => { const ll = e.target.getLatLng(); toPt = { lat: ll.lat, lng: ll.lng }; syncPts(); computeRoute(); });
  fmap.on('click', e => {
    if (!tapMode) return;
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (tapMode === 'from') { fromPt = p; syncPts(); computeRoute(); }
    else if (tapMode === 'to') { toPt = p; syncPts(); computeRoute(); }
    else if (tapMode === 'rep') setRepPt(p);
    setTap(null);
  });
  renderReports(); syncPts(); computeRoute();
  setTimeout(() => fmap.invalidateSize(), 120);
}
function syncPts() {
  $('#fromIn').value = ptLabel(fromPt); $('#toIn').value = ptLabel(toPt);
  if (fmap) { L_.from.setLatLng([fromPt.lat, fromPt.lng]); L_.to.setLatLng([toPt.lat, toPt.lng]); fitDone = false; }
}
function setTap(mode) {
  tapMode = mode; const h = $('#mapHint');
  if (mode) { h.textContent = t('fl.tapHint.' + mode); h.hidden = false; $('#fmap').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  else h.hidden = true;
}
$('#fromTap').onclick = () => setTap('from'); $('#toTap').onclick = () => setTap('to'); $('#repTap').onclick = () => setTap('rep');
function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('no geo'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}
async function useLoc(which, btn) {
  btn.disabled = true;
  try {
    const p = await locate(); p.k = 'fl.myloc'; store.set('lastLoc', { lat: p.lat, lng: p.lng });
    if (which === 'from') { fromPt = p; syncPts(); computeRoute(); }
    else if (which === 'to') { toPt = p; syncPts(); computeRoute(); }
    else setRepPt(p);
    if (fmap) fmap.setView([p.lat, p.lng], Math.max(fmap.getZoom(), 15));
  } catch (e) { toast(t('locErr')); }
  btn.disabled = false;
}
$('#fromLoc').onclick = e => useLoc('from', e.currentTarget);
$('#toLoc').onclick = e => useLoc('to', e.currentTarget);
$('#repLoc').onclick = e => useLoc('rep', e.currentTarget);
$('#repCenter').onclick = () => { if (fmap) { const c = fmap.getCenter(); setRepPt({ lat: c.lat, lng: c.lng }); } };
function setRepPt(p) {
  repPt = p;
  if (!fmap) return;
  if (L_.rep) L_.rep.remove();
  L_.rep = L.marker([p.lat, p.lng], { icon: pinIcon('#7c3aed', '?'), draggable: true }).addTo(fmap);
  L_.rep.on('dragend', e => { const ll = e.target.getLatLng(); repPt = { lat: ll.lat, lng: ll.lng }; });
  $('#repWhere').textContent = t('fl.pinSet') + ` (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`;
}

/* search with OpenStreetMap Nominatim */
function searchBox(inputId, sugId, onPick, extra = '') {
  const inp = $('#' + inputId), sug = $('#' + sugId); let tm, seq = 0;
  inp.addEventListener('input', () => {
    clearTimeout(tm); const q = inp.value.trim();
    if (q.length < 3) { sug.hidden = true; return; }
    tm = setTimeout(async () => {
      const my = ++seq;
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=in&viewbox=79.95,13.25,80.35,12.75&bounded=0${extra}&accept-language=${LANG === 'ta' ? 'ta,en' : 'en'}&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } }); const j = await r.json();
        if (my !== seq) return;
        sug.innerHTML = '';
        if (!arr(j).length) { const b = el('button'); b.textContent = t('notFound'); b.disabled = true; sug.append(b); }
        arr(j).forEach(it => { const b = el('button'); b.type = 'button'; b.textContent = String(it.display_name || '').split(',').slice(0, 3).join(','); b.onclick = () => { sug.hidden = true; onPick(it); }; sug.append(b); });
        sug.hidden = false;
      } catch (e) { sug.hidden = true; toast(t('err.net')); }
    }, 550);
  });
  inp.addEventListener('focus', () => inp.select());
  document.addEventListener('click', e => { if (!e.target.closest('#' + sugId) && e.target !== inp) sug.hidden = true; });
}
const pickPt = it => ({ lat: num(it.lat), lng: num(it.lon), name: String(it.name || it.display_name || '').split(',')[0] });
searchBox('fromIn', 'fromSug', it => { fromPt = pickPt(it); syncPts(); computeRoute(); if (fmap) fmap.setView([fromPt.lat, fromPt.lng], 15); });
searchBox('toIn', 'toSug', it => { toPt = pickPt(it); syncPts(); computeRoute(); if (fmap) fmap.setView([toPt.lat, toPt.lng], 15); });

function renderVeh() {
  $('#vehPills').innerHTML = Object.keys(VEH).map(k => `<button class="pill" data-v="${k}" aria-pressed="${k === veh}">${esc(t('veh.' + k))}</button>`).join('');
}
$('#vehPills').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; veh = b.dataset.v; store.set('veh', veh); renderVeh(); computeRoute(); };

/* geometry helpers (metres) */
function distToRoute(p, coords) {
  const kx = Math.cos(p.lat * Math.PI / 180) * 111320, ky = 110540; let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p.lng) * kx, ay = (coords[i - 1][1] - p.lat) * ky, bx = (coords[i][0] - p.lng) * kx, by = (coords[i][1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let tt = L2 ? -(ax * dx + ay * dy) / L2 : 0; tt = Math.max(0, Math.min(1, tt));
    const x = ax + tt * dx, y = ay + tt * dy; best = Math.min(best, Math.hypot(x, y));
  }
  return best;
}
const hitsOf = (route, bad) => route ? bad.filter(r => distToRoute(r, route.geometry.coordinates) < 75) : [];
function offset(p, m, bearing) {
  const b = bearing * Math.PI / 180;
  return { lat: p.lat + (m * Math.cos(b)) / 110540, lng: p.lng + (m * Math.sin(b)) / (111320 * Math.cos(p.lat * Math.PI / 180)) };
}
async function osrm(points, prof, alts) {
  const c = points.map(p => p.lng.toFixed(6) + ',' + p.lat.toFixed(6)).join(';');
  const q = `?overview=full&geometries=geojson&steps=false&alternatives=${alts ? 'true' : 'false'}`;
  const urls = [`https://routing.openstreetmap.de/${prof}/route/v1/driving/${c}${q}`];
  if (prof === 'routed-car') urls.push(`https://router.project-osrm.org/route/v1/driving/${c}${q}`);
  for (const u of urls) {
    try { const r = await fetch(u); if (!r.ok) continue; const j = await r.json(); if (j.code === 'Ok' && arr(j.routes).length) return j.routes; } catch (e) {}
  }
  throw new Error('route');
}
async function detour(firstHits, bad, prof) {
  const f = firstHits[0];
  for (const d of [350, 700, 1300]) {
    const vias = [0, 45, 90, 135, 180, 225, 270, 315].map(b => offset(f, d, b));
    const res = await Promise.all(vias.map(v => osrm([fromPt, v, toPt], prof, false).then(r => r[0]).catch(() => null)));
    const ok = res.filter(r => r && hitsOf(r, bad).length === 0).sort((a, b) => a.distance - b.distance);
    if (ok.length) return ok[0];
  }
  return null;
}
function setStatus(k, cls, vars, route) { lastStatus = { k, cls, vars, route }; renderStatus(); }
function renderStatus() {
  if (!lastStatus) return;
  const { k, cls, vars, route } = lastStatus, st = $('#routeSt');
  const v = typeof vars === 'function' ? vars() : vars;
  st.textContent = t(k, v);
  st.style.color = cls === 'bad' ? 'var(--bad)' : cls === 'warn' ? 'var(--warn)' : cls === 'ok' ? 'var(--ok)' : '';
  $('#routeMeta').textContent = route ? `${(route.distance / 1000).toFixed(1)} ${t('km')} · ${Math.max(1, Math.round(route.duration / 60))} ${t('min')}` : '';
}
async function computeRoute() {
  if (!fmap) return;
  const seq = ++routeSeq; setStatus('fl.routing', '');
  const { lim, prof } = VEH[veh], bad = allReports().filter(r => r.depth > lim);
  try {
    const routes = await osrm([fromPt, toPt], prof, true); if (seq !== routeSeq) return;
    const firstHits = hitsOf(routes[0], bad);
    let best = routes.find(r => hitsOf(r, bad).length === 0) || null;
    if (!best && firstHits.length) { best = await detour(firstHits, bad, prof); if (seq !== routeSeq) return; }
    drawRoute(best, firstHits.length ? routes[0] : null);
    if (!best) setStatus('fl.none', 'bad', () => ({ v: t('veh.' + veh) }), null);
    else if (firstHits.length) setStatus('fl.rerouted', 'warn', { n: firstHits.length }, best);
    else setStatus('fl.safe', 'ok', null, best);
  } catch (e) { if (seq === routeSeq) { drawRoute(null, null); setStatus('fl.routeErr', 'bad'); } }
}
function drawRoute(best, blocked) {
  ['casing', 'line', 'blocked'].forEach(k => { if (L_[k]) { L_[k].remove(); L_[k] = null; } });
  bestRoute = best; blockedRoute = blocked;
  const ll = r => r.geometry.coordinates.map(c => [c[1], c[0]]);
  if (blocked) L_.blocked = L.polyline(ll(blocked), { color: '#e11d48', weight: 5, opacity: .55, dashArray: '8 10' }).addTo(fmap);
  if (best) {
    L_.casing = L.polyline(ll(best), { color: '#ffffff', weight: 10, opacity: .95 }).addTo(fmap);
    L_.line = L.polyline(ll(best), { color: '#f59e0b', weight: 6 }).addTo(fmap);
  }
  const b = L.latLngBounds([[fromPt.lat, fromPt.lng], [toPt.lat, toPt.lng]]);
  if (best) b.extend(L_.line.getBounds());
  if (!fitDone) { fmap.fitBounds(b, { padding: [40, 40] }); fitDone = true; }
}
function renderReports() {
  if (fmap) {
    L_.reports.clearLayers();
    allReports().forEach(r => {
      const col = depthCol(r.depth);
      const c = L.circle([r.lat, r.lng], { radius: 70, color: col, fillColor: col, fillOpacity: .25, weight: 2 }).addTo(L_.reports);
      c.bindPopup(`<b>${esc(r.depth)} cm</b>${r.sample ? ' · ' + esc(t('fl.sample')) : ''}<br>${esc(r.advice || '')}`);
      L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: `<div style="display:flex;justify-content:center"><span class="dlabel" style="color:${col}">${esc(r.depth)} cm</span></div>`, iconSize: [70, 24], iconAnchor: [35, 12] }), interactive: false }).addTo(L_.reports);
    });
  }
  const list = $('#repList');
  if (!allReports().length) { list.innerHTML = `<p class="hint">${esc(t('fl.noReports'))}</p>`; return; }
  list.innerHTML = '';
  allReports().sort((a, b) => b.at - a.at).forEach(r => {
    const row = el('div', 'rep');
    row.innerHTML = `<span class="dd" style="background:${depthCol(r.depth)}">${esc(r.depth)}</span><div style="flex:1"><b></b><div class="hint" style="margin-top:2px"></div></div><button class="x" aria-label="${esc(t('c.remove'))}">✕</button>`;
    row.querySelector('b').textContent = (r.depth + ' cm ' + t('fl.deep')) + (r.sample ? ' · ' + t('fl.sample') : '') + (r.remote ? ' · ' + t('live.tag') : '');
    row.querySelector('.hint').textContent = (r.advice || '') + ' · ' + new Date(r.at).toLocaleString(LANG === 'ta' ? 'ta-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
    row.querySelector('.x').onclick = () => {
      if (r.remote) { const hid = arr(store.get('hiddenRemote', [])); hid.push(r.id); store.set('hiddenRemote', hid.slice(-300)); remote = remote.filter(x => x.id !== r.id); }
      else { reports = reports.filter(x => x.id !== r.id); saveReports(); }
      renderReports(); computeRoute(); };
    row.onclick = e => { if (!e.target.closest('.x') && fmap) { fmap.setView([r.lat, r.lng], 16); $('#fmap').scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
    list.append(row);
  });
}
$('#demoBtn').onclick = () => {
  const r = bestRoute || blockedRoute; if (!r) return;
  const c = r.geometry.coordinates[Math.floor(r.geometry.coordinates.length / 2)];
  reports.push({ id: 'd' + Date.now(), lat: c[1], lng: c[0], depth: 45, level: 'knee', advice: LANG === 'ta' ? 'மாதிரி: முழங்கால் அளவு தண்ணீர்' : 'Sample: knee-deep water', at: Date.now(), sample: true });
  saveReports(); renderReports(); computeRoute();
};
const fPick = filePicker('fImg');
$('#fGo').onclick = e => busy(e.currentTarget, $('#fErr'), async () => {
  const img = fPick.get(), desc = $('#fDesc').value.trim();
  if (!repPt) { $('#fErr').textContent = t('fl.needLoc'); return; }
  if (!img && !desc) { $('#fErr').textContent = t('fl.needInput'); return; }
  const r = await ask(`You are FloodSense, estimating standing flood-water depth on a street in Chennai, India, from a citizen's photo and/or description. Estimate depth by comparing with reference objects: ankle about 10 cm, kerb about 15 cm, car door sill about 30 cm, adult knee about 45-50 cm, motorbike wheel about 55 cm, car tyre about 60 cm, adult waist about 95 cm. Safety rules: two-wheelers unsafe above 15 cm, cars and autos unsafe above 25 cm, walking unsafe above 30 cm or anywhere a current or open drain is visible. If the photo is not a flooded street, set depth_cm to 0 and say so in advice.
Reply with only JSON: {"depth_cm": integer, "level": "short word like ankle, knee or waist", "reference": "object you compared with", "confidence": "low|medium|high", "safe": {"walk": boolean, "two_wheeler": boolean, "car": boolean}, "advice": "one or two short sentences", "hazards": ["short item"]}
${aiLang()}${desc ? '\nCitizen\'s description: ' + desc.slice(0, 500) : ''}`, img);
  const d = Math.max(0, Math.min(300, Math.round(num(r.depth_cm))));
  const sf = r.safe || {}, out = $('#fOut'); out.innerHTML = '';
  const card = el('div', 'card');
  const chip = (k, lbl) => `<span class="tag ${sf[k] ? 'ok' : 'bad'}">${esc(t(lbl))}: ${esc(t(sf[k] ? 'ok' : 'unsafe'))}</span>`;
  card.innerHTML = `<div class="big" style="color:${depthCol(d)}">${d} cm</div><p class="hint" style="margin-top:6px"></p>
   <div class="pills" style="margin-top:12px">${chip('walk', 'veh.walk')}${chip('two_wheeler', 'veh.two')}${chip('car', 'veh.car')}</div>
   <p style="margin-top:12px" class="adv"></p><ul class="list"></ul><div class="btns"></div>`;
  card.querySelector('.hint').textContent = `${r.level || ''} · ${t('fl.compared')} ${r.reference || '—'} · ${r.confidence || ''} ${t('fl.conf')}`;
  card.querySelector('.adv').textContent = r.advice || '';
  card.querySelector('ul').innerHTML = arr(r.hazards).slice(0, 4).map(h => `<li>${esc(h)}</li>`).join('');
  const add = el('button', 'btn', icon('pin') + `<span>${esc(t('fl.add'))}</span>`);
  const at = repPt;
  add.onclick = () => {
    const rep = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), lat: at.lat, lng: at.lng, depth: d, level: String(r.level || '').slice(0, 30), advice: String(r.advice || '').slice(0, 200), at: Date.now() };
    reports.push(rep); publishReport(rep);
    saveReports(); renderReports(); computeRoute(); add.disabled = true; add.textContent = t('fl.added');
    if (L_.rep) { L_.rep.remove(); L_.rep = null; } repPt = null; $('#repWhere').textContent = '';
    $('#fmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  card.querySelector('.btns').append(add, sayBtn(() => `${d} ${LANG === 'ta' ? 'சென்டிமீட்டர்' : 'centimetres'}. ${r.advice || ''}`));
  out.append(card); card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (elderOn()) card.querySelector('.saybtn').click();
});
onLang(() => { renderVeh(); renderStatus(); renderReports(); $('#fromIn').value = ptLabel(fromPt); $('#toIn').value = ptLabel(toPt); if (tapMode) setTap(tapMode); });

/* ================= SCAM ================= */
const SAMPLES = {
  s1: { en: 'This is Inspector Sharma from Mumbai Cyber Crime. A parcel in your name with illegal drugs was seized at customs. You are now under digital arrest. Stay on this video call and do not tell anyone in your family. Transfer ₹1,50,000 to the RBI verification account within 2 hours to clear your name.', ta: 'நான் மும்பை சைபர் கிரைம் இன்ஸ்பெக்டர் ஷர்மா பேசுகிறேன். உங்கள் பெயரில் போதைப்பொருள் உள்ள பார்சல் சுங்கத்துறையில் பிடிபட்டுள்ளது. நீங்கள் இப்போது டிஜிட்டல் கைதில் உள்ளீர்கள். இந்த வீடியோ அழைப்பைத் துண்டிக்காதீர்கள், குடும்பத்தில் யாரிடமும் சொல்லாதீர்கள். 2 மணி நேரத்துக்குள் RBI சரிபார்ப்புக் கணக்குக்கு ₹1,50,000 அனுப்புங்கள்.' },
  s2: { en: 'Dear Consumer, your electricity power will be disconnected tonight at 9.30 PM because your previous month bill was not updated. Please immediately contact our electricity officer on 98XXXXXX21. Thank you.', ta: 'அன்புள்ள நுகர்வோரே, உங்கள் கடந்த மாத மின் கட்டணம் புதுப்பிக்கப்படாததால் இன்று இரவு 9.30 மணிக்கு மின் இணைப்பு துண்டிக்கப்படும். உடனே எங்கள் மின் அதிகாரியை 98XXXXXX21 என்ற எண்ணில் தொடர்பு கொள்ளுங்கள்.' },
  s3: { en: 'Dear customer, your bank account will be BLOCKED today. Update your PAN and KYC immediately: http://bank-kyc-update.in-verify.co', ta: 'அன்புள்ள வாடிக்கையாளரே, உங்கள் வங்கிக் கணக்கு இன்று முடக்கப்படும். உடனே உங்கள் PAN, KYC-ஐப் புதுப்பிக்கவும்: http://bank-kyc-update.in-verify.co' },
  s4: { en: 'Your food order #4821 has been delivered by Ravi. Enjoy your meal! Rate your order in the app.', ta: 'உங்கள் உணவு ஆர்டர் #4821 ரவி மூலம் டெலிவரி செய்யப்பட்டது. உணவை ரசியுங்கள்! ஆப்பில் மதிப்பிடுங்கள்.' }
};
const renderSamples = () => { $('#sSamples').innerHTML = Object.keys(SAMPLES).map(k => `<button class="pill" data-s="${k}">${esc(t('s.' + k))}</button>`).join(''); };
$('#sSamples').onclick = e => { const b = e.target.closest('[data-s]'); if (b) $('#sTxt').value = SAMPLES[b.dataset.s][LANG]; };
onLang(renderSamples);
const sPick = filePicker('sImg');
$('#sGo').onclick = e => busy(e.currentTarget, $('#sErr'), async () => {
  const txt = $('#sTxt').value.trim(), img = sPick.get();
  if (!txt && !img) { $('#sErr').textContent = t('sc.need'); return; }
  const r = await ask(`You are Scam Shield, helping families in India spot fraud. Analyse the message${img ? ' and the screenshot' : ''}. Look for: fake authority (police, CBI, customs, courier, TRAI, bank, electricity board), urgency or threats, "digital arrest", requests for money, OTP, UPI PIN or screen-sharing apps, unknown links, prizes or lottery, job or task scams, demands for secrecy, emotional pressure. Real Indian police and agencies never arrest anyone over a video call and never ask for money to clear a case. Ordinary delivery or service messages with no request are safe.
Reply with only JSON: {"verdict": "scam|suspicious|safe", "risk": 0-100, "scam_type": "short name", "summary": "one sentence for an elderly reader", "red_flags": [{"flag": "short", "why": "one sentence"}], "do_now": ["short action, max 4"], "family_alert": "a two-sentence WhatsApp message to send a son or daughter about this message"}
${aiLang()}
Message:
"""${txt.slice(0, 4000)}"""`, img);
  const v = String(r.verdict || 'suspicious'), cls = v === 'scam' ? 'bad' : v === 'safe' ? 'ok' : 'warn';
  const word = t(v === 'scam' ? 'sc.scam' : v === 'safe' ? 'sc.safe' : 'sc.sus'), risk = Math.max(0, Math.min(100, Math.round(num(r.risk))));
  const out = $('#sOut'); out.innerHTML = '';
  const top = el('div', 'verdict ' + cls, `<div class="vt"></div><div style="font-weight:700;opacity:.92;margin-top:2px" class="ty"></div><p style="margin-top:10px" class="su"></p><div class="meter"><i style="width:${risk}%"></i></div><div style="margin-top:6px;font-weight:700;font-size:13px">${risk}% ${esc(t('sc.risk'))}</div>`);
  top.querySelector('.vt').textContent = word; top.querySelector('.ty').textContent = r.scam_type || ''; top.querySelector('.su').textContent = r.summary || '';
  const flags = arr(r.red_flags).slice(0, 6), todo = arr(r.do_now).slice(0, 4);
  const det = el('div', 'card', (flags.length ? `<h3>${esc(t('sc.flags'))}</h3><ul class="list">${flags.map(f => `<li><b>${esc(f && f.flag)}</b> — ${esc(f && f.why)}</li>`).join('')}</ul>` : '') +
    (todo.length ? `<h3 style="margin-top:14px">${esc(t('sc.todo'))}</h3><ul class="list">${todo.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '') + '<div class="btns"></div>');
  const fam = el('button', 'btn', icon('share') + `<span>${esc(t('sc.share'))}</span>`);
  fam.onclick = () => share(String(r.family_alert || r.summary || ''));
  det.querySelector('.btns').append(sayBtn(() => [word, r.summary, ...todo].filter(Boolean).join('. ')), fam);
  out.append(top, det); top.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (elderOn()) det.querySelector('.saybtn').click();
});

/* ================= MEDICINE ================= */
let box = arr(store.get('medbox', []));
const saltKey = s => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[\d.]+\s*(mg|mcg|g|ml|iu|%)?/g, '').replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 3 && !['tablets', 'tablet', 'capsules', 'capsule', 'sodium', 'hydrochloride', 'potassium'].includes(w)).join(' ');
function expiryState(exp) {
  const m = /^(\d{1,2})\s*[\/\-.]\s*(\d{2,4})$/.exec(String(exp || '').trim()); if (!m) return null;
  let y = +m[2]; if (y < 100) y += 2000;
  const days = (new Date(y, +m[1], 0, 23, 59) - new Date()) / 864e5;
  return days < 0 ? 'expired' : days < 60 ? 'soon' : 'ok';
}
const dupes = item => { const mine = arr(item.salts).map(saltKey).filter(Boolean); return box.filter(b => b !== item && arr(b.salts).map(saltKey).some(k => k && mine.some(m => k.includes(m) || m.includes(k)))); };
const expTag = st => st === 'expired' ? `<span class="tag bad">${esc(t('md.expired'))}</span>` : st === 'soon' ? `<span class="tag warn">${esc(t('md.soon'))}</span>` : st === 'ok' ? `<span class="tag ok">${esc(t('md.okExp'))}</span>` : '';
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const fmtTime = hm => { const [h, m] = String(hm).split(':').map(Number); return LANG === 'ta' ? `${fmtHour(h).split(' ')[0]} ${h % 12 || 12}:${String(m).padStart(2, '0')}` : `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
const isTaken = (b, tm) => arr((b.taken || {})[todayKey()]).includes(tm);
function setTaken(b, tm, on) {
  const k = todayKey(); b.taken = { [k]: arr((b.taken || {})[k]).filter(x => x !== tm) };
  if (on) b.taken[k].push(tm);
  store.set('medbox', box);
}
function setAlarm(b, tm) {
  const [h, m] = tm.split(':').map(Number), msg = t('md.alarmMsg', { x: b.brand });
  if (NATIVE && NATIVE.openIntent) {
    NATIVE.openIntent(`intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=${h};i.android.intent.extra.alarm.MINUTES=${m};S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(msg)};B.android.intent.extra.alarm.VIBRATE=true;end`);
  } else toast(t('md.alarmWeb'));
}
function renderToday() {
  const doses = [];
  box.forEach(b => arr(b.times).forEach(tm => doses.push({ b, tm })));
  doses.sort((a, c) => a.tm.localeCompare(c.tm));
  const w = $('#mToday');
  if (!doses.length) { w.innerHTML = `<p class="hint">${esc(t('md.noToday'))}</p>`; return; }
  w.innerHTML = '';
  doses.forEach(({ b, tm }) => {
    const done = isTaken(b, tm), row = el('div', 'dose' + (done ? ' done' : ''));
    row.innerHTML = `<span class="tm"></span><span class="nm" style="flex:1;font-weight:700"></span>`;
    row.querySelector('.tm').textContent = fmtTime(tm); row.querySelector('.nm').textContent = b.brand;
    const btn = el('button', 'btn small ' + (done ? 'soft' : ''), esc(t(done ? 'md.taken' : 'md.markTaken')));
    btn.onclick = () => { setTaken(b, tm, !done); renderToday(); };
    row.append(btn); w.append(row);
  });
}
$('#mFamily').onclick = () => {
  const lines = [];
  box.forEach(b => arr(b.times).forEach(tm => lines.push(`${fmtTime(tm)} ${b.brand}: ${t(isTaken(b, tm) ? 'md.statusTaken' : 'md.statusPending')}`)));
  share(t('md.familyMsg', { date: new Date().toLocaleDateString(LANG === 'ta' ? 'ta-IN' : 'en-IN', { day: 'numeric', month: 'short' }), list: '\n' + (lines.join('\n') || '—') }));
};
function renderBox() {
  renderToday();
  const wrap = $('#mBox');
  if (!box.length) { wrap.innerHTML = `<p class="hint">${esc(t('md.empty'))}</p>`; return; }
  wrap.innerHTML = '';
  box.forEach((b, i) => {
    const d = dupes(b), row = el('div', 'rep');
    row.style.alignItems = 'flex-start';
    row.innerHTML = `<span class="dd" style="background:var(--c-med)">${icon('med', 22)}</span><div style="flex:1"><b></b><div class="hint" style="margin-top:2px"></div><div class="pills" style="margin-top:6px">${expTag(expiryState(b.expiry))}${d.length ? `<span class="tag warn">${esc(t('md.dup', { x: d.map(x => x.brand).join(', ') }))}</span>` : ''}</div><div class="times"></div></div><button class="x" aria-label="${esc(t('c.remove'))}">✕</button>`;
    row.querySelector('b').textContent = b.brand;
    row.querySelector('.hint').textContent = arr(b.salts).join(', ') + (b.dose ? ` · ${b.dose}` : '') + (b.expiry ? ` · ${t('md.exp')} ${b.expiry}` : '');
    const times = row.querySelector('.times');
    arr(b.times).forEach(tm => {
      const c = el('span', 'tchip'); c.append(document.createTextNode(fmtTime(tm)));
      const al = el('button', 'al', esc(t('md.alarm'))); al.onclick = () => setAlarm(b, tm);
      const rm = el('button', '', '✕'); rm.setAttribute('aria-label', t('c.remove')); rm.onclick = () => { b.times = arr(b.times).filter(x => x !== tm); store.set('medbox', box); renderBox(); };
      c.append(al, rm); times.append(c);
    });
    const add = el('span', 'timeadd'); add.innerHTML = `<input type="time" value="08:00" aria-label="${esc(t('md.times'))}"><button class="btn soft small">${esc(t('md.addTime'))}</button>`;
    add.querySelector('button').onclick = () => { const v = add.querySelector('input').value; if (!/^\d\d:\d\d$/.test(v)) return; b.times = [...new Set([...arr(b.times), v])].sort(); store.set('medbox', box); renderBox(); };
    times.append(add);
    row.querySelector('.x').onclick = () => { box.splice(i, 1); store.set('medbox', box); renderBox(); };
    wrap.append(row);
  });
}
/* in-app reminder while Thunai is open */
const remindedNow = new Set();
setInterval(() => {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  box.forEach(b => arr(b.times).forEach(tm => {
    const [h, m] = tm.split(':').map(Number), due = h * 60 + m, id = todayKey() + b.brand + tm;
    if (mins >= due && mins - due <= 15 && !isTaken(b, tm) && !remindedNow.has(id)) {
      remindedNow.add(id); const msg = t('md.due', { x: b.brand }); toast(msg); speak(msg);
      try { navigator.vibrate && navigator.vibrate([300, 200, 300]); } catch (e) {}
    }
  }));
}, 30000);
onLang(renderBox);
const mPick = filePicker('mImg');
$('#mGo').onclick = e => busy(e.currentTarget, $('#mErr'), async () => {
  const img = mPick.get(), name = $('#mName').value.trim();
  if (!img && !name) { $('#mErr').textContent = t('md.need'); return; }
  const r = await ask(`You are Medicine Reader, helping elderly people in India understand their medicines. ${img ? 'Read the medicine strip or box in the photo carefully, including small print for the generic salt names, strength and the EXP date.' : 'The user typed this medicine name: "' + name.slice(0, 100) + '".'}${img && name ? ' The user also typed: "' + name.slice(0, 100) + '".' : ''} Identify the brand and its generic salts with strength. Never invent a personal dose; say to follow the prescription. If you cannot read it clearly, set found to false and explain in "spoken" how to retake the photo.
Reply with only JSON: {"found": boolean, "brand": "", "salts": ["generic salt with strength"], "used_for": "plain words", "how_usually_taken": "general guidance such as after food; follow your doctor", "expiry": "MM/YYYY or empty if not visible", "cautions": ["short"], "spoken": "2-3 short sentences to read aloud: name, what it is for${img ? ', expiry' : ''}"}
${aiLang()}`, img);
  const out = $('#mOut'); out.innerHTML = ''; const card = el('div', 'card');
  if (!r.found) { card.textContent = r.spoken || t('md.fail'); out.append(card); return; }
  const item = { brand: String(r.brand || name || 'Medicine').slice(0, 60), salts: arr(r.salts).map(String).slice(0, 5), expiry: String(r.expiry || '').slice(0, 10) };
  const st = expiryState(item.expiry), d = dupes(item);
  card.innerHTML = `<h3 style="font-size:22px"></h3><p class="hint sl"></p><div class="pills" style="margin:10px 0">${expTag(st)}${d.length ? `<span class="tag warn">${esc(t('md.dup', { x: d.map(x => x.brand).join(', ') }))}</span>` : ''}</div>
   <p><b>${esc(t('md.usedFor'))}:</b> <span class="u"></span></p><p style="margin-top:8px"><b>${esc(t('md.how'))}:</b> <span class="h"></span></p><ul class="list"></ul><div class="btns"></div>`;
  card.querySelector('h3').textContent = item.brand;
  card.querySelector('.sl').textContent = item.salts.join(', ') + (item.expiry ? ` · ${t('md.exp')} ${item.expiry}` : '');
  card.querySelector('.u').textContent = r.used_for || ''; card.querySelector('.h').textContent = r.how_usually_taken || '';
  card.querySelector('ul').innerHTML = arr(r.cautions).slice(0, 4).map(c => `<li>${esc(c)}</li>`).join('');
  let words = String(r.spoken || ''); if (st === 'expired') words += ' ' + t('md.expiredSay');
  const add = el('button', 'btn', `<span>${esc(t('md.add'))}</span>`);
  add.onclick = () => { box.push(item); store.set('medbox', box); renderBox(); add.disabled = true; add.textContent = t('md.addedBox'); };
  const sb = sayBtn(() => words);
  card.querySelector('.btns').append(sb, add); out.append(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  speak(words, sb);
});

/* ----- prescription scanner ----- */
const rxPick = filePicker('rxImg');
$('#rxGo').onclick = e => busy(e.currentTarget, $('#rxErr'), async () => {
  const img = rxPick.get(); if (!img) { $('#rxErr').textContent = t('md.rxNeed'); return; }
  const r = await ask(`You are reading a doctor's prescription from India for an elderly patient. It may be handwritten and use abbreviations such as OD, BD, TDS, QID, HS, SOS, AC (before food), PC (after food), or patterns like 1-0-1. List each medicine. Convert the schedule to 24-hour clock times: 1-0-0 or OD → 08:00; 0-1-0 → 14:00; 0-0-1 or HS → 21:00; 1-0-1 or BD → 08:00 and 21:00; 1-1-1 or TDS → 08:00, 14:00 and 21:00; QID → 08:00, 12:00, 16:00, 21:00; SOS (only when needed) → no times. Never guess a medicine you cannot read; mark it low confidence instead.
Reply with only JSON: {"medicines": [{"name": "as written", "salts": ["generic name if you know it"], "dose": "short, e.g. 1 tablet after food", "times": ["HH:MM"], "days": number or null, "confidence": "low|medium|high"}], "warnings": ["short"]}
${aiLang()}`, img);
  const meds = arr(r.medicines).filter(m => m && m.name).slice(0, 12), out = $('#rxOut'); out.innerHTML = '';
  if (!meds.length) { out.innerHTML = `<p class="hint">${esc(t('md.rxNone'))}</p>`; return; }
  const list = el('div');
  meds.forEach((m, i) => {
    const times = arr(m.times).map(String).filter(x => /^\d{1,2}:\d\d$/.test(x)).map(x => x.padStart(5, '0'));
    const row = el('label', 'rxrow', `<input type="checkbox" ${m.confidence === 'low' ? '' : 'checked'} data-i="${i}"><div style="flex:1"><b></b><div class="hint"></div></div>`);
    row.querySelector('b').textContent = String(m.name).slice(0, 60) + (m.confidence === 'low' ? ' ?' : '');
    row.querySelector('.hint').textContent = [String(m.dose || ''), times.map(fmtTime).join(', '), m.days ? m.days + 'd' : ''].filter(Boolean).join(' · ');
    m._times = times; list.append(row);
  });
  const warn = arr(r.warnings).slice(0, 3);
  const addBtn = el('button', 'btn block', esc(t('md.rxAdd'))); addBtn.style.marginTop = '12px';
  addBtn.onclick = () => {
    let n = 0;
    list.querySelectorAll('input:checked').forEach(c => { const m = meds[+c.dataset.i]; box.push({ brand: String(m.name).slice(0, 60), salts: arr(m.salts).map(String).slice(0, 4), dose: String(m.dose || '').slice(0, 60), expiry: '', times: m._times }); n++; });
    store.set('medbox', box); renderBox(); addBtn.disabled = true; addBtn.textContent = t('md.rxAdded', { n }); rxPick.clear();
  };
  out.append(list);
  if (warn.length) out.append(el('ul', 'list', warn.map(w => `<li>${esc(w)}</li>`).join('')));
  out.append(el('p', 'hint', esc(t('md.rxNote'))), addBtn);
});

/* ================= SOS ================= */
let sosMsg = '', contacts = arr(store.get('contacts', []));
function renderContacts() {
  const w = $('#contactList');
  if (!contacts.length) { w.innerHTML = `<p class="hint">${esc(t('sos.noContacts'))}</p>`; return; }
  w.innerHTML = '';
  contacts.forEach((c, i) => {
    const row = el('div', 'contact', `<span class="av"></span><div style="flex:1"><b></b><div class="hint"></div></div><button class="x" aria-label="${esc(t('c.remove'))}">✕</button>`);
    row.querySelector('.av').textContent = (c.name || '?').slice(0, 1).toUpperCase();
    row.querySelector('b').textContent = c.name; row.querySelector('.hint').textContent = c.phone;
    row.querySelector('.x').onclick = () => { contacts.splice(i, 1); store.set('contacts', contacts); renderContacts(); };
    w.append(row);
  });
}
$('#cAdd').onclick = () => {
  const name = $('#cName').value.trim().slice(0, 40), phone = $('#cPhone').value.replace(/[^\d+]/g, '').slice(0, 15);
  if (!name || phone.replace(/\D/g, '').length < 6) return;
  contacts.push({ name, phone }); store.set('contacts', contacts); $('#cName').value = ''; $('#cPhone').value = ''; renderContacts();
};
$('#sosBig').onclick = async () => {
  const st = $('#sosLoc'); st.textContent = t('sos.locating'); $('#sosActions').hidden = true;
  try {
    const p = await new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geo'));
      navigator.geolocation.getCurrentPosition(x => res(x.coords), rej, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    });
    store.set('lastLoc', { lat: p.latitude, lng: p.longitude });
    const m = Math.round(p.accuracy || 0), link = `https://maps.google.com/?q=${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
    const time = new Date().toLocaleTimeString(LANG === 'ta' ? 'ta-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit' });
    sosMsg = t($('#sosStuck').checked ? 'sos.msgStuck' : 'sos.msg', { link, m, time });
    st.textContent = t('sos.ready', { m }); $('#sosActions').hidden = false;
    if (contacts.length) sendSms();
  } catch (e) { st.textContent = t('sos.noLoc'); }
};
function sendSms() {
  if (!contacts.length) { toast(t('sos.needContacts')); $('#cName').focus(); return; }
  openExt(`sms:${contacts.map(c => c.phone).join(';')}?body=${encodeURIComponent(sosMsg)}`);
}
$('#sosSms').onclick = sendSms;
$('#sosShare').onclick = () => share(sosMsg);
onLang(renderContacts);

/* ================= RAIN FORECAST (Open-Meteo, no key) ================= */
const rainLevel = mm => mm < 2.5 ? 'none' : mm < 15.6 ? 'light' : mm < 64.5 ? 'moderate' : mm < 115.6 ? 'heavy' : 'vheavy';
const LVL_COL = { none: '#38bdf8', light: '#38bdf8', moderate: '#f59e0b', heavy: '#e11d48', vheavy: '#9f1239' };
let rainBusy = false;
async function loadRain(force) {
  const c = store.get('rain', null);
  if (c && !force && Date.now() - c.at < 3600e3) { renderRain(c); return; }
  if (c) renderRain(c);
  if (rainBusy || navigator.onLine === false) return;
  rainBusy = true;
  const ll = store.get('lastLoc', null), p = ll ? { ...ll, here: true } : { lat: 12.9249, lng: 80.1275, here: false };
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}&longitude=${p.lng.toFixed(3)}&hourly=precipitation&timezone=Asia%2FKolkata&forecast_days=2`);
    const j = await r.json(), times = arr(j.hourly && j.hourly.time), pr = arr(j.hourly && j.hourly.precipitation);
    const nowH = Date.now() - 3600e3; const series = [];
    times.forEach((tm, i) => { const ts = Date.parse(tm + ':00+05:30'); if (ts >= nowH && series.length < 24) series.push({ ts, mm: Math.max(0, num(pr[i])) }); });
    if (!series.length) throw new Error('empty');
    const sum = series.reduce((a, x) => a + x.mm, 0), peak = series.reduce((a, x) => x.mm > a.mm ? x : a, series[0]);
    const d = { at: Date.now(), sum, peakTs: peak.ts, peakMm: peak.mm, here: p.here, series: series.map(x => x.mm) };
    store.set('rain', d); renderRain(d);
  } catch (e) { if (!c) renderRain(null); }
  rainBusy = false;
}
function renderRain(d) {
  ['#rainHome', '#rainFlood'].forEach(sel => {
    const w = $(sel); if (!w) return;
    if (!d) { w.innerHTML = `<div class="raincard"><h3>${esc(t('rain.title'))}</h3><p class="hint">${esc(t('rain.err'))}</p></div>`; return; }
    const lvl = rainLevel(d.sum), max = Math.max(4, ...d.series), mins = Math.round((Date.now() - d.at) / 60000);
    const peakTime = new Date(d.peakTs).toLocaleTimeString(LANG === 'ta' ? 'ta-IN' : 'en-IN', { hour: 'numeric' });
    w.innerHTML = `<div class="raincard" style="--lvl:${LVL_COL[lvl]}"><h3>${esc(t('rain.title'))}</h3><div class="msg">${esc(t('rain.' + lvl, { mm: d.sum.toFixed(0) }))}</div>
      ${lvl !== 'none' ? `<p class="hint" style="margin-top:4px">${esc(t('rain.peak', { time: peakTime, mmh: d.peakMm.toFixed(1) }))}</p>` : ''}
      <div class="rbars">${d.series.map(v => `<i style="height:${Math.max(4, 100 * v / max).toFixed(0)}%"></i>`).join('')}</div>
      <div class="foot2"><span class="hint" style="margin:0">${esc(t('rain.src', { place: t(d.here ? 'rain.here' : 'rain.default'), ago: mins < 1 ? t('rain.now') : t('rain.minAgo', { n: mins }) }))}</span><button class="btn ghost small" data-rain>${esc(t('rain.refresh'))}</button></div></div>`;
    w.querySelector('[data-rain]').onclick = () => loadRain(true);
  });
}
onLang(() => { const c = store.get('rain', null); if (c) renderRain(c); });

/* ================= LIVE FLOOD MAP (ntfy.sh topic, 12 h) ================= */
const liveOn = () => store.get('liveOn', true);
const topic = () => 'thunai-floods-' + (String(store.get('group', 'ohpc26')).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'ohpc26');
let liveState = 'idle', liveTimer = null, queue = arr(store.get('liveQueue', []));
const validRep = o => o && Number.isFinite(+o.lat) && Number.isFinite(+o.lng) && Math.abs(+o.lat - 13) < 2 && Math.abs(+o.lng - 80.2) < 2 && +o.depth >= 0 && +o.depth <= 300;
async function pullLive() {
  if (!liveOn()) { liveState = 'off'; remote = []; renderLive(); return; }
  if (navigator.onLine === false) { liveState = 'err'; renderLive(); return; }
  try {
    const r = await fetch(`https://ntfy.sh/${topic()}/json?poll=1&since=12h`); if (!r.ok) throw new Error(r.status);
    const txt = await r.text(), hid = new Set(arr(store.get('hiddenRemote', []))), mine = new Set(reports.map(x => String(x.id))), m = new Map();
    txt.split('\n').forEach(line => {
      if (!line.trim()) return; let ev, o;
      try { ev = JSON.parse(line); } catch (e) { return; }
      if (!ev || ev.event !== 'message') return;
      try { o = JSON.parse(ev.message); } catch (e) { return; }
      if (!validRep(o)) return; const id = String(o.id || ev.id).slice(0, 40);
      if (mine.has(id) || hid.has(id)) return;
      m.set(id, { id, lat: +o.lat, lng: +o.lng, depth: Math.round(+o.depth), level: String(o.level || '').slice(0, 30), advice: String(o.advice || '').slice(0, 200), at: num(o.at, num(ev.time) * 1000), remote: true });
    });
    remote = [...m.values()]; liveState = 'on';
  } catch (e) { liveState = 'err'; }
  renderLive(); renderReports(); if (fmap) computeRoute();
}
async function publishReport(rep) {
  if (!liveOn() || rep.sample) return;
  const body = JSON.stringify({ v: 1, id: rep.id, lat: +rep.lat.toFixed(5), lng: +rep.lng.toFixed(5), depth: rep.depth, level: rep.level, advice: rep.advice, at: rep.at });
  if (navigator.onLine === false) { queue.push(body); store.set('liveQueue', queue); toast(t('off.queued')); renderLive(); return; }
  try { const r = await fetch(`https://ntfy.sh/${topic()}`, { method: 'POST', body }); if (!r.ok) throw new Error(r.status); }
  catch (e) { queue.push(body); store.set('liveQueue', queue); renderLive(); }
}
async function flushQueue() {
  if (!queue.length || navigator.onLine === false) return;
  const q = queue; queue = []; store.set('liveQueue', queue);
  for (const body of q) { try { const r = await fetch(`https://ntfy.sh/${topic()}`, { method: 'POST', body }); if (!r.ok) throw 0; } catch (e) { queue.push(body); } }
  store.set('liveQueue', queue); renderLive();
}
function renderLive() {
  const w = $('#liveSt'); if (!w) return;
  w.textContent = !liveOn() ? t('live.off') : liveState === 'err' ? t('live.err') : liveState === 'on' ? t('live.on', { n: remote.length }) : '';
  if (queue.length) w.textContent += (w.textContent ? ' · ' : '') + t('live.queued', { n: queue.length });
}
function startLive() { if (liveTimer) return; flushQueue(); pullLive(); liveTimer = setInterval(pullLive, 30000); }
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
onLang(renderLive);

/* ================= OFFLINE ================= */
function renderOffline() { const o = $('#offline'); o.hidden = navigator.onLine !== false; o.textContent = t('off.banner'); }
window.addEventListener('online', () => { renderOffline(); flushQueue(); if (current === 'flood') pullLive(); });
window.addEventListener('offline', renderOffline);
onLang(renderOffline);


/* ================= TALK TO THUNAI ================= */
const VIEW_TITLE = v => v === 'sos' ? t('sos.title') : v === 'ask' ? t('ask.t') : t('m.' + v + '.t');
function bubbleIn(sel, role, text, cls = '') { const b = el('div', 'bub ' + (role === 'user' ? 'u' : 'a') + (cls ? ' ' + cls : '')); b.textContent = text; $(sel).append(b); $(sel).scrollTop = 1e6; return b; }
let askHist = [], askBusy = false;
function askIntro() { if (!$('#askLog').children.length) bubbleIn('#askLog', 'assistant', t('ask.hello')); }
function renderAskEx() { $('#askEx').innerHTML = ['ex1', 'ex2', 'ex3', 'ex4', 'ex5'].map(k => `<button class="pill" data-ax="${k}">${esc(t('ask.' + k))}</button>`).join(''); }
$('#askEx').onclick = e => { const b = e.target.closest('[data-ax]'); if (b) sendAsk(t('ask.' + b.dataset.ax)); };
$('#askForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#askIn').value.trim(); if (v) { $('#askIn').value = ''; sendAsk(v); } });
$('#askMic').onclick = () => {
  if (!micOK()) { toast(t('err.mic')); return; }
  $('#askMicHint').textContent = t('ask.listening');
  listen(txt => { $('#askMicHint').textContent = t('ask.tap'); sendAsk(txt); }, $('#askMic'));
  setTimeout(() => { if (!$('#askMic').classList.contains('live')) $('#askMicHint').textContent = t('ask.tap'); }, 9000);
};
onLang(() => { renderAskEx(); if ($('#askLog').children.length === 1 && !askHist.length) { $('#askLog').innerHTML = ''; askIntro(); } $('#askMicHint').textContent = t('ask.tap'); });
const ASK_SYS = rainTxt => `You are Thunai, a warm voice assistant inside a phone app for families in Chennai, India. People may speak Tamil, English or a mix. Decide which helper fits the user's latest message and extract data.
Helpers (intent values):
- scam: they share or describe a suspicious message, call, link or offer. data.text = the message itself if they gave it.
- medicine: they ask what a medicine or tablet is for. data.medicine = the name.
- health_log: they state a BP, sugar or pulse reading (e.g. "BP 150 over 95", "sugar 180 after food"). data.sys, data.dia, data.pulse, data.sugar in mg/dL, data.sugar_type fasting|after_food|random.
- health: they ask about their saved readings or the health tracker.
- nearby: they want a hospital, clinic, pharmacy, police, fire station or shelter. data.place_type hospital|pharmacy|police|fire|shelter.
- flood: flooding, waterlogged roads, a safe route. data.destination = the place name if given.
- rain: rain or weather. Answer from the forecast below.
- scheme: government schemes, pensions, scholarships, subsidies.
- document: they want a bill, notice or letter explained.
- energy: electricity bill or saving power.
- sos: emergency, accident, danger, someone hurt or stuck. Tell them to call 112 and that SOS is opening.
- general: anything else; answer helpfully.
Rules: never give a medicine dose. For a health reading, say in general terms whether it looks normal or high and advise following their doctor; for very high readings advise getting medical help. Keep "reply" under 45 words, spoken style, no markdown.
${rainTxt}
Reply with only JSON: {"intent": "...", "reply": "...", "data": {}}
${aiLang()}`;
function goView(v) { keepSpeech = true; location.hash = v; }
async function sendAsk(text) {
  if (askBusy || !text) return; askBusy = true; $('#askErr').innerHTML = '';
  bubbleIn('#askLog', 'user', text); const typing = bubbleIn('#askLog', 'assistant', t('c.thinking'), 'typing');
  const rain = store.get('rain', null);
  const rainTxt = rain ? `Rain forecast for the next 24 hours near the user: about ${rain.sum.toFixed(0)} mm in total, heaviest around ${new Date(rain.peakTs).toLocaleString('en-IN', { hour: 'numeric', day: 'numeric', month: 'short' })} at ${rain.peakMm.toFixed(1)} mm per hour.` : 'No rain forecast is loaded; suggest opening FloodSense.';
  try {
    const r = await gemini({ system: ASK_SYS(rainTxt), contents: [...askHist.slice(-6), { role: 'user', parts: [{ text }] }] });
    typing.remove();
    const reply = String(r.reply || '').trim() || '…', intent = String(r.intent || 'general'), d = (r.data && typeof r.data === 'object') ? r.data : {};
    askHist.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: JSON.stringify(r) }] });
    const b = bubbleIn('#askLog', 'assistant', reply);
    speak(reply);
    handleIntent(intent, d, text, b);
  } catch (e) {
    typing.remove();
    $('#askErr').innerHTML = esc(errText(e)) + (e && (e.code === 'nokey' || e.code === 'badkey') ? ` <a href="#settings">${esc(t('nav.settings'))} →</a>` : '');
  }
  askBusy = false;
}
const INTENT_VIEW = { scam: 'scam', medicine: 'med', health: 'health', health_log: 'health', nearby: 'near', flood: 'flood', rain: 'flood', scheme: 'sch', document: 'doc', energy: 'energy', sos: 'sos' };
function handleIntent(intent, d, text, b) {
  const view = INTENT_VIEW[intent];
  if (intent === 'health_log') {
    if (addReading({ sys: d.sys, dia: d.dia, pulse: d.pulse, sugar: d.sugar, type: d.sugar_type })) { const n = el('div', 'hint', esc(t('ask.saved'))); n.style.margin = '6px 0 0'; b.append(n); }
  }
  if (view) {
    const btn = el('button', 'btn small act', esc(t('ask.open', { x: VIEW_TITLE(view) }))); btn.onclick = () => goView(view); b.append(el('br')); b.append(btn);
  }
  const later = f => setTimeout(f, 1300);
  if (intent === 'sos') later(() => goView('sos'));
  if (intent === 'scam' && (d.text || text.length > 40)) later(() => { goView('scam'); $('#sTxt').value = String(d.text || text).slice(0, 4000); $('#sGo').click(); });
  if (intent === 'medicine' && d.medicine) later(() => { goView('med'); $('#mName').value = String(d.medicine).slice(0, 80); $('#mGo').click(); });
  if (intent === 'nearby') later(() => { if (NCATS[d.place_type]) nCat = d.place_type; goView('near'); setTimeout(() => { renderCats(); searchNear(); }, 300); });
  if (intent === 'scheme') later(() => { goView('sch'); setTimeout(() => sendChat(text), 300); });
  if (intent === 'flood' && d.destination) later(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&viewbox=79.95,13.25,80.35,12.75&q=${encodeURIComponent(String(d.destination))}`);
      const j = arr(await r.json())[0]; if (!j) return;
      toPt = { lat: num(j.lat), lng: num(j.lon), name: String(j.name || d.destination).split(',')[0] };
      const ll = store.get('lastLoc', null); if (ll) fromPt = { lat: ll.lat, lng: ll.lng, k: 'fl.myloc' };
      goView('flood'); setTimeout(() => { syncPts(); computeRoute(); }, 300);
    } catch (e) {}
  });
}

/* ================= DOCUMENT EXPLAINER ================= */
const dPick = filePicker('dImg');
$('#dGo').onclick = e => busy(e.currentTarget, $('#dErr'), async () => {
  const img = dPick.get(), q = $('#dQ').value.trim();
  if (!img) { $('#dErr').textContent = t('doc.need'); return; }
  const r = await ask(`You explain documents to ordinary people in India, many of them elderly. Read the photographed document (an electricity or water bill, a bank or insurance notice, a government letter, a school notice, a legal notice, a hospital bill and so on). Explain it in very simple words. Flag it as suspicious if it looks fake or like a scam (payment to a personal UPI ID, threats of arrest, unknown links, spelling errors on an "official" letter).${q ? ' The user asks: "' + q.slice(0, 300) + '". Answer that question directly.' : ''}
Reply with only JSON: {"doc_type": "short name", "from": "who sent it", "summary": "2-3 simple sentences", "key_points": ["short"], "amounts": [{"label": "", "value": ""}], "deadlines": [{"what": "", "date": ""}], "what_to_do": ["short step"], "answer": "answer to their question, or empty", "suspicious": boolean, "warning": "why it may be fake, or empty"}
${aiLang()}`, img);
  const out = $('#dOut'); out.innerHTML = '';
  if (r.suspicious) { const w = el('div', 'verdict bad', `<div class="vt">${esc(t('doc.warn'))}</div><p style="margin-top:8px"></p>`); w.querySelector('p').textContent = r.warning || ''; out.append(w); }
  const pts = arr(r.key_points).slice(0, 6), amts = arr(r.amounts).slice(0, 6), dl = arr(r.deadlines).slice(0, 5), todo = arr(r.what_to_do).slice(0, 5);
  const card = el('div', 'card', `<h3 style="font-size:20px" class="dt"></h3><p class="hint fr" style="margin-top:-4px"></p><p class="sm" style="margin-top:8px;font-weight:600"></p><p class="an" style="margin-top:10px"></p>
    ${pts.length ? `<h3 style="margin-top:14px">${esc(t('doc.points'))}</h3><ul class="list">${pts.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${amts.length ? `<h3 style="margin-top:14px">${esc(t('doc.amounts'))}</h3><table>${amts.map(a => `<tr><td>${esc(a && a.label)}</td><td class="n"><b>${esc(a && a.value)}</b></td></tr>`).join('')}</table>` : ''}
    ${dl.length ? `<h3 style="margin-top:14px">${esc(t('doc.deadlines'))}</h3><ul class="list">${dl.map(x => `<li><b>${esc(x && x.date)}</b> — ${esc(x && x.what)}</li>`).join('')}</ul>` : ''}
    ${todo.length ? `<h3 style="margin-top:14px">${esc(t('doc.todo'))}</h3><ul class="list">${todo.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}<div class="btns"></div>`);
  card.querySelector('.dt').textContent = r.doc_type || '';
  card.querySelector('.fr').textContent = r.from ? `${t('doc.from')}: ${r.from}` : '';
  card.querySelector('.sm').textContent = r.summary || '';
  const an = card.querySelector('.an'); if (r.answer) { an.textContent = r.answer; an.style.fontWeight = '700'; an.style.color = 'var(--c-doc)'; } else an.remove();
  const spoken = [r.summary, r.answer, ...todo].filter(Boolean).join(' ');
  const sh = el('button', 'btn soft', icon('share') + `<span>${esc(t('doc.share'))}</span>`);
  sh.onclick = () => share([r.doc_type, r.from && `${t('doc.from')}: ${r.from}`, r.summary, r.answer, ...todo.map(x => '• ' + x)].filter(Boolean).join('\n'));
  card.querySelector('.btns').append(sayBtn(() => spoken), sh);
  out.append(card); card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (elderOn()) card.querySelector('.saybtn').click();
});

/* ================= NEARBY HELP (OpenStreetMap / Overpass) ================= */
const NCATS = { hospital: '["amenity"~"^(hospital|clinic|doctors)$"]', pharmacy: '["amenity"="pharmacy"]', police: '["amenity"="police"]', fire: '["amenity"="fire_station"]', shelter: '["amenity"~"^(community_centre|school|social_facility|townhall)$"]' };
const NCOL = { hospital: '#e11d48', pharmacy: '#16a34a', police: '#1d4ed8', fire: '#ea580c', shelter: '#7c3aed' };
let nmap = null, nCat = 'hospital', nCenter = null, nLayer = null, nMe = null, nSeq = 0, nWhereKey = 'rain.default';
function renderCats() {
  $('#nCats').innerHTML = Object.keys(NCATS).map(k => `<button class="pill" data-n="${k}" aria-pressed="${k === nCat}">${esc(t('near.' + k))}</button>`).join('');
  $('#nShelterNote').hidden = nCat !== 'shelter';
}
$('#nCats').onclick = e => { const b = e.target.closest('[data-n]'); if (!b) return; nCat = b.dataset.n; renderCats(); searchNear(); };
function initNear() {
  renderCats();
  if (nmap) { setTimeout(() => nmap.invalidateSize(), 60); return; }
  if (!window.L) return;
  const ll = store.get('lastLoc', null); nCenter = ll || { lat: 12.9249, lng: 80.1275 }; nWhereKey = ll ? 'rain.here' : 'rain.default';
  nmap = L.map('nmap', { zoomControl: false }).setView([nCenter.lat, nCenter.lng], 14);
  L.control.zoom({ position: 'bottomright' }).addTo(nmap); tiles(nmap).addTo(nmap);
  nLayer = L.layerGroup().addTo(nmap);
  setTimeout(() => nmap.invalidateSize(), 120);
  searchNear();
}
$('#nLoc').onclick = async e => {
  const btn = e.currentTarget; btn.disabled = true;
  try { const p = await locate(); store.set('lastLoc', p); nCenter = p; nWhereKey = 'rain.here'; if (nmap) nmap.setView([p.lat, p.lng], 15); searchNear(); }
  catch (er) { toast(t('locErr')); }
  btn.disabled = false;
};
$('#nHere').onclick = () => { if (!nmap) return; const c = nmap.getCenter(); nCenter = { lat: c.lat, lng: c.lng }; nWhereKey = 'near.mapCentre'; searchNear(); };
const distM = (a, b) => { const kx = Math.cos(a.lat * Math.PI / 180) * 111320; return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 110540); };
async function overpass(q) {
  for (const u of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }); if (r.ok) return await r.json(); } catch (e) {}
  }
  throw new Error('overpass');
}
async function searchNear() {
  if (!nCenter) return;
  const my = ++nSeq, list = $('#nList'); list.innerHTML = `<p class="hint">${esc(t('near.searching'))}</p>`;
  $('#nWhere').textContent = t('near.here', { place: t(nWhereKey) });
  if (nMe) nMe.remove();
  if (nmap) nMe = L.circleMarker([nCenter.lat, nCenter.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(nmap);
  let els = [];
  try {
    for (const r of [3000, 8000]) {
      const j = await overpass(`[out:json][timeout:20];nwr${NCATS[nCat]}(around:${r},${nCenter.lat.toFixed(5)},${nCenter.lng.toFixed(5)});out center tags 80;`);
      els = arr(j.elements); if (els.length >= 3) break;
    }
  } catch (e) { if (my === nSeq) list.innerHTML = `<p class="err">${esc(t('near.err'))}</p>`; return; }
  if (my !== nSeq) return;
  const places = els.map(x => {
    const lat = num(x.lat, x.center && x.center.lat), lng = num(x.lon, x.center && x.center.lon), tg = x.tags || {};
    const phone = String(tg.phone || tg['contact:phone'] || tg['phone:mobile'] || tg['contact:mobile'] || '').split(/[;,]/)[0].trim();
    return { lat, lng, name: String((LANG === 'ta' && tg['name:ta']) || tg.name || tg['name:en'] || t('near.unnamed')).slice(0, 80), phone, d: distM(nCenter, { lat, lng }) };
  }).filter(p => p.lat && p.lng).sort((a, b) => a.d - b.d).slice(0, 25);
  if (nLayer) nLayer.clearLayers();
  if (!places.length) { list.innerHTML = `<p class="hint">${esc(t('near.none'))}</p>`; return; }
  list.innerHTML = '';
  const col = NCOL[nCat], bounds = [[nCenter.lat, nCenter.lng]];
  places.forEach((p, i) => {
    if (nmap) { L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="npin" style="background:${col}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(nLayer).bindPopup(esc(p.name)); bounds.push([p.lat, p.lng]); }
    const row = el('div', 'place', `<span class="dist">${p.d < 1000 ? Math.round(p.d) + ' m' : (p.d / 1000).toFixed(1) + ' km'}</span><div style="flex:1"><b></b><div class="hint ph" style="margin-top:2px"></div><div class="acts"></div></div>`);
    row.querySelector('b').textContent = `${i + 1}. ${p.name}`; row.querySelector('.ph').textContent = p.phone || '';
    const acts = row.querySelector('.acts');
    if (p.phone) { const c = el('button', 'btn small', icon('phone', 15) + `<span>${esc(t('near.call'))}</span>`); c.onclick = () => openExt('tel:' + p.phone.replace(/[^\d+]/g, '')); acts.append(c); }
    const r = el('button', 'btn soft small', `<span>${esc(t('near.route'))}</span>`);
    r.onclick = () => { fromPt = { lat: nCenter.lat, lng: nCenter.lng, k: nWhereKey === 'rain.here' ? 'fl.myloc' : null, name: t('fl.pinned') }; toPt = { lat: p.lat, lng: p.lng, name: p.name }; goView('flood'); setTimeout(() => { syncPts(); computeRoute(); }, 300); };
    const m = el('button', 'btn ghost small', `<span>${esc(t('near.maps'))}</span>`); m.onclick = () => openExt(`https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`);
    acts.append(r, m); list.append(row);
  });
  if (nmap && bounds.length > 1) nmap.fitBounds(bounds.slice(0, 9), { padding: [30, 30], maxZoom: 16 });
}
onLang(() => { renderCats(); if (nCenter) $('#nWhere').textContent = t('near.here', { place: t(nWhereKey) }); });

/* ================= HEALTH TRACKER ================= */
let hlog = arr(store.get('health', [])), hType = 'fasting';
function bpFlag(s, d) {
  if (!s || !d) return null;
  if (s >= 180 || d >= 120) return ['crisis', 'var(--bad)']; if (s >= 140 || d >= 90) return ['high', 'var(--bad)'];
  if (s < 90 || d < 60) return ['low', 'var(--warn)']; if (s >= 120 || d >= 80) return ['elev', 'var(--warn)']; return ['ok', 'var(--ok)'];
}
function sugarFlag(v, type) {
  if (!v) return null;
  if (v < 70) return ['vlow', 'var(--bad)']; if (v > 300) return ['vhigh', 'var(--bad)'];
  if (type === 'fasting') return v >= 126 ? ['high', 'var(--bad)'] : v >= 100 ? ['border', 'var(--warn)'] : ['ok', 'var(--ok)'];
  if (type === 'after') return v >= 200 ? ['high', 'var(--bad)'] : v >= 140 ? ['border', 'var(--warn)'] : ['ok', 'var(--ok)'];
  return v >= 200 ? ['high', 'var(--bad)'] : ['ok', 'var(--ok)'];
}
function addReading(o) {
  const sys = num(o.sys), dia = num(o.dia), pulse = num(o.pulse), sugar = num(o.sugar);
  const bpOk = sys >= 50 && sys <= 260 && dia >= 30 && dia <= 160, sOk = sugar >= 20 && sugar <= 600;
  if (!bpOk && !sOk) return false;
  let type = String(o.type || '').replace('after_food', 'after'); if (!['fasting', 'after', 'random'].includes(type)) type = 'random';
  hlog.push({ id: Date.now(), at: Date.now(), sys: bpOk ? sys : 0, dia: bpOk ? dia : 0, pulse: pulse >= 30 && pulse <= 220 ? pulse : 0, sugar: sOk ? sugar : 0, type });
  hlog = hlog.slice(-500); store.set('health', hlog); renderHealth(); return true;
}
function renderHType() { $('#hType').innerHTML = ['fasting', 'after', 'random'].map(k => `<button class="pill" data-ht="${k}" aria-pressed="${k === hType}">${esc(t('hl.' + k))}</button>`).join(''); }
$('#hType').onclick = e => { const b = e.target.closest('[data-ht]'); if (b) { hType = b.dataset.ht; renderHType(); } };
$('#hSave').onclick = () => {
  $('#hErr').textContent = '';
  if (!addReading({ sys: $('#hSys').value, dia: $('#hDia').value, pulse: $('#hPulse').value, sugar: $('#hSugar').value, type: hType })) { $('#hErr').textContent = t('hl.need'); return; }
  ['#hSys', '#hDia', '#hPulse', '#hSugar'].forEach(k => { $(k).value = ''; }); toast(t('hl.saved'));
  $('#hLatest').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
const hWhen = at => new Date(at).toLocaleString(LANG === 'ta' ? 'ta-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function lineChart(series, lines, lo, hi) {
  const W = 320, H = 150, P = 26, n = series.length;
  const x = i => P + (n < 2 ? (W - P * 2) / 2 : i * (W - P * 2) / (n - 1)), y = v => H - 18 - (v - lo) / (hi - lo) * (H - 34);
  let g = `<svg class="hchart" viewBox="0 0 ${W} ${H}">`;
  lines.forEach(([v, col]) => { g += `<line x1="${P}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-dasharray="4 4" stroke-width="1" opacity=".7"/><text x="2" y="${y(v) + 3}">${v}</text>`; });
  series.forEach(([vals, col]) => {
    const pts = vals.map((v, i) => v ? `${x(i).toFixed(1)},${y(Math.max(lo, Math.min(hi, v))).toFixed(1)}` : null).filter(Boolean);
    if (pts.length > 1) g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(p => { const [a, b] = p.split(','); g += `<circle cx="${a}" cy="${b}" r="3.2" fill="${col}"/>`; });
  });
  return g + '</svg>';
}
function renderHealth() {
  renderHType();
  const lb = [...hlog].reverse().find(r => r.sys), ls = [...hlog].reverse().find(r => r.sugar);
  const L = $('#hLatest');
  if (!lb && !ls) { L.innerHTML = `<h3>${esc(t('hl.latest'))}</h3><p class="hint">${esc(t('hl.empty'))}</p>`; }
  else {
    const bf = lb && bpFlag(lb.sys, lb.dia), sf = ls && sugarFlag(ls.sugar, ls.type), pf = lb && lb.pulse && (lb.pulse < 50 || lb.pulse > 120);
    const wk = hlog.filter(r => r.at > Date.now() - 7 * 864e5), avg = k => { const v = wk.map(r => r[k]).filter(Boolean); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0; };
    L.innerHTML = `<h3>${esc(t('hl.latest'))}</h3><div class="reading">
      ${lb ? `<div class="rv" style="--fc:${bf[1]}"><span>${esc(t('hl.bp'))}</span><b>${lb.sys}/${lb.dia}</b><em>${esc(t('f.bp.' + bf[0]))}</em><span>${lb.pulse ? '♥ ' + lb.pulse + ' · ' : ''}${esc(hWhen(lb.at))}</span>${pf ? `<em style="color:var(--warn)">${esc(t('f.pulse'))}</em>` : ''}</div>` : ''}
      ${ls ? `<div class="rv" style="--fc:${sf[1]}"><span>${esc(t('hl.sugarT'))} · ${esc(t('hl.' + ls.type))}</span><b>${ls.sugar}</b><em>${esc(t('f.s.' + sf[0]))}</em><span>${esc(hWhen(ls.at))}</span></div>` : ''}
    </div><p class="hint" style="margin-top:10px">${esc(t('hl.avg', { bp: avg('sys') ? avg('sys') + '/' + avg('dia') : '—', sugar: avg('sugar') || '—' }))}</p>`;
  }
  const last = hlog.slice(-14), C = $('#hCharts');
  if (!last.length) C.innerHTML = `<p class="hint">${esc(t('hl.empty'))}</p>`;
  else C.innerHTML = `<div class="hint" style="font-weight:700"><span class="dotf" style="background:#e11d48"></span>${esc(t('hl.bp'))}</div>` + lineChart([[last.map(r => r.sys), '#e11d48'], [last.map(r => r.dia), '#f59e0b']], [[140, '#e11d48'], [90, '#f59e0b']], 50, 200) +
      `<div class="hint" style="font-weight:700"><span class="dotf" style="background:#7c3aed"></span>${esc(t('hl.sugarT'))}</div>` + lineChart([[last.map(r => r.sugar), '#7c3aed']], [[126, '#7c3aed'], [70, '#e11d48']], 50, 320);
  const H = $('#hList');
  if (!hlog.length) { H.innerHTML = `<p class="hint">${esc(t('hl.empty'))}</p>`; return; }
  H.innerHTML = '';
  [...hlog].reverse().slice(0, 30).forEach(r => {
    const bf = bpFlag(r.sys, r.dia), sf = sugarFlag(r.sugar, r.type);
    const row = el('div', 'hrow', `<span class="when">${esc(hWhen(r.at))}</span><span style="flex:1">${r.sys ? `<span class="dotf" style="background:${bf[1]}"></span><b>${r.sys}/${r.dia}</b>${r.pulse ? ' ♥' + r.pulse : ''} ` : ''}${r.sugar ? `<span class="dotf" style="background:${sf[1]};margin-left:6px"></span><b>${r.sugar}</b> <span class="hint">${esc(t('hl.' + r.type))}</span>` : ''}</span><button class="x" aria-label="${esc(t('c.remove'))}">✕</button>`);
    row.querySelector('.x').onclick = () => { hlog = hlog.filter(x => x.id !== r.id); store.set('health', hlog); renderHealth(); };
    H.append(row);
  });
}
function healthText() {
  return [t('hl.summary', { date: new Date().toLocaleDateString(LANG === 'ta' ? 'ta-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) }),
    ...[...hlog].reverse().slice(0, 14).map(r => `${hWhen(r.at)}: ${r.sys ? 'BP ' + r.sys + '/' + r.dia + (r.pulse ? ', pulse ' + r.pulse : '') : ''}${r.sys && r.sugar ? '; ' : ''}${r.sugar ? t('hl.sugarT') + ' ' + r.sugar + ' (' + t('hl.' + r.type) + ')' : ''}`)].join('\n');
}
$('#hShare').onclick = () => { if (hlog.length) share(healthText()); else toast(t('hl.empty')); };
$('#hExplain').onclick = e => busy(e.currentTarget, $('#hxErr'), async () => {
  if (!hlog.length) { $('#hxErr').textContent = t('hl.empty'); return; }
  const r = await ask(`You give general, friendly wellness information to an elderly person in India about their own home readings. You are not a doctor and must not diagnose or suggest changing medicines. Readings (newest first):
${healthText()}
Use common reference ranges (BP under 120/80 normal, 140/90 or more high, 180/120 or more needs urgent care; fasting sugar under 100 normal, 126 or more high; after-food sugar under 140 normal, 200 or more high; below 70 is low).
Reply with only JSON: {"summary": "2-3 simple sentences about the pattern", "observations": ["short"], "tips": ["simple everyday tip, max 3"], "see_doctor": boolean, "urgent": boolean, "reason": "why they should see a doctor, or empty"}
${aiLang()}`);
  const out = $('#hOut'); out.innerHTML = '';
  if (r.urgent || r.see_doctor) { const w = el('div', 'verdict ' + (r.urgent ? 'bad' : 'warn'), '<p style="font-weight:700"></p>'); w.querySelector('p').textContent = r.reason || ''; out.append(w); }
  const obs = arr(r.observations).slice(0, 4), tips = arr(r.tips).slice(0, 3);
  const card = el('div', 'card', `<p class="sm" style="font-weight:600"></p>${obs.length ? `<ul class="list">${obs.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}${tips.length ? `<ul class="list" style="margin-top:10px">${tips.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}<p class="hint">${esc(t('hl.note'))}</p><div class="btns"></div>`);
  card.querySelector('.sm').textContent = r.summary || '';
  card.querySelector('.btns').append(sayBtn(() => [r.summary, r.reason, ...tips].filter(Boolean).join(' ')));
  out.append(card); card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (elderOn()) card.querySelector('.saybtn').click();
});
onLang(renderHealth);

/* ================= SCHEMES ================= */
const SCH = [
 { id: 'pmkisan', n: ['PM-KISAN', 'பிஎம் கிசான்'], b: ['₹6,000 a year to farmer families, in three instalments', 'விவசாயக் குடும்பங்களுக்கு ஆண்டுக்கு ₹6,000, மூன்று தவணைகளில்'], ok: p => p.occupation === 'farmer' && p.owns_farm_land && !p.income_tax_payer, docs: ['aadhaar', 'land', 'passbook'] },
 { id: 'pmjay', n: ['Ayushman Bharat PM-JAY', 'ஆயுஷ்மான் பாரத்'], b: ['Free hospital treatment up to ₹5 lakh per family per year', 'குடும்பத்துக்கு ஆண்டுக்கு ₹5 லட்சம் வரை இலவச மருத்துவமனை சிகிச்சை'], ok: p => p.income <= 250000 || p.age >= 70, docs: ['aadhaar', 'ration', 'mobile'] },
 { id: 'ujjwala', n: ['PM Ujjwala Yojana', 'பிஎம் உஜ்வாலா'], b: ['Free LPG gas connection for women in low-income homes', 'குறைந்த வருமானக் குடும்பப் பெண்களுக்கு இலவச LPG எரிவாயு இணைப்பு'], ok: p => p.gender === 'female' && p.age >= 18 && p.income <= 200000 && p.has_lpg === false, docs: ['aadhaar', 'ration', 'passbook'] },
 { id: 'pmjjby', n: ['PM Jeevan Jyoti Bima', 'பிஎம் ஜீவன் ஜோதி பீமா'], b: ['₹2 lakh life cover for ₹436 a year', 'ஆண்டுக்கு ₹436-க்கு ₹2 லட்சம் ஆயுள் காப்பீடு'], ok: p => p.age >= 18 && p.age <= 50, docs: ['aadhaar', 'account'] },
 { id: 'pmsby', n: ['PM Suraksha Bima', 'பிஎம் சுரக்ஷா பீமா'], b: ['₹2 lakh accident cover for ₹20 a year', 'ஆண்டுக்கு ₹20-க்கு ₹2 லட்சம் விபத்துக் காப்பீடு'], ok: p => p.age >= 18 && p.age <= 70, docs: ['aadhaar', 'account'] },
 { id: 'apy', n: ['Atal Pension Yojana', 'அடல் ஓய்வூதியத் திட்டம்'], b: ['Pension of ₹1,000–5,000 a month after age 60', '60 வயதுக்குப் பிறகு மாதம் ₹1,000–5,000 ஓய்வூதியம்'], ok: p => p.age >= 18 && p.age <= 40 && !p.income_tax_payer, docs: ['aadhaar', 'account', 'mobile'] },
 { id: 'oldage', n: ['Old Age Pension (IGNOAPS + state)', 'முதியோர் ஓய்வூதியம்'], b: ['Monthly pension for senior citizens in low-income families', 'குறைந்த வருமானக் குடும்ப முதியோருக்கு மாத ஓய்வூதியம்'], ok: p => p.age >= 60 && p.income <= 100000, docs: ['aadhaar', 'age', 'income', 'passbook'] },
 { id: 'sukanya', n: ['Sukanya Samriddhi Yojana', 'செல்வமகள் சேமிப்புத் திட்டம்'], b: ['High-interest, tax-free savings account for a girl child', 'பெண் குழந்தைக்கு அதிக வட்டி, வரி இல்லாத சேமிப்புக் கணக்கு'], ok: p => p.girl_child_under_10, docs: ['birth', 'parentid'] },
 { id: 'pudhumai', n: ['Pudhumai Penn (Tamil Nadu)', 'புதுமைப் பெண் திட்டம்'], b: ['₹1,000 a month to girls in college who studied in government schools', 'அரசுப் பள்ளியில் படித்து கல்லூரியில் சேரும் மாணவிகளுக்கு மாதம் ₹1,000'], ok: p => /tamil|tn|chennai/i.test(p.state) && p.gender === 'female' && p.is_student && p.govt_school, docs: ['aadhaar', 'school', 'college', 'passbook'] },
 { id: 'pudhalvan', n: ['Tamil Pudhalvan (Tamil Nadu)', 'தமிழ்ப் புதல்வன் திட்டம்'], b: ['₹1,000 a month to boys in college who studied in government schools', 'அரசுப் பள்ளியில் படித்து கல்லூரியில் சேரும் மாணவர்களுக்கு மாதம் ₹1,000'], ok: p => /tamil|tn|chennai/i.test(p.state) && p.gender === 'male' && p.is_student && p.govt_school, docs: ['aadhaar', 'school', 'college', 'passbook'] },
 { id: 'magalir', n: ['Kalaignar Magalir Urimai Thogai (TN)', 'கலைஞர் மகளிர் உரிமைத் தொகை'], b: ['₹1,000 a month to women heads of family', 'குடும்பத் தலைவிகளுக்கு மாதம் ₹1,000'], ok: p => /tamil|tn|chennai/i.test(p.state) && p.gender === 'female' && p.woman_head_of_family && p.age >= 21 && p.income <= 250000, docs: ['aadhaar', 'ration', 'passbook', 'ebill'] },
 { id: 'vishwakarma', n: ['PM Vishwakarma', 'பிஎம் விஸ்வகர்மா'], b: ['Skill training, toolkit support and low-interest loans for artisans', 'கைவினைஞர்களுக்குத் திறன் பயிற்சி, கருவித் தொகுப்பு உதவி, குறைந்த வட்டிக் கடன்'], ok: p => p.occupation === 'artisan' && p.age >= 18, docs: ['aadhaar', 'account', 'mobile'] },
 { id: 'mudra', n: ['PM Mudra Yojana', 'பிஎம் முத்ரா கடன்'], b: ['Collateral-free loans to start or grow a small business', 'சிறு தொழில் தொடங்க அல்லது வளர்க்க பிணையில்லாக் கடன்'], ok: p => p.occupation === 'small business' || p.occupation === 'unemployed', docs: ['aadhaar', 'pan', 'bizplan'] },
 { id: 'css', n: ['Central Sector Scholarship', 'மத்தியத் துறை உதவித்தொகை'], b: ['Yearly scholarship for college students who scored in the top 20% in class 12', '12-ஆம் வகுப்பில் முதல் 20% மதிப்பெண் பெற்ற கல்லூரி மாணவர்களுக்கு ஆண்டு உதவித்தொகை'], ok: p => p.is_student && p.income <= 450000, docs: ['mark12', 'income', 'admission', 'passbook'] }
];
const DOCS = { aadhaar: ['Aadhaar', 'ஆதார்'], land: ['Land records (patta)', 'நிலப் பதிவுகள் (பட்டா)'], passbook: ['Bank passbook', 'வங்கிக் கணக்குப் புத்தகம்'], ration: ['Ration card', 'குடும்ப அட்டை'], mobile: ['Mobile number', 'கைபேசி எண்'], account: ['Bank account', 'வங்கிக் கணக்கு'], age: ['Age proof', 'வயதுச் சான்று'], income: ['Income certificate', 'வருமானச் சான்றிதழ்'], birth: ["Girl's birth certificate", 'குழந்தையின் பிறப்புச் சான்றிதழ்'], parentid: ["Parent's Aadhaar and PAN", 'பெற்றோரின் ஆதார், PAN'], school: ['School TC and marksheets', 'பள்ளி மாற்றுச் சான்றிதழ், மதிப்பெண் சான்றிதழ்கள்'], college: ['College ID', 'கல்லூரி அடையாள அட்டை'], ebill: ['Electricity bill', 'மின் கட்டண ரசீது'], pan: ['PAN card', 'பான் அட்டை'], bizplan: ['Business plan or proof', 'தொழில் திட்டம் அல்லது சான்று'], mark12: ['Class 12 marksheet', '12-ஆம் வகுப்பு மதிப்பெண் சான்றிதழ்'], admission: ['College admission proof', 'கல்லூரிச் சேர்க்கைச் சான்று'] };
const L2 = pair => pair[LANG === 'ta' ? 1 : 0];
let chat = [], profile = null, matches = [];
const chatSystem = () => `You are Scheme Agent inside the Thunai app, helping ordinary people in India find government schemes. Talk like a kind helper at an e-Sevai centre. Ask ONE short question per reply, at most 6 questions in total. Infer what you can from what the person already said (for example "farmer with 2 acres" means they own farm land; "girl" means female). Never ask for Aadhaar, bank or ID numbers, or caste. As soon as you know age, gender, state, occupation and yearly family income (estimate a number from a range or words like "low income"), set ready to true and fill the profile; unknown yes/no fields are false, except has_lpg which is true unless they say they have no gas connection.
Reply with only JSON: {"reply": "what you say to the person, under 45 words, no markdown", "ready": boolean, "profile": null or {"name": "", "age": number, "gender": "female|male|other", "state": "", "district": "", "occupation": "farmer|student|daily-wage worker|artisan|small business|salaried|homemaker|unemployed|retired", "income": number, "is_student": boolean, "govt_school": boolean, "owns_farm_land": boolean, "woman_head_of_family": boolean, "girl_child_under_10": boolean, "income_tax_payer": boolean, "has_lpg": boolean}}
${aiLang()}`;
function bubble(role, text, cls = '') { const b = el('div', 'bub ' + (role === 'user' ? 'u' : 'a') + (cls ? ' ' + cls : '')); b.textContent = text; $('#chat').append(b); $('#chat').scrollTop = 1e6; return b; }
function chatIntro() { if (!chat.length) { $('#chat').innerHTML = ''; bubble('assistant', t('ch.intro')); } }
function renderEx() {
  $('#chatEx').innerHTML = `<span class="hint" style="margin:0;align-self:center">${esc(t('ch.try'))}</span>` + ['ex1', 'ex2', 'ex3'].map(k => `<button class="pill" data-ex="${k}">${esc(t('ch.' + k))}</button>`).join('') + `<button class="pill" id="chatReset">↺ ${esc(t('ch.reset'))}</button>`;
}
$('#chatEx').onclick = e => {
  const b = e.target.closest('[data-ex]'); if (b) { sendChat(t('ch.' + b.dataset.ex + 'm')); return; }
  if (e.target.closest('#chatReset')) { chat = []; profile = null; matches = []; $('#cOut').innerHTML = ''; $('#cErr').innerHTML = ''; chatIntro(); }
};
onLang(() => { chatIntro(); renderEx(); if (matches.length || profile) renderSchemes(); });
$('#chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#chatIn').value.trim(); if (!v) return; $('#chatIn').value = ''; sendChat(v); });
let chatBusy = false;
async function sendChat(text) {
  if (chatBusy) return; chatBusy = true;
  const voice = lastInputByVoice; lastInputByVoice = false;
  chat.push({ role: 'user', parts: [{ text }] }); bubble('user', text);
  const typing = bubble('assistant', t('c.thinking'), 'typing'); $('#cErr').innerHTML = ''; $('#chatSend').disabled = true;
  try {
    const raw = await gemini({ system: chatSystem(), contents: chat.slice(-16), json: true });
    typing.remove();
    const reply = String(raw.reply || '').trim() || '…';
    chat.push({ role: 'model', parts: [{ text: JSON.stringify(raw) }] });
    bubble('assistant', reply);
    if (voice) speak(reply);
    if (raw.ready && raw.profile && typeof raw.profile === 'object') {
      const p = raw.profile;
      profile = { name: String(p.name || ''), age: num(p.age), gender: String(p.gender || '').toLowerCase(), state: String(p.state || ''), district: String(p.district || ''), occupation: String(p.occupation || '').toLowerCase(), income: num(p.income, 999999),
        is_student: !!p.is_student || /student/.test(String(p.occupation)), govt_school: !!p.govt_school, owns_farm_land: !!p.owns_farm_land, woman_head_of_family: !!p.woman_head_of_family,
        girl_child_under_10: !!p.girl_child_under_10, income_tax_payer: !!p.income_tax_payer, has_lpg: p.has_lpg === false ? false : true };
      matches = SCH.filter(s => { try { return s.ok(profile); } catch (er) { return false; } });
      const summary = matches.length ? t('ch.summary', { n: matches.length, top: matches.slice(0, 2).map(s => L2(s.n)).join(LANG === 'ta' ? ', ' : ' and ') }) : t('ch.none');
      bubble('assistant', summary);
      renderSchemes();
      if (voice) speak(summary);
    }
  } catch (e) {
    typing.remove(); chat.pop();
    $('#cErr').innerHTML = esc(errText(e)) + (e && (e.code === 'nokey' || e.code === 'badkey') ? ` <a href="#settings">${esc(t('nav.settings'))} →</a>` : '');
  } finally { chatBusy = false; $('#chatSend').disabled = false; }
}
function renderSchemes() {
  const out = $('#cOut'); out.innerHTML = '';
  const card = el('div', 'card', `<h3>${esc(matches.length ? t('ch.found', { n: matches.length }) : t('ch.none'))}</h3>`);
  matches.forEach(s => {
    const c = el('div', 'scheme', `<b></b><p></p><div class="btns" style="margin-top:10px"></div>`);
    c.querySelector('b').textContent = L2(s.n); c.querySelector('p').textContent = L2(s.b);
    const f = el('button', 'btn small', `<span>${esc(t('ch.fill'))}</span>`); f.onclick = () => formFor(s, c);
    const a = el('a', 'btn soft small'); a.href = 'https://www.myscheme.gov.in/search'; a.dataset.ext = ''; a.textContent = t('ch.check');
    c.querySelector('.btns').append(f, a); card.append(c);
  });
  out.append(card);
}
function formFor(s, host) {
  const old = host.querySelector('.form'); if (old) { old.remove(); return; }
  const p = profile || {};
  const fields = [['f.name', p.name || ''], ['f.age', p.age || ''], ['f.gender', p.gender || ''], ['f.state', p.state || ''], ['f.district', p.district || ''], ['f.occ', p.occupation || ''], ['f.income', p.income && p.income < 999999 ? p.income : ''], ['f.mobile', '']];
  const f = el('div', 'form', `<p class="hint">${esc(t('ch.draft'))}</p>` + fields.map((x, i) => `<label class="l" for="ff_${s.id}_${i}">${esc(t(x[0]))}</label><input class="in" id="ff_${s.id}_${i}" value="${esc(x[1])}">`).join('') +
    `<p style="margin-top:12px"><b>${esc(t('ch.docs'))}</b></p><ul class="list">${s.docs.map(d => `<li>${esc(L2(DOCS[d]))}</li>`).join('')}</ul><div class="btns"></div>`);
  const sh = el('button', 'btn', icon('share') + `<span>${esc(t('ch.shareForm'))}</span>`);
  sh.onclick = () => share(`${L2(s.n)}\n` + fields.map((x, i) => `${t(x[0])}: ${f.querySelector('#ff_' + s.id + '_' + i).value}`).join('\n') + `\n${t('ch.docs')}: ${s.docs.map(d => L2(DOCS[d])).join(', ')}`);
  f.querySelector('.btns').append(sh); host.append(f);
}

/* ================= ENERGY ================= */
const PRE = [[['Ceiling fan', 'மின்விசிறி'], 75, 10], [['Fridge (10+ years old)', 'குளிர்சாதனப் பெட்டி (10+ ஆண்டுகள்)'], 130, 24], [['Fridge (5-star)', 'குளிர்சாதனப் பெட்டி (5 நட்சத்திரம்)'], 45, 24], [['Split AC 1.5 ton', 'ஸ்பிளிட் ஏசி 1.5 டன்'], 1500, 6], [['Geyser', 'வெந்நீர் ஹீட்டர்'], 2000, 1], [['Television', 'தொலைக்காட்சி'], 90, 5], [['Washing machine', 'சலவை இயந்திரம்'], 500, 1], [['Water pump motor', 'தண்ணீர் மோட்டார்'], 750, 1], [['LED bulb', 'LED விளக்கு'], 9, 6], [['Old tube light', 'பழைய டியூப் லைட்'], 40, 6]];
let apps = arr(store.get('apps', [{ p: 0, w: 75, h: 10, q: 3 }, { p: 1, w: 130, h: 24, q: 1 }, { p: 3, w: 1500, h: 6, q: 1 }, { p: 5, w: 90, h: 5, q: 1 }]));
const appName = a => a.p != null && PRE[a.p] ? L2(PRE[a.p][0]) : String(a.n || '');
const units = a => num(a.w) * num(a.h) * (a.q || 1) * 30 / 1000;
function renderPresets() { $('#ePresets').innerHTML = PRE.map((p, i) => `<button class="pill" data-i="${i}">+ ${esc(L2(p[0]))}</button>`).join(''); }
$('#ePresets').onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; const p = PRE[+b.dataset.i]; apps.push({ p: +b.dataset.i, w: p[1], h: p[2], q: 1 }); renderApps(); };
function renderApps() {
  store.set('apps', apps); const rate = num($('#eRate').value);
  $('#eRows').innerHTML = apps.length ? apps.map((a, i) => `<tr><td>${esc(appName(a))}${(a.q || 1) > 1 ? ' ×' + a.q : ''}</td><td class="n"><input class="in" type="number" data-i="${i}" data-f="w" value="${num(a.w)}" min="0" aria-label="${esc(t('th.w'))}"></td><td class="n"><input class="in" type="number" data-i="${i}" data-f="h" value="${num(a.h)}" min="0" max="24" step="0.5" aria-label="${esc(t('th.h'))}"></td><td class="n">${units(a).toFixed(0)}</td><td class="n">₹${Math.round(units(a) * rate).toLocaleString('en-IN')}</td><td><button class="x" data-del="${i}" aria-label="${esc(t('c.remove'))}">✕</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="hint">${esc(t('en.empty'))}</td></tr>`;
  const tot = apps.reduce((s, a) => s + units(a), 0), bill = num($('#eBill').value);
  $('#eUnits').textContent = tot.toFixed(0);
  $('#eCost').textContent = '₹' + Math.round(tot * rate).toLocaleString('en-IN');
  $('#eGap').textContent = bill ? Math.max(0, bill - tot).toFixed(0) : '—';
}
$('#eRows').addEventListener('change', e => { const x = e.target; if (x.dataset.f) { apps[+x.dataset.i][x.dataset.f] = Math.max(0, num(x.value)); renderApps(); } });
$('#eRows').addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) { apps.splice(+b.dataset.del, 1); renderApps(); } });
$('#eRate').addEventListener('input', renderApps); $('#eBill').addEventListener('input', renderApps);
onLang(() => { renderPresets(); renderApps(); });
const ePick = filePicker('eImg');
$('#eScan').onclick = e => busy(e.currentTarget, $('#eErr'), async () => {
  const img = ePick.get(); if (!img) { $('#eErr').textContent = t('en.needPhoto'); return; }
  const r = await ask(`You are Energy X-Ray. Identify the home appliance in the photo (an Indian home) and read any BEE star-rating label. Estimate its AVERAGE running power in watts (for fridges and ACs this is the duty-cycled average) and typical daily hours in an Indian home.
Reply with only JSON: {"appliance": "short name", "star_rating": 0-5 (0 if not visible), "est_age_years": number, "avg_watts": number, "hours_per_day": number, "note": "one short sentence about its efficiency"}
${aiLang()}`, img);
  const a = { n: String(r.appliance || 'Appliance').slice(0, 40) + (num(r.star_rating) ? ` (${num(r.star_rating)}★)` : ''), w: Math.max(1, Math.round(num(r.avg_watts, 100))), h: Math.min(24, Math.max(0, num(r.hours_per_day, 4))), q: 1 };
  apps.push(a); renderApps(); ePick.clear();
  const out = $('#eOut'); out.innerHTML = '';
  const card = el('div', 'card', '<h3></h3><p></p>'); card.querySelector('h3').textContent = `${t('en.added')} ${a.n}`; card.querySelector('p').textContent = `${r.note || ''} ${t('en.adjust')}`; out.append(card);
});
$('#ePlan').onclick = e => busy(e.currentTarget, $('#eErr'), async () => {
  if (!apps.length) { $('#eErr').textContent = t('en.needApps'); return; }
  const rate = num($('#eRate').value, 6), list = apps.map(a => `- ${appName(a)}: ${a.w} W × ${a.h} h/day × ${a.q || 1} = ${units(a).toFixed(0)} units/month`).join('\n');
  const r = await ask(`You are Energy X-Ray, an energy auditor for Indian homes. Electricity costs ₹${rate} per unit. Appliance list:
${list.slice(0, 3000)}
Give the 4 most valuable savings actions (replace an old appliance with a 5-star one, change usage time or settings such as AC at 24-26°C, fix habits). Use realistic Indian prices.
Reply with only JSON: {"headline": "one sentence naming the biggest energy waster", "tips": [{"action": "short", "monthly_saving_rs": number, "upgrade_cost_rs": number (0 if free), "payback_months": number (0 if free)}]}
${aiLang()}`);
  const tips = arr(r.tips).slice(0, 5), sum = tips.reduce((s, x) => s + num(x.monthly_saving_rs), 0);
  const out = $('#eOut'); out.innerHTML = '';
  const card = el('div', 'card', `<h3>${esc(t('en.planTitle'))}</h3><p class="hl"></p><div class="kpis" style="margin:14px 0"><div class="kpi"><b>₹${Math.round(sum).toLocaleString('en-IN')}</b><span>${esc(t('en.save'))}</span></div><div class="kpi"><b>₹${Math.round(sum * 12).toLocaleString('en-IN')}</b><span>${esc(t('en.year'))}</span></div></div>
   <div class="scroll"><table><thead><tr><th>${esc(t('th.action'))}</th><th class="n">${esc(t('th.saves'))}</th><th class="n">${esc(t('th.costs'))}</th><th class="n">${esc(t('th.payback'))}</th></tr></thead><tbody>${tips.map(x => `<tr><td>${esc(x.action)}</td><td class="n">₹${Math.round(num(x.monthly_saving_rs))}</td><td class="n">${num(x.upgrade_cost_rs) ? '₹' + Math.round(num(x.upgrade_cost_rs)).toLocaleString('en-IN') : esc(t('en.free'))}</td><td class="n">${num(x.payback_months) ? Math.round(num(x.payback_months)) + ' ' + esc(t('mo')) : esc(t('en.now'))}</td></tr>`).join('')}</tbody></table></div>
   <p class="hint">${esc(t('en.aiNote'))}</p><div class="btns"></div>`);
  card.querySelector('.hl').textContent = r.headline || '';
  card.querySelector('.btns').append(sayBtn(() => r.headline || ''));
  out.append(card); card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ================= GREEN HOURS ================= */
const GI = [760, 760, 760, 760, 755, 750, 740, 720, 690, 650, 610, 580, 560, 555, 565, 590, 640, 700, 770, 800, 800, 790, 780, 770];
const GAPP = [[['Washing machine (1 load)', 'சலவை இயந்திரம் (1 முறை)'], 1], [['Geyser (20 min)', 'வெந்நீர் ஹீட்டர் (20 நிமி.)'], .7], [['Electric scooter charge', 'மின் ஸ்கூட்டர் சார்ஜ்'], 2.5], [['Water pump (1 hr)', 'தண்ணீர் மோட்டார் (1 மணி)'], .75], [['Iron box (1 hr)', 'இஸ்திரிப் பெட்டி (1 மணி)'], 1], [['Electric car charge', 'மின் கார் சார்ஜ்'], 15]];
const gmin = Math.min(...GI), gmax = Math.max(...GI), gbest = GI.indexOf(gmin);
const fmtHour = h => LANG === 'ta' ? `${h < 5 ? 'இரவு' : h < 12 ? 'காலை' : h < 16 ? 'மதியம்' : h < 19 ? 'மாலை' : 'இரவு'} ${h % 12 || 12}` : `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const gcol = v => { const k = (v - gmin) / (gmax - gmin); return k < .33 ? 'linear-gradient(#34d399,#059669)' : k < .66 ? 'linear-gradient(#fcd34d,#f59e0b)' : 'linear-gradient(#fb7185,#e11d48)'; };
let board = [['214', 18.4], ['108', 12.1], ['305', 9.7], ['122', 6.2]], mine = null;
function renderGreenStatic() {
  const gh = $('#gHour').value;
  $('#gHead').textContent = t('gr.head', { h: fmtHour(gbest) });
  $('#gHrs').innerHTML = GI.map((_, h) => `<span>${h % 3 === 0 ? (LANG === 'ta' ? h : (h % 12 || 12) + (h < 12 ? 'a' : 'p')) : ''}</span>`).join('');
  const sel = $('#gApp').value;
  $('#gApp').innerHTML = GAPP.map((a, i) => `<option value="${i}">${esc(L2(a[0]))}</option>`).join(''); if (sel) $('#gApp').value = sel;
  $('#gHour').innerHTML = GI.map((_, h) => `<option value="${h}">${esc(fmtHour(h))}</option>`).join(''); $('#gHour').value = gh || '20';
  $('#gPledge').textContent = t(mine != null ? 'gr.pledged' : 'gr.pledge');
}
function green() {
  const h = num($('#gHour').value, 20), kwh = GAPP[num($('#gApp').value)][1], uses = Math.max(1, num($('#gUses').value, 1));
  $('#gBars').innerHTML = GI.map((v, i) => `<div class="${i === h ? 'cur' : ''}${i === gbest ? ' best' : ''}" title="${esc(fmtHour(i))}: ${v} g" style="height:${(22 + 78 * (v - 500) / (gmax - 500)).toFixed(0)}%;background:${gcol(v)}"></div>`).join('');
  const peak = GI.indexOf(gmax);
  let save = kwh * uses * (GI[h] - gmin) / 1000;
  const already = GI[h] - gmin < 1;
  if (already) save = kwh * uses * (gmax - GI[h]) / 1000;
  $('#gBest').textContent = fmtHour(gbest); $('#gSave').textContent = save.toFixed(1) + ' kg'; $('#gYear').textContent = (save * 12).toFixed(0) + ' kg';
  $('#gSaveLbl').textContent = already ? t('gr.saveVsPeak', { h: fmtHour(peak) }) : t('gr.saveM');
  $('#gNote').textContent = already ? t('gr.already') : t('gr.move', { from: fmtHour(h), to: fmtHour(gbest) });
  $('#gNote').style.color = already ? 'var(--ok)' : '';
  return save;
}
function renderBoard() {
  const rows = [...board.map(r => [t('gr.room') + ' ' + r[0], r[1], false]), ...(mine != null ? [[t('gr.you'), mine, true]] : [])].sort((a, b) => b[1] - a[1]);
  $('#gBoard').innerHTML = rows.map((r, i) => `<tr${r[2] ? ' style="font-weight:800;color:var(--c-green)"' : ''}><td>${i + 1}. ${esc(r[0])}</td><td class="n">${r[1].toFixed(1)} kg</td></tr>`).join('');
}
$('#gApp').onchange = green; $('#gHour').onchange = green; $('#gUses').oninput = green;
$('#gBars').onclick = e => { const i = [...$('#gBars').children].indexOf(e.target); if (i >= 0) { $('#gHour').value = i; green(); } };
$('#gPledge').onclick = () => { mine = green(); renderBoard(); $('#gPledge').textContent = t('gr.pledged'); };
onLang(() => { renderGreenStatic(); green(); renderBoard(); });

/* ================= LAKE ================= */
const LAKES = [
  { k: 'lake.chit', q: 'Chitlapakkam Lake', lat: 12.93389, lng: 80.13611, body: 'body.tambaram', fact: true },
  { k: 'lake.mada', q: 'Madambakkam Lake', lat: 12.910, lng: 80.165, body: 'body.tambaram' },
  { k: 'lake.palli', q: 'Pallikaranai Marsh', lat: 12.9375, lng: 80.215, body: 'body.gcc' },
  { k: 'lake.chem', q: 'Chembarambakkam Lake', lat: 13.01, lng: 80.06, body: 'body.wrd' }
];
const YEARS = ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', 'now'];
let lmap = null, yearLayers = [], yearAttr = [], shownAttr = null, curYear = YEARS.length - 1, lakeSel = 0, boundary = null, playT = null, customLake = null;
function initLake() {
  if (lmap) { setTimeout(() => lmap.invalidateSize(), 60); return; }
  if (!window.L) return;
  lmap = L.map('lmap', { zoomControl: false }).setView([LAKES[0].lat, LAKES[0].lng], 15);
  L.control.zoom({ position: 'bottomright' }).addTo(lmap);
  yearLayers = YEARS.map(y => y === 'now'
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 18, maxZoom: 19, opacity: 0, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' })
    : L.tileLayer(`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${y}_3857/default/g/{z}/{y}/{x}.jpg`, { maxNativeZoom: 14, maxZoom: 19, opacity: 0, attribution: `EOxCloudless ${y} by EOX IT Services GmbH (contains modified Copernicus Sentinel data ${y})` }));
  yearAttr = yearLayers.map(l => l.options.attribution); yearLayers.forEach(l => { l.options.attribution = ''; l.addTo(lmap); });
  setYear(curYear); loadLake(LAKES[0]);
  setTimeout(() => lmap.invalidateSize(), 120);
}
function setYear(i) {
  curYear = i; $('#lYear').value = i;
  yearLayers.forEach((l, j) => l.setOpacity(j === i ? 1 : 0));
  if (lmap && lmap.attributionControl) { if (shownAttr) lmap.attributionControl.removeAttribution(shownAttr); shownAttr = yearAttr[i]; lmap.attributionControl.addAttribution(shownAttr); }
  $('#yearBadge').textContent = YEARS[i] === 'now' ? t('lk.now') : YEARS[i];
}
$('#lYear').addEventListener('input', e => { stopPlay(); setYear(+e.target.value); });
function stopPlay() { if (playT) { clearInterval(playT); playT = null; $('#lPlay').innerHTML = icon('play', 20); } }
$('#lPlay').onclick = () => {
  if (playT) { stopPlay(); return; }
  if (!lmap) return;
  setYear(0); $('#lPlay').innerHTML = icon('pause', 20);
  playT = setInterval(() => { if (curYear >= YEARS.length - 1) { stopPlay(); return; } setYear(curYear + 1); }, 1300);
};
function ringArea(ring) {
  if (!ring || ring.length < 3) return 0;
  const lat0 = ring[0][1] * Math.PI / 180, kx = Math.cos(lat0) * 111320, ky = 110540; let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  return Math.abs(a / 2);
}
function geoArea(g) {
  if (!g) return 0;
  const poly = c => ringArea(c[0]) - c.slice(1).reduce((s, r) => s + ringArea(r), 0);
  if (g.type === 'Polygon') return poly(g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, c) => s + poly(c), 0);
  return 0;
}
async function loadLake(lk, preset) {
  if (!lmap) return;
  if (boundary) { boundary.remove(); boundary = null; }
  $('#lArea').textContent = '…'; $('#lFact').hidden = !lk.fact;
  lmap.setView([lk.lat, lk.lng], 15);
  try {
    let g = preset;
    if (!g) {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=1&q=${encodeURIComponent(lk.q + ', Chennai')}`);
      const j = await r.json(); g = arr(j)[0] && arr(j)[0].geojson;
    }
    if (g && /Polygon/.test(g.type)) {
      boundary = L.geoJSON(g, { style: { color: '#38bdf8', weight: 3, fill: false, dashArray: '6 6' } }).addTo(lmap);
      lmap.fitBounds(boundary.getBounds(), { padding: [30, 30], maxZoom: 16 });
      const m2 = geoArea(g);
      $('#lArea').textContent = `${(m2 / 1e4).toFixed(1)} ${t('lk.ha')} · ${(m2 / 4046.86).toFixed(1)} ${t('lk.acres')}`;
    } else { $('#lArea').textContent = '—'; toast(t('lk.noBoundary')); }
  } catch (e) { $('#lArea').textContent = '—'; toast(t('lk.noBoundary')); }
}
function renderLakePills() {
  $('#lakePills').innerHTML = LAKES.map((l, i) => `<button class="pill" data-l="${i}" aria-pressed="${i === lakeSel && !customLake}">${esc(t(l.k))}</button>`).join('');
  const lk = customLake || LAKES[lakeSel];
  if (!$('#lName').dataset.edited) $('#lName').value = customLake ? customLake.name : t(lk.k);
  if (!$('#lBody').dataset.edited) $('#lBody').value = t(lk.body || 'body.gcc');
}
$('#lName').addEventListener('input', e => { e.target.dataset.edited = '1'; });
$('#lBody').addEventListener('input', e => { e.target.dataset.edited = '1'; });
$('#lakePills').onclick = e => { const b = e.target.closest('[data-l]'); if (!b) return; lakeSel = +b.dataset.l; customLake = null; delete $('#lName').dataset.edited; delete $('#lBody').dataset.edited; renderLakePills(); loadLake(LAKES[lakeSel]); };
searchBox('lakeIn', 'lakeSug', it => {
  customLake = { name: String(it.name || it.display_name || '').split(',')[0], q: String(it.display_name || ''), lat: num(it.lat), lng: num(it.lon), body: 'body.gcc' };
  delete $('#lName').dataset.edited; renderLakePills(); loadLake(customLake, it.geojson);
}, '&polygon_geojson=1');
onLang(() => { renderLakePills(); if (lmap) setYear(curYear); });
const lPick = filePicker('lImg');
$('#lGo').onclick = e => busy(e.currentTarget, $('#lErr'), async () => {
  const img = lPick.get(), note = $('#lNote').value.trim(), lk = $('#lName').value.trim() || 'the lake', body = $('#lBody').value.trim() || 'the local body';
  if (!img && !note) { $('#lErr').textContent = t('lk.need'); return; }
  const r = await ask(`You are LakeWatch, helping citizens in Chennai protect lakes. ${img ? 'Look at the photo taken at the lake. ' : ''}Lake: ${lk.slice(0, 80)}. Authority: ${body.slice(0, 80)}.${note ? ' Citizen\'s note: ' + note.slice(0, 400) : ''}
Identify the problem and write a short, polite, formal complaint letter from a resident to the Commissioner of that authority, with a clear request for action, leaving [Your name], [Address] and [Date] as placeholders.
Reply with only JSON: {"issue": "dumping|construction|sewage|weeds|other", "issue_label": "short name of the problem", "severity": "low|medium|high", "what_we_see": "one sentence", "letter": "the full letter"}
${aiLang()}`, img);
  const sev = ['low', 'medium', 'high'].includes(r.severity) ? r.severity : 'medium';
  const out = $('#lOut'); out.innerHTML = '';
  const card = el('div', 'card', `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h3 style="margin:0"></h3><span class="tag ${sev === 'high' ? 'bad' : sev === 'low' ? 'ok' : 'warn'}">${esc(t('sev.' + sev))} ${esc(t('lk.sev'))}</span></div><p style="margin:10px 0 12px" class="w"></p><pre class="letter"></pre><div class="btns"></div>`);
  card.querySelector('h3').textContent = r.issue_label || r.issue || '';
  card.querySelector('.w').textContent = r.what_we_see || ''; card.querySelector('pre').textContent = r.letter || '';
  const sh = el('button', 'btn', icon('share') + `<span>${esc(t('lk.share'))}</span>`); sh.onclick = () => share(String(r.letter || ''));
  const cp = el('button', 'btn soft', `<span>${esc(t('c.copy'))}</span>`); cp.onclick = () => copy(String(r.letter || ''));
  card.querySelector('.btns').append(sh, cp); out.append(card); card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ================= SETTINGS ================= */
function renderSettings() {
  $('#elderToggle').checked = elderOn(); $('#liveToggle').checked = liveOn(); $('#groupIn').value = store.get('group', 'ohpc26');
  $('#keyIn').value = key(); $('#modelSel').value = MODELS.includes(model()) ? model() : MODELS[0];
  $('#gemVoice').checked = store.get('gemVoice', true);
  $('#keyShow').textContent = t($('#keyIn').type === 'password' ? 'st.show' : 'st.hide');
}
$('#keyShow').onclick = () => { const i = $('#keyIn'); i.type = i.type === 'password' ? 'text' : 'password'; renderSettings(); };
$('#keySave').onclick = () => { store.set('key', $('#keyIn').value.trim()); store.set('model', $('#modelSel').value); $('#keyErr').textContent = ''; $('#keyOk').textContent = t('st.saved'); toast(t('st.saved')); renderHome(); };
$('#modelSel').onchange = () => store.set('model', $('#modelSel').value);
$('#keyClear').onclick = () => { store.set('key', ''); renderSettings(); renderHome(); $('#keyOk').textContent = ''; };
$('#gemVoice').onchange = e => store.set('gemVoice', e.target.checked);
$('#keyTest').onclick = e => {
  store.set('key', $('#keyIn').value.trim()); store.set('model', $('#modelSel').value); $('#keyOk').textContent = '';
  busy(e.currentTarget, $('#keyErr'), async () => {
    const r = await gemini({ parts: [{ text: 'Reply with only this JSON: {"ok": true}' }] });
    if (r && r.ok) { $('#keyOk').textContent = t('st.testOk') + ' · ' + model(); $('#modelSel').value = model(); renderHome(); }
  });
};
$('#elderToggle').onchange = e => { store.set('elder', e.target.checked); renderElder(); };
$('#liveToggle').onchange = e => { store.set('liveOn', e.target.checked); remote = []; pullLive(); };
$('#groupIn').addEventListener('change', e => { store.set('group', e.target.value.trim().slice(0, 30) || 'ohpc26'); remote = []; renderSettings(); pullLive(); });
$('#voiceTest').onclick = e => speak(t('st.voiceSample'), null);
onLang(renderSettings);

/* ================= THEME ================= */
const mq = matchMedia('(prefers-color-scheme: dark)');
const themePref = () => store.get('theme', 'auto');
function applyTheme() {
  const pref = themePref(), dark = pref === 'dark' || (pref === 'auto' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#0a1020' : '#0e7490';
  $('#themeBtn').innerHTML = icon(dark ? 'sun' : 'moon', 20);
  $('#themeBtn').setAttribute('aria-label', t(dark ? 'tm.light' : 'tm.dark'));
  $$('#themePills [data-tm]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tm === pref));
}
function setTheme(p) { store.set('theme', p); applyTheme(); }
$('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
$('#themePills').onclick = e => { const b = e.target.closest('[data-tm]'); if (b) setTheme(b.dataset.tm); };
if (mq.addEventListener) mq.addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });
onLang(applyTheme);

/* ================= start ================= */
applyLang();
show();
if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
