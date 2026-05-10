import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete, relGlyph } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey } from '/synth.js';

const MODULE = 4;

class ClockworkMode extends Mode {
  gears = [];
  ticks = [];
  components = [];
  nextComponentId = 0;
  nodesSeen = [];
  sparks = [];
  primePhase = false;
  downAt = null;
  draggedGear = null;
  t = 0;

  static SPARK_LIFE_MS = 900;

  constructor() {
    super({
      mode: 'clockwork',
      aesthetic: 'industrial',
      topicFallbackColor: '#c8b068',
      vars: {
        '--e-bg': '#1c1a14', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#d4b4f0', '--e-pivot-tint': 'rgba(212,180,240,0.06)', '--e-accent': '#977bce',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.downAt && !this.draggedGear) {
        const dist = Math.hypot(mx - this.downAt.x, my - this.downAt.y);
        if (dist > 5) { this.draggedGear = this.downAt.gear; this.removeGearFromComponent(this.draggedGear); this.draggedGear.meshedWith = null; }
      }
      if (this.draggedGear) { this.draggedGear.x = mx; this.draggedGear.y = my; hideTooltip(); return; }
      let closestTick = null, cd = 15;
      for (const tk of this.ticks) {
        if (tk._x == null) continue;
        const d = Math.hypot(tk._x - mx, tk._y - my);
        if (d < cd) { cd = d; closestTick = tk; }
      }
      if (closestTick) { showTooltip(e, closestTick.node, closestTick.color); this.app.highlightLegendTopic(closestTick.node.topic); return; }
      const hitGear = this.gearAtPoint(mx, my);
      if (hitGear && hitGear.lastNode) { showTooltip(e, hitGear.lastNode, hitGear.color); this.app.highlightLegendTopic(hitGear.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mouseleave', () => { this.downAt = null; });
    this.canvas.addEventListener('mousedown', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const g = this.gearAtPoint(mx, my);
      if (g) this.downAt = { x: mx, y: my, t: performance.now(), gear: g };
    });
    this.canvas.addEventListener('mouseup', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.draggedGear) {
        const TOL = 10;
        let best = null, bestDelta = TOL;
        for (const o of this.gears) {
          if (o === this.draggedGear || (o.alpha ?? 1) < 0.3) continue;
          const d = Math.hypot(o.x - this.draggedGear.x, o.y - this.draggedGear.y);
          const target = o.radius + this.draggedGear.radius;
          if (Math.abs(d - target) < bestDelta) { bestDelta = Math.abs(d - target); best = o; }
        }
        if (best) {
          const newComp = this.getComponent(best.componentId);
          this.draggedGear.componentId = newComp.id;
          this.draggedGear.sign = -best.sign;
          this.draggedGear.omegaFactor = -best.omegaFactor * best.teeth / this.draggedGear.teeth;
          this.draggedGear.meshedWith = best;
          newComp.gears.push(this.draggedGear);
          const dx = this.draggedGear.x - best.x, dy = this.draggedGear.y - best.y;
          const d = Math.hypot(dx, dy) || 1;
          const target = best.radius + this.draggedGear.radius;
          this.draggedGear.x = best.x + (dx / d) * target;
          this.draggedGear.y = best.y + (dy / d) * target;
        } else {
          const comp = { id: this.nextComponentId++, gears: [], pulseStrength: 0, baseSpeed: 0.8 + Math.random() * 0.5 };
          this.components.push(comp);
          this.draggedGear.componentId = comp.id; this.draggedGear.sign = 1; this.draggedGear.omegaFactor = 1; this.draggedGear.meshedWith = null;
          comp.gears.push(this.draggedGear);
        }
        this.draggedGear = null; this.downAt = null; return;
      }
      if (this.downAt) {
        const dt = performance.now() - this.downAt.t;
        const g = this.downAt.gear;
        if (g && dt < 400) {
          const comp = this.getComponent(g.componentId);
          if (comp) comp.pulseStrength = Math.min(5, (comp.pulseStrength || 0) + 1.2);
          if (g.lastNode) this.ticks.push({ gear: g, node: g.lastNode, color: g.color, born: performance.now(), angle: g.angle });
        }
        this.downAt = null;
      }
    });
  }

  count() { return this.gears.length; }
  legendItems() { return this.gears; }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.nodesSeen);
  }

  hasExternalBecause(n) {
    const b = n && n.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  gearForTopic(topic) {
    for (const g of this.gears) if (!g.ghost && g.topic === topic) return g;
    return null;
  }

  topicOfNodeId(id) {
    for (const n of this.nodesSeen) if (n && n.id === id) return n.topic;
    return null;
  }

  gearIsAnchor(gear) {
    if (!gear || gear.ghost) return false;
    for (const n of this.nodesSeen) { if (n && n.topic === gear.topic && this.nodeIncoming(n.id) >= 3) return true; }
    return false;
  }

  gearAnchorStrength(gear) {
    if (!gear || gear.ghost) return 0;
    let maxInbound = 0;
    for (const n of this.nodesSeen) { if (n && n.topic === gear.topic) { const ib = this.nodeIncoming(n.id); if (ib > maxInbound) maxInbound = ib; } }
    return maxInbound;
  }

  getComponent(id) { return this.components.find(c => c.id === id); }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'clockwork');
    });
  }

  tapeLoopHead(freq, vol = 0.08) {
    playSynth({ freq, wave: 'sawtooth', voices: 4, detune: 36, attack: 0.002, decay: 0.10, sustain: 0.0, release: 0.14, duration: 0.08, vol, filter: { type: 'bandpass', freq, Q: 5 }, distortion: { drive: 0.55, tone: 'crunch', mix: 0.55 }, reverbSend: 0.30, delaySend: 0.45 });
  }

  tapeLoopFragment(gear) {
    const teeth = gear.teeth || 20;
    const freq = Math.max(120, 800 / Math.sqrt(teeth));
    const omega = Math.max(0.15, Math.abs(gear.omegaFactor || 1));
    const gapMs = Math.max(60, Math.min(280, 110 / omega));
    const reps = omega < 0.5 ? 3 : 2;
    for (let i = 0; i < reps; i++) {
      setTimeout(() => this.tapeLoopHead(freq, 0.08 * (1 - i * 0.30)), i * gapMs);
    }
  }

  findMeshingPosition(existing, newRadius) {
    const shuffled = [...existing].sort(() => Math.random() - 0.5);
    for (const g of shuffled) {
      const dist = g.radius + newRadius;
      for (let attempt = 0; attempt < 40; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const nx = g.x + Math.cos(angle) * dist, ny = g.y + Math.sin(angle) * dist;
        if (nx - newRadius < 40 || nx + newRadius > this.W - 40) continue;
        if (ny - newRadius < 40 || ny + newRadius > this.H - 40) continue;
        let valid = true;
        for (const o of existing) {
          if (o === g) continue;
          if (Math.hypot(o.x - nx, o.y - ny) < o.radius + newRadius - 2) { valid = false; break; }
        }
        if (valid) return { x: nx, y: ny, meshedWith: g };
      }
    }
    return null;
  }

  spawnGhostGear() {
    const teeth = 14 + Math.floor(Math.random() * 22);
    const radius = teeth * MODULE;
    const toothProfiles = ['standard', 'triangular', 'trapezoidal'];
    const toothProfile = toothProfiles[Math.floor(Math.random() * toothProfiles.length)];
    const spokes = 3 + Math.floor(Math.random() * 4);
    let pos, meshedWith = null, componentId, sign, omegaFactor;
    if (this.gears.length === 0) {
      pos = { x: this.W * 0.5, y: this.H * 0.5 };
      const comp = { id: this.nextComponentId++, gears: [], pulseStrength: 0, baseSpeed: 0.8 + Math.random() * 0.5 };
      this.components.push(comp); componentId = comp.id; sign = 1; omegaFactor = 1;
    } else {
      const placement = this.findMeshingPosition(this.gears, radius);
      if (!placement) return;
      pos = { x: placement.x, y: placement.y }; meshedWith = placement.meshedWith;
      componentId = meshedWith.componentId; sign = -meshedWith.sign;
      omegaFactor = -meshedWith.omegaFactor * meshedWith.teeth / teeth;
    }
    const ghost = { topic: null, color: '#8a7d6d', ghost: true, alpha: 0, targetAlpha: 1, x: pos.x, y: pos.y, radius, teeth, toothProfile, spokes, angle: Math.random() * Math.PI * 2, sign, omegaFactor, componentId, meshedWith };
    this.gears.push(ghost);
    this.getComponent(componentId).gears.push(ghost);
  }

  startPrime() {
    this.primePhase = true;
    this.spawnGhostGear();
  }

  stopPrime() {
    this.primePhase = false;
    for (const g of this.gears) if (g.ghost) g.targetAlpha = 0;
  }

  simulatePrime() {
    for (const g of this.gears) {
      if (g.alpha !== undefined) g.alpha += ((g.targetAlpha ?? 1) - g.alpha) * 0.06;
    }
    for (let i = this.gears.length - 1; i >= 0; i--) {
      const g = this.gears[i];
      if (g.ghost && g.targetAlpha === 0 && g.alpha < 0.01) {
        this.gears.splice(i, 1);
        const comp = this.getComponent(g.componentId);
        if (comp) { const idx = comp.gears.indexOf(g); if (idx >= 0) comp.gears.splice(idx, 1); }
        for (const o of this.gears) if (o.meshedWith === g) o.meshedWith = null;
      }
    }
  }

  adoptNearestGhost(node) {
    const info = this.topicInfo(node.topic);
    const ghostsLive = this.gears.filter(g => g.ghost && g.targetAlpha > 0);
    if (ghostsLive.length === 0) return null;
    const g = ghostsLive[0];
    g.topic = node.topic; g.color = info.color; g.ghost = false; g.targetAlpha = 1; g.lastNode = node;
    return g;
  }

  addTick(node) {
    const info = this.topicInfo(node.topic);
    let gear = this.gears.find(g => g.topic === node.topic && !g.ghost);
    if (!gear) {
      if (this.primePhase) { const adopted = this.adoptNearestGhost(node); if (adopted) gear = adopted; }
    }
    if (!gear) {
      const teeth = 14 + Math.floor(Math.random() * 22);
      const radius = teeth * MODULE;
      const toothProfiles = ['standard', 'triangular', 'trapezoidal'];
      const toothProfile = toothProfiles[Math.floor(Math.random() * toothProfiles.length)];
      const spokes = 3 + Math.floor(Math.random() * 4);
      let pos, meshedWith = null, componentId, sign, omegaFactor;
      if (this.gears.length === 0) {
        pos = { x: this.W * 0.5, y: this.H * 0.5 };
        const comp = { id: this.nextComponentId++, gears: [], pulseStrength: 0, baseSpeed: 0.8 + Math.random() * 0.5 };
        this.components.push(comp); componentId = comp.id; sign = 1; omegaFactor = 1;
      } else {
        const placement = this.findMeshingPosition(this.gears, radius);
        if (placement) {
          pos = { x: placement.x, y: placement.y }; meshedWith = placement.meshedWith;
          componentId = meshedWith.componentId; sign = -meshedWith.sign;
          omegaFactor = -meshedWith.omegaFactor * meshedWith.teeth / teeth;
        } else {
          const margin = radius + 40;
          pos = { x: margin + Math.random() * (this.W - margin * 2), y: margin + Math.random() * (this.H - margin * 2) };
          for (let attempt = 0; attempt < 20; attempt++) {
            let overlap = false;
            for (const o of this.gears) { if (Math.hypot(o.x - pos.x, o.y - pos.y) < o.radius + radius + 10) { overlap = true; break; } }
            if (!overlap) break;
            pos = { x: margin + Math.random() * (this.W - margin * 2), y: margin + Math.random() * (this.H - margin * 2) };
          }
          const comp = { id: this.nextComponentId++, gears: [], pulseStrength: 0, baseSpeed: 0.8 + Math.random() * 0.5 };
          this.components.push(comp); componentId = comp.id; sign = 1; omegaFactor = 1;
        }
      }
      gear = { topic: node.topic, color: info.color, x: pos.x, y: pos.y, radius, teeth, toothProfile, spokes, angle: Math.random() * Math.PI * 2, sign, omegaFactor, componentId, meshedWith };
      this.gears.push(gear);
      this.getComponent(componentId).gears.push(gear);
    }
    if (!this.nodesSeen.includes(node)) this.nodesSeen.push(node);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const pulseAdd = 0.5 + node.confidence + heat * 0.6;
    const comp = this.getComponent(gear.componentId);
    if (comp) comp.pulseStrength = Math.min(4, comp.pulseStrength + pulseAdd);
    gear.lastNode = node; gear.latestStance = node.stance || null; gear.latestRel = node.rel || null;
    this.ticks.push({ gear, node, color: info.color, born: performance.now(), angle: gear.angle, stance: node.stance || null, isExternal: this.hasExternalBecause(node) });
    if (Array.isArray(node.refs) && node.refs.length) {
      for (const tid of node.refs) {
        const refTopic = this.topicOfNodeId(tid);
        if (!refTopic || refTopic === gear.topic) continue;
        const targetGear = this.gearForTopic(refTopic);
        if (!targetGear) continue;
        this.sparks.push({ x1: gear.x, y1: gear.y, x2: targetGear.x, y2: targetGear.y, rel: node.rel, color: info.color, born: performance.now() });
      }
    }
  }

  ensureMissingTeeth(g) {
    if (g.missingTeeth) return g.missingTeeth;
    g.missingTeeth = new Set();
    const count = Math.max(2, Math.min(4, Math.floor(g.teeth * 0.12)));
    for (let i = 0; i < count; i++) g.missingTeeth.add(Math.floor(Math.random() * g.teeth));
    return g.missingTeeth;
  }

  drawGear(g) {
    const alpha = g.alpha ?? 1;
    if (alpha < 0.01) return;
    this.ctx.save(); this.ctx.translate(g.x, g.y); this.ctx.rotate(g.angle); this.ctx.globalAlpha = alpha;
    const rIn = g.radius * 0.9, rOut = g.radius;
    const stance = g.latestStance;
    if (stance === 'questioning') {
      this.ctx.beginPath(); this.ctx.arc(0, 0, rOut, 0, Math.PI * 2); this.ctx.fillStyle = g.color; this.ctx.globalAlpha = alpha * 0.18; this.ctx.fill(); this.ctx.globalAlpha = alpha;
      this.ctx.strokeStyle = g.color; this.ctx.lineWidth = 2; this.ctx.stroke();
      this.ctx.beginPath(); this.ctx.arc(0, 0, rIn, 0, Math.PI * 2); this.ctx.stroke();
    } else if (stance === 'exploring') {
      this.ctx.strokeStyle = g.color; this.ctx.lineWidth = 2;
      this.ctx.beginPath(); this.ctx.arc(0, 0, rOut, 0, Math.PI * 2); this.ctx.stroke();
      this.ctx.beginPath(); this.ctx.arc(0, 0, rIn, 0, Math.PI * 2); this.ctx.stroke();
      const pinCount = Math.min(18, Math.max(10, Math.floor(g.teeth * 0.7))); this.ctx.lineWidth = 1.4;
      for (let i = 0; i < pinCount; i++) { const ang = (i / pinCount) * Math.PI * 2; const ca = Math.cos(ang), sa = Math.sin(ang); this.ctx.beginPath(); this.ctx.moveTo(ca * rIn, sa * rIn); this.ctx.lineTo(ca * rOut, sa * rOut); this.ctx.stroke(); }
      this.ctx.fillStyle = g.color; this.ctx.globalAlpha = alpha * 0.1;
      this.ctx.beginPath(); this.ctx.arc(0, 0, rIn, 0, Math.PI * 2); this.ctx.fill(); this.ctx.globalAlpha = alpha;
    } else {
      const missing = stance === 'conceding' ? this.ensureMissingTeeth(g) : null;
      this.ctx.beginPath();
      for (let i = 0; i < g.teeth; i++) {
        const step = Math.PI * 2 / g.teeth, a0 = i * step;
        if (missing && missing.has(i)) { this.ctx.lineTo(Math.cos(a0 + step) * rIn, Math.sin(a0 + step) * rIn); continue; }
        if (g.toothProfile === 'triangular') { const aMid = a0 + step * 0.5; this.ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn); this.ctx.lineTo(Math.cos(aMid) * rOut, Math.sin(aMid) * rOut); }
        else if (g.toothProfile === 'trapezoidal') { const a1 = a0 + step * 0.15, a2 = a0 + step * 0.85; this.ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn); this.ctx.lineTo(Math.cos(a1) * rOut, Math.sin(a1) * rOut); this.ctx.lineTo(Math.cos(a2) * rOut, Math.sin(a2) * rOut); }
        else { const a1 = a0 + step * 0.3, a2 = a0 + step * 0.7, a3 = a0 + step; this.ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn); this.ctx.lineTo(Math.cos(a1) * rOut, Math.sin(a1) * rOut); this.ctx.lineTo(Math.cos(a2) * rOut, Math.sin(a2) * rOut); this.ctx.lineTo(Math.cos(a3) * rIn, Math.sin(a3) * rIn); }
      }
      this.ctx.closePath(); this.ctx.fillStyle = g.color; this.ctx.globalAlpha = alpha * 0.25; this.ctx.fill(); this.ctx.globalAlpha = alpha;
      this.ctx.strokeStyle = g.color; this.ctx.lineWidth = 2; this.ctx.stroke();
    }
    this.ctx.beginPath(); this.ctx.arc(0, 0, g.radius * 0.22, 0, Math.PI * 2); this.ctx.fillStyle = g.color; this.ctx.fill();
    if (stance !== 'exploring' && stance !== 'questioning') {
      this.ctx.strokeStyle = g.color; this.ctx.lineWidth = 1.5;
      const spokes = g.spokes || 5;
      for (let i = 0; i < spokes; i++) { const a = (i / spokes) * Math.PI * 2; this.ctx.beginPath(); this.ctx.moveTo(Math.cos(a) * g.radius * 0.24, Math.sin(a) * g.radius * 0.24); this.ctx.lineTo(Math.cos(a) * g.radius * 0.85, Math.sin(a) * g.radius * 0.85); this.ctx.stroke(); }
    }
    const glyph = relGlyph(g.latestRel);
    if (glyph) {
      const rv = parseInt(g.color.slice(1, 3), 16), gg = parseInt(g.color.slice(3, 5), 16), bv = parseInt(g.color.slice(5, 7), 16);
      const luma = 0.2126 * rv + 0.7152 * gg + 0.0722 * bv;
      const ink = luma > 140 ? 'rgba(20, 16, 10, 0.45)' : 'rgba(245, 235, 210, 0.4)';
      this.ctx.save(); this.ctx.rotate(-g.angle);
      this.ctx.strokeStyle = ink; this.ctx.lineWidth = 0.9;
      this.ctx.font = `${Math.max(10, Math.floor(g.radius * 0.32))}px "JetBrains Mono", monospace`;
      this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
      this.ctx.strokeText(glyph, 0, 0);
      this.ctx.restore();
    }
    this.ctx.globalAlpha = 1; this.ctx.restore();
  }

  drawSparks() {
    const now = performance.now();
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      const t = (now - sp.born) / ClockworkMode.SPARK_LIFE_MS;
      if (t >= 1) { this.sparks.splice(i, 1); continue; }
      const fade = Math.sin(t * Math.PI);
      const dx = sp.x2 - sp.x1, dy = sp.y2 - sp.y1;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      const nx = -dy / dist, ny = dx / dist;
      this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
      if (sp.rel === 'contradicts') {
        this.ctx.strokeStyle = `rgba(240, 140, 90, ${0.75 * fade})`; this.ctx.lineWidth = 1.4;
        const steps = 14; this.ctx.beginPath();
        for (let k = 0; k <= steps; k++) {
          const u = k / steps; const bx = sp.x1 + dx * u, by = sp.y1 + dy * u;
          const env = Math.sin(u * Math.PI); const offset = Math.sin(u * Math.PI * 10 + t * 20) * 4 * env;
          const px = bx + nx * offset, py = by + ny * offset;
          if (k === 0) this.ctx.moveTo(px, py); else this.ctx.lineTo(px, py);
        }
        this.ctx.stroke();
      } else if (sp.rel === 'synthesizes') {
        this.ctx.strokeStyle = `rgba(240, 220, 180, ${0.55 * fade})`; this.ctx.lineWidth = 1.8;
        this.ctx.beginPath(); this.ctx.moveTo(sp.x1, sp.y1); this.ctx.lineTo(sp.x2, sp.y2); this.ctx.stroke();
      } else if (sp.rel === 'refines') {
        this.ctx.strokeStyle = `rgba(220, 210, 180, ${0.42 * fade})`; this.ctx.lineWidth = 0.7;
        this.ctx.setLineDash([1, 3]); this.ctx.beginPath(); this.ctx.moveTo(sp.x1, sp.y1); this.ctx.lineTo(sp.x2, sp.y2); this.ctx.stroke(); this.ctx.setLineDash([]);
      } else if (sp.rel === 'questions') {
        const pulse = 0.5 + Math.sin(t * Math.PI * 6) * 0.5;
        this.ctx.strokeStyle = `rgba(220, 190, 220, ${0.5 * fade * pulse})`; this.ctx.lineWidth = 1.1;
        this.ctx.beginPath(); this.ctx.moveTo(sp.x1, sp.y1); this.ctx.lineTo(sp.x2, sp.y2); this.ctx.stroke();
      } else if (sp.rel === 'supersedes') {
        this.ctx.strokeStyle = `rgba(200, 190, 170, ${0.3 * fade})`; this.ctx.lineWidth = 0.9;
        this.ctx.beginPath(); this.ctx.moveTo(sp.x1, sp.y1); this.ctx.lineTo(sp.x1 + dx * 0.32, sp.y1 + dy * 0.32); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.moveTo(sp.x1 + dx * 0.68, sp.y1 + dy * 0.68); this.ctx.lineTo(sp.x2, sp.y2); this.ctx.stroke();
      } else {
        this.ctx.strokeStyle = `rgba(235, 220, 180, ${0.5 * fade})`; this.ctx.lineWidth = 1.1;
        this.ctx.beginPath(); this.ctx.moveTo(sp.x1, sp.y1); this.ctx.lineTo(sp.x2, sp.y2); this.ctx.stroke();
      }
    }
    this.ctx.globalAlpha = 1;
  }

  drawAnchorHaloes() {
    for (const g of this.gears) {
      if (g.ghost) continue;
      const inbound = this.gearAnchorStrength(g);
      if (inbound < 3) continue;
      const intensity = Math.min(1, (inbound - 2) / 4);
      this.ctx.strokeStyle = `rgba(218, 175, 102, ${0.3 * intensity})`; this.ctx.lineWidth = 2.2;
      this.ctx.beginPath(); this.ctx.arc(g.x, g.y, g.radius + 8, 0, Math.PI * 2); this.ctx.stroke();
      this.ctx.strokeStyle = `rgba(218, 175, 102, ${0.5 * intensity})`; this.ctx.lineWidth = 0.8;
      this.ctx.beginPath(); this.ctx.arc(g.x, g.y, g.radius + 4, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  drawMainsprings() {
    const drawn = new Set();
    for (const tk of this.ticks) {
      if (!tk.isExternal) continue;
      const g = tk.gear;
      if (!g || drawn.has(g)) continue; drawn.add(g);
      const margin = 28, W = this.W, H = this.H;
      const dL = g.x, dR = W - g.x, dT = g.y, dB = H - g.y;
      const minD = Math.min(dL, dR, dT, dB);
      let mx, my;
      if (minD === dL) { mx = margin; my = g.y; } else if (minD === dR) { mx = W - margin; my = g.y; }
      else if (minD === dT) { mx = g.x; my = margin; } else { mx = g.x; my = H - margin; }
      this.ctx.strokeStyle = 'rgba(218, 175, 102, 0.25)'; this.ctx.lineWidth = 0.8;
      this.ctx.beginPath(); this.ctx.moveTo(g.x, g.y); this.ctx.lineTo(mx, my); this.ctx.stroke();
      this.ctx.strokeStyle = 'rgba(218, 175, 102, 0.8)'; this.ctx.lineWidth = 1.1;
      this.ctx.beginPath();
      const coils = 3, stepAng = 0.5;
      for (let k = 0; k < coils * 12; k++) { const ang = k * stepAng; const r = 1 + k * 0.25; const px = mx + Math.cos(ang) * r; const py = my + Math.sin(ang) * r; if (k === 0) this.ctx.moveTo(px, py); else this.ctx.lineTo(px, py); }
      this.ctx.stroke();
    }
  }

  removeGearFromComponent(gear) {
    const comp = this.getComponent(gear.componentId);
    if (!comp) return;
    const idx = comp.gears.indexOf(gear);
    if (idx >= 0) comp.gears.splice(idx, 1);
    for (const o of this.gears) if (o !== gear && o.meshedWith === gear) o.meshedWith = null;
  }

  gearAtPoint(mx, my) {
    let hit = null, hd = Infinity;
    for (const g of this.gears) {
      if ((g.alpha ?? 1) < 0.3) continue;
      const d = Math.hypot(g.x - mx, g.y - my);
      if (d < g.radius && d < hd) { hd = d; hit = g; }
    }
    return hit;
  }

  onStart() {
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one ghost gear per token with teeth count derived from
  // the token's character count (longer token → more teeth → bigger gear).
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const teeth = 12 + (tok.length * 2);
      const radius = teeth * MODULE;
      const toothProfiles = ['standard', 'triangular', 'trapezoidal'];
      const toothProfile = toothProfiles[(h >> 4) % 3];
      const spokes = 3 + ((h >> 8) % 4);
      let pos, meshedWith = null, componentId, sign, omegaFactor;
      if (this.gears.length === 0) {
        pos = { x: this.W * 0.5, y: this.H * 0.5 };
        const comp = { id: this.nextComponentId++, gears: [], pulseStrength: 0, baseSpeed: 0.6 + Math.random() * 0.4 };
        this.components.push(comp); componentId = comp.id; sign = 1; omegaFactor = 1;
      } else {
        const placement = this.findMeshingPosition(this.gears, radius);
        if (!placement) continue;
        pos = { x: placement.x, y: placement.y }; meshedWith = placement.meshedWith;
        componentId = meshedWith.componentId; sign = -meshedWith.sign;
        omegaFactor = -meshedWith.omegaFactor * meshedWith.teeth / teeth;
      }
      const ghost = { topic: null, color: '#6a5f50', ghost: true, alpha: 0, targetAlpha: 1, x: pos.x, y: pos.y, radius, teeth, toothProfile, spokes, angle: (h % 628) / 100, sign, omegaFactor, componentId, meshedWith };
      this.gears.push(ghost);
      this.getComponent(componentId).gears.push(ghost);
    }
  }

  onNode(n) {
    this.addTick(n);
    if (this.primePhase) this.stopPrime();
    this.initAural();
    const gear = this.gears.find(g => g.topic === n.topic && !g.ghost);
    if (gear) this.tapeLoopFragment(gear);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.gears = [];
    this.ticks = [];
    this.components = [];
    this.nextComponentId = 0;
    this.primePhase = false;
    this.downAt = null;
    this.draggedGear = null;
    this.sparks = [];
    this.nodesSeen.length = 0;
  }

  // Walnut bench — subtle horizontal wood-grain striations on top of the brown bg.
  // ~60 wavy lines at random y, alternating slightly-darker and slightly-warmer
  // tones at low alpha. Static; rendered once into an offscreen canvas.
  drawWalnutBench() {
    if (!this._woodOff || this._woodW !== this.W || this._woodH !== this.H) {
      if (!this._woodOff) this._woodOff = document.createElement('canvas');
      this._woodOff.width = Math.max(1, Math.ceil(this.W));
      this._woodOff.height = Math.max(1, Math.ceil(this.H));
      this._woodW = this.W; this._woodH = this.H;
      const oc = this._woodOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.lineWidth = 1;
      for (let i = 0; i < 60; i++) {
        const y = Math.random() * this.H;
        const alpha = 0.08 + Math.random() * 0.07;
        const dark = Math.random() < 0.55;
        const r = dark ? 10 : 36;
        const g = dark ? 9 : 30;
        const b = dark ? 6 : 22;
        oc.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        oc.beginPath();
        const amp = 2 + Math.random() * 5;
        const freq = 0.001 + Math.random() * 0.003;
        const phase = Math.random() * Math.PI * 2;
        for (let x = 0; x <= this.W; x += 4) {
          const yy = y + amp * Math.sin(x * freq + phase);
          if (x === 0) oc.moveTo(x, yy); else oc.lineTo(x, yy);
        }
        oc.stroke();
      }
    }
    this.ctx.drawImage(this._woodOff, 0, 0);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.t += 0.016;
    const ht = this.app.highlightedTopic;
    this.ctx.fillStyle = '#1c1a14'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawWalnutBench();
    this.simulatePrime();
    for (const comp of this.components) {
      const drive = (comp.baseSpeed + comp.pulseStrength * 2) * 0.012;
      for (const g of comp.gears) { if (g === this.draggedGear) continue; g.angle += drive * g.omegaFactor; }
      comp.pulseStrength *= 0.94;
    }
    for (const g of this.gears) {
      if (!g.meshedWith) continue;
      const a1 = g.alpha ?? 1, a2 = g.meshedWith.alpha ?? 1;
      const a = Math.min(a1, a2);
      if (a < 0.05) continue;
      this.ctx.strokeStyle = g.color; this.ctx.globalAlpha = 0.12 * a; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(g.x, g.y); this.ctx.lineTo(g.meshedWith.x, g.meshedWith.y); this.ctx.stroke();
      this.ctx.globalAlpha = 1;
    }
    this.drawAnchorHaloes(); this.drawMainsprings(); this.drawSparks();
    for (const g of this.gears) {
      const gearDim = ht && !g.ghost && g.topic && g.topic !== ht ? 0.25 : 1;
      this.ctx.globalAlpha = gearDim;
      this.drawGear(g);
      this.ctx.globalAlpha = 1;
    }
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      const tk = this.ticks[i];
      let lifeMs = 1200;
      if (tk.stance === 'questioning') lifeMs = 2200;
      else if (tk.stance === 'conceding') lifeMs = 750;
      const age = (performance.now() - tk.born) / lifeMs;
      if (age > 1) { this.ticks.splice(i, 1); continue; }
      const alpha = 1 - age;
      const r = tk.gear.radius + 10 + age * 20;
      const a = tk.angle;
      const x = tk.gear.x + Math.cos(a) * r, y = tk.gear.y + Math.sin(a) * r;
      tk._x = x; tk._y = y;
      let flashAlpha = alpha, flashR = 4;
      if (tk.stance === 'claiming') { flashAlpha = alpha * 1.1; flashR = 5.5; }
      else if (tk.stance === 'questioning') { flashAlpha = alpha * (0.6 + Math.sin(age * Math.PI * 4) * 0.4); }
      else if (tk.stance === 'conceding') { flashAlpha = alpha * 0.5; flashR = 3; }
      this.ctx.fillStyle = tk.color; this.ctx.globalAlpha = Math.max(0, Math.min(1, flashAlpha));
      this.ctx.beginPath(); this.ctx.arc(x, y, flashR, 0, Math.PI * 2); this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }
}

export { ClockworkMode };
