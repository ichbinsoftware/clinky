import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, playTone } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

class ConstellationMode extends Mode {
  stars = [];
  autoLinks = [];
  userLinks = [];
  selected = null;
  mouseX = -1;
  mouseY = -1;
  t = 0;
  topicCentres = new Map();
  primePhase = false;
  ghostStars = [];
  shooters = [];
  shooterTimer = 0;
  activePedal = null;
  firedPivots = new Set();

  constructor() {
    super({
      mode: 'constellation',
      aesthetic: 'ambient',
      topicFallbackColor: '#ffffff',
      vars: {
        '--e-bg': '#050818', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#bfdff1', '--e-pivot-tint': 'rgba(191,223,241,0.06)', '--e-accent': '#ffd860',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top;
      const hit = this.starAt(this.mouseX, this.mouseY);
      if (hit) { showTooltip(e, hit.node, hit.color); this.app.highlightLegendTopic(hit.node.topic); this.canvas.style.cursor = 'pointer'; }
      else { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'crosshair'; }
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouseX = -1; this.mouseY = -1; });
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const hit = this.starAt(mx, my);
      if (!hit) { this.selected = null; return; }
      if (this.selected && this.selected !== hit) {
        const dup = this.userLinks.find(ln => (ln.a === this.selected && ln.b === hit) || (ln.a === hit && ln.b === this.selected));
        if (!dup) {
          this.userLinks.push({ a: this.selected, b: hit });
          const tA = this.topicInfo(this.selected.topic).note, tB = this.topicInfo(hit.topic).note;
          playTone(tA, 0.3, 'triangle', 0.04);
          setTimeout(() => playTone(tB, 0.35, 'triangle', 0.04), 120);
        }
        this.selected = null;
      } else {
        this.selected = hit;
        playTone(this.topicInfo(hit.topic).note, 0.25, 'sine', 0.05);
      }
    });
  }

  count() { return this.stars.length; }
  legendItems() { return this.stars; }

  starIncoming(s) {
    const id = s.node && s.node.id;
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.stars.map(x => x.node).filter(Boolean));
  }

  hasExternalBecause(s) {
    const b = s.node && s.node.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  starByNodeId(id) {
    for (const s of this.stars) if (s.node && s.node.id === id) return s;
    return null;
  }

  topicMidi(topicId) {
    const info = this.topicInfo(topicId);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    return quantizeToKey(rawMidi);
  }

  firePedal(pivot) {
    if (this.activePedal) { for (const v of this.activePedal.voices) { try { v.stop(); } catch {} } }
    const root = this.topicMidi(pivot.topic);
    const voices = [];
    voices.push(playSynth({ midi: root, ...PRESETS.pad, attack: 1.2, release: 6.0, duration: 120, vol: 0.05, reverbSend: 0.65, delaySend: 0.15 }));
    voices.push(playSynth({ midi: root + 7, ...PRESETS.pad, attack: 1.4, release: 6.0, duration: 120, vol: 0.04, reverbSend: 0.65, delaySend: 0.15 }));
    this.activePedal = { pivotId: pivot.node && pivot.node.id, voices };
  }

  stopPedal() {
    if (!this.activePedal) return;
    for (const v of this.activePedal.voices) { try { v.stop(); } catch {} }
    this.activePedal = null;
  }

  checkConstellationPedal() {
    for (const pivot of this.stars) {
      if (!pivot.node || pivot.node.id == null) continue;
      if (this.firedPivots.has(pivot.node.id)) continue;
      const inbound = this.starIncoming(pivot);
      if (inbound < 3) continue;
      const referrers = this.stars.filter(s => s !== pivot && s.node && Array.isArray(s.node.refs) && s.node.refs.includes(pivot.node.id));
      if (referrers.length < 3) continue;
      this.firedPivots.add(pivot.node.id);
      this.firePedal(pivot);
      return;
    }
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'constellation');
      configureReverb({ duration: 4.5, decay: 2.8, wet: 0.65 });
    });
  }

  centreFor(topicId) {
    if (!this.topicCentres.has(topicId)) {
      const margin = 140;
      this.topicCentres.set(topicId, { cx: margin + Math.random() * (this.W - margin * 2), cy: margin + Math.random() * (this.H - margin * 2) });
    }
    return this.topicCentres.get(topicId);
  }

  addStar(node) {
    const info = this.topicInfo(node.topic);
    const c = this.centreFor(node.topic);
    const ang = Math.random() * Math.PI * 2, dist = 20 + Math.random() * 90;
    const x = Math.max(30, Math.min(this.W - 30, c.cx + Math.cos(ang) * dist));
    const y = Math.max(30, Math.min(this.H - 30, c.cy + Math.sin(ang) * dist));
    const star = { x, y, color: info.color, size: 1.2 + node.confidence * 2.2, topic: node.topic, node, twinklePhase: Math.random() * Math.PI * 2, twinkleSpeed: 0.02 + Math.random() * 0.03, age: 0 };
    this.stars.push(star);
    const hasRefs = Array.isArray(node.refs) && node.refs.length > 0;
    if (hasRefs) {
      for (const tid of node.refs) { const target = this.starByNodeId(tid); if (target) this.autoLinks.push({ a: star, b: target, rel: node.rel }); }
    } else {
      const sameTopic = this.stars.filter(s => s !== star && s.topic === node.topic);
      const nearest = sameTopic.map(s => ({ s, d: Math.hypot(s.x - x, s.y - y) })).sort((a, b) => a.d - b.d).slice(0, 2);
      for (const { s } of nearest) this.autoLinks.push({ a: star, b: s, rel: null });
    }
    if (this.hasExternalBecause(star)) this.spawnInboundShooter(star);
    playTone(info.note, 1.2 + node.confidence * 0.8, 'sine', 0.04);
  }

  spawnInboundShooter(star) {
    const edge = Math.floor(Math.random() * 4);
    let sx, sy;
    if (edge === 0)      { sx = Math.random() * this.W;  sy = -30; }
    else if (edge === 1) { sx = this.W + 30;             sy = Math.random() * this.H; }
    else if (edge === 2) { sx = Math.random() * this.W;  sy = this.H + 30; }
    else                 { sx = -30;                                 sy = Math.random() * this.H; }
    this.shooters.push({ x: sx, y: sy, dx: star.x - sx, dy: star.y - sy, age: 0, maxAge: 55 });
  }

  starAt(x, y, tol = 18) {
    let best = null, bestD = tol;
    for (const s of this.stars) { const d = Math.hypot(s.x - x, s.y - y); if (d < bestD) { bestD = d; best = s; } }
    return best;
  }

  spawnGhostStar() {
    this.ghostStars.push({ x: 30 + Math.random() * (this.W - 60), y: 30 + Math.random() * (this.H - 60), size: 0.8 + Math.random() * 1.2, twinklePhase: Math.random() * Math.PI * 2, twinkleSpeed: 0.02 + Math.random() * 0.04, alpha: 0, targetAlpha: 0.2 + Math.random() * 0.2 });
  }

  spawnShooter() {
    const edge = Math.floor(Math.random() * 2);
    const x = edge === 0 ? Math.random() * this.W : -20;
    const y = edge === 0 ? -20 : Math.random() * this.H * 0.5;
    this.shooters.push({ x, y, dx: 200 + Math.random() * 300, dy: 80 + Math.random() * 180, age: 0, maxAge: 45 + Math.random() * 20 });
    playTone(660 + Math.random() * 200, 0.3, 'sine', 0.025);
  }

  startPrime() {
    this.primePhase = true;
    this.ghostStars = [];
    this.shooters = [];
    this.shooterTimer = 120;
    for (let i = 0; i < 22; i++) this.spawnGhostStar();
  }

  stopPrime() {
    this.primePhase = false;
    for (const g of this.ghostStars) g.targetAlpha = 0;
  }

  simulate() {
    this.t += 0.016;
    for (const s of this.stars) { s.twinklePhase += s.twinkleSpeed; s.age++; }
    for (let i = this.ghostStars.length - 1; i >= 0; i--) {
      const g = this.ghostStars[i];
      g.twinklePhase += g.twinkleSpeed;
      g.alpha += (g.targetAlpha - g.alpha) * 0.03;
      if (!this.primePhase) g.alpha *= 0.97;
      if (g.alpha < 0.01 && g.targetAlpha === 0) this.ghostStars.splice(i, 1);
    }
    if (this.primePhase) {
      this.shooterTimer--;
      if (this.shooterTimer <= 0) { this.spawnShooter(); this.shooterTimer = 180 + Math.random() * 240; }
    }
    for (let i = this.shooters.length - 1; i >= 0; i--) {
      this.shooters[i].age++;
      if (this.shooters[i].age > this.shooters[i].maxAge) this.shooters.splice(i, 1);
    }
  }

  drawSky() {
    this.ctx.fillStyle = '#050818'; this.ctx.fillRect(0, 0, this.W, this.H);
    const g = this.ctx.createRadialGradient(this.W / 2, this.H / 2, 0, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.6);
    g.addColorStop(0, 'rgba(15, 20, 45, 0.5)'); g.addColorStop(1, 'rgba(2, 3, 10, 0.4)');
    this.ctx.fillStyle = g; this.ctx.fillRect(0, 0, this.W, this.H);
    // Nebula wash — three large soft radial blobs (rose / teal / gold) at low
    // alpha in different canvas regions. Distant gas clouds.
    const blobs = [
      { fx: 0.25, fy: 0.30, fr: 0.55, c: '180, 100, 130' },
      { fx: 0.75, fy: 0.65, fr: 0.50, c: '90, 160, 170' },
      { fx: 0.55, fy: 0.20, fr: 0.45, c: '200, 170, 100' },
    ];
    for (const b of blobs) {
      const cx = b.fx * this.W, cy = b.fy * this.H;
      const r = b.fr * Math.max(this.W, this.H);
      const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(${b.c}, 0.16)`);
      grad.addColorStop(0.4, `rgba(${b.c}, 0.06)`);
      grad.addColorStop(1, `rgba(${b.c}, 0)`);
      this.ctx.fillStyle = grad;
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  drawGhostStars() {
    for (const g of this.ghostStars) {
      const tw = (Math.sin(g.twinklePhase) + 1) * 0.5;
      this.ctx.fillStyle = `rgba(200, 210, 230, ${g.alpha * (0.5 + tw * 0.5)})`;
      this.ctx.beginPath(); this.ctx.arc(g.x, g.y, g.size, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  drawShooters() {
    for (const sh of this.shooters) {
      const p = sh.age / sh.maxAge;
      const x = sh.x + sh.dx * p, y = sh.y + sh.dy * p;
      const tailLen = 40;
      const mag = Math.hypot(sh.dx, sh.dy);
      const tailX = x - (sh.dx / mag) * tailLen, tailY = y - (sh.dy / mag) * tailLen;
      const fade = Math.sin(p * Math.PI);
      const grad = this.ctx.createLinearGradient(tailX, tailY, x, y);
      grad.addColorStop(0, 'rgba(220, 230, 255, 0)'); grad.addColorStop(1, `rgba(220, 230, 255, ${fade})`);
      this.ctx.strokeStyle = grad; this.ctx.lineWidth = 1.2; this.ctx.lineCap = 'round';
      this.ctx.beginPath(); this.ctx.moveTo(tailX, tailY); this.ctx.lineTo(x, y); this.ctx.stroke();
      this.ctx.fillStyle = `rgba(240, 245, 255, ${fade})`;
      this.ctx.beginPath(); this.ctx.arc(x, y, 1.4, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  drawAutoLinks() {
    const ht = this.app.highlightedTopic;
    for (const ln of this.autoLinks) {
      const dim = ht && ln.a.topic !== ht ? 0.15 : 1;
      const [r, g, b] = hexToRgb(ln.a.color);
      let alpha = 0.18, lineW = 0.6, dash = null;
      switch (ln.rel) {
        case 'supports': alpha = 0.24; break;
        case 'contradicts': alpha = 0.32; dash = [3, 4]; break;
        case 'synthesizes': alpha = 0.32; lineW = 1.1; break;
        case 'refines': alpha = 0.22; dash = [1, 3]; break;
        case 'questions': alpha = 0.22; dash = [5, 7]; break;
        case 'supersedes': alpha = 0.12; lineW = 1.8; break;
      }
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * dim})`; this.ctx.lineWidth = lineW;
      if (dash) this.ctx.setLineDash(dash);
      this.ctx.beginPath(); this.ctx.moveTo(ln.a.x, ln.a.y); this.ctx.lineTo(ln.b.x, ln.b.y); this.ctx.stroke();
      if (dash) this.ctx.setLineDash([]);
    }
  }

  drawConstellationFigures() {
    for (const pivot of this.stars) {
      if (pivot.node == null) continue;
      const inbound = this.starIncoming(pivot);
      if (inbound < 3) continue;
      const pivotId = pivot.node.id;
      const referrers = this.stars.filter(s => s !== pivot && s.node && Array.isArray(s.node.refs) && s.node.refs.includes(pivotId));
      if (referrers.length < 3) continue;
      const sorted = referrers.map(s => ({ s, ang: Math.atan2(s.y - pivot.y, s.x - pivot.x) })).sort((a, b) => a.ang - b.ang).map(e => e.s);
      this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.28)'; this.ctx.lineWidth = 0.75; this.ctx.setLineDash([3, 5]);
      this.ctx.beginPath(); this.ctx.moveTo(sorted[0].x, sorted[0].y);
      for (let i = 1; i < sorted.length; i++) this.ctx.lineTo(sorted[i].x, sorted[i].y);
      this.ctx.closePath(); this.ctx.stroke(); this.ctx.setLineDash([]);
      const ringR = pivot.size * (4 + Math.min(inbound - 3, 3) * 0.8);
      this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.3)'; this.ctx.lineWidth = 0.9;
      this.ctx.beginPath(); this.ctx.arc(pivot.x, pivot.y, ringR, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  drawUserLinks() {
    for (const ln of this.userLinks) {
      this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.55)'; this.ctx.lineWidth = 0.9; this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(ln.a.x, ln.a.y); this.ctx.lineTo(ln.b.x, ln.b.y); this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
  }

  drawStars() {
    const ht = this.app.highlightedTopic;
    for (const s of this.stars) {
      const dim = ht && s.topic !== ht ? 0.12 : 1;
      const [r, g, b] = hexToRgb(s.color);
      const twinkleNorm = (Math.sin(s.twinklePhase) + 1) * 0.5;
      const stance = s.node && s.node.stance;
      const heat = (s.node && typeof s.node.heat === 'number') ? s.node.heat : 0;
      let coreA;
      if (stance === 'claiming') { coreA = (0.88 + twinkleNorm * 0.06) * dim; }
      else if (stance === 'conceding') { coreA = (0.28 + twinkleNorm * 0.12 * (1 + heat * 0.8)) * dim; }
      else if (stance === 'questioning') { const phase = (s.twinklePhase * 1.6) % (Math.PI * 2); coreA = (phase < Math.PI * 0.32 ? 0.98 : 0.14) * dim; }
      else { const ampA = 0.25 * (1 + heat * 0.8); coreA = (0.75 + twinkleNorm * ampA) * dim; }
      const inbound = this.starIncoming(s);
      const pivotScale = inbound >= 3 ? 1 + Math.min(0.5, (inbound - 2) * 0.12) : 1;
      const effSize = s.size * pivotScale;
      const [hR, hG, hB] = stance === 'conceding' ? [160, 180, 210] : [r, g, b];
      this.ctx.fillStyle = `rgba(${hR},${hG},${hB},${0.08 * dim})`; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, effSize * 3 + twinkleNorm * 2, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = `rgba(${hR},${hG},${hB},${0.25 * dim})`; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, effSize * 1.8, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = `rgba(${Math.min(255, hR + 80)},${Math.min(255, hG + 80)},${Math.min(255, hB + 80)},${coreA})`; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, effSize, 0, Math.PI * 2); this.ctx.fill();
      if (s === this.selected) {
        this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.85)'; this.ctx.lineWidth = 1; this.ctx.setLineDash([2, 3]);
        this.ctx.beginPath(); this.ctx.arc(s.x, s.y, effSize + 6, 0, Math.PI * 2); this.ctx.stroke(); this.ctx.setLineDash([]);
      }
    }
  }

  drawSelectedDrag() {
    if (this.selected && this.mouseX >= 0) {
      this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.4)'; this.ctx.lineWidth = 0.8; this.ctx.setLineDash([3, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(this.selected.x, this.selected.y); this.ctx.lineTo(this.mouseX, this.mouseY); this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: place one ghost star per token at a hashed position,
  // then briefly draw lines between adjacent token-stars.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = 40 + (h % (this.W - 80));
      const y = 40 + ((h >> 10) % (this.H - 80));
      this.ghostStars.push({
        x, y,
        size: 1.2 + ((h >> 4) % 8) / 4,
        twinklePhase: ((h >> 8) % 628) / 100,
        twinkleSpeed: 0.02 + ((h >> 12) % 30) / 1000,
        alpha: 0,
        targetAlpha: 0.28 + ((h >> 16) % 12) / 100,
      });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.addStar(n);
  }

  onDone() { this.stopPrime(); this.stopPedal(); }
  onError() { this.stopPrime(); this.stopPedal(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.stars = [];
    this.autoLinks = [];
    this.userLinks = [];
    this.ghostStars = [];
    this.shooters = [];
    this.selected = null;
    this.primePhase = false;
    this.topicCentres.clear();
    this.stopPedal();
    this.firedPivots.clear();
  }

  draw() {
    if (this.app.isPaused()) return;
    this.checkConstellationPedal();
    this.simulate();
    this.drawSky();
    this.drawGhostStars();
    this.drawShooters();
    this.drawAutoLinks();
    this.drawConstellationFigures();
    this.drawUserLinks();
    this.drawSelectedDrag();
    this.drawStars();
  }
}

export { ConstellationMode };
