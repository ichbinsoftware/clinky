import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, nodeBy, relColor } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, quantizeToKey } from '/synth.js';

class StickiesMode extends Mode {
  tilts = new Map();
  threadFocus = null;
  overridePos = new Map();
  mouseDownInfo = null;
  dragState = null;
  primePhase = false;
  padPos = { x: 0, y: 0 };
  padLayers = 10;
  padAlpha = 0;
  padTarget = 0;
  flyingStickies = [];
  placedBlanks = [];
  spawnTimer = 0;

  constructor() {
    super({
      mode: 'stickies',
      aesthetic: 'jazz',
      topicFallbackColor: '#ffd60a',
      vars: {
        '--e-bg': '#ffffff', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(205,33,60,0.08)', '--e-accent': '#cd213c',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousedown', e => {
      const mx = e.clientX, my = e.clientY;
      const hit = this.stickyHitTest(mx, my);
      this.mouseDownInfo = { x: mx, y: my, node: hit?.node ?? null, prePos: hit ? { x: hit.pos.x, y: hit.pos.y, tilt: hit.pos.tilt } : null };
    });
    this.canvas.addEventListener('mousemove', e => {
      const mx = e.clientX, my = e.clientY;
      if (this.mouseDownInfo && this.mouseDownInfo.node && !this.dragState) {
        const d = Math.hypot(mx - this.mouseDownInfo.x, my - this.mouseDownInfo.y);
        if (d > 5) { this.dragState = { node: this.mouseDownInfo.node, prePos: { ...this.mouseDownInfo.prePos }, offsetX: this.mouseDownInfo.prePos.x - this.mouseDownInfo.x, offsetY: this.mouseDownInfo.prePos.y - this.mouseDownInfo.y }; this.canvas.style.cursor = 'grabbing'; hideTooltip(); }
      }
      if (this.dragState) { this.overridePos.set(this.dragState.node, { x: mx + this.dragState.offsetX, y: my + this.dragState.offsetY, tilt: this.dragState.prePos.tilt }); return; }
      const hit = this.stickyHitTest(mx, my);
      if (hit) { showTooltip(e, hit.node, this.topicInfo(hit.node.topic).color); this.app.highlightLegendTopic(hit.node.topic); this.canvas.style.cursor = 'pointer'; }
      else { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'default'; }
    });
    this.canvas.addEventListener('mouseup', e => {
      const mx = e.clientX, my = e.clientY;
      if (this.dragState) {
        const { positions } = this.computeLayout();
        let target = null;
        for (const n of this.nodes) {
          if (n === this.dragState.node) continue;
          const pos = positions.get(n); if (!pos) continue;
          if (Math.abs(mx - pos.x) < pos.size/2 && Math.abs(my - pos.y) < pos.size/2) { target = { node: n, pos: { x: pos.x, y: pos.y, tilt: pos.tilt } }; break; }
        }
        if (target) { this.overridePos.set(target.node, { x: this.dragState.prePos.x, y: this.dragState.prePos.y, tilt: target.pos.tilt }); this.overridePos.set(this.dragState.node, { x: target.pos.x, y: target.pos.y, tilt: this.dragState.prePos.tilt }); }
        this.dragState = null; this.mouseDownInfo = null; this.canvas.style.cursor = 'default'; return;
      }
      if (this.mouseDownInfo) { const hit = this.stickyHitTest(mx, my); if (hit) this.threadFocus = (this.threadFocus === hit.node) ? null : hit.node; else this.threadFocus = null; this.mouseDownInfo = null; }
    });
    this.canvas.addEventListener('mouseleave', () => { if (this.dragState) { this.dragState = null; this.canvas.style.cursor = 'default'; } });
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
      setAesthetic('jazz');
      pickSessionKey(this.app.prompt() || 'stickies');
    });
  }

  lengthToMidi(lenPx) {
    const norm = Math.max(0, Math.min(1, (lenPx - 200) / (1500 - 200)));
    const raw = Math.round(78 - norm * 28);
    return quantizeToKey(raw);
  }

  playStringPluck(midi, rel) {
    switch (rel) {
      case 'supports': playSynth({ midi, ...PRESETS.pluck, vol: 0.13, reverbSend: 0.20 }); break;
      case 'contradicts': playSynth({ midi, ...PRESETS.pluck, vol: 0.13, voices: 2, detune: 15, reverbSend: 0.20 }); break;
      case 'synthesizes': playSynth({ midi, ...PRESETS.pluck, vol: 0.11, reverbSend: 0.20 }); playSynth({ midi: midi + 4, ...PRESETS.pluck, vol: 0.09, reverbSend: 0.20 }); break;
      case 'questions': playSynth({ midi, ...PRESETS.pluck, vol: 0.07, reverbSend: 0.15, filter: { type: 'lowpass', freq: 700, Q: 0.7 } }); break;
      case 'supersedes': playSynth({ midi, ...PRESETS.pluck, vol: 0.09, reverbSend: 0.10, decay: 0.04, release: 0.06 }); break;
      default: playSynth({ midi, ...PRESETS.pluck, vol: 0.11, reverbSend: 0.20 }); break;
    }
  }

  playRedStringPlucks(node) {
    if (!Array.isArray(node.refs) || node.refs.length === 0) return;
    const { positions } = this.computeLayout();
    const srcPos = positions.get(node); if (!srcPos) return;
    const rel = node.rel || 'supports';
    let i = 0;
    for (const refId of node.refs) {
      const tgt = nodeBy(refId, this.nodes); if (!tgt) continue;
      const tgtPos = positions.get(tgt); if (!tgtPos) continue;
      const len = Math.hypot(srcPos.x - tgtPos.x, srcPos.y - tgtPos.y);
      const midi = this.lengthToMidi(len);
      setTimeout(() => this.playStringPluck(midi, rel), i * 80);
      i++;
    }
  }

  startPrime() {
    this.primePhase = true;
    this.padPos = { x: 100, y: this.H - 100 };
    this.padLayers = 10; this.padTarget = 1; this.flyingStickies = []; this.placedBlanks = []; this.spawnTimer = 20;
  }

  stopPrime() { this.primePhase = false; this.padTarget = 0; }

  gridPositionFor(slotIdx) {
    const margin = Math.max(60, this.sideBuffer()), size = 130, gap = 16;
    const perRow = Math.max(2, Math.floor((this.W - margin * 2 + gap) / (size + gap)));
    const row = Math.floor(slotIdx / perRow), col = slotIdx % perRow;
    return { x: margin + col * (size + gap) + size / 2, y: margin + row * (size + gap) + size / 2 };
  }

  tearSticky() {
    if (this.padLayers <= 0) return;
    this.padLayers--;
    const slotIdx = this.placedBlanks.length + this.flyingStickies.length;
    const target = this.gridPositionFor(slotIdx);
    this.flyingStickies.push({ fromX: this.padPos.x, fromY: this.padPos.y, toX: target.x, toY: target.y, tilt: (Math.random() - 0.5) * 0.14, progress: 0, duration: 32, slotIdx });
  }

  simulatePrime() {
    this.padAlpha += (this.padTarget - this.padAlpha) * 0.1;
    if (this.primePhase) { this.spawnTimer--; if (this.spawnTimer <= 0 && this.padLayers > 0) { this.tearSticky(); this.spawnTimer = 78 + Math.floor(Math.random() * 30); } }
    for (let i = this.flyingStickies.length - 1; i >= 0; i--) {
      const f = this.flyingStickies[i]; f.progress++;
      if (f.progress >= f.duration) { this.placedBlanks.push({ x: f.toX, y: f.toY, tilt: f.tilt, size: 130, alpha: 1, slotIdx: f.slotIdx }); this.flyingStickies.splice(i, 1); }
    }
    for (let i = this.placedBlanks.length - 1; i >= 0; i--) {
      const p = this.placedBlanks[i];
      const realOccupies = p.slotIdx < this.nodes.length;
      const targetAlpha = (this.primePhase && !realOccupies) ? 1 : 0;
      p.alpha += (targetAlpha - p.alpha) * (realOccupies ? 0.22 : 0.08);
      if (p.alpha < 0.02 && !this.primePhase) this.placedBlanks.splice(i, 1);
    }
  }

  drawBlankSticky(x, y, size, tilt, alpha) {
    if (alpha < 0.02) return;
    this.ctx.save(); this.ctx.translate(x, y); this.ctx.rotate(tilt);
    this.ctx.globalAlpha = alpha * 0.22; this.ctx.fillStyle = '#000'; this.ctx.fillRect(-size/2 + 3, -size/2 + 5, size, size);
    this.ctx.globalAlpha = alpha; this.ctx.fillStyle = '#ebe4d2'; this.ctx.fillRect(-size/2, -size/2, size, size);
    this.ctx.fillStyle = `rgba(0,0,0,${alpha * 0.06})`; this.ctx.beginPath(); this.ctx.moveTo(size/2 - 14, size/2); this.ctx.lineTo(size/2, size/2); this.ctx.lineTo(size/2, size/2 - 14); this.ctx.closePath(); this.ctx.fill();
    this.ctx.restore();
  }

  drawPad() {
    if (this.padAlpha < 0.02 || this.padLayers <= 0) return;
    const size = 90, layerOffset = 0.7;
    for (let l = 0; l < this.padLayers; l++) {
      this.ctx.save(); this.ctx.translate(this.padPos.x, this.padPos.y - l * layerOffset); this.ctx.rotate(-0.04);
      if (l === 0) { this.ctx.globalAlpha = this.padAlpha * 0.22; this.ctx.fillStyle = '#000'; this.ctx.fillRect(-size/2 + 2, -size/2 + 4, size, size); }
      this.ctx.globalAlpha = this.padAlpha; this.ctx.fillStyle = '#ebe4d2'; this.ctx.fillRect(-size/2, -size/2, size, size);
      this.ctx.globalAlpha = this.padAlpha * 0.2; this.ctx.strokeStyle = '#888'; this.ctx.lineWidth = 0.4; this.ctx.strokeRect(-size/2, -size/2, size, size);
      this.ctx.restore();
    }
  }

  drawFlyingSticky(f) {
    const t = f.progress / f.duration, eased = t * (2 - t);
    const midX = (f.fromX + f.toX) / 2, peakY = Math.min(f.fromY, f.toY) - 70;
    const u = 1 - eased;
    const x = u * u * f.fromX + 2 * u * eased * midX + eased * eased * f.toX;
    const y = u * u * f.fromY + 2 * u * eased * peakY + eased * eased * f.toY;
    const spinTilt = f.tilt + Math.sin(t * Math.PI) * 0.08;
    const size = 130 * (0.8 + 0.2 * eased);
    this.drawBlankSticky(x, y, size, spinTilt, 1);
  }

  drawPrime() {
    this.drawPad();
    for (const p of this.placedBlanks) this.drawBlankSticky(p.x, p.y, p.size, p.tilt, p.alpha);
    for (const f of this.flyingStickies) this.drawFlyingSticky(f);
  }

  computeLayout() {
    const margin = Math.max(60, this.sideBuffer()), size = 130, gap = 16;
    const perRow = Math.max(2, Math.floor((this.W - margin * 2 + gap) / (size + gap)));
    const positions = new Map();
    this.nodes.forEach((n, i) => {
      if (!this.tilts.has(n)) this.tilts.set(n, (Math.random() - 0.5) * 0.14);
      const row = Math.floor(i / perRow), col = i % perRow;
      const gridX = margin + col * (size + gap) + size / 2, gridY = margin + row * (size + gap) + size / 2;
      const override = this.overridePos.get(n);
      positions.set(n, override ? { x: override.x, y: override.y, size, tilt: override.tilt ?? this.tilts.get(n) } : { x: gridX, y: gridY, size, tilt: this.tilts.get(n) });
    });
    return { positions };
  }

  getStickyDim(node) {
    if (!this.threadFocus) return 1;
    if (node === this.threadFocus) return 1;
    if (this.threadFocus.refs && this.threadFocus.refs.includes(node.id)) return 1;
    if (node.refs && node.refs.includes(this.threadFocus.id)) return 1;
    return 0.38;
  }

  getStickyLift(node) {
    if (this.dragState && this.dragState.node === node) return 1.0;
    if (this.threadFocus === node) return 0.45;
    return 0;
  }

  drawThreadLine(from, to, rel, alpha, width) {
    const col = relColor(rel); this.ctx.strokeStyle = col; this.ctx.setLineDash([6, 4]); this.ctx.lineWidth = width; this.ctx.globalAlpha = alpha;
    this.ctx.beginPath();
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2 - Math.min(40, Math.abs(from.x - to.x) * 0.12);
    this.ctx.moveTo(from.x, from.y); this.ctx.quadraticCurveTo(mx, my, to.x, to.y); this.ctx.stroke();
    this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
  }

  drawThread(positions) {
    if (!this.threadFocus) return;
    const focusPos = positions.get(this.threadFocus); if (!focusPos) return;
    for (const refId of (this.threadFocus.refs || [])) {
      const target = nodeBy(refId, this.nodes); if (!target || target === this.threadFocus) continue;
      const pos = positions.get(target); if (!pos) continue;
      this.drawThreadLine(focusPos, pos, this.threadFocus.rel, 0.9, 1.8);
    }
    for (const other of this.nodes) {
      if (other === this.threadFocus) continue;
      if (other.refs && other.refs.includes(this.threadFocus.id)) {
        const pos = positions.get(other); if (!pos) continue;
        this.drawThreadLine(pos, focusPos, other.rel, 0.9, 1.8);
      }
    }
  }

  drawAmbientThreads(positions) {
    if (this.threadFocus || !this.sessionHasRefs()) return;
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      const sPos = positions.get(src); if (!sPos) continue;
      for (const refId of src.refs) { const tgt = nodeBy(refId, this.nodes); if (!tgt || tgt === src) continue; const tPos = positions.get(tgt); if (!tPos) continue; this.drawThreadLine(sPos, tPos, src.rel, 0.35, 1.1); }
      if (Array.isArray(src.because)) {
        for (const bid of src.because) { if (typeof bid !== 'number') continue; const tgt = nodeBy(bid, this.nodes); if (!tgt || tgt === src) continue; const tPos = positions.get(tgt); if (!tPos) continue; this.drawThreadLine(sPos, tPos, null, 0.2, 0.7); }
      }
    }
  }

  drawSticky(x, y, baseSize, tilt, color, node, dim, lift = 0) {
    const heatMult = node.heat != null ? 1 + node.heat * 0.25 : 1;
    const incoming = this.nodeIncoming(node), pivotMult = 1 + Math.min(0.18, incoming * 0.04);
    const size = baseSize * heatMult * pivotMult;
    this.ctx.save(); this.ctx.translate(x, y); this.ctx.rotate(tilt);
    if (lift > 0) this.ctx.scale(1 + lift * 0.05, 1 + lift * 0.05);
    this.ctx.globalAlpha = (0.28 + lift * 0.18) * dim; this.ctx.fillStyle = '#000';
    this.ctx.fillRect(-size/2 + 3 + lift * 9, -size/2 + 5 + lift * 11, size, size);
    this.ctx.globalAlpha = dim;
    const [r, g, b] = hexToRgb(color);
    const grad = this.ctx.createLinearGradient(-size/2, -size/2, size/2, size/2);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`); grad.addColorStop(1, `rgba(${Math.max(0,r-20)},${Math.max(0,g-20)},${Math.max(0,b-20)},1)`);
    this.ctx.fillStyle = grad; this.ctx.fillRect(-size/2, -size/2, size, size);
    const stance = node.stance;
    this.ctx.fillStyle = 'rgba(0,0,0,0.06)'; this.ctx.beginPath(); this.ctx.moveTo(size/2 - 14, size/2); this.ctx.lineTo(size/2, size/2); this.ctx.lineTo(size/2, size/2 - 14); this.ctx.closePath(); this.ctx.fill();
    if (stance === 'conceding') {
      const peel = 18;
      this.ctx.fillStyle = 'rgba(245, 241, 232, 0.85)';
      this.ctx.beginPath(); this.ctx.moveTo(size/2, -size/2); this.ctx.lineTo(size/2, -size/2 + peel); this.ctx.lineTo(size/2 - peel, -size/2); this.ctx.closePath(); this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(0,0,0,0.12)'; this.ctx.lineWidth = 0.6; this.ctx.stroke();
      this.ctx.strokeStyle = 'rgba(0,0,0,0.18)'; this.ctx.lineWidth = 0.5;
      this.ctx.beginPath(); this.ctx.moveTo(size/2 - peel, -size/2); this.ctx.lineTo(size/2, -size/2 + peel); this.ctx.stroke();
    }
    if (stance === 'exploring') {
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'; this.ctx.beginPath(); this.ctx.moveTo(-size/2, -size/2);
      const steps = 8;
      for (let i = 1; i <= steps; i++) { const fy = -size/2 + (size * i) / steps, bump = (i % 2 === 0 ? 2 : -2); this.ctx.lineTo(-size/2 + bump, fy); }
      this.ctx.lineTo(-size/2 + 5, size/2); this.ctx.lineTo(-size/2, size/2); this.ctx.closePath(); this.ctx.fill();
    }
    this.ctx.fillStyle = 'rgba(20,20,20,0.88)'; this.ctx.font = "500 10.5px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    this.wrapText(node.text, -size/2 + 10, -size/2 + 14, size - 20, 13);
    if (stance === 'questioning') { this.ctx.fillStyle = 'rgba(0,0,0,0.22)'; this.ctx.font = "700 64px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText('?', 0, 4); }
    this.ctx.font = "700 8px 'JetBrains Mono', monospace"; this.ctx.fillStyle = 'rgba(0,0,0,0.42)'; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    this.ctx.fillText(node.type.toUpperCase(), -size/2 + 10, size/2 - 16);
    if (node.type === 'resolution') { this.ctx.strokeStyle = 'rgba(0,0,0,0.55)'; this.ctx.lineWidth = 2; this.ctx.strokeRect(-size/2 + 3, -size/2 + 3, size - 6, size - 6); }
    if (incoming >= 3) { this.ctx.fillStyle = '#d4a332'; this.ctx.font = "700 14px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top'; this.ctx.fillText('★', -size/2 + 6, -size/2 + 4); }
    if (this.nodeHasExternalBecause(node)) { this.ctx.fillStyle = 'rgba(0,0,0,0.55)'; this.ctx.font = "500 10px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'bottom'; this.ctx.fillText('↗', size/2 - 6, size/2 - 18); }
    this.ctx.restore();
  }

  wrapText(text, x, y, maxW, lineH) {
    const words = text.split(' '); let line = '', yy = y, lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (this.ctx.measureText(test).width > maxW && line) {
        this.ctx.fillText(line, x, yy); line = w; yy += lineH; lines++;
        if (lines >= 6) { this.ctx.fillText(line + '…', x, yy); return; }
      } else line = test;
    }
    if (line) this.ctx.fillText(line, x, yy);
  }

  stickyHitTest(mx, my) {
    const { positions } = this.computeLayout();
    for (const node of this.nodes) {
      const pos = positions.get(node); if (!pos) continue;
      if (Math.abs(mx - pos.x) < pos.size / 2 && Math.abs(my - pos.y) < pos.size / 2) return { node, pos };
    }
    return null;
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: kick off one blank Post-it flying animation per token so the
  // wall gets populated with placeholder stickies before real nodes arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const h = this.hashToken(tok);
      // Stagger the tears slightly so they don't all fly at once
      if (this.padLayers > 0) {
        // We already have tearSticky scheduled via spawnTimer; just add extra slots
        const slotIdx = this.placedBlanks.length + this.flyingStickies.length + i;
        const target = this.gridPositionFor(slotIdx);
        this.flyingStickies.push({
          fromX: this.padPos.x, fromY: this.padPos.y,
          toX: target.x, toY: target.y,
          tilt: (((h >> 4) % 28) / 100 - 0.14),
          progress: -(i * 8),   // stagger start
          duration: 32,
          slotIdx,
        });
        if (this.padLayers > 0) this.padLayers = Math.max(0, this.padLayers - 1);
      }
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.playRedStringPlucks(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.tilts.clear(); this.placedBlanks = []; this.flyingStickies = []; this.padAlpha = 0;
    this.threadFocus = null; this.overridePos.clear(); this.mouseDownInfo = null; this.dragState = null;
    if (this.primePhase) this.stopPrime();
    this.primePhase = false;
  }

  // Office wall — vertical bands of varying width and slight darkness
  // simulating paint-roller streaks. Real walls aren't flat. Cached.
  drawOfficeWall() {
    if (!this._wallOff || this._wallW !== this.W || this._wallH !== this.H) {
      if (!this._wallOff) this._wallOff = document.createElement('canvas');
      this._wallOff.width = Math.max(1, Math.ceil(this.W));
      this._wallOff.height = Math.max(1, Math.ceil(this.H));
      this._wallW = this.W; this._wallH = this.H;
      const oc = this._wallOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      let x = 0;
      while (x < this.W) {
        const bandW = 30 + Math.random() * 50;
        const tone = 8 + Math.random() * 12;
        const alpha = 0.04 + Math.random() * 0.05;
        oc.fillStyle = `rgba(${100 + tone}, ${95 + tone}, ${90 + tone}, ${alpha})`;
        oc.fillRect(x, 0, bandW, this.H);
        x += bandW;
      }
    }
    this.ctx.drawImage(this._wallOff, 0, 0);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.ctx.fillStyle = '#ffffff'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawOfficeWall();
    this.simulatePrime(); this.drawPrime();
    const { positions } = this.computeLayout();
    const ht = this.app.highlightedTopic;
    this.drawAmbientThreads(positions); this.drawThread(positions);
    for (const node of this.nodes) {
      const pos = positions.get(node); if (!pos) continue;
      const topicDim = ht && ht !== node.topic ? 0.25 : 1;
      const threadDim = this.getStickyDim(node);
      const dim = Math.min(topicDim, threadDim), lift = this.getStickyLift(node);
      this.drawSticky(pos.x, pos.y, pos.size, pos.tilt, this.topicInfo(node.topic).color, node, dim, lift);
    }
    this.ctx.globalAlpha = 1;
  }
}

export { StickiesMode };
