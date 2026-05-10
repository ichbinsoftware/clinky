import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete, nodeBy, relGlyph } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, quantizeToKey, playRelInterval } from '/synth.js';

const DIRS = [{ dx: 1, dy: 0 },{ dx: 1, dy: 1 },{ dx: 0, dy: 1 },{ dx: -1, dy: 1 },{ dx: -1, dy: 0 },{ dx: -1, dy: -1 },{ dx: 0, dy: -1 },{ dx: 1, dy: -1 }];
const HUB_RADIUS = 95;
const PENCIL_STEP = 95;
const TRANSIT_JINGLES = [
  { name: 'tokyo', notes: [7, 5, 2, 0], stride: 130 }, { name: 'london', notes: [4, 0, 4], stride: 180 },
  { name: 'paris', notes: [3, 0], stride: 220 }, { name: 'mtr', notes: [5, 0], stride: 240 },
  { name: 'moscow', notes: [0, 4, 7], stride: 160 }, { name: 'singapore', notes: [9, 7, 4, 0], stride: 150 },
];
const CANON_MOTIF = [0, 4, 2, 5, 7, 5, 4, 0];
const CANON_STRIDE_MS = 160;
const CANON_VOICE_GAP_MS = CANON_STRIDE_MS * 4;
const CANON_COOLDOWN_MS = 3000;

class SubwayMode extends Mode {
  stations = [];
  HUB = { x: 0, y: 0 };
  lineAssignments = new Map();
  primePhase = false;
  pencils = [];
  pencilSpawnTimer = 0;
  trains = [];
  _lastCanonTime = 0;

  constructor() {
    super({
      mode: 'subway',
      aesthetic: 'classical',
      vars: {
        '--e-bg': '#ffffff', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(144,12,63,0.08)', '--e-accent': '#900c3f',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let closest = null, cd = 18;
      for (const s of this.stations) { const d = Math.hypot(s.x - mx, s.y - my); if (d < cd) { cd = d; closest = s; } }
      if (closest) { showTooltip(e, closest, closest.color); this.app.highlightLegendTopic(closest.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });


    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.primePhase) {
        const p = this.pencilUnderPoint(mx, my);
        if (p) { for (const other of this.pencils) other.pinned = false; p.pinned = true; }
        return;
      }
    });
    this.canvas.addEventListener('dblclick', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const topicId = this.topicUnderPoint(mx, my);
      if (topicId) this.startTrain(topicId);
    });
  }

  count() { return this.stations.length; }
  legendItems() { return this.stations; }

  topicInfo(n) { return this.topics.find(t => t.id === n) || { color: '#888', label: n, note: 440 }; }
  nodeIncoming(s) { return s.id != null ? (this.incomingRefsMap[s.id] ?? incomingRefsOf(s.id, this.stations)) : 0; }
  nodeHasExternalBecause(s) { return Array.isArray(s.because) && s.because.some(b => typeof b === 'string'); }
  sessionHasRefs() { for (const s of this.stations) if (Array.isArray(s.refs) && s.refs.length > 0) return true; return false; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = innerWidth;
    this.H = innerHeight;
    this.canvas.width  = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.HUB.x = this.W / 2;
    this.HUB.y = this.H / 2;
    this.repositionPencils();
    this.redraw();
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('classical');
      pickSessionKey(this.app.prompt() || 'subway');
    });
  }

  hashTopic(id) { const s = String(id || ''); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h); }

  topicToSessionMidi(topicId) {
    const info = this.topicInfo(topicId);
    const freq = info.note || 440;
    return quantizeToKey(Math.round(69 + 12 * Math.log2(freq / 440)));
  }

  jingleForTopic(topicId) { return TRANSIT_JINGLES[this.hashTopic(topicId) % TRANSIT_JINGLES.length]; }

  playStationChime(station) {
    if (!station) return;
    const jingle = this.jingleForTopic(station.topic);
    const baseMidi = this.topicToSessionMidi(station.topic);
    jingle.notes.forEach((d, i) => { setTimeout(() => playSynth({ midi: baseMidi + d + 12, ...PRESETS.bell, duration: 0.4, vol: 0.09, reverbSend: 0.45 }), i * jingle.stride); });
  }

  playInterchangeCanon(sourceStation) {
    if (!sourceStation) return;
    const now = performance.now();
    if (now - this._lastCanonTime < CANON_COOLDOWN_MS) return;
    this._lastCanonTime = now;
    const srcMidi = this.topicToSessionMidi(sourceStation.topic);
    CANON_MOTIF.forEach((d, i) => {
      setTimeout(() => playSynth({ midi: srcMidi + d, ...PRESETS.pluck, vol: 0.11, reverbSend: 0.40 }), i * CANON_STRIDE_MS);
      setTimeout(() => playSynth({ midi: srcMidi + d + 12, ...PRESETS.pluck, vol: 0.09, reverbSend: 0.40 }), CANON_VOICE_GAP_MS + i * CANON_STRIDE_MS);
    });
  }

  playTransferInterval(station) {
    if (!station || !Array.isArray(station.refs)) return;
    const crossRef = station.refs.find(id => { const tgt = this.stations.find(st => st.id === id); return tgt && tgt.topic !== station.topic && station.joinedTo !== tgt; });
    if (!crossRef) return;
    const rootMidi = this.topicToSessionMidi(station.topic) + 12;
    playRelInterval(station.rel || 'supports', rootMidi, { duration: 1.0, voiceOpts: { ...PRESETS.bell, vol: 0.07, reverbSend: 0.55 } });
  }

  isCrossLineInterchange(s) {
    if (s.joinedTo && s.joinedTo.topic !== s.topic) return true;
    if (!Array.isArray(s.refs)) return false;
    return s.refs.some(id => { const tgt = this.stations.find(st => st.id === id); return tgt && tgt.topic !== s.topic; });
  }

  compassFromVector(dx, dy) { const ang = Math.atan2(dy, dx); return ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8; }
  compassDistance(a, b) { let d = Math.abs(a - b) % 8; return Math.min(d, 8 - d); }

  assignLine(topicId) {
    if (this.lineAssignments.has(topicId)) return this.lineAssignments.get(topicId);
    const idealOrder = [0, 5, 2, 7, 4, 1, 6, 3];
    const counts = Array(8).fill(0);
    for (const v of this.lineAssignments.values()) counts[v.dirIdx]++;
    const ideal = idealOrder[this.lineAssignments.size % 8];
    let dirIdx, tier;
    if (counts[ideal] === 0) { dirIdx = ideal; tier = 0; }
    else {
      let minCount = Infinity; dirIdx = ideal;
      for (let d = 0; d < 8; d++) if (counts[d] < minCount) { minCount = counts[d]; dirIdx = d; }
      tier = minCount;
    }
    const a = { dirIdx, tier }; this.lineAssignments.set(topicId, a); return a;
  }

  lineStart(topicId) {
    const a = this.assignLine(topicId), d = DIRS[a.dirIdx], mag = Math.hypot(d.dx, d.dy) || 1;
    const radius = HUB_RADIUS + a.tier * 60;
    return { x: this.HUB.x + (d.dx / mag) * radius, y: this.HUB.y + (d.dy / mag) * radius, dir: a.dirIdx };
  }

  pencilStationsFor(dirIdx, count) {
    const d = DIRS[dirIdx], mag = Math.hypot(d.dx, d.dy) || 1, pts = [];
    for (let n = 0; n < count; n++) {
      const dist = HUB_RADIUS + n * PENCIL_STEP;
      pts.push({ x: this.HUB.x + (d.dx / mag) * dist, y: this.HUB.y + (d.dy / mag) * dist, jx: (Math.random() - 0.5) * 4, jy: (Math.random() - 0.5) * 4 });
    }
    return pts;
  }

  repositionPencils() {
    for (const p of this.pencils) {
      const d = DIRS[p.dirIdx], mag = Math.hypot(d.dx, d.dy) || 1;
      for (let n = 0; n < p.stations.length; n++) { const dist = HUB_RADIUS + n * PENCIL_STEP; p.stations[n].x = this.HUB.x + (d.dx / mag) * dist; p.stations[n].y = this.HUB.y + (d.dy / mag) * dist; }
    }
  }

  spawnPencil() {
    const used = new Set(this.pencils.filter(p => !p.consumed && p.targetAlpha > 0).map(p => p.dirIdx));
    const candidates = []; for (let i = 0; i < 8; i++) if (!used.has(i)) candidates.push(i);
    if (candidates.length === 0) return;
    const dirIdx = candidates[Math.floor(Math.random() * candidates.length)], count = 2 + Math.floor(Math.random() * 3);
    this.pencils.push({ dirIdx, stations: this.pencilStationsFor(dirIdx, count), alpha: 0, targetAlpha: 1, consumed: false, age: 0, lifetime: 150 + Math.random() * 90 });
  }

  startPrime() { this.primePhase = true; this.pencils = []; this.pencilSpawnTimer = 5; this.spawnPencil(); this.spawnPencil(); }
  stopPrime() { this.primePhase = false; for (const p of this.pencils) if (!p.consumed) p.targetAlpha = 0; }

  simulatePrime() {
    if (this.primePhase) {
      this.pencilSpawnTimer--;
      const live = this.pencils.filter(p => !p.consumed && p.targetAlpha > 0).length;
      if (this.pencilSpawnTimer <= 0 && live < 3) { this.spawnPencil(); this.pencilSpawnTimer = 60 + Math.random() * 80; }
    }
    for (let i = this.pencils.length - 1; i >= 0; i--) {
      const p = this.pencils[i]; p.alpha += (p.targetAlpha - p.alpha) * 0.06; p.age++;
      if (this.primePhase && !p.consumed && !p.pinned && p.targetAlpha === 1 && p.age > p.lifetime) p.targetAlpha = 0;
      if (p.targetAlpha === 0 && p.alpha < 0.01) this.pencils.splice(i, 1);
    }
  }

  startTrain(topicId) {
    this.trains = this.trains.filter(t => t.topic !== topicId);
    this.trains.push({ topic: topicId, segIdx: 0, t: 0, waiting: false, waitUntil: 0, lastNow: performance.now() });
  }

  simulateTrains() {
    const now = performance.now();
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const tr = this.trains[i];
      const path = this.stations.filter(s => s.topic === tr.topic);
      if (path.length === 0) { this.trains.splice(i, 1); continue; }
      const fromX = tr.segIdx === 0 ? this.HUB.x : path[tr.segIdx - 1].x;
      const fromY = tr.segIdx === 0 ? this.HUB.y : path[tr.segIdx - 1].y;
      const target = path[tr.segIdx];
      if (!target) { this.trains.splice(i, 1); continue; }
      if (tr.waiting) {
        if (now >= tr.waitUntil) { tr.waiting = false; tr.segIdx++; tr.t = 0; tr.lastNow = now; }
        tr._x = target.x; tr._y = target.y; continue;
      }
      const dx = target.x - fromX, dy = target.y - fromY, len = Math.hypot(dx, dy) || 1;
      const dt = (now - tr.lastNow) / 1000; tr.lastNow = now;
      tr.t += (220 * dt) / len;
      if (tr.t >= 1) {
        tr._x = target.x; tr._y = target.y; tr.waiting = true; tr.waitUntil = now + 400;
        this.playStationChime(target); this.playTransferInterval(target);
        if (this.isCrossLineInterchange(target)) this.playInterchangeCanon(target);
      } else { tr._x = fromX + dx * tr.t; tr._y = fromY + dy * tr.t; }
    }
  }

  addStation(node) {
    const info = this.topicInfo(node.topic);
    const sameLine = this.stations.filter(s => s.topic === node.topic);
    let x, y, dir, joinedTo = null;
    if (sameLine.length === 0) {
      const start = this.lineStart(node.topic);
      x = start.x; y = start.y; dir = start.dir;
      let best = this.pencils.find(p => p.pinned && !p.consumed && p.targetAlpha > 0);
      if (!best) { let bestD = 9; for (const p of this.pencils) { if (p.consumed || p.targetAlpha === 0) continue; const cd = this.compassDistance(p.dirIdx, start.dir); if (cd < bestD) { bestD = cd; best = p; } } }
      if (best) { best.consumed = true; best.targetAlpha = 0; }
    } else {
      const last = sameLine[sameLine.length - 1];
      const wantJoin = node.type === 'choice' || node.type === 'resolution' || Math.random() < 0.15;
      if (wantJoin) {
        const candidates = this.stations.filter(s => s.topic !== node.topic && !s.isTerminus).map(s => ({ s, d: Math.hypot(s.x - last.x, s.y - last.y) })).filter(c => c.d > 140 && c.d < 340).sort((a, b) => a.d - b.d);
        if (candidates.length) joinedTo = candidates[0].s;
      }
      if (joinedTo) { x = joinedTo.x; y = joinedTo.y; dir = this.compassFromVector(x - last.x, y - last.y); joinedTo.isInterchange = true; }
      else {
        dir = last.dir;
        if (node.type === 'branch') dir = (dir + (Math.random() < 0.5 ? 1 : 7)) % 8;
        else if (node.type === 'choice') dir = (dir + (Math.random() < 0.5 ? 2 : 6)) % 8;
        else if (node.type === 'dead-end') dir = (dir + (Math.random() < 0.5 ? 3 : 5)) % 8;
        else if (Math.random() < 0.1) dir = (dir + (Math.random() < 0.5 ? 1 : 7)) % 8;
        const step = 95 + node.confidence * 70;
        const d0 = DIRS[dir], mag0 = Math.hypot(d0.dx, d0.dy) || 1;
        x = last.x + (d0.dx / mag0) * step; y = last.y + (d0.dy / mag0) * step;
        const margin = 90; let attempts = 0;
        while (attempts < 4 && (x < margin || x > this.W - margin || y < margin || y > this.H - margin)) {
          dir = (dir + 2) % 8; const dd = DIRS[dir], mm = Math.hypot(dd.dx, dd.dy) || 1;
          x = last.x + (dd.dx / mm) * step; y = last.y + (dd.dy / mm) * step; attempts++;
        }
      }
    }
    const d = DIRS[dir], mag = Math.hypot(d.dx, d.dy) || 1, perpX = -d.dy / mag, perpY = d.dx / mag;
    this.stations.push({ ...node, x, y, dir, color: info.color, isInterchange: node.type === 'resolution' || node.type === 'choice' || !!joinedTo, isTerminus: sameLine.length === 0, joinedTo, curveSide: joinedTo ? (Math.random() < 0.5 ? 1 : -1) : 0, perpX, perpY, born: performance.now() });
  }

  topicUnderPoint(mx, my, tol = 10) {
    let bestTopic = null, best = tol;
    for (const topic of this.topics) {
      const pts = this.stations.filter(s => s.topic === topic.id); if (pts.length === 0) continue;
      let prev = { x: this.HUB.x, y: this.HUB.y };
      for (const p of pts) {
        const dx = p.x - prev.x, dy = p.y - prev.y, len2 = dx * dx + dy * dy || 1;
        let t = ((mx - prev.x) * dx + (my - prev.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(mx - (prev.x + dx * t), my - (prev.y + dy * t));
        if (d < best) { best = d; bestTopic = topic.id; }
        prev = p;
      }
    }
    return bestTopic;
  }

  pencilUnderPoint(mx, my, tol = 12) {
    let bestPencil = null, best = tol;
    for (const p of this.pencils) {
      if (p.consumed || p.targetAlpha === 0) continue;
      let prev = { x: this.HUB.x, y: this.HUB.y };
      for (const s of p.stations) {
        const sx = s.x + s.jx, sy = s.y + s.jy;
        const dx = sx - prev.x, dy = sy - prev.y, len2 = dx * dx + dy * dy || 1;
        let t = ((mx - prev.x) * dx + (my - prev.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(mx - (prev.x + dx * t), my - (prev.y + dy * t));
        if (d < best) { best = d; bestPencil = p; }
        prev = { x: sx, y: sy };
      }
    }
    return bestPencil;
  }

  drawTransferArcs() {
    if (!this.sessionHasRefs()) return;
    for (const src of this.stations) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      const sPos = src.joinedTo || src;
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.stations); if (!tgt) continue;
        if (tgt.topic === src.topic) continue;
        const tPos = tgt.joinedTo || tgt;
        if (src.joinedTo === tgt || tgt.joinedTo === src) continue;
        let dash = [3, 3], width = 1.3, alphaMult = 1;
        switch (src.rel) { case 'supports': dash = []; break; case 'refines': dash = [1, 3]; width = 1.0; alphaMult = 0.8; break; case 'synthesizes': dash = []; width = 2.0; break; case 'contradicts': dash = [5, 3]; alphaMult = 0.9; break; case 'questions': dash = [2, 3]; alphaMult = 0.8; break; case 'supersedes': dash = [4, 4]; alphaMult = 0.7; break; }
        this.ctx.strokeStyle = src.color; this.ctx.globalAlpha = 0.55 * alphaMult; this.ctx.lineWidth = width; this.ctx.setLineDash(dash); this.ctx.lineCap = 'round';
        const mx = (sPos.x + tPos.x) / 2, my = (sPos.y + tPos.y) / 2;
        const dx = tPos.x - sPos.x, dy = tPos.y - sPos.y, len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(30, len * 0.12), cx = mx + (-dy / len) * bend, cy = my + (dx / len) * bend;
        this.ctx.beginPath(); this.ctx.moveTo(sPos.x, sPos.y); this.ctx.quadraticCurveTo(cx, cy, tPos.x, tPos.y); this.ctx.stroke(); this.ctx.setLineDash([]);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  drawPencils() {
    if (this.pencils.length === 0) return;
    this.ctx.save();
    for (const p of this.pencils) {
      if (p.alpha < 0.01) continue;
      const a = p.alpha, darken = p.pinned ? 1.55 : 1;
      this.ctx.strokeStyle = `rgba(70,65,60,${Math.min(1, a * 0.55 * darken)})`; this.ctx.lineWidth = p.pinned ? 2 : 1.5; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round'; this.ctx.setLineDash([4, 3]);
      this.ctx.beginPath(); this.ctx.moveTo(this.HUB.x, this.HUB.y);
      for (const s of p.stations) this.ctx.lineTo(s.x + s.jx, s.y + s.jy);
      this.ctx.stroke();
      this.ctx.strokeStyle = `rgba(130,125,120,${a * 0.25})`; this.ctx.setLineDash([3, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(this.HUB.x + 1, this.HUB.y + 1);
      for (const s of p.stations) this.ctx.lineTo(s.x + s.jx + 1, s.y + s.jy + 1);
      this.ctx.stroke(); this.ctx.setLineDash([]);
      for (const s of p.stations) { this.ctx.strokeStyle = `rgba(110,105,100,${a * 0.7})`; this.ctx.lineWidth = 1.2; this.ctx.beginPath(); this.ctx.arc(s.x + s.jx, s.y + s.jy, 4.5, 0, Math.PI * 2); this.ctx.stroke(); }
    }
    this.ctx.restore();
  }

  drawLines() {
    const ht = this.app.highlightedTopic;
    for (const topic of this.topics) {
      const pts = this.stations.filter(s => s.topic === topic.id); if (pts.length < 1) continue;
      const lineDim = ht && topic.id !== ht ? 0.25 : 1;
      this.ctx.globalAlpha = lineDim;
      this.ctx.strokeStyle = topic.color; this.ctx.lineWidth = 10; this.ctx.lineCap = 'butt'; this.ctx.lineJoin = 'miter'; this.ctx.miterLimit = 8;
      this.ctx.beginPath(); this.ctx.moveTo(this.HUB.x, this.HUB.y);
      let prevX = this.HUB.x, prevY = this.HUB.y;
      for (const p of pts) {
        if (p.joinedTo) {
          const dx = p.x - prevX, dy = p.y - prevY, len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len, curveAmt = Math.min(len * 0.28, 70);
          const cx = (prevX + p.x) / 2 + nx * curveAmt * p.curveSide, cy = (prevY + p.y) / 2 + ny * curveAmt * p.curveSide;
          this.ctx.quadraticCurveTo(cx, cy, p.x, p.y);
        } else this.ctx.lineTo(p.x, p.y);
        prevX = p.x; prevY = p.y;
      }
      this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
  }

  drawStations() {
    const ht = this.app.highlightedTopic;
    this.ctx.font = '500 11px "Space Grotesk", Helvetica, Arial, sans-serif'; this.ctx.textBaseline = 'middle';
    for (const s of this.stations) {
      const stanceAlpha = s.stance === 'conceding' ? 0.5 : s.stance === 'questioning' ? 0.75 : s.stance === 'exploring' ? 0.85 : 1;
      const legendDim = ht && s.topic !== ht ? 0.25 : 1;
      const incoming = this.nodeIncoming(s), boost = Math.min(4, incoming * 0.8);
      this.ctx.globalAlpha = stanceAlpha * legendDim;
      if (s.isInterchange) {
        this.ctx.fillStyle = '#ffffff'; this.ctx.strokeStyle = '#111'; this.ctx.lineWidth = 3 + (boost > 0 ? 1 : 0);
        this.ctx.beginPath(); this.ctx.arc(s.x, s.y, 9 + boost, 0, Math.PI * 2); this.ctx.fill(); this.ctx.stroke();
        if (incoming >= 3) { this.ctx.lineWidth = 1; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, 9 + boost + 4, 0, Math.PI * 2); this.ctx.stroke(); }
      } else {
        this.ctx.fillStyle = '#ffffff'; this.ctx.strokeStyle = s.stance === 'questioning' ? '#666' : '#111'; this.ctx.lineWidth = 1.8;
        if (s.stance === 'exploring') this.ctx.setLineDash([2, 2]);
        this.ctx.beginPath(); this.ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2); this.ctx.fill(); this.ctx.stroke(); this.ctx.setLineDash([]);
      }
      if (s.heat != null && s.heat > 0.1) {
        const mx = s.x + s.perpX * 8 - s.perpY * 2, my = s.y + s.perpY * 8 + s.perpX * 2;
        this.ctx.globalAlpha = stanceAlpha * legendDim * (0.5 + s.heat * 0.5); this.ctx.fillStyle = '#111';
        this.ctx.beginPath(); this.ctx.moveTo(mx, my - 3); this.ctx.lineTo(mx + 3, my); this.ctx.lineTo(mx, my + 3); this.ctx.lineTo(mx - 3, my); this.ctx.closePath(); this.ctx.fill();
      }
      if (this.nodeHasExternalBecause(s)) {
        this.ctx.globalAlpha = stanceAlpha * 0.7; this.ctx.fillStyle = '#666'; this.ctx.font = '600 10px "JetBrains Mono", monospace'; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
        this.ctx.fillText('↑', s.x + (s.isInterchange ? 12 : 7), s.y - 8);
        this.ctx.font = '500 11px "Space Grotesk", Helvetica, Arial, sans-serif';
      }
    }
    for (const s of this.stations) {
      if (s.joinedTo) continue;
      const label = this.formatLabel(s.text); if (!label) continue;
      const sLegendDim = ht && s.topic !== ht ? 0.25 : 1;
      const offset = s.isInterchange ? 18 : 14, lx = s.x + s.perpX * offset, ly = s.y + s.perpY * offset;
      if (Math.abs(s.perpX) < 0.3) this.ctx.textAlign = 'center';
      else if (s.perpX > 0) this.ctx.textAlign = 'left';
      else this.ctx.textAlign = 'right';
      this.ctx.globalAlpha = sLegendDim;
      this.ctx.fillStyle = '#111'; this.ctx.fillText(label, lx, ly);
    }
    this.ctx.globalAlpha = 1;
  }

  formatLabel(text) {
    if (!text) return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= 22) return clean;
    const cut = clean.slice(0, 22), lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 8 ? cut.slice(0, lastSpace) : cut) + '…';
  }

  drawHub() {
    if (this.topics.length === 0 && this.pencils.length === 0) return;
    this.ctx.fillStyle = '#ffffff'; this.ctx.strokeStyle = '#111'; this.ctx.lineWidth = 4;
    this.ctx.beginPath(); this.ctx.arc(this.HUB.x, this.HUB.y, 15, 0, Math.PI * 2); this.ctx.fill(); this.ctx.stroke();
  }

  drawTrains() {
    for (const tr of this.trains) {
      if (tr._x === undefined) continue;
      const info = this.topicInfo(tr.topic);
      this.ctx.fillStyle = '#ffffff'; this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 3;
      this.ctx.beginPath(); this.ctx.arc(tr._x, tr._y, 7, 0, Math.PI * 2); this.ctx.fill(); this.ctx.stroke();
      this.ctx.fillStyle = '#111'; this.ctx.beginPath(); this.ctx.arc(tr._x, tr._y, 2, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  redraw() {
    this.ctx.fillStyle = '#ffffff'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawMapFibre();
    this.drawCoordinateGrid();
    this.drawPencils(); this.drawLines(); this.drawTransferArcs(); this.drawStations(); this.drawHub(); this.drawTrains();
  }

  // Coordinate grid — faint micro-grid lines every 60px in both directions.
  // Cartographic underlay. Cached.
  drawCoordinateGrid() {
    if (!this._gridOff || this._gridW !== this.W || this._gridH !== this.H) {
      if (!this._gridOff) this._gridOff = document.createElement('canvas');
      this._gridOff.width = Math.max(1, Math.ceil(this.W));
      this._gridOff.height = Math.max(1, Math.ceil(this.H));
      this._gridW = this.W; this._gridH = this.H;
      const oc = this._gridOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.strokeStyle = 'rgba(0, 0, 0, 0.04)';
      oc.lineWidth = 0.5;
      for (let x = 60.5; x < this.W; x += 60) {
        oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, this.H); oc.stroke();
      }
      for (let y = 60.5; y < this.H; y += 60) {
        oc.beginPath(); oc.moveTo(0, y); oc.lineTo(this.W, y); oc.stroke();
      }
    }
    this.ctx.drawImage(this._gridOff, 0, 0);
  }

  // Map paper fibre — sparse fibre-like specks tiled via createPattern.
  // Folded paper map.
  drawMapFibre() {
    if (!this._fibrePattern) {
      const tile = document.createElement('canvas');
      tile.width = 96; tile.height = 96;
      const tc = tile.getContext('2d');
      const id = tc.createImageData(96, 96);
      for (let i = 0; i < 96 * 96; i++) {
        if (Math.random() < 0.09) {
          id.data[i * 4 + 0] = 90 + Math.random() * 30;
          id.data[i * 4 + 1] = 80 + Math.random() * 25;
          id.data[i * 4 + 2] = 60 + Math.random() * 20;
          id.data[i * 4 + 3] = 18 + Math.random() * 16;
        } else {
          id.data[i * 4 + 3] = 0;
        }
      }
      tc.putImageData(id, 0, 0);
      this._fibrePattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._fibrePattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  onStart() {
    this.initAural();
    this.HUB.x = this.W / 2;
    this.HUB.y = this.H / 2;
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one pencil-sketched route per token, with the compass
  // direction and station count determined by the token. Same prompt → same
  // initial route pattern (subtle determinism). Routes fade as real stations arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;

    const usedDirs = new Set();
    for (const tok of tokens) {
      // Hash → compass direction (0-7). Skip if direction already used (one route per direction).
      const h = this.hashToken(tok);
      let dirIdx = h % 8;
      let tries = 0;
      while (usedDirs.has(dirIdx) && tries < 8) { dirIdx = (dirIdx + 1) % 8; tries++; }
      if (usedDirs.has(dirIdx)) break;        // all 8 directions taken
      usedDirs.add(dirIdx);

      // Station count = token length / 2 (clamped 2..5)
      const count = Math.max(2, Math.min(5, Math.floor(tok.length / 2)));
      this.pencils.push({
        dirIdx,
        stations: this.pencilStationsFor(dirIdx, count),
        alpha: 0,
        targetAlpha: 1,
        consumed: false,
        age: 0,
        lifetime: 150 + Math.random() * 90,
      });
    }
  }

  onNode(n) {
    if (this.primePhase && this.stations.length === 0) {
      this.HUB.x = this.W / 2;
      this.HUB.y = this.H / 2;
    }
    this.addStation(n);
    const s = this.stations[this.stations.length - 1];
    this.playStationChime(s); this.playTransferInterval(s);
    if (s && this.isCrossLineInterchange(s)) this.playInterchangeCanon(s);
  }

  onTopics(t) {
    // topics handled by base class; rebuild HUB position
    if (!this.primePhase) return;
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.stations = []; this.pencils = []; this.trains = [];
    this.primePhase = false; this.lineAssignments.clear(); this._lastCanonTime = 0;
    this.redraw();
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    this.simulateTrains();
    this.redraw();
  }
}

export { SubwayMode };
