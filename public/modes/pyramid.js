import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, nodeBy, relColor, relGlyph } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const TIER_LABELS = ['ANSWER', 'ARGUMENTS', 'SUPPORTING CLAIMS', 'EVIDENCE & ASIDES'];
const STONE_W = 16, STONE_H = 10, STONE_GAP = 2;

class PyramidMode extends Mode {
  primePhase = false;
  plannedStones = [];
  nextStoneIdx = 0;
  spawnTimer = 0;
  tierRevealAlpha = 1.0;
  threadFocus = null;
  tierLock = null;
  apexHover = false;
  tierOverrides = new Map();

  constructor() {
    super({
      mode: 'pyramid',
      aesthetic: 'classical',
      topicFallbackColor: '#8f7e66',
      vars: {
        '--e-bg': '#ece5d3', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(168,112,24,0.08)', '--e-accent': '#5a3818',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    // Tier override promotion on graph complete
    onGraphComplete(({ incoming_refs }) => {
      this.incomingRefsMap = incoming_refs || {};
      this.tierOverrides.clear();
      for (const n of this.nodes) {
        const baseT = this.baseTierOf(n);
        const inc = (incoming_refs[n.id] || 0);
        let t = baseT;
        if (inc >= 3 && t > 1) t--;
        if (inc >= 6 && t > 1) t--;
        if (t !== baseT) this.tierOverrides.set(n, t);
      }
    });

    this.canvas.addEventListener('mousemove', e => {
      if (this.primePhase) { this.canvas.style.cursor = 'default'; return; }
      const node = this.nodeHitTest(e.clientX, e.clientY);
      const tier = this.tierLabelHitTest(e.clientX, e.clientY);
      this.apexHover = !!(node && this.tierOf(node) === 0);
      if (node) {
        if (this.apexHover) hideTooltip();
        else showTooltip(e, node, this.topicInfo(node.topic).color);
        this.app.highlightLegendTopic(node.topic);
        this.canvas.style.cursor = 'pointer';
      } else if (tier !== null) { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'pointer'; }
      else { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'default'; }
    });
    this.canvas.addEventListener('mouseleave', () => { this.apexHover = false; });
    this.canvas.addEventListener('click', e => {
      if (this.primePhase) return;
      const node = this.nodeHitTest(e.clientX, e.clientY);
      if (node) { this.threadFocus = (this.threadFocus === node) ? null : node; this.tierLock = null; return; }
      const tier = this.tierLabelHitTest(e.clientX, e.clientY);
      if (tier !== null) { this.tierLock = (this.tierLock === tier) ? null : tier; this.threadFocus = null; return; }
      this.threadFocus = null; this.tierLock = null;
    });
  }

  nodeIncoming(n) { return n.id != null ? (this.incomingRefsMap[n.id] ?? incomingRefsOf(n.id, this.nodes)) : 0; }
  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('classical');
      pickSessionKey(this.app.prompt() || 'pyramid');
    });
  }

  scaleNote(degree) {
    const key = getSessionKey();
    const len = key.notes.length;
    const oct = Math.floor(degree / len) * 12;
    return key.notes[((degree % len) + len) % len] + oct;
  }

  tierDrone(midi, dur, vol) {
    return playSynth({ midi, wave: 'triangle', voices: 2, detune: 12, attack: 0.8, decay: 0.5, sustain: 0.75, release: 1.2, duration: dur, vol, filter: { type: 'lowpass', freq: 900, Q: 0.5 }, reverbSend: 0.5 });
  }

  tierBell(midi, dur, vol) {
    return playSynth({ midi, ...PRESETS.bell, duration: dur, vol, reverbSend: 0.4 });
  }

  baseTierOf(n) {
    if (n.type === 'resolution' && (n.topic === 'synthesis' || n.topic === 'conclusion')) return 0;
    if (n.type === 'resolution' || n.type === 'choice') return 1;
    if (n.type === 'claim') return 2;
    return 3;
  }

  tierOf(n) { return this.tierOverrides.has(n) ? this.tierOverrides.get(n) : this.baseTierOf(n); }

  playTierVoice(node) {
    const tier = this.tierOf(node);
    if (tier === 3) this.tierDrone(this.scaleNote(0) - 24, 4.0, 0.06);
    else if (tier === 2) this.tierDrone(this.scaleNote(4) - 12, 3.5, 0.06);
    else if (tier === 1) this.tierDrone(this.scaleNote(0), 3.0, 0.06);
    else if (tier === 0) this.tierBell(this.scaleNote(4) + 12, 2.0, 0.10);
  }

  computePyramidStones() {
    const padX = Math.max(100, this.sideBuffer()), padT = 100, padB = 60;
    const cx = this.W / 2, topY = padT + 40, baseY = this.H - padB, totalH = baseY - topY;
    const maxBaseW = Math.min(this.W - padX * 2, 900), rowHeight = STONE_H + STONE_GAP;
    const rowCount = Math.max(4, Math.floor(totalH / rowHeight));
    const stones = [];
    for (let row = 0; row < rowCount; row++) {
      const yCenter = baseY - (row + 0.5) * rowHeight, frac = (rowCount - row) / rowCount;
      const rowWidth = maxBaseW * frac, stonesInRow = Math.max(1, Math.floor(rowWidth / (STONE_W + STONE_GAP)));
      const actualWidth = stonesInRow * (STONE_W + STONE_GAP) - STONE_GAP, startX = cx - actualWidth / 2;
      for (let s = 0; s < stonesInRow; s++) {
        stones.push({ x: startX + s * (STONE_W + STONE_GAP), y: yCenter - STONE_H / 2, w: STONE_W, h: STONE_H, row, visible: false, dropAge: 0, fadingOut: false, fadeAge: 0 });
      }
    }
    return stones;
  }

  startPrime() {
    this.primePhase = true; this.plannedStones = this.computePyramidStones();
    this.nextStoneIdx = 0; this.spawnTimer = 6; this.tierRevealAlpha = 0.18;
    this._unpackLabels = [];
  }

  stopPrime() { this.primePhase = false; for (const s of this.plannedStones) if (s.visible) s.fadingOut = true; }

  simulatePrime() {
    const target = this.primePhase ? 0.18 : 1.0;
    this.tierRevealAlpha += (target - this.tierRevealAlpha) * 0.1;
    if (this.primePhase) {
      this.spawnTimer--;
      if (this.spawnTimer <= 0 && this.nextStoneIdx < this.plannedStones.length) {
        this.plannedStones[this.nextStoneIdx].visible = true; this.plannedStones[this.nextStoneIdx].dropAge = 0;
        this.nextStoneIdx++; this.spawnTimer = 7 + Math.floor(Math.random() * 3);
      }
    }
    for (const s of this.plannedStones) { if (s.visible) { s.dropAge++; if (s.fadingOut) s.fadeAge++; } }
  }

  drawStones() {
    if (this.plannedStones.length === 0) return;
    for (const stone of this.plannedStones) {
      if (!stone.visible) continue;
      const t = Math.min(1, stone.dropAge / 12), eased = 1 - Math.pow(1 - t, 3), dropOffset = -8 * (1 - eased);
      let alpha = 0.78;
      if (stone.fadingOut) alpha *= Math.max(0, 1 - stone.fadeAge / 15);
      if (alpha < 0.02) continue;
      const y = stone.y + dropOffset;
      this.ctx.fillStyle = `rgba(228, 179, 102, ${alpha})`; this.ctx.fillRect(stone.x, y, stone.w, stone.h);
      this.ctx.fillStyle = `rgba(169, 130, 69, ${alpha})`; this.ctx.fillRect(stone.x, y + stone.h - 1, stone.w, 1);
    }
  }

  computeLayout() {
    const padX = Math.max(100, this.sideBuffer()), padT = 100, padB = 60;
    const cx = this.W / 2, topY = padT + 40, baseY = this.H - padB, totalH = baseY - topY;
    const tierH = totalH / 4, maxBaseW = Math.min(this.W - padX * 2, 900);
    const pyramid = [0, 1, 2, 3].map(i => ({ i, yTop: topY + i / 4 * totalH, yBot: topY + (i + 1) / 4 * totalH, wTop: maxBaseW * i / 4, wBot: maxBaseW * (i + 1) / 4 }));
    const positions = new Map();
    const perTier = [[], [], [], []];
    for (const n of this.nodes) perTier[this.tierOf(n)].push(n);
    perTier.forEach((arr, ti) => {
      const tier = pyramid[ti], midY = (tier.yTop + tier.yBot) / 2, availW = (tier.wTop + tier.wBot) / 2 - 20;
      const n = Math.max(arr.length, 1), cardW = Math.min(180, availW / n - 8);
      const totalCardsW = cardW * n + 8 * (n - 1), startX = cx - totalCardsW / 2;
      arr.forEach((nd, i) => positions.set(nd, { x: startX + i * (cardW + 8), y: midY - 20, w: cardW, h: 40 }));
    });
    return { pyramid, positions, cx, topY, baseY, maxBaseW };
  }

  getThreadSet() {
    if (!this.threadFocus) return { ancestors: new Set(), descendants: new Set() };
    const ancestors = new Set(), descendants = new Set();
    for (const refId of (this.threadFocus.refs || [])) { const a = this.nodes.find(x => x.id === refId); if (a) ancestors.add(a); }
    for (const other of this.nodes) { if (other === this.threadFocus) continue; if (other.refs && other.refs.includes(this.threadFocus.id)) descendants.add(other); }
    return { ancestors, descendants };
  }

  getNodeDim(node) {
    if (this.threadFocus) { if (node === this.threadFocus) return 1; const { ancestors, descendants } = this.getThreadSet(); if (ancestors.has(node) || descendants.has(node)) return 1; return 0.2; }
    if (this.tierLock !== null) return this.tierOf(node) === this.tierLock ? 1 : 0.22;
    return 1;
  }

  getTierDim(ti) {
    if (this.tierLock !== null) return this.tierLock === ti ? 1 : 0.24;
    if (this.threadFocus) {
      const { ancestors, descendants } = this.getThreadSet();
      const related = new Set([this.threadFocus, ...ancestors, ...descendants]);
      const anyInTier = this.nodes.some(n => this.tierOf(n) === ti && related.has(n));
      return anyInTier ? 1 : 0.45;
    }
    return 1;
  }

  drawArc(x1, y1, x2, y2, rel) {
    const col = relColor(rel), mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1, len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const bend = Math.min(36, len * 0.18), bx = mx + (-dy / len) * bend, by = my + (dx / len) * bend;
    this.ctx.strokeStyle = col; this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(bx, by, x2, y2); this.ctx.stroke();
  }

  drawThreadLines(positions) {
    if (!this.threadFocus) return;
    const fp = positions.get(this.threadFocus); if (!fp) return;
    const fcx = fp.x + fp.w / 2, fcy = fp.y + fp.h / 2;
    this.ctx.setLineDash([4, 4]); this.ctx.lineWidth = 1.5;
    for (const refId of (this.threadFocus.refs || [])) {
      const anc = this.nodes.find(x => x.id === refId); if (!anc) continue;
      const ap = positions.get(anc); if (!ap) continue;
      this.drawArc(fcx, fcy, ap.x + ap.w / 2, ap.y + ap.h / 2, this.threadFocus.rel);
    }
    for (const other of this.nodes) {
      if (other === this.threadFocus) continue;
      if (other.refs && other.refs.includes(this.threadFocus.id)) {
        const op = positions.get(other); if (!op) continue;
        this.drawArc(op.x + op.w / 2, op.y + op.h / 2, fcx, fcy, other.rel);
      }
    }
    this.ctx.setLineDash([]);
  }

  drawAmbientArcs(positions) {
    if (this.threadFocus || !this.sessionHasRefs()) return;
    this.ctx.setLineDash([3, 4]); this.ctx.lineWidth = 1;
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      const sp = positions.get(src); if (!sp) continue;
      const sInfo = this.topicInfo(src.topic);
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.nodes); if (!tgt || tgt === src) continue;
        const tp = positions.get(tgt); if (!tp) continue;
        const x1 = sp.x + sp.w / 2, y1 = sp.y + sp.h / 2, x2 = tp.x + tp.w / 2, y2 = tp.y + tp.h / 2;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
        const len = Math.max(1, Math.sqrt(dx * dx + dy * dy)), bend = Math.min(30, len * 0.15);
        const bx = mx + (-dy / len) * bend, by = my + (dx / len) * bend;
        this.ctx.strokeStyle = sInfo.color; this.ctx.globalAlpha = 0.32;
        this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(bx, by, x2, y2); this.ctx.stroke();
        if (len >= 80) {
          const qmx = (x1 + 2 * bx + x2) / 4, qmy = (y1 + 2 * by + y2) / 4, glyph = relGlyph(src.rel);
          if (glyph) { this.ctx.globalAlpha = 0.85; this.ctx.font = "700 9px 'JetBrains Mono', monospace"; this.ctx.fillStyle = '#463730'; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(glyph, qmx, qmy); }
        }
      }
    }
    this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
  }

  drawApexCallout(positions) {
    if (!this.apexHover) return;
    const apex = this.nodes.find(n => this.tierOf(n) === 0); if (!apex) return;
    const pos = positions.get(apex); if (!pos) return;
    const prompt = (this.app.prompt && this.app.prompt()) || '(no prompt)';
    const tierCount = new Set(this.nodes.map(n => this.tierOf(n))).size;
    const meta = `${this.nodes.length} thoughts · ${tierCount} tiers`;
    const calloutW = 280, padX_c = 12, padY_c = 10, lineH = 16;
    this.ctx.font = "500 12px 'Space Grotesk', sans-serif";
    const lines = []; let line = '';
    for (const w of prompt.split(' ')) { const test = line ? line + ' ' + w : w; if (this.ctx.measureText(test).width > calloutW - padX_c * 2 && line) { lines.push(line); line = w; if (lines.length >= 3) break; } else line = test; }
    if (line && lines.length < 3) lines.push(line);
    if (lines.length === 3 && this.ctx.measureText(lines[2] + ' ' + (prompt.split(' ').pop() || '')).width > calloutW - padX_c * 2) {
      while (this.ctx.measureText(lines[2] + '…').width > calloutW - padX_c * 2 && lines[2].length > 4) lines[2] = lines[2].slice(0, -1);
      lines[2] += '…';
    }
    const calloutH = lines.length * lineH + padY_c * 2 + 22;
    let cx_ = pos.x + pos.w + 14;
    if (cx_ + calloutW > this.W - this.sideBuffer()) cx_ = pos.x - calloutW - 14;
    const cy_ = Math.max(20, pos.y - 8);
    this.ctx.strokeStyle = '#a9822a'; this.ctx.lineWidth = 1;
    this.ctx.beginPath(); const pointerX = cx_ > pos.x ? cx_ : cx_ + calloutW;
    this.ctx.moveTo(pos.x + pos.w / 2, pos.y + pos.h / 2); this.ctx.lineTo(pointerX, cy_ + 22); this.ctx.stroke();
    this.ctx.fillStyle = 'rgba(35, 30, 22, 0.94)'; this.ctx.strokeStyle = '#a9822a'; this.ctx.lineWidth = 1;
    this.ctx.fillRect(cx_, cy_, calloutW, calloutH); this.ctx.strokeRect(cx_, cy_, calloutW, calloutH);
    this.ctx.fillStyle = '#fffbe6'; this.ctx.font = "500 12px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    lines.forEach((l, i) => this.ctx.fillText(l, cx_ + padX_c, cy_ + padY_c + i * lineH));
    this.ctx.fillStyle = 'rgba(255, 251, 230, 0.55)'; this.ctx.font = "400 10px 'JetBrains Mono', monospace";
    this.ctx.fillText(meta, cx_ + padX_c, cy_ + padY_c + lines.length * lineH + 6);
  }

  nodeHitTest(mx, my) {
    const { positions } = this.computeLayout();
    for (const node of this.nodes) { const pos = positions.get(node); if (!pos) continue; if (mx > pos.x && mx < pos.x + pos.w && my > pos.y && my < pos.y + pos.h) return node; }
    return null;
  }

  tierLabelHitTest(mx, my) {
    const { pyramid, cx } = this.computeLayout();
    this.ctx.font = "700 10px 'JetBrains Mono', monospace";
    for (let i = 0; i < pyramid.length; i++) {
      const tier = pyramid[i], labelText = TIER_LABELS[i], w = this.ctx.measureText(labelText).width;
      const labelY = (tier.yTop + tier.yBot) / 2, rightX = cx - tier.wBot / 2 - 20, leftX = rightX - w;
      if (mx > leftX - 8 && mx < rightX + 8 && my > labelY - 9 && my < labelY + 9) return i;
    }
    return null;
  }

  wrapText(text, x, y, maxW, lineH, maxLines) {
    const words = text.split(' '); let line = '', yy = y, lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (this.ctx.measureText(test).width > maxW && line) {
        this.ctx.fillText(line, x, yy); line = w; yy += lineH; lines++;
        if (lines >= maxLines) { this.ctx.fillText(line.slice(0, 28) + '…', x, yy); return; }
      } else line = test;
    }
    if (line) this.ctx.fillText(line, x, yy);
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: fill the lowest tier's placeholder slots with token text,
  // giving the pyramid a faint foundation of words before real nodes land.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    this._unpackLabels = tokens; // stored for drawing below
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.playTierVoice(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.plannedStones = []; this.nextStoneIdx = 0; this.tierRevealAlpha = 1.0;
    this.threadFocus = null; this.tierLock = null; this.apexHover = false;
    this.tierOverrides.clear(); this._unpackLabels = [];
    if (this.primePhase) this.stopPrime();
    this.primePhase = false;
  }

  // Drafting blueprint — faint architectural grid (24px minor / 96px major)
  // plus measurement ticks at all four edges. Designed before built. Cached.
  drawDraftingBlueprint() {
    if (!this._draftOff || this._draftW !== this.W || this._draftH !== this.H) {
      if (!this._draftOff) this._draftOff = document.createElement('canvas');
      this._draftOff.width = Math.max(1, Math.ceil(this.W));
      this._draftOff.height = Math.max(1, Math.ceil(this.H));
      this._draftW = this.W; this._draftH = this.H;
      const oc = this._draftOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.strokeStyle = 'rgba(70, 50, 30, 0.05)';
      oc.lineWidth = 0.5;
      for (let x = 0; x <= this.W; x += 24) { oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, this.H); oc.stroke(); }
      for (let y = 0; y <= this.H; y += 24) { oc.beginPath(); oc.moveTo(0, y); oc.lineTo(this.W, y); oc.stroke(); }
      oc.strokeStyle = 'rgba(70, 50, 30, 0.10)';
      oc.lineWidth = 0.7;
      for (let x = 0; x <= this.W; x += 96) { oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, this.H); oc.stroke(); }
      for (let y = 0; y <= this.H; y += 96) { oc.beginPath(); oc.moveTo(0, y); oc.lineTo(this.W, y); oc.stroke(); }
      oc.strokeStyle = 'rgba(70, 50, 30, 0.30)';
      oc.lineWidth = 1;
      for (let x = 48; x < this.W; x += 48) {
        const len = (x % 192 === 0) ? 14 : 7;
        oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, len); oc.stroke();
        oc.beginPath(); oc.moveTo(x, this.H); oc.lineTo(x, this.H - len); oc.stroke();
      }
      for (let y = 48; y < this.H; y += 48) {
        const len = (y % 192 === 0) ? 14 : 7;
        oc.beginPath(); oc.moveTo(0, y); oc.lineTo(len, y); oc.stroke();
        oc.beginPath(); oc.moveTo(this.W, y); oc.lineTo(this.W - len, y); oc.stroke();
      }
    }
    this.ctx.drawImage(this._draftOff, 0, 0);
  }

  // Aged-paper warmth — uneven yellowed patches at session-fixed positions,
  // peak 5–10% alpha. Layered on top of the sandstone grain.
  drawAgedPatches() {
    if (!this._agedPatches) {
      this._agedPatches = [];
      const tints = ['205, 165, 95', '215, 175, 105', '195, 155, 80', '225, 185, 110'];
      const count = 5 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        this._agedPatches.push({
          fx: Math.random(),
          fy: Math.random(),
          fr: 0.10 + Math.random() * 0.10,
          tint: tints[i % tints.length],
          alpha: 0.05 + Math.random() * 0.05,
        });
      }
    }
    for (const p of this._agedPatches) {
      const cx = p.fx * this.W, cy = p.fy * this.H;
      const r = p.fr * Math.max(this.W, this.H);
      const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${p.tint}, ${p.alpha})`);
      g.addColorStop(0.5, `rgba(${p.tint}, ${p.alpha * 0.4})`);
      g.addColorStop(1, `rgba(${p.tint}, 0)`);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  // Sandstone grain — sparse three-tone speckle (rust / warm sand / light
  // cream) tile, cached as a Pattern. The pyramid is built of stone.
  drawSandstoneGrain() {
    if (!this._sandstonePattern) {
      const tile = document.createElement('canvas');
      tile.width = 96; tile.height = 96;
      const tc = tile.getContext('2d');
      const id = tc.createImageData(96, 96);
      for (let i = 0; i < 96 * 96; i++) {
        if (Math.random() < 0.10) {
          const v = Math.random();
          if (v < 0.4) {
            id.data[i * 4 + 0] = 140 + Math.random() * 30;
            id.data[i * 4 + 1] = 100 + Math.random() * 25;
            id.data[i * 4 + 2] = 60 + Math.random() * 20;
          } else if (v < 0.7) {
            id.data[i * 4 + 0] = 200 + Math.random() * 30;
            id.data[i * 4 + 1] = 175 + Math.random() * 25;
            id.data[i * 4 + 2] = 130 + Math.random() * 20;
          } else {
            id.data[i * 4 + 0] = 235 + Math.random() * 20;
            id.data[i * 4 + 1] = 220 + Math.random() * 20;
            id.data[i * 4 + 2] = 195 + Math.random() * 15;
          }
          id.data[i * 4 + 3] = 30 + Math.random() * 40;
        }
      }
      tc.putImageData(id, 0, 0);
      this._sandstonePattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._sandstonePattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.ctx.fillStyle = '#ece5d3'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawSandstoneGrain();
    this.drawAgedPatches();
    this.drawDraftingBlueprint();
    this.simulatePrime();
    const { pyramid, positions, cx, topY, baseY, maxBaseW } = this.computeLayout();
    const ht = this.app.highlightedTopic;
    const tierFills = ['#a9822a', '#c89b45', '#e4b366', '#f1cf8e'];
    pyramid.forEach((tier, i) => {
      this.ctx.globalAlpha = this.tierRevealAlpha * this.getTierDim(i);
      this.ctx.fillStyle = tierFills[i];
      this.ctx.beginPath(); this.ctx.moveTo(cx - tier.wTop / 2, tier.yTop); this.ctx.lineTo(cx + tier.wTop / 2, tier.yTop); this.ctx.lineTo(cx + tier.wBot / 2, tier.yBot); this.ctx.lineTo(cx - tier.wBot / 2, tier.yBot); this.ctx.closePath(); this.ctx.fill();
      this.ctx.strokeStyle = '#463730'; this.ctx.lineWidth = 1; this.ctx.stroke();
      this.ctx.fillStyle = '#463730'; this.ctx.font = "700 10px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'middle';
      const labelY = (tier.yTop + tier.yBot) / 2, labelX = cx - tier.wBot / 2 - 20;
      this.ctx.fillText(TIER_LABELS[i], labelX, labelY);
      if (this.tierLock === i) { const lw = this.ctx.measureText(TIER_LABELS[i]).width; this.ctx.strokeStyle = '#463730'; this.ctx.lineWidth = 1.5; this.ctx.beginPath(); this.ctx.moveTo(labelX - lw, labelY + 8); this.ctx.lineTo(labelX, labelY + 8); this.ctx.stroke(); }
    });
    this.ctx.globalAlpha = 1;
    // Draw unpack token labels across the base of the pyramid during prime
    if (this.primePhase && this._unpackLabels && this._unpackLabels.length > 0) {
      const baseTier = pyramid[pyramid.length - 1];
      if (baseTier) {
        const alpha = 0.28 * this.tierRevealAlpha;
        this.ctx.globalAlpha = alpha;
        this.ctx.fillStyle = '#5a3818';
        this.ctx.font = "500 9px 'JetBrains Mono', monospace";
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
        const labelY = (baseTier.yTop + baseTier.yBot) / 2;
        const step = baseTier.wBot / (this._unpackLabels.length + 1);
        this._unpackLabels.forEach((tok, i) => {
          const lx = cx - baseTier.wBot / 2 + step * (i + 1);
          this.ctx.fillText(tok, lx, labelY);
        });
        this.ctx.globalAlpha = 1;
      }
    }
    this.drawStones(); this.drawAmbientArcs(positions); this.drawThreadLines(positions);
    for (const node of this.nodes) {
      const pos = positions.get(node); if (!pos) continue;
      const info = this.topicInfo(node.topic);
      const legendDim = ht && ht !== node.topic ? 0.25 : 1;
      this.ctx.globalAlpha = Math.min(legendDim, this.getNodeDim(node));
      const stance = node.stance, heatBorder = node.heat != null ? 1 + node.heat * 1.8 : 0;
      this.ctx.fillStyle = '#fffbe6';
      if (stance === 'conceding') this.ctx.fillStyle = 'rgba(255, 251, 230, 0.55)';
      this.ctx.fillRect(pos.x, pos.y, pos.w, pos.h);
      this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 1.5 + heatBorder;
      if (stance === 'exploring') this.ctx.setLineDash([3, 3]);
      this.ctx.strokeRect(pos.x, pos.y, pos.w, pos.h); this.ctx.setLineDash([]);
      this.ctx.fillStyle = info.color; this.ctx.fillRect(pos.x, pos.y, 4, pos.h);
      this.ctx.fillStyle = stance === 'conceding' ? 'rgba(10,10,10,0.55)' : 'rgba(10,10,10,0.9)';
      this.ctx.font = this.tierOf(node) === 0 ? "700 11px 'Cormorant Garamond', serif" : stance === 'claiming' ? "700 9.5px 'Space Grotesk', sans-serif" : stance === 'exploring' ? "400 9.5px 'Space Grotesk', sans-serif" : "500 9.5px 'Space Grotesk', sans-serif";
      this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
      this.wrapText(node.text, pos.x + 10, pos.y + 6, pos.w - 14, 11, 2);
      if (stance === 'conceding') { this.ctx.strokeStyle = 'rgba(10,10,10,0.5)'; this.ctx.lineWidth = 1; this.ctx.beginPath(); this.ctx.moveTo(pos.x + 10, pos.y + pos.h / 2); this.ctx.lineTo(pos.x + pos.w - 10, pos.y + pos.h / 2); this.ctx.stroke(); }
      if (stance === 'questioning') { this.ctx.fillStyle = 'rgba(150, 86, 162, 0.55)'; this.ctx.font = "700 7px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'top'; this.ctx.fillText('? PENDING', pos.x + pos.w - 4, pos.y + 3); }
      if (node.type === 'resolution') { this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 2; this.ctx.strokeRect(pos.x - 2, pos.y - 2, pos.w + 4, pos.h + 4); }
      if (this.tierOverrides.has(node)) { this.ctx.fillStyle = '#d4a332'; this.ctx.font = "700 11px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'top'; this.ctx.fillText('★', pos.x + pos.w - 4, pos.y + 2); }
      if (this.nodeHasExternalBecause(node)) { this.ctx.fillStyle = 'rgba(70, 55, 48, 0.62)'; this.ctx.font = "700 8px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'top'; this.ctx.fillText('↗', pos.x + pos.w - 4, pos.y + pos.h - 12); }
      if (node === this.threadFocus) { this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 2.5; this.ctx.strokeRect(pos.x - 3, pos.y - 3, pos.w + 6, pos.h + 6); }
    }
    this.ctx.globalAlpha = 1;
    this.drawApexCallout(positions);
  }
}

export { PyramidMode };
