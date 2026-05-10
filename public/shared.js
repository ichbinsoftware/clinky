// clinky/public/shared.js — backwards-compat shim. Re-exports the new clinky.js

// the migration. Will be removed once all modes are converted.
//
// New code should import from /clinky.js directly.

import clinky, {
  Clinky,
  Essay,
  // pub/sub
  onGraphComplete,
  onBatchStart,
  onUsage,
  // streaming
  startStream,
  // sound
  playTone,
  playNodeSound,
  setSoundOn,
  isSoundOn,
  // tooltip
  showTooltip,
  hideTooltip,
  // pulse
  createThinkingPulse,
  // graph utils
  nodeBy,
  refsFrom,
  incomingRefsOf,
  // palette + glyphs
  relColor,
  hexToRgb,
  stanceGlyph,
  relGlyph,
  // export
  sessionColophon,
} from '/clinky.js';

// re-export everything that didn't change name
export {
  onGraphComplete,
  onBatchStart,
  onUsage,
  playTone,
  playNodeSound,
  setSoundOn,
  isSoundOn,
  showTooltip,
  hideTooltip,
  createThinkingPulse,
  nodeBy,
  refsFrom,
  incomingRefsOf,
  relColor,
  hexToRgb,
  stanceGlyph,
  relGlyph,
  sessionColophon,
};

// startThinking → startStream (renamed but signature preserved)
export const startThinking = startStream;

// mountChrome → clinky() (factory wraps the new class)
export function mountChrome(getCount = () => 0) {
  return clinky(getCount);
}

// mountEssay({chrome, ...}) → app.essay({...})
// Old call sites pass `chrome` as the app handle; route it through.
export function mountEssay({ chrome, ...opts }) {
  if (!chrome || typeof chrome.essay !== 'function') {
    console.warn('[clinky] mountEssay: missing chrome arg or app.essay() not available');
    return null;
  }
  return chrome.essay(opts);
}

// mountControls — legacy old-bar style controls (rarely used, kept for safety)
export function mountControls(mount) {
  mount.innerHTML = `
    <input id="fl-prompt" type="text" placeholder="ask anything…" style="font-family:'Space Grotesk',sans-serif;font-size:1rem;padding:0.6rem 1rem;border:1.5px solid #0a0a0a;background:#fff;flex:1;min-width:300px" />
    <button id="fl-go" style="background:#0a0a0a;color:#f5f1e8;border:1.5px solid #0a0a0a;font-family:'Space Grotesk',sans-serif;font-weight:500;font-size:0.9rem;padding:0.6rem 1.5rem;cursor:pointer;text-transform:lowercase">think</button>
    <button id="fl-sound" style="background:#f5f1e8;color:#0a0a0a;border:1.5px solid #0a0a0a;font-family:'Space Grotesk',sans-serif;font-size:0.85rem;padding:0.6rem 1rem;cursor:pointer;text-transform:lowercase">sound off</button>
    <button id="fl-stop" style="background:#f5f1e8;color:#0a0a0a;border:1.5px solid #0a0a0a;font-family:'Space Grotesk',sans-serif;font-size:0.85rem;padding:0.6rem 1rem;cursor:pointer;text-transform:lowercase">stop</button>
    <button id="fl-pause" style="background:#f5f1e8;color:#0a0a0a;border:1.5px solid #0a0a0a;font-family:'Space Grotesk',sans-serif;font-size:0.85rem;padding:0.6rem 1rem;cursor:pointer;text-transform:lowercase">pause</button>
    <button id="fl-clear" style="background:#f5f1e8;color:#0a0a0a;border:1.5px solid #0a0a0a;font-family:'Space Grotesk',sans-serif;font-size:0.85rem;padding:0.6rem 1rem;cursor:pointer;text-transform:lowercase">clear</button>
    <span id="fl-status" style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:#777;margin-left:0.5rem">idle</span>
  `;
  const $ = id => mount.querySelector('#' + id);
  $('fl-sound').addEventListener('click', () => {
    setSoundOn(!isSoundOn());
    $('fl-sound').textContent = isSoundOn() ? 'sound on' : 'sound off';
    $('fl-sound').style.background = isSoundOn() ? '#ffd60a' : '#f5f1e8';
  });
  return {
    prompt: () => $('fl-prompt').value,
    onGo(fn) {
      const handler = () => { $('fl-go').textContent = 'thinking…'; $('fl-go').style.opacity = '0.6'; fn(); };
      $('fl-go').addEventListener('click', handler);
      $('fl-prompt').addEventListener('keydown', e => { if (e.key === 'Enter') handler(); });
    },
    resetButton() { const b = document.getElementById('fl-go'); if (b) { b.textContent = 'think'; b.style.opacity = '1'; } },
    onStop(fn) { $('fl-stop').addEventListener('click', fn); },
    onPause(fn) {
      let paused = false;
      $('fl-pause').addEventListener('click', () => {
        paused = !paused;
        $('fl-pause').textContent = paused ? 'resume' : 'pause';
        $('fl-pause').style.background = paused ? '#ffd60a' : '#f5f1e8';
        fn(paused);
      });
    },
    onClear(fn) { $('fl-clear').addEventListener('click', fn); },
    setStatus(t) { $('fl-status').textContent = t; },
  };
}

// Re-export the new class entry too, in case anything migrates ad-hoc
export { clinky as default, Clinky, Essay };
