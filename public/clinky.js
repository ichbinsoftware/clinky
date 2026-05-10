// clinky/public/clinky.js — framework entry. Class internally, factory externally.
import { setSynthEnabled, setMasterGain } from '/synth.js';
import { Essay } from '/essay.js';

// ============================================================================
// SSE pub/sub for stream-wide events
// Modes register handlers at module init via onGraphComplete / onBatchStart /
// onUsage. startStream fans SSE events to all registered handlers. Per-call
// callbacks via opts also fire (one-session handlers).
// ============================================================================
const _graphHandlers = [];
const _batchHandlers = [];
const _usageHandlers = [];

export function onGraphComplete(fn) { _graphHandlers.push(fn); return () => { const i = _graphHandlers.indexOf(fn); if (i >= 0) _graphHandlers.splice(i, 1); }; }
export function onBatchStart(fn)    { _batchHandlers.push(fn); return () => { const i = _batchHandlers.indexOf(fn); if (i >= 0) _batchHandlers.splice(i, 1); }; }
export function onUsage(fn)         { _usageHandlers.push(fn); return () => { const i = _usageHandlers.indexOf(fn); if (i >= 0) _usageHandlers.splice(i, 1); }; }

// ============================================================================
// SSE stream factory — used internally by Clinky.think(); also exported as
// `startThinking` for legacy callers via the shim.
// ============================================================================
export function startStream(prompt, { onTopics, onNode, onDone, onError, onStatus, onThinking, onBatch, onGraph, onUsage: onUsageCb, nodeStagger } = {}) {
  const t0 = performance.now();
  console.log(`[clinky] think started at ${new Date().toISOString()}`);
  const mode = window.location.pathname.replace(/^\//, '').replace(/\.html$/, '') || '';
  const pageParams = new URLSearchParams(window.location.search);

  const sessionId = pageParams.get('session');
  let esUrl;
  if (sessionId) {
    const speed = pageParams.get('speed');
    const replayParams = new URLSearchParams();
    if (speed != null) replayParams.set('speed', speed);
    esUrl = `/api/replay/${encodeURIComponent(sessionId)}${replayParams.toString() ? '?' + replayParams : ''}`;
    console.log(`[clinky] replay ${sessionId}${speed != null ? ` @ ${speed}×` : ''}`);
  } else {
    const apiParams = new URLSearchParams({ prompt, mode });
    for (const key of ['agent', 'model', 'effort', 'narrate', 'record']) {
      const v = pageParams.get(key);
      if (v !== null) apiParams.set(key, v);
    }
    esUrl = `/api/think?${apiParams}`;
  }
  const es = new EventSource(esUrl);
  let done = false;
  let nodeCount = 0;

  const stagger = Number(nodeStagger) || 0;
  let lastDispatch = 0;
  const queue = [];
  let timer = null;
  function dispatchNext() {
    timer = null;
    if (queue.length === 0) return;
    const node = queue.shift();
    lastDispatch = performance.now();
    nodeCount++;
    console.log(`[clinky] node ${nodeCount} at +${((performance.now()-t0)/1000).toFixed(1)}s`);
    onNode && onNode(node);
    if (queue.length > 0) timer = setTimeout(dispatchNext, stagger);
  }

  es.addEventListener('topics', e => onTopics && onTopics(JSON.parse(e.data)));
  es.addEventListener('node', e => {
    const node = JSON.parse(e.data);
    if (stagger <= 0) {
      nodeCount++;
      console.log(`[clinky] node ${nodeCount} at +${((performance.now()-t0)/1000).toFixed(1)}s`);
      onNode && onNode(node);
      return;
    }
    queue.push(node);
    if (!timer) {
      const since = performance.now() - lastDispatch;
      const wait = Math.max(0, stagger - since);
      if (wait === 0) dispatchNext();
      else timer = setTimeout(dispatchNext, wait);
    }
  });
  es.addEventListener('status', e => {
    console.log(`[clinky] status at +${((performance.now()-t0)/1000).toFixed(1)}s:`, e.data);
    onStatus && onStatus(JSON.parse(e.data));
    onThinking && onThinking();
  });
  es.addEventListener('batch', e => {
    const data = JSON.parse(e.data);
    onBatch && onBatch(data);
    for (const fn of _batchHandlers) { try { fn(data); } catch (err) { console.error('[clinky] batch handler error', err); } }
  });
  es.addEventListener('graph', e => {
    const data = JSON.parse(e.data);
    onGraph && onGraph(data);
    for (const fn of _graphHandlers) { try { fn(data); } catch (err) { console.error('[clinky] graph handler error', err); } }
  });
  es.addEventListener('usage', e => {
    const data = JSON.parse(e.data);
    onUsageCb && onUsageCb(data);
    for (const fn of _usageHandlers) { try { fn(data); } catch (err) { console.error('[clinky] usage handler error', err); } }
  });
  es.addEventListener('error', e => {
    if (e.data) {
      done = true;  // suppress onerror — it fires for the same event and would overwrite the real message
      try { onError && onError(JSON.parse(e.data)); } catch { onError && onError({}); }
    }
  });
  function flushAndDone() {
    while (queue.length > 0) {
      const node = queue.shift();
      nodeCount++;
      onNode && onNode(node);
    }
    if (timer) { clearTimeout(timer); timer = null; }
  }
  es.addEventListener('done', () => { done = true; flushAndDone(); console.log(`[clinky] done at +${((performance.now()-t0)/1000).toFixed(1)}s — ${nodeCount} nodes`); onDone && onDone(); es.close(); });
  es.onerror = () => {
    if (!done) {
      done = true;
      es.close();
      // Network-level error (dropped connection, server crash) — surface it so
      // the UI transitions out of the streaming state instead of hanging.
      onError && onError({ error: 'connection lost' });
      onDone  && onDone();
    }
  };
  return { close: () => { done = true; if (timer) { clearTimeout(timer); timer = null; } queue.length = 0; es.close(); } };
}

// ============================================================================
// Sound — module-level state, auto-syncs synth.js
// ============================================================================
let audioCtx = null;
let soundOn = false;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function playTone(freq, dur, type, vol) {
  if (!soundOn) return;
  const ctx = getAudio();
  const now = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  g.connect(ctx.destination);
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  o.start(now);
  o.stop(now + dur + 0.05);
}

const TYPE_SOUNDS = {
  claim:      (n) => playTone(n, 0.25, 'sine', 0.1),
  branch:     (n) => { playTone(n, 0.3, 'sine', 0.08); playTone(n * 1.25, 0.25, 'sine', 0.06); },
  choice:     (n) => playTone(n, 0.4, 'triangle', 0.12),
  'dead-end': (n) => { playTone(n, 0.15, 'triangle', 0.08); setTimeout(() => playTone(n * 0.75, 0.3, 'triangle', 0.06), 100); },
  aside:      (n) => playTone(n * 1.5, 0.2, 'sine', 0.05),
  resolution: (n) => { playTone(n, 0.6, 'sine', 0.06); playTone(n*1.25, 0.5, 'sine', 0.05); playTone(n*1.5, 0.4, 'sine', 0.04); },
};

export function playNodeSound(type, noteFreq) {
  const fn = TYPE_SOUNDS[type];
  if (fn) fn(noteFreq || 440);
}

export function setSoundOn(v) {
  soundOn = v;
  setSynthEnabled(v);
  setMasterGain(v ? 1.0 : 0);
}
export function isSoundOn() { return soundOn; }
// match synth state to shared sound state on first import (safe — no AudioContext yet)
setSynthEnabled(false);

// ============================================================================
// Tooltip
// ============================================================================
let tooltipEl = null;
function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'fl-tooltip';
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

export function showTooltip(e, node, _topicColor) {
  const tip = ensureTooltip();
  // Build tooltip via DOM API — never via innerHTML — to prevent XSS from model-emitted text
  tip.textContent = '';
  const topic = document.createElement('span'); topic.className = 'tt-topic'; topic.textContent = node.topic ?? '';
  const type  = document.createElement('span'); type.className  = 'tt-type';  type.textContent = node.type ?? '';
  const br1   = document.createElement('br');
  const text  = document.createElement('span'); text.className  = 'tt-text';  text.textContent = node.text ?? '';
  tip.append(topic, ' ', type, br1, text);
  if (node.confidence != null) {
    const br2  = document.createElement('br');
    const meta = document.createElement('span'); meta.className = 'tt-meta'; meta.textContent = `confidence ${Math.round(node.confidence * 100)}%`;
    tip.append(br2, meta);
  }
  tip.style.opacity = '1';
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  requestAnimationFrame(() => {
    const rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 10) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 10) y = e.clientY - rect.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
}

export function hideTooltip() {
  if (tooltipEl) tooltipEl.style.opacity = '0';
}

// ============================================================================
// Thinking pulse — animation while waiting for nodes
// ============================================================================
export function createThinkingPulse(canvas, ctx, opts = {}) {
  const color = opts.color || '#e63946';
  const bg = opts.bg || null;
  const drawFn = opts.drawFn || null;
  let active = false;
  let startT = 0;
  let firstRun = true;

  function tick() {
    if (!active) return;
    const t = (performance.now() - startT) / 1000;
    if (bg && firstRun) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (drawFn) drawFn(ctx, canvas, t, color);
    else defaultPulse(ctx, canvas, t, color);
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  return {
    start(isEmpty) { active = true; firstRun = !!isEmpty; startT = performance.now(); tick(); },
    stop() { active = false; },
  };
}

function defaultPulse(ctx, canvas, t, color) {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  for (let i = 0; i < 3; i++) {
    const phase = t * 1.5 + i * 0.7;
    const r = 8 + Math.sin(phase) * 4 + i * 18;
    ctx.strokeStyle = color;
    ctx.globalAlpha = Math.max(0, 0.15 - i * 0.04 + Math.sin(phase) * 0.05);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 0.4 + Math.sin(t * 2) * 0.3;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
}

// ============================================================================
// Icon SVGs (stroke-based, currentColor, 16×16 viewBox)
// Exported so Essay can reuse IC_READ.
// ============================================================================
const _ic = (body, extra = '') =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra} style="width:14px;height:14px;display:block">${body}</svg>`;
export const IC_STOP    = _ic('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>');
export const IC_PAUSE   = _ic('<rect x="3" y="3" width="3.5" height="10" rx="1" fill="currentColor" stroke="none"/><rect x="9.5" y="3" width="3.5" height="10" rx="1" fill="currentColor" stroke="none"/>');
export const IC_PLAY    = _ic('<path d="M5 3l8 5-8 5V3z" fill="currentColor" stroke="none"/>');
export const IC_SPIN    = _ic('<circle cx="8" cy="8" r="5" stroke-dasharray="8 24"/>');
export const IC_SOUND0  = _ic('<path d="M3 6h2l4-3v10l-4-3H3V6z" fill="currentColor" stroke="none"/><line x1="11.5" y1="5.5" x2="14.5" y2="10.5"/><line x1="14.5" y1="5.5" x2="11.5" y2="10.5"/>');
export const IC_SOUND1  = _ic('<path d="M3 6h2l4-3v10l-4-3H3V6z" fill="currentColor" stroke="none"/><path d="M12 5.5a3.5 3.5 0 010 5"/>');
export const IC_SAVE    = _ic('<line x1="8" y1="2" x2="8" y2="10"/><polyline points="5,7 8,10 11,7"/><line x1="3" y1="13.5" x2="13" y2="13.5"/>');
export const IC_REFRESH = _ic('<path d="M13.5 8a5.5 5.5 0 10-1.1 3.3"/><polyline points="12,14 13.5,11.3 10.5,10.5"/>');
export const IC_READ    = _ic('<rect x="3" y="2" width="10" height="12" rx="1.5"/><line x1="5.5" y1="5.5" x2="10.5" y2="5.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="10.5" x2="8.5" y2="10.5"/>');

// ============================================================================
// Subword splitter — BPE-mimic via common English morpheme boundaries.
// Used by the counter ticker to display fragments that look like a real
// LLM tokenizer's pieces, not arbitrary character cuts.
// ============================================================================
const _PREFIXES = ['inter', 'super', 'over', 'under', 'anti', 'non', 'pre', 'mis', 'dis', 'un', 're'];
const _SUFFIXES = ['ation', 'ition', 'ement', 'ility', 'tion', 'sion', 'ment', 'ness', 'able', 'ible', 'ity', 'ing', 'ies', 'ied', 'ous', 'ish', 'ize', 'ise', 'ers', 'est', 'ly', 'ed', 'er', 'al'];

// Meta-thinking words interleaved into the counter ticker during the wait.
// The user sees their prompt fragments AND the model's "in-progress" labels,
// shuffled together — gives the wait a feeling of activity even though no
// data is arriving yet.
const _THINKING_WORDS = [
  'thinking', 'pondering', 'wondering', 'researching', 'analysing',
  'reasoning', 'considering', 'contemplating', 'weighing', 'examining',
  'exploring', 'reflecting', 'mulling', 'musing', 'deliberating',
  'processing', 'mapping', 'tracing', 'unpacking', 'turning',
];

function subwordSplit(word) {
  if (word.length <= 4) return [word];
  const pieces = [];
  let stem = word;

  // Try to peel a prefix — only if remaining stem is at least 3 chars
  for (const pre of _PREFIXES) {
    if (stem.toLowerCase().startsWith(pre) && stem.length - pre.length >= 3) {
      pieces.push(stem.slice(0, pre.length));
      stem = stem.slice(pre.length);
      break;
    }
  }

  // Try to peel a suffix — only if remaining stem is at least 3 chars
  let suffix = null;
  for (const suf of _SUFFIXES) {
    if (stem.toLowerCase().endsWith(suf) && stem.length - suf.length >= 3) {
      suffix = stem.slice(stem.length - suf.length);
      stem = stem.slice(0, stem.length - suf.length);
      break;
    }
  }

  pieces.push(stem);
  if (suffix) pieces.push(suffix);
  return pieces;
}

// ============================================================================
// The Clinky class — the framework's main mounting class. Owns the prompt
// pill, mini-controls, node counter, topic legend, and lifecycle events.
// ============================================================================
export class Clinky extends EventTarget {
  // DOM refs
  #pill; #counter; #legend; #promptEl; #errorBanner; #errorMsg;
  #btnThink; #btnStop; #btnPause; #btnSound; #btnSave; #btnClear;

  // state
  #getCount;
  #paused = false;
  #prevState = 'idle';
  #highlightTopic = null;
  #onLegendHover = null;

  // counter meta — populated by modes via updateCounter({...}) and consumed by #counterText
  #meta = {};
  #sessionStart = null;
  #counterReleaseTimer = null;

  // listener registries
  #pauseListeners = [];
  #resumeListeners = [];
  #sessionStartHandlers = [];
  #sessionEndHandlers = [];
  #clearFn = null;

  constructor(getCount = () => 0) {
    super();
    this.#getCount = getCount;
    this.#injectDOM();
    this.#captureRefs();
    this.#detectCanvasBrightness();
    this.#wireFade();
    this.#wireHeaderHide();
    this.#wireSoundButton();
    this.#wireSaveButton();
    this.#wirePauseButton();
  }

  // ────────── public surface ──────────

  prompt() { return this.#promptEl.value; }

  isPaused() { return this.#paused; }

  setState(s) {
    this.#btnStop.disabled  = (s === 'idle' || s === 'done');
    this.#btnPause.disabled = (s === 'idle' || s === 'thinking');
    this.#pill.classList.toggle('thinking', s === 'thinking' || s === 'streaming');
    this.#btnThink.classList.toggle('spinning', s === 'thinking');
    this.#btnThink.innerHTML = s === 'thinking' ? IC_SPIN : IC_PLAY;
    this.#btnThink.classList.toggle('hidden', s === 'streaming');
    this.#counter.classList.toggle('active', s !== 'idle');

    // Clear error banner when a new session starts
    if (s === 'thinking') this.#errorBanner.classList.remove('visible');

    // Session timing — start at thinking, capture duration at done
    if (s === 'thinking') {
      this.#sessionStart = performance.now();
      this.#meta = {};                     // reset meta for new session
    } else if (s === 'done' && this.#sessionStart != null) {
      this.#meta.durationMs = performance.now() - this.#sessionStart;
    }

    // Counter visibility — pinned during active session, released 5s after done
    // so it fades and hides with the rest of the header chrome on cursor-away.
    if (s === 'thinking' || s === 'streaming') {
      clearTimeout(this.#counterReleaseTimer);
      document.body.classList.add('fl-counter-pinned');
    } else if (s === 'done') {
      clearTimeout(this.#counterReleaseTimer);
      this.#counterReleaseTimer = setTimeout(
        () => document.body.classList.remove('fl-counter-pinned'),
        5000
      );
    }

    this.#counter.textContent = this.#counterText(s);

    // Counter ticker — runs during thinking AND streaming (slower) to keep
    // the counter alive between batches. Stops on done/idle.
    if (s === 'thinking') this.#startCounterTicker('thinking');
    else if (s === 'streaming') this.#startCounterTicker('streaming');
    else this.#stopCounterTicker();

    this.#showChromeEls();
    if (s === 'done' && this.#prevState !== 'done') this.#fireSessionEnd();
    this.#prevState = s;
  }

  showError(err) {
    const msg = (err && err.error) ? err.error : 'something went wrong';
    this.#errorMsg.textContent = msg.slice(0, 200);
    this.#errorBanner.classList.add('visible');
  }

  // Modes call updateCounter() (no args) on every node arrival, OR
  // updateCounter({topic, topicCount, pivotCount}) to enrich the counter
  // text with live/closing metadata. Object is merged into internal #meta.
  updateCounter(meta) {
    if (meta && typeof meta === 'object') Object.assign(this.#meta, meta);
    this.#counter.textContent = this.#counterText(this.#prevState);
  }

  updateLegend(topics, items) {
    this.#legend.innerHTML = topics.map(t => {
      const count = items.filter(i => (i.node || i).topic === t.id).length;
      if (count === 0) return '';     // skip empty topics — avoids race-flicker between topic event + first node
      // Escape label; validate color to a safe hex/named value before CSS injection
      const safeLabel = String(t.label ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
      const safeColor = /^#[0-9a-f]{3,8}$/i.test(t.color) ? t.color : '#888';
      return `<div class="legend-item" data-topic="${safeLabel}"><span>${safeLabel}</span><span class="legend-count">${count}</span><div class="legend-dot" style="background:${safeColor}"></div></div>`;
    }).join('');
    this.#legend.querySelectorAll('.legend-item').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const tid = el.dataset.topic;
        this.#highlightTopic = tid;
        this.#legend.querySelectorAll('.legend-item').forEach(li => {
          li.style.opacity = li.dataset.topic === tid ? '1' : '0.3';
        });
        if (this.#onLegendHover) this.#onLegendHover(tid);
      });
      el.addEventListener('mouseleave', () => {
        this.#highlightTopic = null;
        this.#legend.querySelectorAll('.legend-item').forEach(li => { li.style.opacity = ''; });
        if (this.#onLegendHover) this.#onLegendHover(null);
      });
    });
  }

  highlightLegendTopic(topicId) {
    this.#legend.querySelectorAll('.legend-item').forEach(li => {
      const match = topicId && li.dataset.topic === topicId;
      li.classList.toggle('legend-active', !!match);
      li.style.opacity = topicId ? (match ? '' : '0.15') : '';
    });
  }

  get highlightedTopic() { return this.#highlightTopic; }

  onLegendHover(fn) { this.#onLegendHover = fn; }

  // ────────── lifecycle events ──────────

  onSessionStart(fn) { this.#sessionStartHandlers.push(fn); }
  onSessionEnd(fn)   { this.#sessionEndHandlers.push(fn); }

  onGo(fn) {
    const wrapped = (...args) => {
      // Empty prompt: don't fire session start — server would 400 and the user
      // would see a silent flash. Focus the input instead so the cursor lands
      // where they need to type.
      if (!this.#promptEl.value.trim()) {
        this.#promptEl.focus();
        return;
      }
      this.#enableHeaderHide();
      this.#fireSessionStart();
      return fn(...args);
    };
    this.#btnThink.addEventListener('click', wrapped);
    this.#promptEl.addEventListener('keydown', e => { if (e.key === 'Enter') wrapped(); });
    // Auto-fire replay on ?session=<id>
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('session');
    if (sid) {
      fetch('/api/sessions')
        .then(r => r.json())
        .then(list => {
          const s = list.find(x => x.id === sid);
          if (s?.prompt) this.#promptEl.value = s.prompt;
        })
        .catch(() => {})
        .finally(() => setTimeout(wrapped, 150));
    }
  }

  onStop(fn) { this.#btnStop.addEventListener('click', fn); }

  onPause(fn) {
    // legacy signature: fires fn(true) on pause, fn(false) on resume
    this.#pauseListeners.push(() => fn(true));
    this.#resumeListeners.push(() => fn(false));
  }

  onResume(fn) { this.#resumeListeners.push(fn); }

  onClear(fn) {
    this.#clearFn = fn;
    this.#btnClear.addEventListener('click', fn);
  }

  // ────────── streaming ──────────

  think(prompt, opts) {
    return startStream(prompt, opts);
  }

  // ────────── sub-factory ──────────

  essay(opts) {
    return new Essay({ ...opts, app: this });
  }

  // ────────── private helpers ──────────

  #injectDOM() {
    const html = `
      <div class="node-counter chrome" id="fl-counter"></div>
      <div class="mini-controls chrome" id="fl-mini">
        <button id="fl-stop" title="stop" aria-label="stop" disabled>${IC_STOP}</button>
        <button id="fl-pause" title="pause" aria-label="pause" disabled>${IC_PAUSE}</button>
        <div class="sep"></div>
        <button id="fl-sound" title="sound" aria-label="toggle sound">${IC_SOUND0}</button>
        <button id="fl-save" title="save png" aria-label="save as PNG">${IC_SAVE}</button>
        <button id="fl-clear" title="refresh" aria-label="clear canvas">${IC_REFRESH}</button>
      </div>
      <div class="prompt-pill chrome" id="fl-pill">
        <input id="fl-prompt" type="text" placeholder="ask anything…" />
        <button class="think-btn" id="fl-think" aria-label="think">${IC_PLAY}</button>
      </div>
      <div class="topic-legend chrome" id="fl-legend"></div>
      <div class="fl-error-banner" id="fl-error">
        <span class="fl-error-msg" id="fl-error-msg"></span>
        <button class="fl-error-dismiss" id="fl-error-dismiss" aria-label="dismiss">×</button>
      </div>
    `;
    const frag = document.createRange().createContextualFragment(html);
    document.body.appendChild(frag);
  }

  #captureRefs() {
    const $ = id => document.getElementById(id);
    this.#pill     = $('fl-pill');
    this.#counter  = $('fl-counter');
    this.#legend   = $('fl-legend');
    this.#btnThink = $('fl-think');
    this.#btnStop  = $('fl-stop');
    this.#btnPause = $('fl-pause');
    this.#btnSound = $('fl-sound');
    this.#btnSave  = $('fl-save');
    this.#btnClear   = $('fl-clear');
    this.#promptEl   = $('fl-prompt');
    this.#errorBanner = $('fl-error');
    this.#errorMsg    = $('fl-error-msg');
    $('fl-error-dismiss').addEventListener('click', () => this.#errorBanner.classList.remove('visible'));
  }

  #detectCanvasBrightness() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg && bg.match(/\d+(?:\.\d+)?/g);
    if (!m || m.length < 3) return;
    const [r, g, b] = m.slice(0, 3).map(Number);
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (luma > 0.55) document.body.classList.add('fl-canvas-light');
  }

  #fadeTimer = null;
  #wireFade() {
    const chromeEls = document.querySelectorAll('.chrome');
    const showChromeEls = () => {
      chromeEls.forEach(el => el.classList.remove('faded'));
      clearTimeout(this.#fadeTimer);
      this.#fadeTimer = setTimeout(() => {
        if (document.activeElement === this.#promptEl || this.#getCount() === 0) return;
        chromeEls.forEach(el => el.classList.add('faded'));
      }, 3500);
    };
    document.addEventListener('mousemove', showChromeEls);
    document.addEventListener('keydown', showChromeEls);
    showChromeEls();
    this.#showChromeEls = showChromeEls;  // capture for setState use
  }
  #showChromeEls = () => {};   // replaced by #wireFade

  #headerHideEnabled = false;
  #headerHideTimer = null;
  #wireHeaderHide() {
    const HEADER_REVEAL_PX = 110;
    const HEADER_HIDE_DELAY = 600;

    const revealHeader = () => {
      clearTimeout(this.#headerHideTimer);
      this.#headerHideTimer = null;
      document.body.classList.remove('fl-header-hidden');
    };
    const scheduleHideHeader = () => {
      if (!this.#headerHideEnabled) return;
      if (document.activeElement === this.#promptEl) return;
      if (this.#headerHideTimer) return;
      this.#headerHideTimer = setTimeout(() => {
        if (document.activeElement === this.#promptEl) return;
        document.body.classList.add('fl-header-hidden');
        this.#headerHideTimer = null;
      }, HEADER_HIDE_DELAY);
    };

    document.addEventListener('mousemove', (e) => {
      if (e.clientY < HEADER_REVEAL_PX) revealHeader();
      else if (!document.body.classList.contains('fl-header-hidden')) scheduleHideHeader();
    });
    [this.#pill, document.getElementById('fl-mini'), this.#counter].forEach(el => {
      if (!el) return;
      el.addEventListener('mouseenter', revealHeader);
    });
    this.#promptEl.addEventListener('focus', revealHeader);
    this.#promptEl.addEventListener('blur', scheduleHideHeader);
  }
  #enableHeaderHide() {
    if (this.#headerHideEnabled) return;
    this.#headerHideEnabled = true;
    // schedule first hide
    if (document.activeElement !== this.#promptEl && !this.#headerHideTimer) {
      this.#headerHideTimer = setTimeout(() => {
        if (document.activeElement === this.#promptEl) return;
        document.body.classList.add('fl-header-hidden');
        this.#headerHideTimer = null;
      }, 600);
    }
  }

  #wireSoundButton() {
    this.#btnSound.addEventListener('click', () => {
      setSoundOn(!isSoundOn());
      this.#btnSound.innerHTML = isSoundOn() ? IC_SOUND1 : IC_SOUND0;
      this.#btnSound.classList.toggle('active', isSoundOn());
    });
  }

  #wireSaveButton() {
    this.#btnSave.addEventListener('click', () => {
      const src = document.getElementById('canvas');
      if (!src) return;
      const scale = 2;
      const light = document.body.classList.contains('fl-canvas-light');
      const prompt = this.#promptEl.value || '';
      const now = new Date();
      const dt = now.toISOString().slice(0, 16).replace('T', ' ');

      const tmpC = document.createElement('canvas');
      const tmpX = tmpC.getContext('2d');
      const fontSize = 13 * scale;
      const pad = 20 * scale;
      const maxW = src.width * scale - pad * 2;
      tmpX.font = `400 ${fontSize}px 'Space Grotesk', sans-serif`;
      const words = prompt.split(' ');
      const lines = [];
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (tmpX.measureText(test).width > maxW && line) { lines.push(line); line = w; }
        else line = test;
      }
      if (line) lines.push(line);

      const lineH = fontSize * 1.5;
      const dtH = 11 * scale * 1.5;

      const off = document.createElement('canvas');
      off.width = src.width * scale;
      off.height = src.height * scale;
      const ctx2 = off.getContext('2d');
      ctx2.drawImage(src, 0, 0, off.width, off.height);

      const textColor = light ? 'rgba(26,26,26,0.85)' : 'rgba(240,236,228,0.85)';
      const muteColor = light ? 'rgba(26,26,26,0.45)' : 'rgba(240,236,228,0.45)';
      const bottomY = off.height - pad;
      const totalTextH = lines.length * lineH + (prompt ? 6 * scale : 0) + dtH;
      const startY = bottomY - totalTextH;

      ctx2.textBaseline = 'top';
      ctx2.font = `400 ${fontSize}px 'Space Grotesk', sans-serif`;
      ctx2.fillStyle = textColor;
      lines.forEach((l, i) => ctx2.fillText(l, pad, startY + i * lineH));

      ctx2.font = `400 ${11 * scale}px 'Space Grotesk', sans-serif`;
      ctx2.fillStyle = muteColor;
      ctx2.fillText(dt, pad, startY + lines.length * lineH + 6 * scale);

      off.toBlob(blob => {
        const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'clinky';
        const ts = now.toISOString().replace('T', '-').slice(0, 19).replace(/:/g, '');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `clinky-${slug}-${ts}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, 'image/png');
    });
  }

  #wirePauseButton() {
    this.#btnPause.addEventListener('click', () => {
      this.#paused = !this.#paused;
      this.#btnPause.innerHTML = this.#paused ? IC_PLAY : IC_PAUSE;
      this.#btnPause.title = this.#paused ? 'resume' : 'pause';
      this.#btnPause.setAttribute('aria-label', this.#paused ? 'resume' : 'pause');
      this.#btnPause.classList.toggle('active', this.#paused);
      if (this.#paused) for (const fn of this.#pauseListeners) fn();
      else for (const fn of this.#resumeListeners) fn();
    });
  }

  #fireSessionStart() {
    if (this.#clearFn) { try { this.#clearFn(); } catch (e) { console.warn('[clinky] clear error', e); } }
    for (const fn of this.#sessionStartHandlers) {
      try { fn(); } catch (e) { console.warn('[clinky] sessionStart handler error', e); }
    }
  }
  #fireSessionEnd() {
    for (const fn of this.#sessionEndHandlers) {
      try { fn(); } catch (e) { console.warn('[clinky] sessionEnd handler error', e); }
    }
  }

  #counterText(s) {
    if (s === 'thinking') return 'thinking…';
    const n = this.#getCount();
    const meta = this.#meta || {};
    if (s === 'streaming') {
      return `${n} ${n === 1 ? 'thought' : 'thoughts'}`;
    }
    if (s === 'done') {
      // closing summary — done · N thoughts · duration · topic count · pivots (if any)
      const parts = ['done', `${n} ${n === 1 ? 'thought' : 'thoughts'}`];
      if (meta.durationMs != null) parts.push(`${Math.round(meta.durationMs / 1000)}s`);
      if (meta.topicCount) parts.push(`${meta.topicCount} topics`);
      if (meta.pivotCount) parts.push(`${meta.pivotCount}★`);
      return parts.join(' · ');
    }
    return '';
  }

  #tickerTimer = null;
  #startCounterTicker(state = 'thinking') {
    this.#stopCounterTicker();
    const prompt = this.#promptEl.value || '';
    const words = prompt.split(/\s+/)
      .map(w => w.replace(/[^a-z0-9]/gi, ''))
      .filter(w => w.length >= 3);

    // Pre-split each word into subword pieces (BPE-mimic via morpheme rules).
    const pieces = [];
    for (const w of words) pieces.push(...subwordSplit(w));

    const tick = () => {
      let frag;
      if (state === 'streaming') {
        // During streaming: alternate between live count and thinking words.
        // Each tick fires only if no node arrives in the gap (setState resets
        // the timer on each arrival), so this renders only during inter-batch silences.
        const n = this.#getCount();
        const countText = `${n} ${n === 1 ? 'thought' : 'thoughts'}`;
        // 50/50 between count display and meta-thinking verb
        if (Math.random() < 0.5) {
          frag = countText;
        } else {
          frag = _THINKING_WORDS[Math.floor(Math.random() * _THINKING_WORDS.length)];
        }
      } else {
        // During thinking (pre-first-node): mix prompt fragments + thinking verbs
        const useThinking = pieces.length === 0 || Math.random() < 0.45;
        if (useThinking) {
          frag = _THINKING_WORDS[Math.floor(Math.random() * _THINKING_WORDS.length)];
        } else {
          frag = pieces[Math.floor(Math.random() * pieces.length)];
          if (Math.random() < 0.5) {
            const arr = frag.split('');
            for (let i = arr.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            frag = arr.join('');
          }
        }
      }
      this.#counter.textContent = frag;
    };

    // Streaming ticks slowly (between-batch transitions), thinking ticks faster (active pre-stream)
    const interval = state === 'streaming' ? 1800 : 450;
    tick();
    this.#tickerTimer = setInterval(tick, interval);
  }
  #stopCounterTicker() {
    if (this.#tickerTimer) {
      clearInterval(this.#tickerTimer);
      this.#tickerTimer = null;
    }
  }
}

// ============================================================================
// graph + palette + glyph utilities
// ============================================================================

export function nodeBy(id, nodes) {
  if (id == null || !Array.isArray(nodes)) return null;
  for (const n of nodes) if (n && n.id === id) return n;
  return null;
}

export function refsFrom(node, nodes) {
  if (!node || !Array.isArray(node.refs) || !Array.isArray(nodes)) return [];
  const out = [];
  for (const id of node.refs) {
    const n = nodeBy(id, nodes);
    if (n) out.push(n);
  }
  return out;
}

export function incomingRefsOf(id, nodes) {
  if (id == null || !Array.isArray(nodes)) return 0;
  let count = 0;
  for (const n of nodes) {
    if (n && Array.isArray(n.refs) && n.refs.includes(id)) count++;
  }
  return count;
}

const REL_COLORS = {
  supports:    '#2a9d8f',
  contradicts: '#e63946',
  synthesizes: '#f4a261',
  refines:     '#8ecae6',
  questions:   '#9656a2',
  supersedes:  '#6c757d',
};
export function relColor(rel) {
  return REL_COLORS[rel] || '#8a8a8a';
}

export function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

const STANCE_GLYPHS = {
  claiming:    '●',
  exploring:   '○',
  questioning: '?',
  conceding:   '·',
};
export function stanceGlyph(stance) {
  return STANCE_GLYPHS[stance] || '';
}

const REL_GLYPHS = {
  supports:    '+',
  contradicts: '×',
  synthesizes: '✦',
  refines:     '~',
  questions:   '?',
  supersedes:  '▶',
};
export function relGlyph(rel) {
  return REL_GLYPHS[rel] || '';
}

export function sessionColophon(usage) {
  if (!usage) return '';
  const parts = [];
  if (usage.duration_ms != null) parts.push(`${(usage.duration_ms / 1000).toFixed(1)}s`);
  if (usage.input_tokens != null || usage.output_tokens != null) {
    parts.push(`${usage.input_tokens ?? '?'} in / ${usage.output_tokens ?? '?'} out`);
  }
  if (usage.cache_read_tokens != null && usage.cache_read_tokens > 0) {
    parts.push(`${usage.cache_read_tokens} cached`);
  }
  if (usage.total_cost_usd != null) parts.push(`$${usage.total_cost_usd.toFixed(4)}`);
  if (usage.stop_reason) parts.push(usage.stop_reason);
  return parts.join(' · ');
}

// ============================================================================
// Default export — the factory
// ============================================================================
export default function clinky(getCount) {
  return new Clinky(getCount);
}

// Re-export Essay for advanced use
export { Essay };
