import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, nodeBy } from '/clinky.js';
import { playSynth, playChord, midiToFreq, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const ROOTLESS = { maj9: [4, 7, 11, 14], min9: [3, 7, 10, 14], dom7: [4, 7, 10, 14] };
const VOICING_CYCLE = ['maj9', 'min9', 'dom7'];

class DendrogramMode extends Mode {
  leaves = [];
  tree = null;
  highlighted = null;
  primePhase = false;
  sprouts = [];
  sproutSpawnTimer = 0;

  constructor() {
    super({
      mode: 'dendrogram',
      aesthetic: 'jazz',
      topicFallbackColor: '#888',
      vars: {
        '--e-bg': '#ffffff', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#a87018', '--e-pivot-tint': 'rgba(168,112,24,0.08)', '--e-accent': '#5a3818',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      if (!this.tree || this.leaves.length === 0) { this.canvas.style.cursor = 'crosshair'; return; }
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const leafHit = this.leafAtPoint(mx, my);
      if (leafHit) { showTooltip(e, leafHit, leafHit.color); this.app.highlightLegendTopic(leafHit.topic); this.canvas.style.cursor = 'pointer'; return; }
      const internalHit = this.internalNodeAt(mx, my);
      if (internalHit) { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'pointer'; return; }
      hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'crosshair';
    });
    this.canvas.addEventListener('mouseleave', () => { this.canvas.style.cursor = 'crosshair'; });
    this.canvas.addEventListener('click', e => {
      if (this.primePhase || !this.tree) return;
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const leafHit = this.leafAtPoint(mx, my);
      if (leafHit) {
        if (this.highlighted && this.highlighted.kind === 'ancestry' && this.highlighted.leafCluster === leafHit.cluster) this.highlighted = null;
        else this.highlighted = { kind: 'ancestry', leafCluster: leafHit.cluster };
        return;
      }
      const internalHit = this.internalNodeAt(mx, my);
      if (internalHit) {
        if (this.highlighted && this.highlighted.kind === 'subtree' && this.highlighted.node === internalHit) this.highlighted = null;
        else this.highlighted = { kind: 'subtree', node: internalHit };
        return;
      }
      this.highlighted = null;
    });
  }

  count() { return this.leaves.length; }
  legendItems() { return this.leaves; }

  leafIncoming(L) { return L.id != null ? (this.incomingRefsMap[L.id] ?? incomingRefsOf(L.id, this.leaves)) : 0; }
  leafHasExternalBecause(L) { return Array.isArray(L.because) && L.because.some(b => typeof b === 'string'); }
  sessionHasRefs() {
    for (const L of this.leaves) if (Array.isArray(L.refs) && L.refs.length > 0) return true;
    return false;
  }

  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = innerWidth;
    this.H = innerHeight;
    this.canvas.width  = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rebuild();
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('jazz');
      pickSessionKey(this.app.prompt() || 'dendrogram');
    });
  }

  scaleNote(degree) {
    const key = getSessionKey();
    const len = key.notes.length;
    const oct = Math.floor(degree / len) * 12;
    return key.notes[((degree % len) + len) % len] + oct;
  }

  playMergeVoicing(node) {
    const idx = Math.max(0, this.topics.findIndex(t => t.id === node.topic));
    const degree = (idx * 2) % 7;
    const rootMidi = this.scaleNote(degree) + 12;
    const quality = VOICING_CYCLE[idx % VOICING_CYCLE.length];
    const midis = ROOTLESS[quality].map(i => rootMidi + i);
    playChord(midis.map(midiToFreq), { ...PRESETS.pad, duration: 1.2, vol: 0.13, reverbSend: 0.35 });
  }

  blendHex(a, b) {
    const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
    return `rgb(${Math.round((r1 + r2) / 2)},${Math.round((g1 + g2) / 2)},${Math.round((b1 + b2) / 2)})`;
  }

  distance(a, b) {
    let d = a.topic === b.topic ? 0 : 1;
    if (a.type !== b.type) d += 0.3;
    d += Math.abs((a.confidence || 0.7) - (b.confidence || 0.7)) * 0.2;
    return d;
  }

  clusterDist(a, b) {
    let sum = 0, count = 0;
    for (const ma of a.members) { for (const mb of b.members) { sum += this.distance(ma, mb); count++; } }
    return sum / Math.max(1, count);
  }

  colourOf(cluster) {
    if (cluster.isLeaf) return cluster.leaf.color;
    return this.blendHex(this.colourOf(cluster.children[0]), this.colourOf(cluster.children[1]));
  }

  genGhostTree(x, yTop, width, yBottom, depthLeft) {
    if (depthLeft === 0) return { leaf: true, x, y: yBottom };
    const forkFrac = 0.35 + Math.random() * 0.35;
    const forkY = yTop + (yBottom - yTop) * forkFrac;
    const half = width / 2;
    return { leaf: false, x, y: yTop, forkY, leftX: x - half, rightX: x + half, left: this.genGhostTree(x - half, forkY, width * (0.4 + Math.random() * 0.2), yBottom, depthLeft - 1), right: this.genGhostTree(x + half, forkY, width * (0.4 + Math.random() * 0.2), yBottom, depthLeft - 1) };
  }

  flattenGhostTree(node, segs, parentReveal) {
    if (node.leaf) { segs.push({ type: 'leaf', x: node.x, y: node.y, revealAt: parentReveal + 2 }); return; }
    const vertDur = 10, horzDur = 8, vertDone = parentReveal + vertDur;
    segs.push({ type: 'vert', x: node.x, y1: node.y, y2: node.forkY, revealAt: parentReveal, duration: vertDur });
    segs.push({ type: 'horz', x1: node.leftX, x2: node.rightX, y: node.forkY, revealAt: vertDone, duration: horzDur });
    this.flattenGhostTree(node.left, segs, vertDone + horzDur);
    this.flattenGhostTree(node.right, segs, vertDone + horzDur);
  }

  spawnSprout() {
    const margin = 160, yTop = 70, yBottom = this.H - 70;
    const buf = this.sideBuffer();
    const minX = Math.max(margin, buf), maxX = Math.min(this.W - margin, this.W - buf);
    if (maxX <= minX) return;
    const rootX = minX + Math.random() * (maxX - minX);
    const width = 200 + Math.random() * 140;
    const depth = 2 + (Math.random() < 0.55 ? 1 : 0);
    const tree = this.genGhostTree(rootX, yTop, width, yBottom, depth);
    const segs = [];
    this.flattenGhostTree(tree, segs, 0);
    const lastReveal = segs.reduce((m, s) => Math.max(m, (s.revealAt || 0) + (s.duration || 0)), 0);
    this.sprouts.push({ segs, t: 0, alpha: 0, targetAlpha: 0.28 + Math.random() * 0.1, growDoneAt: lastReveal + 6, holdFrames: 45 });
  }

  startPrime() { this.primePhase = true; this.sprouts = []; this.sproutSpawnTimer = 10; }
  stopPrime() { this.primePhase = false; for (const sp of this.sprouts) sp.targetAlpha = 0; }

  simulatePrime() {
    if (this.primePhase) {
      this.sproutSpawnTimer--;
      const live = this.sprouts.filter(s => s.targetAlpha > 0).length;
      if (this.sproutSpawnTimer <= 0 && live < 2) { this.spawnSprout(); this.sproutSpawnTimer = 90 + Math.random() * 70; }
    }
    for (let i = this.sprouts.length - 1; i >= 0; i--) {
      const s = this.sprouts[i];
      s.t++;
      s.alpha += (s.targetAlpha - s.alpha) * 0.05;
      if (s.targetAlpha > 0 && s.t > s.growDoneAt + s.holdFrames) s.targetAlpha = 0;
      if (s.alpha < 0.005 && s.targetAlpha === 0) this.sprouts.splice(i, 1);
    }
  }

  drawSprouts() {
    if (this.sprouts.length === 0) return;
    this.ctx.lineCap = 'round'; this.ctx.lineWidth = 0.9;
    for (const s of this.sprouts) {
      if (s.alpha < 0.01) continue;
      this.ctx.strokeStyle = `rgba(180, 180, 210, ${s.alpha})`; this.ctx.fillStyle = `rgba(200, 200, 220, ${s.alpha})`;
      this.ctx.beginPath();
      for (const seg of s.segs) {
        if (s.t < seg.revealAt) continue;
        const progress = seg.type === 'leaf' ? 1 : Math.min(1, (s.t - seg.revealAt) / seg.duration);
        if (seg.type === 'vert') { this.ctx.moveTo(seg.x, seg.y1); this.ctx.lineTo(seg.x, seg.y1 + (seg.y2 - seg.y1) * progress); }
        else if (seg.type === 'horz') { const midX = (seg.x1 + seg.x2) / 2; this.ctx.moveTo(midX, seg.y); this.ctx.lineTo(midX + (seg.x1 - midX) * progress, seg.y); this.ctx.moveTo(midX, seg.y); this.ctx.lineTo(midX + (seg.x2 - midX) * progress, seg.y); }
      }
      this.ctx.stroke();
      for (const seg of s.segs) {
        if (seg.type !== 'leaf' || s.t < seg.revealAt) continue;
        const progress = Math.min(1, (s.t - seg.revealAt) / 6);
        this.ctx.beginPath(); this.ctx.arc(seg.x, seg.y, 2.6 * progress, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  isInAncestry(cluster, leafCluster) {
    let cur = leafCluster;
    while (cur) { if (cur === cluster) return true; cur = cur.parent; }
    return false;
  }

  isInSubtree(ancestor, target) {
    if (!ancestor || !target) return false;
    if (target === ancestor) return true;
    if (ancestor.isLeaf) return false;
    return this.isInSubtree(ancestor.children[0], target) || this.isInSubtree(ancestor.children[1], target);
  }

  isNodeHighlighted(n) {
    if (!this.highlighted) return true;
    if (this.highlighted.kind === 'ancestry') return this.isInAncestry(n, this.highlighted.leafCluster);
    if (this.highlighted.kind === 'subtree') return this.isInSubtree(this.highlighted.node, n);
    return true;
  }

  internalNodeAt(mx, my, tol = 10) {
    if (!this.tree) return null;
    let best = null, bestD = tol;
    (function visit(n) { if (!n.isLeaf) { const d = Math.hypot(n.x - mx, n.y - my); if (d < bestD) { bestD = d; best = n; } for (const c of n.children) visit(c); } })(this.tree);
    return best;
  }

  leafAtPoint(mx, my, tol = 14) {
    let best = null, bestD = tol;
    for (const L of this.leaves) { const d = Math.hypot(L.x - mx, L.y - my); if (d < bestD) { bestD = d; best = L; } }
    return best;
  }

  buildTree() {
    if (this.leaves.length === 0) { this.tree = null; return; }
    let clusters = this.leaves.map(L => { const c = { members: [L], isLeaf: true, leaf: L, height: 0, color: L.color }; L.cluster = c; return c; });
    while (clusters.length > 1) {
      let bi = 0, bj = 1, bestD = Infinity;
      for (let i = 0; i < clusters.length; i++) { for (let j = i + 1; j < clusters.length; j++) { const d = this.clusterDist(clusters[i], clusters[j]); if (d < bestD) { bestD = d; bi = i; bj = j; } } }
      const a = clusters[bi], b = clusters[bj];
      const parent = { members: [...a.members, ...b.members], isLeaf: false, children: [a, b], height: Math.max(a.height, b.height) + bestD + 0.02 };
      a.parent = parent; b.parent = parent;
      clusters = clusters.filter((_, idx) => idx !== bi && idx !== bj);
      clusters.push(parent);
    }
    const root = clusters[0]; root.parent = null;
    const ordered = [];
    (function walk(n) { if (n.isLeaf) { ordered.push(n.leaf); return; } walk(n.children[0]); walk(n.children[1]); })(root);
    const padX = this.sideBuffer(), padY = 60;
    const plotW = this.W - padX * 2;
    const step = plotW / Math.max(1, ordered.length - 1);
    const maxH = root.height || 1;
    const plotH = this.H - padY * 2 - 40;
    const yBase = this.H - padY;
    ordered.forEach((leaf, i) => { leaf.x = ordered.length === 1 ? this.W / 2 : padX + i * step; leaf.y = yBase; });
    const self = this;
    (function place(n) { if (n.isLeaf) { n.x = n.leaf.x; n.y = yBase; n.color = n.leaf.color; return n.x; } const ax = place(n.children[0]); const bx = place(n.children[1]); n.x = (ax + bx) / 2; n.y = yBase - (n.height / maxH) * plotH; n.color = self.colourOf(n); return n.x; })(root);
    this.tree = root;
  }

  rebuild() { this.buildTree(); }

  rgbStrToHex(s) {
    const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return '#888888';
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }

  drawBracket(a, parent) {
    this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(a.x, parent.y); this.ctx.lineTo(parent.x, parent.y); this.ctx.stroke();
  }

  drawEdges(n) {
    if (n.isLeaf) return;
    for (const c of n.children) {
      const col = (n.color && n.color.startsWith('#')) ? n.color : (typeof n.color === 'string' && n.color.startsWith('rgb')) ? this.rgbStrToHex(n.color) : '#888888';
      const [r, g, b] = hexToRgb(col);
      const lit = this.isNodeHighlighted(n) && this.isNodeHighlighted(c);
      const childTopic = c.isLeaf ? c.leaf.topic : (c.members[0] && c.members[0].topic);
      const legendDim = childTopic ? this.legendTopicDim(childTopic) : 1;
      const dim = (lit ? 1 : 0.12) * legendDim;
      let maxHeat = 0;
      (function visit(nn) { if (nn.isLeaf) { if (nn.leaf.heat != null && nn.leaf.heat > maxHeat) maxHeat = nn.leaf.heat; } else for (const g of nn.children) visit(g); })(c);
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.55 * dim})`;
      this.ctx.lineWidth = (lit ? 1.6 : 1) + Math.log2(n.members.length) * 0.4 + maxHeat * 1.4;
      this.ctx.lineCap = 'round';
      this.drawBracket(c, n);
      this.drawEdges(c);
    }
  }

  drawLeaves(n) {
    if (n.isLeaf) {
      const L = n.leaf;
      const dim = (this.isNodeHighlighted(n) ? 1 : 0.12) * this.legendTopicDim(L.topic);
      const [r, g, b] = hexToRgb(L.color);
      const incoming = this.leafIncoming(L);
      const heat = L.heat, stance = L.stance;
      const isOrphan = (!Array.isArray(L.refs) || L.refs.length === 0) && incoming === 0 && (!Array.isArray(L.because) || L.because.length === 0);
      const absenceMult = isOrphan ? 0.5 : 1;
      const radius = 4 + Math.min(5, incoming * 0.8);
      if (heat != null && heat > 0.1 && dim > 0.3) {
        const haloR = radius + 2 + heat * 6;
        const grad = this.ctx.createRadialGradient(n.x, n.y, radius, n.x, n.y, haloR);
        grad.addColorStop(0, `rgba(${r},${g},${b},${0.3 * dim * heat})`); grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        this.ctx.fillStyle = grad; this.ctx.beginPath(); this.ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2); this.ctx.fill();
      }
      const bodyAlpha = 0.95 * dim * absenceMult;
      if (stance === 'questioning') {
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${bodyAlpha})`; this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.arc(n.x, n.y, radius, 0, Math.PI * 2); this.ctx.stroke();
      } else if (stance === 'conceding') {
        this.ctx.fillStyle = `rgba(${r},${g},${b},${bodyAlpha * 0.5})`;
        this.ctx.beginPath(); this.ctx.arc(n.x, n.y + 5, radius, 0, Math.PI * 2); this.ctx.fill();
      } else {
        const stanceA = stance === 'exploring' ? 0.75 : 1;
        this.ctx.fillStyle = `rgba(${r},${g},${b},${bodyAlpha * stanceA})`;
        this.ctx.beginPath(); this.ctx.arc(n.x, n.y, radius, 0, Math.PI * 2); this.ctx.fill();
        if (stance === 'exploring') {
          this.ctx.strokeStyle = `rgba(${r},${g},${b},${bodyAlpha})`; this.ctx.lineWidth = 1; this.ctx.setLineDash([2, 2]);
          this.ctx.beginPath(); this.ctx.arc(n.x, n.y, radius, 0, Math.PI * 2); this.ctx.stroke(); this.ctx.setLineDash([]);
        }
      }
      if (this.leafHasExternalBecause(L) && dim > 0.3) {
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${dim * 0.45})`; this.ctx.lineWidth = 0.7;
        for (let i = -1; i <= 1; i++) { this.ctx.beginPath(); this.ctx.moveTo(n.x + i * 2, n.y + radius); this.ctx.lineTo(n.x + i * 4, n.y + radius + 8 + Math.abs(i) * 2); this.ctx.stroke(); }
      }
    } else { for (const c of n.children) this.drawLeaves(c); }
  }

  drawRefsCrossLinks() {
    if (!this.sessionHasRefs() || this.leaves.length < 2) return;
    this.ctx.lineCap = 'round';
    for (const src of this.leaves) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.leaves); if (!tgt) continue;
        if (Math.abs(src.x - tgt.x) < 40 && src.cluster && tgt.cluster) { if (src.cluster.parent === tgt.cluster.parent) continue; }
        const lit = this.isNodeHighlighted(src.cluster) && this.isNodeHighlighted(tgt.cluster);
        const dim = lit ? 1 : 0.12;
        if (dim < 0.15) continue;
        const [r, g, b] = hexToRgb(src.color);
        let dash = [], width = 0.9, alphaMult = 1;
        switch (src.rel) {
          case 'refines': dash = [1, 3]; width = 0.7; alphaMult = 0.8; break;
          case 'synthesizes': dash = []; width = 1.6; break;
          case 'contradicts': dash = [4, 3]; alphaMult = 0.95; break;
          case 'questions': dash = [2, 3]; alphaMult = 0.85; break;
          case 'supersedes': dash = [3, 4]; alphaMult = 0.7; break;
        }
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.32 * dim * alphaMult})`; this.ctx.lineWidth = width;
        if (dash.length) this.ctx.setLineDash(dash);
        const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2 + Math.min(40, Math.abs(src.x - tgt.x) * 0.18);
        this.ctx.beginPath(); this.ctx.moveTo(src.x, src.y); this.ctx.quadraticCurveTo(mx, my, tgt.x, tgt.y); this.ctx.stroke();
        if (dash.length) this.ctx.setLineDash([]);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  drawInternalNodes(n) {
    if (n.isLeaf) return;
    const dim = this.isNodeHighlighted(n) ? 1 : 0.15;
    const col = n.color.startsWith('rgb') ? n.color : n.color;
    const [cr, cg, cb] = hexToRgb(col.startsWith('#') ? col : this.rgbStrToHex(col));
    this.ctx.fillStyle = `rgba(${cr},${cg},${cb},${dim})`;
    this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 2.2 + Math.log2(n.members.length) * 0.3, 0, Math.PI * 2); this.ctx.fill();
    for (const c of n.children) this.drawInternalNodes(c);
  }

  addLeaf(n) {
    const info = this.topicInfo(n.topic);
    this.leaves.push({ ...n, color: info.color, x: 0, y: 0 });
    this.rebuild();
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one ghost sprout per token whose horizontal root position
  // is hashed from the token. More tokens → richer pre-tree silhouette.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const buf = this.sideBuffer();
      const minX = Math.max(60, buf);
      const maxX = Math.min(this.W - 60, this.W - buf);
      if (maxX <= minX) continue;
      const rootX = minX + (h % (maxX - minX));
      const width = 80 + ((h >> 8) % 120);
      const depth = 2 + ((h >> 12) % 2);
      const yTop = 70, yBottom = this.H - 70;
      const tree = this.genGhostTree(rootX, yTop, width, yBottom, depth);
      const segs = [];
      this.flattenGhostTree(tree, segs, 0);
      const lastReveal = segs.reduce((m, s) => Math.max(m, (s.revealAt || 0) + (s.duration || 0)), 0);
      this.sprouts.push({ segs, t: 0, alpha: 0, targetAlpha: 0.22 + ((h >> 16) % 8) / 100, growDoneAt: lastReveal + 6, holdFrames: 90 });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.addLeaf(n);
    this.playMergeVoicing(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.leaves = [];
    this.tree = null;
    this.sprouts = [];
    this.primePhase = false;
    this.highlighted = null;
    this.canvas.style.cursor = 'crosshair';
  }

  legendTopicDim(topic) {
    const ht = this.app.highlightedTopic;
    return ht && topic !== ht ? 0.25 : 1;
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    // Geological strata — four horizontal bands of slightly different muted
    // tones with sharp transitions, like sediment layers recording the merges.
    const g = this.ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0,    '#ffffff');
    g.addColorStop(0.22, '#fbfaf7');
    g.addColorStop(0.23, '#f6f3ec');
    g.addColorStop(0.48, '#f6f3ec');
    g.addColorStop(0.49, '#f3f3f6');
    g.addColorStop(0.74, '#f3f3f6');
    g.addColorStop(0.75, '#f6f1e8');
    g.addColorStop(1,    '#efe7d8');
    this.ctx.fillStyle = g; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawSprouts();
    if (this.tree) { this.drawEdges(this.tree); this.drawInternalNodes(this.tree); this.drawLeaves(this.tree); this.drawRefsCrossLinks(); }
  }
}

export { DendrogramMode };
