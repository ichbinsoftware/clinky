import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, configureReverb, heatReverbSend } from '/synth.js';

// Each topic band sustains a stack of octaves with a bell-curve amplitude
// window (Shepard 1964). New thoughts trigger a brief pitched bloom that
// swells into the cathedral reverb before melting back into the infinite register.

class MarkoMode extends Mode {
  // ─── mode-specific state ─────────────────────────────────────────────────────
  bands = [];
  ghostBands = [];           // {y, height, alpha, targetAlpha, toneR, toneG, toneB, breathPhase, breathSpeed, toneCycle}
  ghostSpawnTimer = 0;
  primePhase = false;
  hoveredBand = null;         // real band currently under cursor

  // --- Shepard band (option D) — Shepard 1964 ---
  // Each topic band = a stack of octaves with a bell-curve amplitude window
  // centred on the topic's pitch. Perpetual-register illusion: the ear can't
  // locate a fundamental because there isn't one. Rothko's "infinite" rendered
  // sonically. References: Roger Shepard, "Circularity in Judgments of Relative
  // Pitch", JASA 36 (1964); Jean-Claude Risset's continuous-glissando variant.
  topicDrones = new Map();   // topic.id → array of voice handles [{stop}, …]
  cathedralInit = false;

  constructor() {
    super({
      mode: 'marko',
      aesthetic: 'ambient',
      topicFallbackColor: '#e63946',
      vars: {
        '--e-bg': '#1a0a0a', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#ebd9a0', '--e-pivot-tint': 'rgba(90,42,42,0.4)', '--e-accent': '#c2562a',
      },
      essayGetSession: () => ({
        prompt: this.app.prompt(),
        nodes: this.nodes.map(n => ({ ...n, incoming_refs_count: this.nodeIncoming(n.id) })),
        topics: this.topics,
      }),
    });

    // Wire canvas event listeners
    this.canvas.addEventListener('mouseleave', () => { this.hoveredBand = null; });
    this.canvas.addEventListener('mousemove', e => this.#onMouseMove(e));
    this.canvas.addEventListener('click', e => this.#onClick(e));
  }

  // ─── lifecycle hooks ─────────────────────────────────────────────────────────

  onStart() {
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
    this.initCathedral();
  }

  // Prompt-unpack: spawn one ghost band per prompt token immediately,
  // distributed top-to-bottom, height proportional to token character count.
  // The bands sit while the model thinks; fade out as nodes arrive (via stopPrime).
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;

    const margin = this.H * 0.05;
    const usable = this.H - margin * 2;
    const totalChars = tokens.reduce((s, t) => s + t.length, 0);

    let y = margin;
    for (const tok of tokens) {
      // Height proportional to token length, with a floor + ceiling
      const weight = tok.length / totalChars;
      const height = Math.max(30, Math.min(180, weight * usable));

      // Tone: muted grey-brown — same default as random ghost bands
      const baseTone = 85 + Math.random() * 40;
      const toneR = Math.floor(baseTone);
      const toneG = Math.floor(baseTone * 0.75);
      const toneB = Math.floor(baseTone * 0.6);

      this.ghostBands.push({
        y, height,
        alpha: 0,
        targetAlpha: 1,
        toneR, toneG, toneB,
        breathPhase: Math.random() * Math.PI * 2,
        breathSpeed: 0.008 + Math.random() * 0.008,
      });

      y += height + 4;
      if (y >= margin + usable) break;        // no more room
    }
  }

  onTopics(t) {
    t.forEach(nt => {
      if (!this.topicDrones.has(nt.id)) {
        this.startTopicDrone(nt);     // each new topic = a new sustained pad voice
      }
    });
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.recalcBands();
    this.bloomOnThought(n);           // brief pad swell on arrival (replaces playNodeSound)
  }

  onDone() {
    // Session complete — fade out drones. Each Shepard voice has release: 3.5s
    // so the cathedral exhales for ~3–4 seconds before silence.
    this.stopAllDrones();
    this.stopPrime();
  }

  onError() {
    this.stopAllDrones();
    this.stopPrime();
  }

  onStop() {
    this.stopAllDrones();
    this.stopPrime();
  }

  onClear() {
    this.bands = [];
    this.ghostBands = [];
    this.primePhase = false;
    this.hoveredBand = null;
    this.stopAllDrones();             // fade out all cathedral voices
  }

  // ─── topic / drone methods ───────────────────────────────────────────────────

  initCathedral() {
    if (this.cathedralInit) return;
    this.cathedralInit = true;
    setAesthetic('ambient');
    // Longer reverb than ambient default — this is a CATHEDRAL, not a living room.
    configureReverb({ duration: 5.5, decay: 3.2, wet: 0.75 });
  }

  // Number of octaves in the Shepard stack. 6 covers ~4 audible kHz of spectrum
  // (e.g. C2 up to C7), wide enough to "smear" the register completely.
  startTopicDrone(topic) {
    if (this.topicDrones.has(topic.id)) return;
    const SHEPARD_OCTAVES = 6;
    const freq = topic.note || 440;
    // Convert topic frequency to MIDI for clean octave arithmetic.
    const baseMidi = Math.round(69 + 12 * Math.log2(freq / 440));
    // Stack OCTAVES voices centred on baseMidi (3 below, 3 above).
    const voices = [];
    for (let i = 0; i < SHEPARD_OCTAVES; i++) {
      const offset = i - Math.floor(SHEPARD_OCTAVES / 2);   // −3 … +2
      const midi = baseMidi + offset * 12;
      // Bell-curve amplitude window: sin((i + 0.5) / N × π). Peaks in middle,
      // falls to near-0 at edges. THIS is what creates the Shepard illusion —
      // the ear can't hear the top or bottom octaves, so the pitch has no anchor.
      const bellWeight = Math.sin(((i + 0.5) / SHEPARD_OCTAVES) * Math.PI);
      const voice = playSynth({
        midi,
        wave: 'sine',
        attack: 0.8,                    // gentle swell in
        decay: 0.3,
        sustain: 0.9,                   // holds near-peak
        release: 3.5,                   // slow fade out when stopped
        duration: 999,
        vol: 0.04 * bellWeight,         // per-octave amplitude × bell weight
        reverbSend: 0.55,
        delaySend: 0.12,
      });
      voices.push(voice);
    }
    this.topicDrones.set(topic.id, voices);
  }

  bloomOnThought(node) {
    const info = this.topicInfo(node.topic);
    const freq = info.note || 440;
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    // Bloom is a single pad voice at the topic's centre note — rides above the
    // Shepard stack, giving each thought a moment of "pitched presence" before
    // melting back into the infinite register.
    playSynth({
      ...PRESETS.pad,
      freq,
      duration: 1.6,
      vol: 0.08 + heat * 0.06,
      voices: 2,
      detune: 12,
      attack: 0.9,
      release: 2.0,
      reverbSend: heatReverbSend(0.55, heat),
      delaySend: 0.2,
    });
  }

  stopAllDrones() {
    for (const [, voices] of this.topicDrones) {
      if (Array.isArray(voices)) {
        voices.forEach(v => { try { v.stop(); } catch {} });
      } else {
        try { voices.stop(); } catch {}
      }
    }
    this.topicDrones.clear();
  }

  // ─── ghost bands: thinking-phase animation ───────────────────────────────────

  spawnGhostBand() {
    // Wider height variation — some bands are thin strips, others are massive fields
    const margin = this.H * 0.05;
    const minH = 30, maxH = 240;
    let y, height, tries = 0;
    do {
      // Exponential distribution feels more Rothko — favours medium heights, some outliers big/small
      const t = Math.random();
      height = minH + (maxH - minH) * Math.pow(t, 1.6);
      y = margin + Math.random() * (this.H - margin * 2 - height);
      tries++;
    } while (tries < 10 && this.ghostBands.some(g =>
      Math.abs((g.y + g.height / 2) - (y + height / 2)) < (g.height + height) / 2 + 10
    ));

    // Tone: mostly muted grey-brown, occasionally near-white or near-black
    let toneR, toneG, toneB;
    const roll = Math.random();
    if (roll < 0.1) {
      // Near-black — slightly cooler than the red ground
      const k = 15 + Math.random() * 18;
      toneR = Math.floor(k);
      toneG = Math.floor(k);
      toneB = Math.floor(k * 1.1);
    } else if (roll < 0.2) {
      // Near-white — warm cream tone
      const k = 200 + Math.random() * 30;
      toneR = Math.floor(k);
      toneG = Math.floor(k * 0.97);
      toneB = Math.floor(k * 0.9);
    } else {
      // Muted grey-brown (default)
      const baseTone = 85 + Math.random() * 40;
      toneR = Math.floor(baseTone);
      toneG = Math.floor(baseTone * 0.75);
      toneB = Math.floor(baseTone * 0.6);
    }

    this.ghostBands.push({
      y, height,
      alpha: 0,
      targetAlpha: 1,
      toneR, toneG, toneB,
      breathPhase: Math.random() * Math.PI * 2,
      breathSpeed: 0.008 + Math.random() * 0.008,
    });
  }

  cycleGhostTone(band) {
    band.toneCycle = ((band.toneCycle || 0) + 1) % 3;
    switch (band.toneCycle) {
      case 0: { // grey-brown
        const k = 85 + Math.random() * 40;
        band.toneR = Math.floor(k);
        band.toneG = Math.floor(k * 0.75);
        band.toneB = Math.floor(k * 0.6);
        break;
      }
      case 1: { // near-black
        const k = 15 + Math.random() * 18;
        band.toneR = Math.floor(k);
        band.toneG = Math.floor(k);
        band.toneB = Math.floor(k * 1.1);
        break;
      }
      case 2: { // near-white
        const k = 200 + Math.random() * 30;
        band.toneR = Math.floor(k);
        band.toneG = Math.floor(k * 0.97);
        band.toneB = Math.floor(k * 0.9);
        break;
      }
    }
    // Reroll breath phase so the change feels like a fresh note
    band.breathPhase = 0;
  }

  ghostBandAtY(y) {
    for (let i = this.ghostBands.length - 1; i >= 0; i--) {
      const g = this.ghostBands[i];
      const breathScale = 1 + Math.sin(g.breathPhase) * 0.04;
      const h = g.height * breathScale;
      const yCentre = g.y + g.height / 2;
      const top = yCentre - h / 2;
      if (y >= top && y <= top + h) return g;
    }
    return null;
  }

  startPrime() {
    this.primePhase = true;
    this.ghostBands = [];
    this.ghostSpawnTimer = 10;         // first ghost appears quickly
  }

  stopPrime() {
    this.primePhase = false;
    // All ghosts fade out
    for (const g of this.ghostBands) g.targetAlpha = 0;
  }

  simulatePrime() {
    if (this.primePhase) {
      this.ghostSpawnTimer--;
      if (this.ghostSpawnTimer <= 0 && this.ghostBands.length < 5) {
        this.spawnGhostBand();
        this.ghostSpawnTimer = 120 + Math.random() * 60; // 2–3s between ghosts
      }
    }
    for (let i = this.ghostBands.length - 1; i >= 0; i--) {
      const g = this.ghostBands[i];
      g.alpha += (g.targetAlpha - g.alpha) * 0.035;
      g.breathPhase += g.breathSpeed;
      if (!this.primePhase) g.alpha *= 0.94;
      if (g.targetAlpha === 0 && g.alpha < 0.01) this.ghostBands.splice(i, 1);
    }
  }

  drawGhostBands() {
    if (this.ghostBands.length === 0) return;
    const pad = this.W * 0.08;
    for (const g of this.ghostBands) {
      // Breath: gentle height expansion + saturation pulse
      const breathScale = 1 + Math.sin(g.breathPhase) * 0.04;
      const breathSat = 0.6 + (Math.sin(g.breathPhase * 0.7) + 1) * 0.2; // 0.6–1.0
      const h = g.height * breathScale;
      const yCentre = g.y + g.height / 2;
      const y = yCentre - h / 2;

      const sat = g.alpha * breathSat;

      const bleedV = 40;
      const bleedH = 30;
      const offX = pad - bleedH;
      const offY = y - bleedV;
      const offW = this.W - pad * 2 + bleedH * 2;
      const offH = h + bleedV * 2;
      const coreA = sat * 0.6;
      this.bleedRect(g.toneR, g.toneG, g.toneB, Math.max(0, coreA), offX, offY, offW, offH, bleedH, bleedV);
    }
  }

  // Underpainting — five large soft warm/cool blobs at session-fixed positions,
  // very low alpha. Rothko's grounds were never flat; this hints at the layers
  // beneath the visible field.
  drawUnderpainting() {
    if (!this._underBlobs) {
      this._underBlobs = [];
      const tints = ['120, 60, 40', '90, 70, 50', '50, 60, 90', '80, 50, 80', '110, 80, 60'];
      for (const tint of tints) {
        this._underBlobs.push({
          fx: 0.10 + Math.random() * 0.80,
          fy: 0.10 + Math.random() * 0.80,
          fr: 0.28 + Math.random() * 0.18,
          tint,
          alpha: 0.05 + Math.random() * 0.04,
        });
      }
    }
    for (const b of this._underBlobs) {
      const cx = b.fx * this.W, cy = b.fy * this.H;
      const r = b.fr * Math.max(this.W, this.H);
      const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${b.tint}, ${b.alpha})`);
      g.addColorStop(0.5, `rgba(${b.tint}, ${b.alpha * 0.4})`);
      g.addColorStop(1, `rgba(${b.tint}, 0)`);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  // Gallery spot — soft warm radial from above-centre. The painting is hung in a room.
  drawGallerySpot() {
    const cx = this.W / 2, cy = this.H * 0.05;
    const r = Math.max(this.W, this.H) * 0.7;
    const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(255, 220, 180, 0.10)');
    grad.addColorStop(0.5, 'rgba(255, 210, 170, 0.04)');
    grad.addColorStop(1, 'rgba(220, 180, 140, 0)');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  // Linen weave — fine canvas-grain tile across the whole bg. Cached as a
  // Pattern; single fillRect per frame. The colour-field paintings sit on
  // actual canvas.
  drawLinenWeave() {
    if (!this._linenPattern) {
      const tile = document.createElement('canvas');
      tile.width = 8; tile.height = 8;
      const tc = tile.getContext('2d');
      tc.strokeStyle = 'rgba(220, 180, 150, 0.05)';
      tc.lineWidth = 1;
      tc.beginPath();
      tc.moveTo(0, 1.5); tc.lineTo(4, 1.5);
      tc.moveTo(4, 5.5); tc.lineTo(8, 5.5);
      tc.moveTo(2.5, 2); tc.lineTo(2.5, 6);
      tc.moveTo(6.5, 0); tc.lineTo(6.5, 2);
      tc.moveTo(6.5, 6); tc.lineTo(6.5, 8);
      tc.stroke();
      this._linenPattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._linenPattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  // Render a soft-edged rect bleeding on all four sides via two-axis alpha masking.
  // Why two passes on an offscreen canvas: destination-in on the main canvas would
  // erase already-drawn content from neighbouring bands.
  bleedRect(r, g, bl, alpha, x, y, w, h, bleedH, bleedV) {
    if (!this._off) this._off = document.createElement('canvas');
    const off = this._off;
    off.width = Math.max(1, Math.ceil(w));
    off.height = Math.max(1, Math.ceil(h));
    const oc = off.getContext('2d');
    oc.fillStyle = `rgba(${r},${g},${bl},${alpha})`;
    oc.fillRect(0, 0, off.width, off.height);
    oc.globalCompositeOperation = 'destination-in';
    const vT1 = bleedV / off.height, vT2 = 1 - vT1;
    const vG = oc.createLinearGradient(0, 0, 0, off.height);
    vG.addColorStop(0, 'rgba(0,0,0,0)'); vG.addColorStop(vT1, 'rgba(0,0,0,1)');
    vG.addColorStop(vT2, 'rgba(0,0,0,1)'); vG.addColorStop(1, 'rgba(0,0,0,0)');
    oc.fillStyle = vG; oc.fillRect(0, 0, off.width, off.height);
    const hT1 = bleedH / off.width, hT2 = 1 - hT1;
    const hG = oc.createLinearGradient(0, 0, off.width, 0);
    hG.addColorStop(0, 'rgba(0,0,0,0)'); hG.addColorStop(hT1, 'rgba(0,0,0,1)');
    hG.addColorStop(hT2, 'rgba(0,0,0,1)'); hG.addColorStop(1, 'rgba(0,0,0,0)');
    oc.fillStyle = hG; oc.fillRect(0, 0, off.width, off.height);
    oc.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(off, x, y);
  }

  recalcBands() {
    const topicCounts = {}, topicConfidence = {};
    this.nodes.forEach(n => { topicCounts[n.topic] = (topicCounts[n.topic] || 0) + 1; topicConfidence[n.topic] = Math.max(topicConfidence[n.topic] || 0, n.confidence); });
    const topicList = this.topics.map(t => t.id).filter(id => topicCounts[id]);
    const total = topicList.reduce((s, id) => s + topicCounts[id], 0) || 1;
    this.bands = [];
    let y = 0;
    const margin = this.H * 0.03;
    const usable = this.H - margin * 2 - (topicList.length - 1) * 8;
    topicList.forEach((id) => {
      const info = this.topicInfo(id);
      const weight = topicCounts[id] / total;
      const h = Math.max(30, usable * weight);
      const confidence = topicConfidence[id] || 0.5;
      const hasDead = this.nodes.some(n => n.topic === id && n.type === 'dead-end');
      const hasResolution = this.nodes.some(n => n.topic === id && n.type === 'resolution');
      const bandNodes = this.nodes.filter(n => n.topic === id);
      // heat aggregation — mean heat across band's nodes (0 if none have it)
      let heatSum = 0, heatN = 0;
      bandNodes.forEach(n => { if (typeof n.heat === 'number') { heatSum += n.heat; heatN++; } });
      const avgHeat = heatN > 0 ? heatSum / heatN : 0;
      // pivot count — nodes in this band with ≥3 inbound refs
      const pivotCount = bandNodes.filter(n => this.nodeIncoming(n.id) >= 3).length;
      // dominant stance across band's nodes (for edge softness)
      const stanceCounts = {};
      bandNodes.forEach(n => { if (n.stance) stanceCounts[n.stance] = (stanceCounts[n.stance] || 0) + 1; });
      let domStance = null, domN = 0;
      for (const [s, c] of Object.entries(stanceCounts)) if (c > domN) { domN = c; domStance = s; }
      this.bands.push({
        y: margin + y, height: h, color: info.color, rgb: hexToRgb(info.color),
        saturation: hasDead ? 0.3 : 0.5 + confidence * 0.5,
        topic: id, glow: hasResolution,
        targetY: margin + y, targetH: h,
        nodes: bandNodes,
        avgHeat, pivotCount, domStance,
      });
      y += h + 8;
    });
    // compute per-boundary ref-bleed — count refs where source's topic and
    // target's topic are adjacent-band neighbours. Stored on the boundary record.
    for (let i = 0; i < this.bands.length - 1; i++) {
      const a = this.bands[i], b = this.bands[i + 1];
      let aToB = 0, bToA = 0;
      a.nodes.forEach(n => {
        if (!Array.isArray(n.refs)) return;
        n.refs.forEach(rid => {
          const tgt = this.nodes.find(x => x.id === rid);
          if (tgt && tgt.topic === b.topic) aToB++;
        });
      });
      b.nodes.forEach(n => {
        if (!Array.isArray(n.refs)) return;
        n.refs.forEach(rid => {
          const tgt = this.nodes.find(x => x.id === rid);
          if (tgt && tgt.topic === a.topic) bToA++;
        });
      });
      a._bleedDown = aToB;        // A's colour bleeds down into top of B
      b._bleedUp = bToA;          // B's colour bleeds up into bottom of A
    }
  }

  draw() {
    if (this.app.isPaused()) return;
    const ht = this.app.highlightedTopic;
    this.simulatePrime();
    this.ctx.fillStyle = '#1a0a0a'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawLinenWeave();
    this.drawUnderpainting();
    this.drawGallerySpot();
    this.drawGhostBands();
    const pad = this.W * 0.08;
    this.bands.forEach((b, idx) => {
      b.y += (b.targetY - b.y) * 0.08;
      b.height += (b.targetH - b.height) * 0.08;
      const [r, g, bl] = b.rgb;
      // heat → saturation lift (stronger — was +20%, now +45%)
      const heatMul = 1 + b.avgHeat * 0.45;                  // 1.0 … 1.45
      const satBase = b.saturation * heatMul;
      // stance → edge softness modifier. claiming = sharper (fewer blur
      // layers at full expand), exploring = wider bleed, questioning = pulsing
      // edge alpha via sin(time), conceding = more faded edges.
      const t = performance.now() * 0.001;
      const stanceEdgeSpread = (b.domStance === 'exploring') ? 1.35 : (b.domStance === 'claiming') ? 0.75 : 1;
      const stancePulse = (b.domStance === 'questioning') ? (1 + Math.sin(t * 0.9) * 0.15) : 1;
      const stanceEdgeAlpha = (b.domStance === 'conceding') ? 0.7 : 1;
      const bleedV = 40 * stanceEdgeSpread;
      const bleedH = 30 * stanceEdgeSpread;
      const offX = pad - bleedH;
      const offY = b.y - bleedV;
      const offW = this.W - pad * 2 + bleedH * 2;
      const offH = b.height + bleedV * 2;
      const coreA = satBase * 0.7 * stanceEdgeAlpha * stancePulse;
      this.bleedRect(r, g, bl, Math.max(0, coreA), offX, offY, offW, offH, bleedH, bleedV);
      if (b.glow) {
        const cx = this.W / 2, cy = b.y + b.height / 2;
        const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, b.height);
        grad.addColorStop(0, `rgba(${r},${g},${bl},0.15)`); grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
        this.ctx.fillStyle = grad; this.ctx.fillRect(pad, b.y, this.W - pad * 2, b.height);
      }
      // pivot centre darken — if the band contains pivot nodes (≥3 inbound),
      // apply a faint darker vertical gradient at the band's centre line.
      // Very subtle — like a slight gravitational well in the colour field.
      if (b.pivotCount > 0) {
        const intensity = Math.min(1, b.pivotCount / 3);    // 1 pivot = 0.33, 3+ = 1.0
        const cy = b.y + b.height / 2;
        const halfH = Math.min(b.height * 0.45, 90);         // wider well (was 0.35, 60)
        const grad = this.ctx.createLinearGradient(0, cy - halfH, 0, cy + halfH);
        grad.addColorStop(0, `rgba(0,0,0,0)`);
        grad.addColorStop(0.5, `rgba(0,0,0,${0.22 * intensity})`); // darker centre (was 0.08)
        grad.addColorStop(1, `rgba(0,0,0,0)`);
        this.ctx.fillStyle = grad;
        this.ctx.fillRect(pad + 4, cy - halfH, this.W - pad * 2 - 8, halfH * 2);
      }
      // ref bleed — if this band has refs into the next band, let A's colour
      // bleed DOWN into the top of B (gradient fading inward). Tone-safe: no
      // hard lines, just a faint colour wash near the boundary.
      const nextBand = this.bands[idx + 1];
      if (nextBand && b._bleedDown > 0) {
        const bleedIntensity = Math.min(1, b._bleedDown / 3);
        const bleedDepth = Math.min(nextBand.height * 0.55, 70);  // deeper (was 0.4, 36)
        const grad = this.ctx.createLinearGradient(0, nextBand.y, 0, nextBand.y + bleedDepth);
        grad.addColorStop(0, `rgba(${r},${g},${bl},${0.38 * bleedIntensity})`);  // stronger (was 0.18)
        grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
        this.ctx.fillStyle = grad;
        this.ctx.fillRect(pad + 4, nextBand.y, this.W - pad * 2 - 8, bleedDepth);
      }
      // Symmetric upward bleed from B into bottom of A
      if (nextBand && nextBand._bleedUp > 0) {
        const [nr, ng, nbl] = nextBand.rgb;
        const bleedIntensity = Math.min(1, nextBand._bleedUp / 3);
        const bleedDepth = Math.min(b.height * 0.55, 70);
        const bottomY = b.y + b.height;
        const grad = this.ctx.createLinearGradient(0, bottomY, 0, bottomY - bleedDepth);
        grad.addColorStop(0, `rgba(${nr},${ng},${nbl},${0.38 * bleedIntensity})`);
        grad.addColorStop(1, `rgba(${nr},${ng},${nbl},0)`);
        this.ctx.fillStyle = grad;
        this.ctx.fillRect(pad + 4, bottomY - bleedDepth, this.W - pad * 2 - 8, bleedDepth);
      }
      // stance → noise-dot texture variation. Uses the existing noise layer
      // (sits off the main colour field, so amplifying it is tone-safe in a way
      // that edge amplification isn't).
      let dotCount = 40, dotSize = 2, dotBaseAlpha = 0.03;
      if (b.domStance === 'claiming') {          // dense crisp dots — solid, settled
        dotCount = 60; dotSize = 2; dotBaseAlpha = 0.05;
      } else if (b.domStance === 'exploring') {  // fewer, larger dots — roomier, less resolved
        dotCount = 22; dotSize = 3; dotBaseAlpha = 0.05;
      } else if (b.domStance === 'questioning') {// pulsing alpha — unresolved
        dotCount = 40; dotSize = 2;
        dotBaseAlpha = 0.025 + (Math.sin(t * 0.8) + 1) * 0.02;   // 0.025 … 0.065
      } else if (b.domStance === 'conceding') {  // sparse, faded — fading
        dotCount = 14; dotSize = 2; dotBaseAlpha = 0.018;
      }
      this.ctx.globalAlpha = dotBaseAlpha;
      for (let i = 0; i < dotCount; i++) {
        const nx = pad + Math.random() * (this.W - pad * 2), ny = b.y + Math.random() * b.height;
        this.ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
        this.ctx.fillRect(nx, ny, dotSize, dotSize);
      }
      this.ctx.globalAlpha = 1;

      // Hover — bleed edges outward gently into neighbours
      if (b === this.hoveredBand) {
        for (let layer = 0; layer < 12; layer++) {
          const expand = 20 + layer * 8;
          const alpha = b.saturation * (0.025 - layer * 0.0015);
          if (alpha <= 0) continue;
          this.ctx.fillStyle = `rgba(${r},${g},${bl},${alpha})`;
          this.ctx.fillRect(pad - expand, b.y - expand, this.W - pad * 2 + expand * 2, b.height + expand * 2);
        }
      }
    });
  }

  // ─── private event handlers ──────────────────────────────────────────────────

  #onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const pad = this.W * 0.08;
    const inBandX = mx >= pad && mx <= this.W - pad;
    let found = null;
    if (inBandX) {
      this.bands.forEach(b => { if (my >= b.y && my <= b.y + b.height) found = b; });
    }
    this.hoveredBand = found;
    if (found) {
      const frac = (mx - pad) / (this.W - pad * 2);
      const idx = Math.min(found.nodes.length - 1, Math.floor(frac * found.nodes.length));
      const n = found.nodes[Math.max(0, idx)];
      if (n) { showTooltip(e, n, found.color); this.app.highlightLegendTopic(n.topic); }
    } else { hideTooltip(); this.app.highlightLegendTopic(null); }
  }

  #onClick(e) {
    if (!this.primePhase) return;
    const rect = this.canvas.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const g = this.ghostBandAtY(my);
    if (g) this.cycleGhostTone(g);
  }
}

export { MarkoMode };
