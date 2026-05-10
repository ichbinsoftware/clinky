// clinky/public/synth.js — standalone ADSR synth for clinky modes.
// No dependencies. Import into any mode: `import { playSynth, playChord, midiToFreq } from './synth.js'`.

let _ctx = null;
let _master = null;
let _reverbBus = null;  // lazy: { input, output, conv, wetGain }
let _delayBus  = null;  // lazy: { input, output, delay, feedback, wetGain }
let _enabled = true;

function ctx() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _master = _ctx.createGain();
    _master.gain.value = 1;
    _master.connect(_ctx.destination);
  }
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

export function setSynthEnabled(v) { _enabled = !!v; }
export function isSynthEnabled()    { return _enabled; }
export function setMasterGain(v)    { ctx(); _master.gain.value = v; }
export function getAudioContext()   { return ctx(); }

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Chord-from-root helper. `intervals` are semitone offsets.
export const CHORDS = {
  MAJ:  [0, 4, 7],
  MIN:  [0, 3, 7],
  MAJ7: [0, 4, 7, 11],
  MIN7: [0, 3, 7, 10],
  DOM7: [0, 4, 7, 10],
  SUS2: [0, 2, 7],
  SUS4: [0, 5, 7],
  DIM:  [0, 3, 6],
  AUG:  [0, 4, 8],
};
export function chordFromRoot(rootMidi, intervals) {
  return intervals.map(i => midiToFreq(rootMidi + i));
}

// --- FX buses (lazy, lifted from evr/workers/app/modules/mixer-audio.js) ---

function _generateIR(c, duration, decay) {
  const length = Math.max(1, Math.floor(c.sampleRate * duration));
  const buffer = c.createBuffer(2, length, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

function _ensureReverbBus() {
  if (_reverbBus) return _reverbBus;
  const c = ctx();
  const input = c.createGain();        input.gain.value = 1;
  const conv  = c.createConvolver();   conv.buffer = _generateIR(c, 1.5, 2);
  const wetGain = c.createGain();      wetGain.gain.value = 1;
  input.connect(conv);
  conv.connect(wetGain);
  wetGain.connect(_master);
  _reverbBus = { input, output: wetGain, conv, wetGain };
  return _reverbBus;
}

function _ensureDelayBus() {
  if (_delayBus) return _delayBus;
  const c = ctx();
  const input = c.createGain();    input.gain.value = 1;
  const delay = c.createDelay(5);  delay.delayTime.value = 0.375;
  const feedback = c.createGain(); feedback.gain.value = 0.35;
  const wetGain = c.createGain();  wetGain.gain.value = 1;
  input.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wetGain);
  wetGain.connect(_master);
  _delayBus = { input, output: wetGain, delay, feedback, wetGain };
  return _delayBus;
}

// Reconfigure the shared reverb. Lazy-creates the bus on first call.
// opts: { duration (s), decay (exp curve), wet (0..1) }
export function configureReverb({ duration, decay, wet } = {}) {
  const bus = _ensureReverbBus();
  if (duration != null || decay != null) {
    bus.conv.buffer = _generateIR(ctx(), duration ?? 1.5, decay ?? 2);
  }
  if (wet != null) bus.wetGain.gain.value = wet;
}

// Reconfigure the shared delay. Lazy-creates the bus on first call.
// opts: { time (s), feedback (0..0.95), wet (0..1) }
export function configureDelay({ time, feedback, wet } = {}) {
  const bus = _ensureDelayBus();
  const now = ctx().currentTime;
  if (time != null)     bus.delay.delayTime.setTargetAtTime(time, now, 0.02);
  if (feedback != null) bus.feedback.gain.setTargetAtTime(Math.min(0.95, feedback), now, 0.02);
  if (wet != null)      bus.wetGain.gain.value = wet;
}

// Wave-shaper curve cache — curves are ~176KB each, so we quantise drive to 0.05
// and reuse. Small price in granularity, big win for rapid voice creation.
const _curveCache = new Map();
function _getDistortionCurve(drive, tone) {
  const dq = Math.round(Math.max(0, Math.min(1, drive)) * 20) / 20;
  const key = `${tone}:${dq}`;
  if (_curveCache.has(key)) return _curveCache.get(key);
  const samples = 44100;
  const curve = new Float32Array(samples);
  const amount = 1 + dq * 50;   // scaled up from mixer's 0.5 — synths need more bite
  const DEG = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    switch (tone) {
      case 'crunch': {
        const k = amount * 50;
        curve[i] = ((3 + k) * x * DEG) / (Math.PI + k * Math.abs(x));
        break;
      }
      case 'fuzz':
        curve[i] = x > 0 ? 1 - Math.exp(-x * amount) : -(1 - Math.exp(x * amount));
        break;
      case 'hard-clip':
        curve[i] = Math.max(-1, Math.min(1, x * amount));
        break;
      case 'warm':
      default:
        curve[i] = Math.tanh(x * amount);
        break;
    }
  }
  _curveCache.set(key, curve);
  return curve;
}

// Inline distortion (wave-shaper with dry/wet mix). Returns { input, output }.
function _buildDistortion(c, { drive = 0.3, tone = 'warm', mix = 1 } = {}) {
  const input  = c.createGain();
  const shaper = c.createWaveShaper();
  const dry    = c.createGain();
  const wet    = c.createGain();
  const output = c.createGain();
  shaper.oversample = '2x';
  shaper.curve = _getDistortionCurve(drive, tone);
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;
  input.connect(dry);  dry.connect(output);
  input.connect(shaper); shaper.connect(wet); wet.connect(output);
  return { input, output };
}

// Inline tremolo (VCA + LFO). Returns { input, output, stop(at) }.
// At depth 0: gain == 1 (pass-through). At depth 1: gain oscillates [0, 1].
function _buildTremolo(c, { rate = 4, depth = 0.5, shape = 'sine' } = {}) {
  const signal = c.createGain();
  signal.gain.value = 0;                         // overridden by bias + LFO
  const bias = c.createConstantSource();
  bias.offset.value = 1 - depth * 0.5;
  bias.connect(signal.gain);
  bias.start();
  const osc = c.createOscillator();
  osc.type = shape;
  osc.frequency.value = rate;
  const depthGain = c.createGain();
  depthGain.gain.value = depth * 0.5;
  osc.connect(depthGain);
  depthGain.connect(signal.gain);
  osc.start();
  return {
    input: signal,
    output: signal,
    stop(at) {
      try { bias.stop(at); } catch {}
      try { osc.stop(at); } catch {}
    },
  };
}

// playSynth — fire one ADSR voice.
//
// opts:
//   freq, midi, wave, attack, decay, sustain, release, duration, vol,
//   voices, detune, filter, filterEnv, when, destination     (as before)
//   distortion   { drive, tone, mix }     wave-shaper inserted after filter
//                                         tone: 'warm'|'crunch'|'fuzz'|'hard-clip'
//   tremolo      { rate, depth, shape }   inserted after distortion
//   pan          -1..1  stereo position, inserted last
//   reverbSend   0..1  send level into shared reverb bus
//   delaySend    0..1  send level into shared delay bus
//
// Returns { stop(at?) } — triggers release early.
export function playSynth(opts = {}) {
  if (!_enabled) return { stop() {} };
  const c = ctx();
  const now = opts.when ?? c.currentTime;

  const freq     = opts.freq ?? (opts.midi != null ? midiToFreq(opts.midi) : 440);
  const attack   = Math.max(0.001, opts.attack  ?? 0.01);
  const decay    = Math.max(0.001, opts.decay   ?? 0.1);
  const sustain  = Math.min(1, Math.max(0, opts.sustain ?? 0.6));
  const release  = Math.max(0.01, opts.release ?? 0.25);
  const duration = Math.max(0, opts.duration ?? 0.3);
  const wave     = opts.wave ?? 'triangle';
  const peak     = opts.vol  ?? 0.15;
  const voices   = Math.max(1, opts.voices ?? 1);
  const detune   = opts.detune ?? 0;
  const dest     = opts.destination || _master;

  // amp envelope
  const amp = c.createGain();
  amp.gain.setValueAtTime(0, now);
  amp.gain.linearRampToValueAtTime(peak, now + attack);
  amp.gain.linearRampToValueAtTime(peak * sustain, now + attack + decay);

  // signal-chain tail: walks forward as we insert nodes
  let tail = amp;

  if (opts.filter) {
    const filter = c.createBiquadFilter();
    filter.type = opts.filter.type || 'lowpass';
    const baseFreq = opts.filter.freq ?? 1200;
    filter.frequency.value = baseFreq;
    filter.Q.value = opts.filter.Q ?? 0.7;
    if (opts.filterEnv) {
      const amt = opts.filterEnv.amount ?? baseFreq;
      const fa  = Math.max(0.001, opts.filterEnv.attack ?? 0.01);
      const fd  = Math.max(0.001, opts.filterEnv.decay  ?? 0.2);
      filter.frequency.setValueAtTime(baseFreq, now);
      filter.frequency.linearRampToValueAtTime(baseFreq + amt, now + fa);
      filter.frequency.linearRampToValueAtTime(baseFreq, now + fa + fd);
    }
    tail.connect(filter);
    tail = filter;
  }

  if (opts.distortion) {
    const dist = _buildDistortion(c, opts.distortion);
    tail.connect(dist.input);
    tail = dist.output;
  }

  let trem = null;
  if (opts.tremolo) {
    trem = _buildTremolo(c, opts.tremolo);
    tail.connect(trem.input);
    tail = trem.output;
  }

  if (opts.pan != null) {
    const panner = c.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
    tail.connect(panner);
    tail = panner;
  }

  // dry path
  tail.connect(dest);

  // sends — tap from tail so tremolo/filter shape the send too
  if (opts.reverbSend > 0) {
    const g = c.createGain();
    g.gain.value = opts.reverbSend;
    tail.connect(g);
    g.connect(_ensureReverbBus().input);
  }
  if (opts.delaySend > 0) {
    const g = c.createGain();
    g.gain.value = opts.delaySend;
    tail.connect(g);
    g.connect(_ensureDelayBus().input);
  }

  // oscillators
  const oscs = [];
  for (let i = 0; i < voices; i++) {
    const o = c.createOscillator();
    o.type = wave;
    o.frequency.value = freq;
    if (voices > 1 && detune !== 0) {
      const spread = detune / 2;
      o.detune.value = -spread + (i / (voices - 1)) * detune;
    }
    o.connect(amp);
    o.start(now);
    oscs.push(o);
  }

  let releaseScheduled = false;
  let stopScheduled = 0;
  function scheduleRelease(at) {
    if (releaseScheduled && at >= stopScheduled) return;
    // Use cancelAndHoldAtTime to preserve the current rendered gain value
    // instead of snapping to peak*sustain (which can be 0 for sustain=0
    // voices like bell, causing an audible click when stolen mid-decay).
    // Falls back to cancel+setValueAtTime for old browsers.
    try {
      if (typeof amp.gain.cancelAndHoldAtTime === 'function') {
        amp.gain.cancelAndHoldAtTime(at);
      } else {
        amp.gain.cancelScheduledValues(at);
        amp.gain.setValueAtTime(peak * sustain, at);
      }
    } catch {}
    amp.gain.linearRampToValueAtTime(0.0001, at + release);
    stopScheduled = at + release + 0.05;
    oscs.forEach(o => { try { o.stop(stopScheduled); } catch {} });
    if (trem) trem.stop(stopScheduled);
    releaseScheduled = true;
  }

  scheduleRelease(now + attack + decay + duration);

  return {
    stop(at) {
      const t = Math.max(c.currentTime, at ?? c.currentTime);
      scheduleRelease(t);
    },
  };
}

// playChord — multiple voices through a shared gain bus so the ADSR shapes the chord as one voice.
// Distortion, tremolo, and sends are applied at the bus (whole chord distorts/wobbles/sends
// together). Panning can be applied per-voice via `panSpread` for stereo width.
//
// freqs: number[] in Hz  (or use `midis: number[]`)
// opts: stagger (ms), chordGain, distortion, tremolo, pan, panSpread (-1..1 total spread
//       across voices, L→R), reverbSend, delaySend, plus anything playSynth accepts.
export function playChord(freqs, opts = {}) {
  if (!_enabled) return { stop() {} };
  const c = ctx();
  const when = opts.when ?? c.currentTime;
  const staggerMs = opts.stagger ?? 0;
  const list = opts.midis ? opts.midis.map(midiToFreq) : freqs;
  const finalDest = opts.destination || _master;

  const bus = c.createGain();
  bus.gain.value = opts.chordGain ?? 0.25;

  let busTail = bus;
  if (opts.distortion) {
    const dist = _buildDistortion(c, opts.distortion);
    busTail.connect(dist.input);
    busTail = dist.output;
  }

  let busTrem = null;
  if (opts.tremolo) {
    busTrem = _buildTremolo(c, opts.tremolo);
    busTail.connect(busTrem.input);
    busTail = busTrem.output;
  }

  if (opts.pan != null) {
    const panner = c.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
    busTail.connect(panner);
    busTail = panner;
  }

  busTail.connect(finalDest);

  if (opts.reverbSend > 0) {
    const g = c.createGain();
    g.gain.value = opts.reverbSend;
    busTail.connect(g);
    g.connect(_ensureReverbBus().input);
  }
  if (opts.delaySend > 0) {
    const g = c.createGain();
    g.gain.value = opts.delaySend;
    busTail.connect(g);
    g.connect(_ensureDelayBus().input);
  }

  // voices feed the bus directly (no per-voice sends — bus handles that)
  const voiceOpts = {
    wave:     opts.wave     ?? 'triangle',
    attack:   opts.attack   ?? 0.02,
    decay:    opts.decay    ?? 0.15,
    sustain:  opts.sustain  ?? 0.55,
    release:  opts.release  ?? 0.4,
    duration: opts.duration ?? 0.5,
    vol:      opts.vol      ?? 0.4,
    voices:   opts.voices   ?? 1,
    detune:   opts.detune   ?? 0,
    filter:   opts.filter,
    filterEnv: opts.filterEnv,
    destination: bus,
  };

  const spread = opts.panSpread ?? 0;
  const voices = list.map((f, i) => {
    const voicePan = (spread !== 0 && list.length > 1)
      ? -spread + (i / (list.length - 1)) * (spread * 2)
      : undefined;
    return playSynth({
      ...voiceOpts,
      freq: f,
      when: when + (i * staggerMs) / 1000,
      ...(voicePan != null ? { pan: voicePan } : {}),
    });
  });

  // Schedule the bus tremolo to stop at natural end-of-chord so its LFO doesn't leak.
  if (busTrem) {
    const naturalEnd = when
      + (list.length * staggerMs) / 1000
      + voiceOpts.attack + voiceOpts.decay
      + voiceOpts.duration
      + voiceOpts.release
      + 0.2;
    busTrem.stop(naturalEnd);
  }

  return {
    stop(at) {
      const t = at ?? c.currentTime;
      voices.forEach(v => v.stop(t));
      if (busTrem) busTrem.stop(t + voiceOpts.release + 0.1);
    },
  };
}

// Presets — tuned to sound finished, not dry. Sends will lazy-init the shared buses.
export const PRESETS = {
  pluck:  { wave: 'triangle', attack: 0.005, decay: 0.08, sustain: 0.0, release: 0.15, duration: 0.0, vol: 0.18,
            filter: { type: 'lowpass', freq: 2400, Q: 0.9 },
            reverbSend: 0.18, delaySend: 0.22 },

  pad:    { wave: 'sawtooth', attack: 0.6,   decay: 0.4,  sustain: 0.7, release: 1.2,  duration: 1.0, vol: 0.10,
            voices: 3, detune: 18,
            filter: { type: 'lowpass', freq: 900, Q: 0.4 },
            reverbSend: 0.4, delaySend: 0.15 },

  bell:   { wave: 'sine',     attack: 0.002, decay: 0.5,  sustain: 0.0, release: 1.2,  duration: 0.0, vol: 0.14,
            reverbSend: 0.55 },

  stab:   { wave: 'square',   attack: 0.003, decay: 0.12, sustain: 0.2, release: 0.2,  duration: 0.1, vol: 0.10,
            filter: { type: 'lowpass', freq: 1800, Q: 1.5 },
            filterEnv: { amount: 2000, attack: 0.005, decay: 0.15 },
            distortion: { drive: 0.25, tone: 'crunch', mix: 0.5 },
            delaySend: 0.3, reverbSend: 0.12 },

  bass:   { wave: 'sawtooth', attack: 0.005, decay: 0.1,  sustain: 0.6, release: 0.15, duration: 0.2, vol: 0.15,
            filter: { type: 'lowpass', freq: 500, Q: 3 },
            filterEnv: { amount: 1500, attack: 0.01, decay: 0.18 },
            distortion: { drive: 0.2, tone: 'warm', mix: 0.35 } },

  breath: { wave: 'triangle', attack: 0.15,  decay: 0.2,  sustain: 0.4, release: 0.6,  duration: 0.4, vol: 0.08,
            filter: { type: 'lowpass', freq: 1400, Q: 0.5 },
            tremolo: { rate: 4.5, depth: 0.3 },
            reverbSend: 0.4 },

  fuzz:   { wave: 'sawtooth', attack: 0.005, decay: 0.1,  sustain: 0.5, release: 0.2,  duration: 0.15, vol: 0.10,
            filter: { type: 'lowpass', freq: 1500, Q: 1 },
            distortion: { drive: 0.7, tone: 'fuzz', mix: 0.85 },
            reverbSend: 0.15 },
};

// ============================================================

// All APIs that create audio nodes (setAesthetic, startBed) must be
// called after a user gesture — browsers block AudioContext otherwise.
// ============================================================

// --- Keys ---

export const KEYS = {
  'A-minor':  { name: 'A minor',  rootMidi: 57, scale: 'minor', notes: [57,59,60,62,64,65,67] },
  'C-minor':  { name: 'C minor',  rootMidi: 60, scale: 'minor', notes: [60,62,63,65,67,68,70] },
  'G-minor':  { name: 'G minor',  rootMidi: 55, scale: 'minor', notes: [55,57,58,60,62,63,65] },
  'F#-minor': { name: 'F# minor', rootMidi: 54, scale: 'minor', notes: [54,56,57,59,61,62,64] },
  'E-minor':  { name: 'E minor',  rootMidi: 52, scale: 'minor', notes: [52,54,55,57,59,60,62] },
  'D-minor':  { name: 'D minor',  rootMidi: 50, scale: 'minor', notes: [50,52,53,55,57,58,60] },
  'Bb-minor': { name: 'B♭ minor', rootMidi: 58, scale: 'minor', notes: [58,60,61,63,65,66,68] },
  'C-major':  { name: 'C major',  rootMidi: 60, scale: 'major', notes: [60,62,64,65,67,69,71] },
  'G-major':  { name: 'G major',  rootMidi: 67, scale: 'major', notes: [67,69,71,72,74,76,78] },
  'D-major':  { name: 'D major',  rootMidi: 62, scale: 'major', notes: [62,64,66,67,69,71,73] },
  'F-major':  { name: 'F major',  rootMidi: 65, scale: 'major', notes: [65,67,69,70,72,74,76] },
  'Bb-major': { name: 'B♭ major', rootMidi: 58, scale: 'major', notes: [58,60,62,63,65,67,69] },
  'Eb-major': { name: 'E♭ major', rootMidi: 63, scale: 'major', notes: [63,65,67,68,70,72,74] },
  'A-minor-pentatonic': { name: 'A minor pent.', rootMidi: 57, scale: 'min-pent', notes: [57,60,62,64,67] },
  'G-minor-pentatonic': { name: 'G minor pent.', rootMidi: 55, scale: 'min-pent', notes: [55,58,60,62,65] },
  'G-dorian':  { name: 'G Dorian',  rootMidi: 55, scale: 'dorian', notes: [55,57,58,60,62,64,65] },
  'D-dorian':  { name: 'D Dorian',  rootMidi: 50, scale: 'dorian', notes: [50,52,53,55,57,59,60] },
};

export const KEY_POOLS = {
  techno:     ['A-minor', 'C-minor', 'G-minor', 'F#-minor'],
  classical:  ['C-major', 'G-major', 'D-major', 'F-major', 'A-minor', 'E-minor', 'D-minor'],
  ambient:    ['A-minor', 'C-major', 'D-major', 'G-major'],
  videogame:  ['C-major', 'G-major', 'F-major', 'A-minor', 'E-minor', 'F#-minor'],
  jazz:       ['F-major', 'Bb-major', 'Eb-major', 'D-minor', 'G-minor', 'C-minor', 'A-minor'],
  industrial: ['Bb-minor', 'F#-minor', 'C-minor', 'D-minor', 'A-minor'],   // all-minor; B♭m default = Reznor flat-key territory
};

// --- Aesthetics ---
// Each aesthetic declares its default key, voicing library, preset,

export const AESTHETICS = {
  techno: {
    defaultKey: 'G-minor',
    voicings: {
      root:     (r) => [r],
      power:    (r) => [r, r+7, r+12],             // 1-5-8 (no 3rd)
      m7no3:    (r) => [r, r+7, r+10],             // 1-5-♭7
      min7:     (r) => [r, r+3, r+7, r+10],
      sus4:     (r) => [r, r+5, r+7],
      sus2:     (r) => [r, r+2, r+7],
      tritone:  (r) => [r, r+6],
      phrygian: (r) => [r, r+1, r+7],
    },
    preset: { wave: 'sawtooth', attack: 0.003, decay: 0.12, sustain: 0.2, release: 0.2,
              duration: 0.1, vol: 0.12,
              filter: { type: 'lowpass', freq: 1800, Q: 1.5 },
              filterEnv: { amount: 2000, attack: 0.005, decay: 0.15 },
              distortion: { drive: 0.2, tone: 'crunch', mix: 0.4 } },
    reverb: { duration: 0.8, decay: 2.0, wet: 0.25 },
    delay:  { time: 0.18, feedback: 0.35, wet: 0.20 },
    reverbSend: 0.15,
    delaySend:  0.10,
  },

  classical: {
    defaultKey: 'C-major',
    voicings: {
      triad:       (r, q='maj') => q==='min' ? [r, r+3, r+7] : [r, r+4, r+7],
      triad1st:    (r, q='maj') => q==='min' ? [r+3, r+7, r+12] : [r+4, r+7, r+12],
      triad2nd:    (r, q='maj') => q==='min' ? [r+7, r+12, r+15] : [r+7, r+12, r+16],
      maj7:        (r) => [r, r+4, r+7, r+11],
      min7:        (r) => [r, r+3, r+7, r+10],
      dom7:        (r) => [r, r+4, r+7, r+10],
      openVoicing: (r, q='maj') => q==='min' ? [r-12, r+7, r+12, r+15] : [r-12, r+7, r+12, r+16],
    },
    preset: { wave: 'triangle', attack: 0.4, decay: 0.3, sustain: 0.7, release: 1.0,
              duration: 1.0, vol: 0.10, voices: 2, detune: 10,
              filter: { type: 'lowpass', freq: 1200, Q: 0.6 } },
    reverb: { duration: 2.5, decay: 2.5, wet: 0.50 },
    delay:  null,
    reverbSend: 0.35,
    delaySend:  0,
  },

  ambient: {
    defaultKey: 'A-minor',
    voicings: {
      sus2:       (r) => [r, r+2, r+7],
      sus4:       (r) => [r, r+5, r+7],
      add9:       (r, q='maj') => q==='min' ? [r, r+3, r+7, r+14] : [r, r+4, r+7, r+14],
      maj9:       (r) => [r, r+4, r+7, r+11, r+14],
      min9:       (r) => [r, r+3, r+7, r+10, r+14],
      quartal3:   (r) => [r, r+5, r+10],
      quartal4:   (r) => [r, r+5, r+10, r+15],
      drone:      (r) => [r-12, r, r+7, r+12],    // pedal + octave + 5th
      openFifths: (r) => [r-12, r+7, r+12, r+19],
    },
    preset: { wave: 'sawtooth', attack: 0.8, decay: 0.5, sustain: 0.8, release: 1.8,
              duration: 1.0, vol: 0.08, voices: 3, detune: 18,
              filter: { type: 'lowpass', freq: 900, Q: 0.4 } },
    reverb: { duration: 4.0, decay: 3.0, wet: 0.70 },
    delay:  { time: 1.2, feedback: 0.50, wet: 0.40 },
    reverbSend: 0.55,
    delaySend:  0.25,
  },

  videogame: {
    defaultKey: 'C-major',
    voicings: {
      power:        (r) => [r, r+7],
      triad:        (r, q='maj') => q==='min' ? [r, r+3, r+7] : [r, r+4, r+7],
      parallel5ths: (r) => [r, r+7, r+12, r+19],
      octaveLead:   (r) => [r, r+12],
    },
    preset: { wave: 'square', attack: 0.001, decay: 0.04, sustain: 0.3, release: 0.04,
              duration: 0.08, vol: 0.14,
              filter: { type: 'lowpass', freq: 3500, Q: 1 } },
    reverb: { duration: 0.15, decay: 1.0, wet: 0.08 },
    delay:  { time: 0.09, feedback: 0.20, wet: 0.15 },
    reverbSend: 0.05,
    delaySend:  0.12,
  },

  jazz: {
    defaultKey: 'F-major',
    voicings: {
      shell:      (r) => [r, r+4, r+10],                     // 1-3-♭7
      shellMaj:   (r) => [r, r+4, r+11],                     // 1-3-7
      rootlessA:  (r, q='maj7') => q==='min7'
                    ? [r+3, r+7, r+10, r+14]                 // min9 A-form
                    : [r+4, r+7, r+11, r+14],                // maj9 A-form
      rootlessB:  (r) => [r+10, r+14, r+16, r+19],
      maj9:       (r) => [r, r+4, r+7, r+11, r+14],
      min9:       (r) => [r, r+3, r+7, r+10, r+14],
      dom13:      (r) => [r, r+4, r+7, r+10, r+14, r+21],
      halfDim:    (r) => [r, r+3, r+6, r+10],
      altDom:     (r) => [r, r+4, r+10, r+13, r+15],         // 7♭9♯9
      tritoneSub: (r) => [r+6, r+10, r+13, r+16],            // ♭II7 for V7
    },
    preset: { wave: 'triangle', attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.5,
              duration: 1.0, vol: 0.11, voices: 2, detune: 6,
              filter: { type: 'lowpass', freq: 1800, Q: 0.7 },
              distortion: { drive: 0.1, tone: 'warm', mix: 0.25 } },
    reverb: { duration: 1.0, decay: 1.8, wet: 0.35 },
    delay:  null,
    reverbSend: 0.28,
    delaySend:  0,
  },

  // Reznor / Throbbing Gristle / — saw + heavy
  // distortion, short metallic plate, atonal/cluster voicings, no triads.
  // Distortion lives on the default preset (not opt-in via PRESETS.fuzz),
  // which is the load-bearing differentiator from techno's stab preset.
  industrial: {
    defaultKey: 'Bb-minor',
    bpm: null,
    voicings: {
      root:        (r) => [r],
      octave:      (r) => [r, r + 12],
      powerSub:    (r) => [r - 12, r, r + 7],              // sub + 1 + 5 — wide power chord
      power:       (r) => [r, r + 7],                       // 1 + 5, no 3rd
      tritone:     (r) => [r, r + 6],                       // 1 + ♯4 — devil's interval
      cluster:     (r) => [r, r + 1, r + 2],                // semitone cluster
      smear:       (r) => [r, r + 1, r + 6],                // root + ♭2 + ♯4 — Reznor smear
      halfDim:     (r) => [r, r + 3, r + 6, r + 10],        // m7♭5
      atonal4:     (r) => [r, r + 1, r + 5, r + 8],         // 4-note non-functional
    },
    preset: { wave: 'sawtooth', attack: 0.005, decay: 0.20, sustain: 0.35, release: 0.30,
              duration: 0.35, vol: 0.10, voices: 3, detune: 22,
              filter: { type: 'lowpass', freq: 1100, Q: 4 },
              distortion: { drive: 0.55, tone: 'crunch', mix: 0.65 } },
    reverb: { duration: 0.45, decay: 1.5, wet: 0.30 },     // short metal-plate
    delay:  { time: 0.36, feedback: 0.45, wet: 0.32 },     // dotted-eighth-ish ping
    reverbSend: 0.22,
    delaySend:  0.18,
  },
};

// --- Progressions (scale-degree offsets from tonic; negative = below) ---

export const PROGRESSIONS = {
  techno: {
    drone:    [0],
    melodic:  [0, -4],       // i–VI
    dorian:   [0, -5],       // i–VII
    inward:   [0, 5],        // i–iv
    phrygian: [0, 1],        // i–♭II
  },
  classical: {
    authentic:   [0, 5, 7, 0],   // I–IV–V–I
    pachelbel:   [0, 9, 5, 7],   // I–vi–IV–V
    ii_V_I:      [2, 7, 0],
    deceptive:   [0, 7, 9],      // I–V–vi
    journey:     [9, 5, 0, 7],   // vi–IV–I–V
    axis:        [0, 7, 9, 5],   // I–V–vi–IV
    circle:      [0, 9, 2, 7],   // I–vi–ii–V
  },
  ambient: {
    oscillate:  [0, 9],      // I–vi
    parallel:   [0, 2, 4],
    modalShift: [0, -3],     // I–♭VI
    static:     [0],
    drift:      [0, 5, -3, 0],
  },
  videogame: {
    marioWorld: [0, 7, 9, 5],  // I–V–vi–IV
    fanfare:    [0, 5, 7, 0],  // I–IV–V–I
    dungeon:    [0, -2, -4],   // i–♭VII–♭VI
  },
  jazz: {
    ii_V_I:        [2, 7, 0],
    rhythmChanges: [0, 9, 2, 7],
    turnaround:    [4, 9, 2, 7],
  },
};

// --- Cadences (classical) ---

export const CADENCES = {
  authentic: (rootMidi, quality='maj') => [
    { midis: [rootMidi + 7, rootMidi + 11, rootMidi + 14, rootMidi + 17], dur: 0.5 },
    { midis: quality === 'min'
        ? [rootMidi, rootMidi + 3, rootMidi + 7]
        : [rootMidi, rootMidi + 4, rootMidi + 7], dur: 1.5 },
  ],
  plagal: (rootMidi, quality='maj') => [
    { midis: [rootMidi + 5, rootMidi + 9, rootMidi + 12], dur: 0.5 },
    { midis: quality === 'min'
        ? [rootMidi, rootMidi + 3, rootMidi + 7]
        : [rootMidi, rootMidi + 4, rootMidi + 7], dur: 1.5 },
  ],
  deceptive: (rootMidi) => [
    { midis: [rootMidi + 7, rootMidi + 11, rootMidi + 14], dur: 0.5 },
    { midis: [rootMidi + 9, rootMidi + 12, rootMidi + 16], dur: 1.2 },
  ],
  half: (rootMidi) => [
    { midis: [rootMidi + 7, rootMidi + 11, rootMidi + 14], dur: 1.5 },
  ],
};

// --- Rhythmic beds ---

export const RHYTHMIC_BEDS = {
  kick: {
    defaultBPM: 120,
    defaultPattern: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    voice: { wave: 'sine', attack: 0.001, decay: 0.1, sustain: 0, release: 0.02,
             duration: 0, vol: 0.22, freq: 55,
             filter: { type: 'lowpass', freq: 200, Q: 1.2 } },
  },
  heartbeat: {
    defaultBPM: 60,
    defaultPattern: [1, 0, 0.7, 0, 0, 0, 0, 0],
    voice: { wave: 'sine', attack: 0.003, decay: 0.25, sustain: 0, release: 0.1,
             duration: 0, vol: 0.14, freq: 65,
             filter: { type: 'lowpass', freq: 140, Q: 0.8 } },
  },
  click: {
    defaultBPM: 120,
    defaultPattern: [1],
    voice: { wave: 'square', attack: 0.0005, decay: 0.015, sustain: 0, release: 0.005,
             duration: 0, vol: 0.10, freq: 3000,
             filter: { type: 'bandpass', freq: 3000, Q: 8 } },
  },
  tick: {
    defaultBPM: 60,
    defaultPattern: [1, 0, 0, 0],
    voice: { wave: 'square', attack: 0.001, decay: 0.025, sustain: 0, release: 0.01,
             duration: 0, vol: 0.12, freq: 1200,
             filter: { type: 'bandpass', freq: 1200, Q: 4 } },
  },
};

// --- Session state ---

let _sessionKey = null;
let _aesthetic  = 'ambient';
let _bedMode    = 'auto';
let _bedInterval = null;
let _bedCurrent = null;

// --- Key accessors ---

export function setSessionKey(keyName) {
  const k = typeof keyName === 'string' ? KEYS[keyName] : keyName;
  if (!k) throw new Error(`Unknown key: ${keyName}`);
  _sessionKey = k;
  return k;
}

export function getSessionKey() {
  if (!_sessionKey) _sessionKey = KEYS['A-minor'];
  return _sessionKey;
}

// Snap any MIDI/Hz value to the nearest pitch in the current session key.
export function quantizeToKey(midiOrFreq) {
  const key = getSessionKey();
  let midi = midiOrFreq;
  if (midi > 127) midi = 69 + 12 * Math.log2(midi / 440);
  const target = Math.round(midi);
  let best = key.notes[0], bestDist = Infinity;
  for (let oct = -3; oct <= 4; oct++) {
    for (const n of key.notes) {
      const candidate = n + oct * 12;
      const d = Math.abs(candidate - target);
      if (d < bestDist) { bestDist = d; best = candidate; }
    }
  }
  return best;
}

export function hashString(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

// Deterministic session-key selection from prompt hash within aesthetic's pool.
export function pickSessionKey(prompt, aesthetic = _aesthetic) {
  const pool = KEY_POOLS[aesthetic] || KEY_POOLS.ambient;
  const idx = Math.abs(hashString(prompt || '')) % pool.length;
  return setSessionKey(pool[idx]);
}

// --- Aesthetic accessors ---

// Call from a user-gesture context — configures reverb/delay which lazy-creates audio nodes.
export function setAesthetic(name) {
  if (!AESTHETICS[name]) throw new Error(`Unknown aesthetic: ${name}`);
  _aesthetic = name;
  const a = AESTHETICS[name];
  if (a.reverb) configureReverb(a.reverb);
  if (a.delay)  configureDelay(a.delay);
  if (!_sessionKey) _sessionKey = KEYS[a.defaultKey] || KEYS['A-minor'];
  return { name, config: a };
}

export function getAesthetic() {
  return { name: _aesthetic, config: AESTHETICS[_aesthetic] };
}

// Look up a voicing in the current aesthetic and return a MIDI-note array.
export function getVoicing(voicingName, rootMidi, quality) {
  const fn = AESTHETICS[_aesthetic].voicings[voicingName];
  if (!fn) return [rootMidi];
  return fn(rootMidi, quality);
}

// --- Rel → interval (aesthetic-aware dispatcher) ---

const REL_INTERVALS = {
  supports:    7,    // perfect 5th
  contradicts: 6,    // tritone
  synthesizes: 4,    // major 3rd
  refines:     1,    // minor 2nd
  questions:   6,    // augmented 4th (enharmonic tritone, resolves differently)
  supersedes:  12,   // octave
};

// Play a two-note interval representing a schema `rel` relationship,
// rendered through the current aesthetic's preset + FX.
// opts: { aesthetic, voicing, duration, voiceOpts, when }
export function playRelInterval(rel, rootMidi, opts = {}) {
  const interval = REL_INTERVALS[rel];
  if (interval === undefined) return { stop() {} };
  const aesthetic = opts.aesthetic || _aesthetic;
  const config = AESTHETICS[aesthetic];
  const duration = opts.duration ?? ({
    techno:    0.15,
    videogame: 0.10,
    classical: 0.90,
    jazz:      1.20,
    ambient:   2.00,
  }[aesthetic] || 1.0);
  const baseOpts = {
    ...config.preset,
    reverbSend: config.reverbSend,
    delaySend:  config.delaySend,
    duration,
    ...(opts.voiceOpts || {}),
  };
  return playChord([rootMidi, rootMidi + interval].map(midiToFreq),
                   { ...baseOpts, when: opts.when });
}

// --- Stance articulation ---

const STANCE_ARTICULATION = {
  claiming:    { attack: 0.005, release: 0.08, volMult: 1.1 },   // staccato + forte
  exploring:   { attack: 0.05,  release: 0.25, volMult: 0.85 },  // legato
  questioning: { attack: 0.02,  release: 2.0,  volMult: 0.9 },   // fermata (held)
  conceding:   { attack: 0.02,  release: 0.15, volMult: 0.5 },   // decrescendo
};

// Returns a new voiceOpts with attack/release/vol modified per stance.
export function articulate(voiceOpts, stance) {
  const a = STANCE_ARTICULATION[stance];
  if (!a) return voiceOpts;
  return {
    ...voiceOpts,
    attack:  a.attack,
    release: a.release,
    vol:     (voiceOpts?.vol ?? 0.15) * a.volMult,
  };
}

// --- Heat dynamics ---

export function heatVelocity(baseVol, heat) {
  return baseVol * (0.3 + (heat ?? 0) * 0.7);
}

export function heatReverbSend(baseSend, heat) {
  return baseSend * (1 + (heat ?? 0));
}

// --- Because grounding ---

// kind: 'internal' (pedal tone under), 'external' (off-stage reverb+pan),
// 'prior' (detuned flat to suggest "from before").
export function playBecause(rootMidi, kind = 'internal', opts = {}) {
  if (!_enabled) return { stop() {} };
  const aesthetic = opts.aesthetic || _aesthetic;
  const config = AESTHETICS[aesthetic];
  const base = { ...config.preset, reverbSend: config.reverbSend };

  if (kind === 'external') {
    return playSynth({
      ...base,
      midi: rootMidi,
      duration: opts.duration ?? 1.8,
      vol: (base.vol ?? 0.1) * 0.6,
      pan: opts.pan ?? (Math.random() > 0.5 ? -0.85 : 0.85),
      voices: 2,
      detune: -15,
      reverbSend: (base.reverbSend ?? 0.3) + 0.3,
      filter: { type: 'lowpass', freq: 1200, Q: 1 },
      when: opts.when,
    });
  }

  if (kind === 'prior') {
    return playSynth({
      ...base,
      midi: rootMidi,
      duration: opts.duration ?? 1.5,
      vol: (base.vol ?? 0.1) * 0.5,
      voices: 2,
      detune: -12,
      reverbSend: (base.reverbSend ?? 0.3) + 0.2,
      when: opts.when,
    });
  }

  // 'internal' — soft pedal-tone grounding
  return playSynth({
    ...base,
    midi: rootMidi,
    duration: opts.duration ?? 2.0,
    vol: (base.vol ?? 0.1) * 0.5,
    when: opts.when,
  });
}

// --- Rhythmic bed scheduler ---

export function setBedMode(mode) {
  if (!['auto', 'on', 'off'].includes(mode)) {
    throw new Error(`Invalid bed mode: ${mode}. Use 'auto' | 'on' | 'off'.`);
  }
  _bedMode = mode;
  if (mode === 'off') stopBed();
}

export function getBedMode() { return _bedMode; }

// Start a rhythmic bed. opts: { type, bpm, pattern }
// type ∈ RHYTHMIC_BEDS; bpm/pattern override defaults.
// Returns { type, bpm } or null if bedMode === 'off' or type unknown.
export function startBed({ type, bpm, pattern } = {}) {
  if (_bedMode === 'off') return null;
  if (!type) return null;
  stopBed();
  const bed = RHYTHMIC_BEDS[type];
  if (!bed) return null;
  const effBpm = bpm || bed.defaultBPM;
  const effPattern = pattern || bed.defaultPattern;
  const stepsPerBar = effPattern.length;
  // One bar of 4 beats; step = beat / (steps/4)
  const stepMs = (60000 / effBpm) / (stepsPerBar / 4);
  let stepIdx = 0;
  const tick = () => {
    if (!_enabled) return;
    const amp = effPattern[stepIdx % effPattern.length];
    if (amp > 0) playSynth({ ...bed.voice, vol: bed.voice.vol * amp });
    stepIdx++;
  };
  _bedInterval = setInterval(tick, stepMs);
  _bedCurrent = { type, bpm: effBpm };
  return _bedCurrent;
}

export function stopBed() {
  if (_bedInterval) {
    clearInterval(_bedInterval);
    _bedInterval = null;
    _bedCurrent = null;
  }
}

export function getBed() { return _bedCurrent; }

// --- Voice pool (polyphony management) ---

// Caps concurrent voices per mode. When the pool is full, the oldest voice is
// stolen (force-released) to make room for the new one. Prevents dense sessions
// from stacking 30+ voices into mush/clipping.
export function createVoicePool({ modeId = 'default', maxVoices = 8,
                                  destination = null } = {}) {
  const voices = [];   // FIFO — oldest at index 0

  function pruneFinished() {
    const now = _ctx ? _ctx.currentTime : 0;
    while (voices.length && voices[0]._endsAt <= now) voices.shift();
  }

  function makeRoom() {
    pruneFinished();
    if (voices.length >= maxVoices) {
      const oldest = voices.shift();
      try { oldest.stop(); } catch {}
    }
  }

  function track(handle, naturalEnd) {
    handle._endsAt = naturalEnd;
    voices.push(handle);
    return handle;
  }

  function naturalEnd(opts) {
    const now = _ctx ? _ctx.currentTime : 0;
    const at = opts.when ?? now;
    const a = Math.max(0.001, opts.attack  ?? 0.01);
    const d = Math.max(0.001, opts.decay   ?? 0.1);
    const dur = Math.max(0, opts.duration ?? 0.3);
    const r = Math.max(0.01, opts.release ?? 0.25);
    return at + a + d + dur + r + 0.05;
  }

  return {
    play(opts = {}) {
      makeRoom();
      const finalOpts = destination ? { ...opts, destination } : opts;
      const handle = playSynth(finalOpts);
      return track(handle, naturalEnd(opts));
    },
    playChord(freqs, opts = {}) {
      makeRoom();
      const finalOpts = destination ? { ...opts, destination } : opts;
      const handle = playChord(freqs, finalOpts);
      // Estimate chord's natural end — use longest voice worst-case
      const staggerSec = ((opts.stagger ?? 0) * (freqs?.length || 1)) / 1000;
      return track(handle, naturalEnd(opts) + staggerSec);
    },
    releaseAll() {
      while (voices.length) {
        const v = voices.shift();
        try { v.stop(); } catch {}
      }
    },
    size() { pruneFinished(); return voices.length; },
    get maxVoices() { return maxVoices; },
    modeId,
  };
}

// --- Master chain (per-mode compressor + limiter) ---

const _masterChains = new Map();   // modeId → { input, output, config }

// Inserts a compressor + optional brick-wall limiter between a mode's voices
// and the master bus. Pass the returned `input` as the `destination` in
// playSynth/playChord calls (or to createVoicePool's destination opt).
//
// config: { compressor: { threshold, ratio, attack, release, knee }, limiter: bool }
export function attachMasterChain(modeId, config = {}) {
  detachMasterChain(modeId);
  const c = ctx();
  const input = c.createGain();
  let tail = input;

  if (config.compressor) {
    const cc = config.compressor;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = cc.threshold ?? -18;
    comp.ratio.value     = cc.ratio     ?? 4;
    comp.attack.value    = cc.attack    ?? 0.003;
    comp.release.value   = cc.release   ?? 0.15;
    comp.knee.value      = cc.knee      ?? 6;
    tail.connect(comp);
    tail = comp;
  }

  if (config.limiter) {
    // Brick-wall limiter approximated with a fast-attack compressor at near-infinite ratio.
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -1;
    lim.ratio.value     = 20;
    lim.attack.value    = 0.0001;
    lim.release.value   = 0.05;
    lim.knee.value      = 0;
    tail.connect(lim);
    tail = lim;
  }

  tail.connect(_master);

  const chain = { input, output: tail, config };
  _masterChains.set(modeId, chain);
  return chain;
}

export function getMasterChain(modeId) {
  return _masterChains.get(modeId) || null;
}

export function detachMasterChain(modeId) {
  const chain = _masterChains.get(modeId);
  if (!chain) return;
  try { chain.input.disconnect(); } catch {}
  try { chain.output.disconnect(); } catch {}
  _masterChains.delete(modeId);
}

// --- Cadence player (classical) ---

// Plays a named cadence from the CADENCES table as a timed sequence of chords.
// cadenceName: 'authentic' | 'plagal' | 'deceptive' | 'half'
// opts: { quality ('maj'|'min'), voiceOpts, reverbSend, tempoScale, overlap, when }
export function playCadence(cadenceName, rootMidi, opts = {}) {
  const cadenceFn = CADENCES[cadenceName];
  if (!cadenceFn) return { stop() {} };

  const steps = cadenceFn(rootMidi, opts.quality || 'maj');
  const aesthetic = AESTHETICS[_aesthetic];
  const voiceOpts = opts.voiceOpts || aesthetic.preset;
  const reverbSend = opts.reverbSend ?? aesthetic.reverbSend;
  const tempoScale = opts.tempoScale ?? 1;
  const overlap = opts.overlap ?? 0.85;   // 1.0 = no overlap (staccato), <1 = legato
  const baseWhen = opts.when ?? (_ctx ? _ctx.currentTime : 0);

  const voices = [];
  let offset = 0;
  for (const step of steps) {
    const dur = step.dur * tempoScale;
    const handle = playChord(step.midis.map(midiToFreq), {
      ...voiceOpts,
      reverbSend,
      duration: dur,
      when: baseWhen + offset,
    });
    voices.push(handle);
    offset += dur * overlap;
  }

  return { stop(at) { voices.forEach(v => { try { v.stop(at); } catch {} }); } };
}

// --- Progression player ---

// Plays a named progression from PROGRESSIONS[currentAesthetic] as a sequence
// of chords, one per beat. Chord roots are offset from rootMidi by the
// progression's scale-degree semitones; each chord is voiced via the aesthetic's
// voicing library (voicingName, quality).
//
// opts: { voicingName, quality, voiceOpts, reverbSend, beatMs, overlap, when }
export function playProgression(progName, rootMidi, opts = {}) {
  const progSet = PROGRESSIONS[_aesthetic];
  const prog = progSet && progSet[progName];
  if (!prog) return { stop() {} };

  const aesthetic = AESTHETICS[_aesthetic];
  const voicingName = opts.voicingName ||
    (_aesthetic === 'jazz' ? 'rootlessA'
     : _aesthetic === 'ambient' ? 'add9'
     : _aesthetic === 'techno' ? 'm7no3'
     : _aesthetic === 'videogame' ? 'triad'
     : 'triad');
  const quality = opts.quality || (aesthetic.defaultKey.includes('minor') ? 'min' : 'maj');
  const voiceOpts = opts.voiceOpts || aesthetic.preset;
  const reverbSend = opts.reverbSend ?? aesthetic.reverbSend;
  const beatSec = (opts.beatMs ?? 1000) / 1000;
  const overlap = opts.overlap ?? 0.9;
  const baseWhen = opts.when ?? (_ctx ? _ctx.currentTime : 0);

  const voices = [];
  prog.forEach((semitones, i) => {
    const chordRoot = rootMidi + semitones;
    const voicing = getVoicing(voicingName, chordRoot, quality);
    const handle = playChord(voicing.map(midiToFreq), {
      ...voiceOpts,
      reverbSend,
      duration: beatSec * overlap,
      when: baseWhen + i * beatSec,
    });
    voices.push(handle);
  });

  return { stop(at) { voices.forEach(v => { try { v.stop(at); } catch {} }); } };
}
