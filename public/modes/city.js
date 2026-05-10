import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, playNodeSound, playTone, nodeBy } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, getSessionKey, quantizeToKey } from '/synth.js';

const CELL = 40;
const CAR_COLORS = ['#e8d44d', '#ffffff', '#ff6b6b', '#4dabf7', '#ffa94d'];
const ROAD_POSITIONS = [-10, -5, 0, 5, 10];

class CityMode extends Mode {
  buildings = [];
  cars = [];
  parks = [];
  stars = [];
  frame = 0;
  primePhase = false;
  surveyBreathPhase = 0;
  surveyMarkers = [];
  surveyMarkerTimer = 0;
  lastMarkerPos = null;
  subWobbleVoice = null;
  crackleTimer = null;

  constructor() {
    super({
      mode: 'city',
      aesthetic: 'ambient',
      topicFallbackColor: '#aabbcc',
      vars: {
        '--e-bg': '#1a2030', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#f1bd58', '--e-pivot-tint': 'rgba(241,189,88,0.06)', '--e-accent': '#7cbfc6',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let closest = null, cd = 30;
      for (const b of this.buildings) {
        if (b._screenX == null) continue;
        const d = Math.hypot(b._screenX - mx, b._screenY - my);
        if (d < cd) { cd = d; closest = b; }
      }
      if (closest) { showTooltip(e, closest, closest.color); this.app.highlightLegendTopic(closest.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.primePhase) {
        const cell = this.screenToGrid(mx, my);
        this.surveyMarkers.push({ gx: cell.gx, gy: cell.gy, age: 0, maxAge: 80 });
        this.lastMarkerPos = { gx: cell.gx, gy: cell.gy };
        return;
      }
      let hitBuilding = null, bd = 30;
      for (const b of this.buildings) {
        if (b._screenX == null) continue;
        const d = Math.hypot(b._screenX - mx, b._screenY - my);
        if (d < bd) { bd = d; hitBuilding = b; }
      }
      if (hitBuilding) {
        hitBuilding.flashUntil = performance.now() + 1000;
        playNodeSound(hitBuilding.type, this.topicInfo(hitBuilding.topic).note);
        return;
      }
      let hitCar = null, cd = 20;
      for (const c of this.cars) {
        const cp = this.iso(c.gx, c.gy, 0);
        const d = Math.hypot(cp.x - mx, cp.y - my);
        if (d < cd) { cd = d; hitCar = c; }
      }
      if (hitCar) { hitCar.boostUntil = performance.now() + 2000; playTone(800, 0.12, 'square', 0.05); return; }
      const cell = this.screenToGrid(mx, my);
      const onRoad = ROAD_POSITIONS.some(r => Math.abs(cell.gx - r) < 1 || Math.abs(cell.gy - r) < 1);
      const occupied = onRoad || this.buildings.some(b => b.gx === cell.gx && b.gy === cell.gy) || this.parks.some(p => p.gx === cell.gx && p.gy === cell.gy);
      if (!occupied) this.parks.push({ gx: cell.gx, gy: cell.gy });
    });
  }

  count() { return this.buildings.length; }
  legendItems() { return this.buildings; }

  buildingIncoming(b) { return b.id != null ? (this.incomingRefsMap[b.id] ?? incomingRefsOf(b.id, this.buildings)) : 0; }
  hasExternalBecause(b) { return Array.isArray(b.because) && b.because.some(x => typeof x === 'string'); }
  sessionHasRefs() {
    for (const b of this.buildings) if (Array.isArray(b.refs) && b.refs.length > 0) return true;
    return false;
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'city');
    });
  }

  topicScaleNote(topicId, octaveOffset = 12) {
    const key = getSessionKey();
    const idx = Math.max(0, this.topics.findIndex(t => t.id === topicId));
    const degree = (idx * 2 + 2) % key.notes.length;
    return key.notes[degree] + octaveOffset;
  }

  startSubWobble() {
    if (this.subWobbleVoice) return;
    const root = getSessionKey().rootMidi;
    this.subWobbleVoice = playSynth({ midi: root - 24, wave: 'sine', duration: 600, vol: 0.14, attack: 0.3, release: 1.0, tremolo: { rate: 1.2, depth: 0.4 }, reverbSend: 0.5 });
  }

  stopSubWobble() {
    if (this.subWobbleVoice) { try { this.subWobbleVoice.stop(); } catch {} this.subWobbleVoice = null; }
  }

  startCrackle() {
    if (this.crackleTimer) return;
    const tick = () => {
      if (!this.crackleTimer) return;
      const cutoff = 6000 + Math.random() * 3000;
      playSynth({ freq: 440, wave: 'sawtooth', voices: 4, detune: 50, attack: 0.001, decay: 0.003, sustain: 0.3, release: 0.005, duration: 0.008, vol: 0.010, filter: { type: 'bandpass', freq: cutoff, Q: 2 } });
      this.crackleTimer = setTimeout(tick, 180 + Math.random() * 240);
    };
    this.crackleTimer = setTimeout(tick, 100);
  }

  stopCrackle() {
    if (this.crackleTimer) { clearTimeout(this.crackleTimer); this.crackleTimer = null; }
  }

  playVoiceStab(node) {
    const baseMidi = this.topicScaleNote(node.topic);
    playSynth({ midi: baseMidi, wave: 'triangle', voices: 2, detune: 8, duration: 1.0, vol: 0.08, attack: 0.2, release: 0.7, filter: { type: 'bandpass', freq: 900, Q: 3 }, reverbSend: 0.8 });
  }

  stopAllAural() { this.stopSubWobble(); this.stopCrackle(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = innerWidth;
    this.H = innerHeight;
    this.canvas.width  = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.initStars();
    this.redraw();
  }

  initStars() {
    this.stars = [];
    for (let i = 0; i < 100; i++) {
      this.stars.push({ x: Math.random() * this.W, y: Math.random() * this.H * 0.5, phase: Math.random() * Math.PI * 2, speed: 0.01 + Math.random() * 0.02, size: 0.5 + Math.random() * 1.2 });
    }
  }

  iso(gx, gy, gz) {
    const cx = this.W / 2, cy = this.H * 0.6;
    return { x: cx + (gx - gy) * CELL * 0.5, y: cy + (gx + gy) * CELL * 0.25 - gz * CELL * 0.3 };
  }

  shade(hex, factor) {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.round(r*factor)}, ${Math.round(g*factor)}, ${Math.round(b*factor)})`;
  }

  addBuilding(node) {
    const info = this.topicInfo(node.topic);
    const topicIdx = this.topics.findIndex(t => t.id === node.topic);
    const districtSize = 5;
    const districtX = ((topicIdx % 4) - 2) * districtSize;
    const districtY = (Math.floor(topicIdx / 4) - 1) * districtSize;
    let gx, gy, tries = 0;
    if (node._atGx !== undefined) { gx = node._atGx; gy = node._atGy; }
    else {
      do { gx = districtX + Math.floor(Math.random() * districtSize); gy = districtY + Math.floor(Math.random() * districtSize); tries++; }
      while (tries < 20 && this.buildings.find(b => b.gx === gx && b.gy === gy));
    }
    const height = 1 + (node.confidence || 0.7) * 6;
    this.buildings.push({ ...node, gx, gy, baseHeight: height, height, targetHeight: height, currentHeight: 0, color: info.color });
  }

  drawBuilding(b) {
    const h = b.currentHeight;
    if (h < 0.01) return;
    const isDerelict = b.stance === 'conceding';
    const buildingColor = isDerelict ? this.shade(b.color, 0.5) : b.color;
    const p000 = this.iso(b.gx, b.gy, 0), p100 = this.iso(b.gx + 1, b.gy, 0);
    const p110 = this.iso(b.gx + 1, b.gy + 1, 0), p010 = this.iso(b.gx, b.gy + 1, 0);
    const p001 = this.iso(b.gx, b.gy, h), p101 = this.iso(b.gx + 1, b.gy, h);
    const p111 = this.iso(b.gx + 1, b.gy + 1, h), p011 = this.iso(b.gx, b.gy + 1, h);
    this.ctx.fillStyle = this.shade(buildingColor, 0.85);
    this.ctx.beginPath(); this.ctx.moveTo(p100.x, p100.y); this.ctx.lineTo(p110.x, p110.y); this.ctx.lineTo(p111.x, p111.y); this.ctx.lineTo(p101.x, p101.y); this.ctx.closePath(); this.ctx.fill();
    this.ctx.fillStyle = this.shade(buildingColor, 0.6);
    this.ctx.beginPath(); this.ctx.moveTo(p000.x, p000.y); this.ctx.lineTo(p100.x, p100.y); this.ctx.lineTo(p101.x, p101.y); this.ctx.lineTo(p001.x, p001.y); this.ctx.closePath(); this.ctx.fill();
    this.ctx.fillStyle = buildingColor;
    this.ctx.beginPath(); this.ctx.moveTo(p001.x, p001.y); this.ctx.lineTo(p101.x, p101.y); this.ctx.lineTo(p111.x, p111.y); this.ctx.lineTo(p011.x, p011.y); this.ctx.closePath(); this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(0,0,0,0.3)'; this.ctx.lineWidth = 1;
    this.ctx.beginPath(); this.ctx.moveTo(p000.x, p000.y); this.ctx.lineTo(p100.x, p100.y); this.ctx.lineTo(p101.x, p101.y); this.ctx.lineTo(p001.x, p001.y); this.ctx.closePath(); this.ctx.stroke();
    this.ctx.beginPath(); this.ctx.moveTo(p100.x, p100.y); this.ctx.lineTo(p110.x, p110.y); this.ctx.lineTo(p111.x, p111.y); this.ctx.lineTo(p101.x, p101.y); this.ctx.closePath(); this.ctx.stroke();
    b._screenX = p001.x; b._screenY = p001.y;
  }

  drawWindows(b) {
    const h = b.currentHeight;
    if (h < 0.8) return;
    const bIdx = this.buildings.indexOf(b);
    const flashing = b.flashUntil && performance.now() < b.flashUntil;
    const winW = 0.12, winH = 0.18;
    const cols = [0.25, 0.5, 0.75];
    const litColor = flashing ? 'rgba(255,245,200,0.95)' : 'rgba(255,230,150,0.85)';
    const darkColor = 'rgba(0,0,0,0.25)';
    let litThreshold = 65;
    if (b.heat != null && b.heat > 0) litThreshold = 65 + Math.floor(b.heat * 30);
    if (b.stance === 'conceding') litThreshold = 15;
    for (const fracX of cols) {
      for (let wz = 0.3; wz < h - 0.2; wz += 0.55) {
        const wx = b.gx + fracX - winW / 2;
        const lit = flashing || ((bIdx * 7 + Math.floor(fracX * 10) * 13 + Math.floor(wz * 10) * 47) % 100) < litThreshold;
        const p1 = this.iso(wx, b.gy, wz), p2 = this.iso(wx + winW, b.gy, wz), p3 = this.iso(wx + winW, b.gy, wz + winH), p4 = this.iso(wx, b.gy, wz + winH);
        this.ctx.fillStyle = lit ? litColor : darkColor;
        this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.lineTo(p3.x, p3.y); this.ctx.lineTo(p4.x, p4.y); this.ctx.closePath(); this.ctx.fill();
      }
    }
    for (const fracY of cols) {
      for (let wz = 0.3; wz < h - 0.2; wz += 0.55) {
        const wy = b.gy + fracY - winW / 2;
        const lit = flashing || ((bIdx * 11 + Math.floor(fracY * 10) * 19 + Math.floor(wz * 10) * 37) % 100) < litThreshold;
        const p1 = this.iso(b.gx + 1, wy, wz), p2 = this.iso(b.gx + 1, wy + winW, wz), p3 = this.iso(b.gx + 1, wy + winW, wz + winH), p4 = this.iso(b.gx + 1, wy, wz + winH);
        this.ctx.fillStyle = lit ? litColor : darkColor;
        this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.lineTo(p3.x, p3.y); this.ctx.lineTo(p4.x, p4.y); this.ctx.closePath(); this.ctx.fill();
      }
    }
  }

  drawBuildingMarkers(b) {
    if (b.currentHeight < 0.5) return;
    const inc = this.buildingIncoming(b);
    if (inc >= 3) {
      const top = this.iso(b.gx + 0.5, b.gy + 0.5, b.currentHeight + 0.4);
      this.ctx.fillStyle = '#d4a332'; this.ctx.font = "700 14px 'Space Grotesk', sans-serif";
      this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText('★', top.x, top.y);
    }
    if (b.stance === 'questioning' && b.currentHeight > 1.5) {
      this.ctx.strokeStyle = 'rgba(235, 210, 120, 0.55)'; this.ctx.lineWidth = 1;
      const top1 = this.iso(b.gx, b.gy, b.currentHeight + 0.1), top2 = this.iso(b.gx + 1, b.gy + 1, b.currentHeight + 0.1);
      const top3 = this.iso(b.gx + 1, b.gy, b.currentHeight + 0.1), top4 = this.iso(b.gx, b.gy + 1, b.currentHeight + 0.1);
      this.ctx.beginPath(); this.ctx.moveTo(top1.x, top1.y); this.ctx.lineTo(top2.x, top2.y); this.ctx.moveTo(top3.x, top3.y); this.ctx.lineTo(top4.x, top4.y); this.ctx.stroke();
    }
    if (this.hasExternalBecause(b)) {
      const spot = this.iso(b.gx + 1, b.gy, b.currentHeight + 0.2);
      this.ctx.fillStyle = 'rgba(220, 225, 235, 0.75)'; this.ctx.font = "500 10px 'JetBrains Mono', monospace";
      this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText('↗', spot.x + 2, spot.y);
    }
  }

  drawStars() {
    for (const s of this.stars) {
      s.phase += s.speed;
      const alpha = 0.3 + 0.5 * (Math.sin(s.phase) * 0.5 + 0.5);
      this.ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      this.ctx.beginPath(); this.ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  drawGroundQuad(gx1, gy1, gx2, gy2, color) {
    const p1 = this.iso(gx1, gy1, 0), p2 = this.iso(gx2, gy1, 0), p3 = this.iso(gx2, gy2, 0), p4 = this.iso(gx1, gy2, 0);
    this.ctx.fillStyle = color;
    this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.lineTo(p3.x, p3.y); this.ctx.lineTo(p4.x, p4.y); this.ctx.closePath(); this.ctx.fill();
  }

  drawRoads() {
    const ROAD_W = 0.35, MIN = -15, MAX = 15, roadColor = 'rgba(35,42,55,0.55)';
    for (let gy = -10; gy <= 10; gy += 5) this.drawGroundQuad(MIN, gy - ROAD_W, MAX, gy + ROAD_W, roadColor);
    for (let gx = -10; gx <= 10; gx += 5) this.drawGroundQuad(gx - ROAD_W, MIN, gx + ROAD_W, MAX, roadColor);
  }

  drawRefsRoads() {
    if (!this.sessionHasRefs()) return;
    for (const src of this.buildings) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      const sCentre = this.iso(src.gx + 0.5, src.gy + 0.5, 0);
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.buildings);
        if (!tgt || tgt === src) continue;
        const tCentre = this.iso(tgt.gx + 0.5, tgt.gy + 0.5, 0);
        this.drawRelRoad(sCentre, tCentre, src.color, src.rel);
      }
      if (Array.isArray(src.because)) {
        for (const b of src.because) {
          if (typeof b !== 'number') continue;
          const tgt = nodeBy(b, this.buildings);
          if (!tgt || tgt === src) continue;
          const tCentre = this.iso(tgt.gx + 0.5, tgt.gy + 0.5, 0);
          this.drawRelRoad(sCentre, tCentre, src.color, null, true);
        }
      }
    }
  }

  drawRelRoad(from, to, color, rel, isBecause) {
    let width = 2, dash = [], alpha = 0.55;
    if (isBecause) { width = 1.2; dash = [1, 4]; alpha = 0.35; }
    else switch (rel) {
      case 'supports': width = 2.5; dash = []; alpha = 0.60; break;
      case 'refines': width = 1.5; dash = [2, 3]; alpha = 0.45; break;
      case 'synthesizes': width = 3.5; dash = []; alpha = 0.72; break;
      case 'contradicts': width = 1.8; dash = [5, 3]; alpha = 0.55; break;
      case 'questions': width = 1.2; dash = [2, 4]; alpha = 0.40; break;
      case 'supersedes': width = 1.5; dash = [6, 4]; alpha = 0.35; break;
    }
    this.ctx.strokeStyle = color; this.ctx.globalAlpha = alpha; this.ctx.lineWidth = width;
    if (dash.length) this.ctx.setLineDash(dash);
    this.ctx.lineCap = 'round';
    this.ctx.beginPath(); this.ctx.moveTo(from.x, from.y); this.ctx.lineTo(to.x, to.y); this.ctx.stroke();
    if (dash.length) this.ctx.setLineDash([]);
    this.ctx.globalAlpha = 1;
  }

  drawParks() {
    for (const p of this.parks) {
      const p1 = this.iso(p.gx, p.gy, 0), p2 = this.iso(p.gx + 1, p.gy, 0), p3 = this.iso(p.gx + 1, p.gy + 1, 0), p4 = this.iso(p.gx, p.gy + 1, 0);
      this.ctx.fillStyle = 'rgba(40,120,60,0.45)';
      this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.lineTo(p3.x, p3.y); this.ctx.lineTo(p4.x, p4.y); this.ctx.closePath(); this.ctx.fill();
    }
  }

  drawAvLights() {
    for (const b of this.buildings) {
      if (b.currentHeight < 4) continue;
      const blinkPhase = (this.frame * 0.05 + this.buildings.indexOf(b) * 1.7) % (Math.PI * 2);
      if (Math.sin(blinkPhase) < 0.3) continue;
      const top = this.iso(b.gx + 0.5, b.gy + 0.5, b.currentHeight + 0.15);
      this.ctx.fillStyle = 'rgba(255,40,40,0.9)';
      this.ctx.beginPath(); this.ctx.arc(top.x, top.y, 2.5, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = 'rgba(255,40,40,0.12)';
      this.ctx.beginPath(); this.ctx.arc(top.x, top.y, 8, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  screenToGrid(mx, my) {
    const cx = this.W / 2, cy = this.H * 0.6;
    const sx = mx - cx, sy = my - cy;
    return { gx: Math.floor((sx + 2 * sy) / CELL), gy: Math.floor((2 * sy - sx) / CELL) };
  }

  spawnCar() {
    const horiz = Math.random() < 0.5;
    const roadPos = ROAD_POSITIONS[Math.floor(Math.random() * ROAD_POSITIONS.length)];
    const speed = (Math.random() < 0.5 ? 1 : -1) * (0.035 + Math.random() * 0.025);
    const color = CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
    const startPos = speed > 0 ? -14 : 14;
    if (horiz) this.cars.push({ gx: startPos, gy: roadPos, vx: speed, vy: 0, color, lastInt: -999 });
    else this.cars.push({ gx: roadPos, gy: startPos, vx: 0, vy: speed, color, lastInt: -999 });
  }

  simulateCars() {
    const now = performance.now();
    for (const c of this.cars) {
      const boost = (c.boostUntil && now < c.boostUntil) ? 2 : 1;
      c.gx += c.vx * boost; c.gy += c.vy * boost;
      const snapX = Math.round(c.gx / 5) * 5, snapY = Math.round(c.gy / 5) * 5;
      const nearX = Math.abs(c.gx - snapX) < 0.08, nearY = Math.abs(c.gy - snapY) < 0.08;
      const intKey = snapX * 100 + snapY;
      if (nearX && nearY && intKey !== c.lastInt && Math.random() < 0.3) {
        c.lastInt = intKey;
        const sp = Math.hypot(c.vx, c.vy);
        if (c.vx !== 0) { c.gy = snapY; c.vx = 0; c.vy = (Math.random() < 0.5 ? 1 : -1) * sp; }
        else { c.gx = snapX; c.vy = 0; c.vx = (Math.random() < 0.5 ? 1 : -1) * sp; }
      } else if (nearX && nearY) c.lastInt = intKey;
    }
    this.cars = this.cars.filter(c => c.gx > -16 && c.gx < 16 && c.gy > -12 && c.gy < 14);
    while (this.cars.length < 8 && this.buildings.length > 0) this.spawnCar();
  }

  drawCars() {
    for (const c of this.cars) {
      const sz = 0.3, szH = 0.15;
      const p1 = this.iso(c.gx - sz / 2, c.gy - szH, 0), p2 = this.iso(c.gx + sz / 2, c.gy - szH, 0);
      const p3 = this.iso(c.gx + sz / 2, c.gy + szH, 0), p4 = this.iso(c.gx - sz / 2, c.gy + szH, 0);
      this.ctx.fillStyle = c.color; this.ctx.globalAlpha = 0.75;
      this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.lineTo(p3.x, p3.y); this.ctx.lineTo(p4.x, p4.y); this.ctx.closePath(); this.ctx.fill();
      const hx = c.gx + (c.vx > 0 ? sz / 2 : c.vx < 0 ? -sz / 2 : 0);
      const hy = c.gy + (c.vy > 0 ? szH : c.vy < 0 ? -szH : 0);
      const hp = this.iso(hx, hy, 0);
      this.ctx.fillStyle = 'rgba(255,255,220,0.9)'; this.ctx.globalAlpha = 1;
      this.ctx.beginPath(); this.ctx.arc(hp.x, hp.y, 1.5, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  startPrime() {
    this.primePhase = true;
    this.surveyBreathPhase = 0;
    this.surveyMarkers = [];
    this.surveyMarkerTimer = 30;
    this.lastMarkerPos = null;
  }

  stopPrime() { this.primePhase = false; }

  simulatePrime() {
    if (!this.primePhase && this.surveyMarkers.length === 0) return;
    this.surveyBreathPhase += 0.02;
    if (this.primePhase) {
      this.surveyMarkerTimer--;
      if (this.surveyMarkerTimer <= 0) {
        const gx = -10 + Math.floor(Math.random() * 20), gy = -6 + Math.floor(Math.random() * 14);
        this.surveyMarkers.push({ gx, gy, age: 0, maxAge: 80 });
        this.lastMarkerPos = { gx, gy };
        this.surveyMarkerTimer = 50 + Math.floor(Math.random() * 40);
      }
    }
    for (let i = this.surveyMarkers.length - 1; i >= 0; i--) {
      this.surveyMarkers[i].age++;
      if (this.surveyMarkers[i].age > this.surveyMarkers[i].maxAge) this.surveyMarkers.splice(i, 1);
    }
  }

  drawSurveyGrid() {
    if (!this.primePhase && this.surveyMarkers.length === 0) return;
    const breathAlpha = 0.06 + Math.sin(this.surveyBreathPhase) * 0.03;
    this.ctx.strokeStyle = `rgba(100,120,150,${breathAlpha})`; this.ctx.lineWidth = 0.5;
    for (let gy = -8; gy <= 10; gy++) {
      const p1 = this.iso(-12, gy, 0), p2 = this.iso(12, gy, 0);
      this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.stroke();
    }
    for (let gx = -12; gx <= 12; gx++) {
      const p1 = this.iso(gx, -8, 0), p2 = this.iso(gx, 10, 0);
      this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.stroke();
    }
    for (const m of this.surveyMarkers) {
      const t = m.age / m.maxAge;
      const alpha = t < 0.25 ? t / 0.25 : (1 - t) / 0.75;
      const p1 = this.iso(m.gx, m.gy, 0), p2 = this.iso(m.gx + 1, m.gy, 0), p3 = this.iso(m.gx + 1, m.gy + 1, 0), p4 = this.iso(m.gx, m.gy + 1, 0);
      this.ctx.fillStyle = `rgba(140,170,220,${alpha * 0.3})`;
      this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(p2.x, p2.y); this.ctx.lineTo(p3.x, p3.y); this.ctx.lineTo(p4.x, p4.y); this.ctx.closePath(); this.ctx.fill();
    }
  }

  redraw() {
    const ht = this.app.highlightedTopic;
    const grad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, '#0a0f1c');
    grad.addColorStop(0.7, '#141826');
    grad.addColorStop(0.88, '#26201e');
    grad.addColorStop(1, '#1a2030');
    this.ctx.fillStyle = grad; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawStars(); this.drawRoads(); this.drawRefsRoads(); this.drawParks(); this.drawSurveyGrid();
    const sorted = [...this.buildings].sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
    for (const b of sorted) {
      const dim = ht && b.topic !== ht ? 0.25 : 1;
      this.ctx.globalAlpha = dim;
      this.drawBuilding(b); this.drawWindows(b); this.drawBuildingMarkers(b);
      this.ctx.globalAlpha = 1;
    }
    this.drawCars(); this.drawAvLights();
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: scatter one chalk-outline survey marker per token at a hashed
  // grid position, giving the empty city a sense of "planned plots" before buildings arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const gx = -8 + (h % 17);
      const gy = -5 + ((h >> 5) % 11);
      this.surveyMarkers.push({ gx, gy, age: 0, maxAge: 160 + ((h >> 10) % 60) });
    }
  }

  onNode(n) {
    if (this.primePhase && this.lastMarkerPos) { n._atGx = this.lastMarkerPos.gx; n._atGy = this.lastMarkerPos.gy; }
    this.addBuilding(n);
    if (this.primePhase) this.stopPrime();
    this.startSubWobble();
    this.startCrackle();
    this.playVoiceStab(n);
  }

  onDone() { this.stopPrime(); this.stopAllAural(); }
  onError() { this.stopPrime(); this.stopAllAural(); }
  onStop() { this.stopPrime(); this.stopAllAural(); }

  onClear() {
    this.buildings = [];
    this.cars = [];
    this.parks = [];
    this.surveyMarkers = [];
    this.primePhase = false;
    this.lastMarkerPos = null;
    this.stopAllAural();
    this.redraw();
  }

  draw() {
    if (this.app.isPaused()) return;
    this.frame++;
    for (const b of this.buildings) b.currentHeight += (b.targetHeight - b.currentHeight) * 0.08;
    this.simulatePrime();
    this.simulateCars();
    this.redraw();
  }
}

export { CityMode };
