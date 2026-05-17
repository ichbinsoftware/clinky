// clinky/public/mode.js — Mode base class. Each visualization mode extends this.
// Handles: canvas/ctx setup, resize, app+essay mount, onGraphComplete refs map,
// default streaming lifecycle (start/stop/clear), RAF loop.
// Modes override hooks (onNode, onClear, onDone, etc.) and implement draw().

import clinky, { onGraphComplete, incomingRefsOf, hideTooltip } from '/clinky.js';

export class Mode {
  // ─── shared state ───────────────────────────────────────────────────────────
  canvas;
  ctx;
  app;
  essay;
  topics = [];
  nodes  = [];
  reflections = [];
  stream = null;
  incomingRefsMap = {};

  constructor({
    mode,
    aesthetic = 'ambient',
    vars = {},
    essayGetSession,
    nodeStagger = 1000,
    topicFallbackColor = '#888',
  } = {}) {
    this._mode               = mode;
    this._aesthetic          = aesthetic;
    this._vars               = vars;
    this._nodeStagger        = nodeStagger;
    this._topicFallbackColor = topicFallbackColor;
    this._auralReady         = false;

    Object.entries(vars).forEach(([k, v]) => document.body.style.setProperty(k, v));

    // canvas
    this.canvas = document.getElementById('canvas');
    this.ctx    = this.canvas.getContext('2d');
    // Base mouseleave: always hide tooltip + clear legend highlight.
    // Modes that need extra reset logic (hoveredBand, caughtFlake etc)
    // add their own mouseleave handler on top.
    this.canvas.addEventListener('mouseleave', () => {
      hideTooltip();
      this.app?.highlightLegendTopic(null);
    });

    // resize — listener registered now; initial call deferred to mount()
    // so subclass class fields (which override resize() may reference) are
    // initialized before resize() runs the first time.
    window.addEventListener('resize', () => this.resize());

    // app
    this.app = clinky(() => this.count());

    // essay
    this.essay = this.app.essay({
      mode,
      aesthetic,
      vars,
      getSession: () => {
        const base = essayGetSession ? essayGetSession() : {
          prompt: this.app.prompt(),
          nodes:  this.nodes,
          topics: this.topics,
        };
        // Always pass reflections through — independent of any custom session shape.
        return { ...base, reflections: this.reflections };
      },
    });

    // graph refs — always wired; modes can also use incomingRefsMap directly
    onGraphComplete(({ incoming_refs }) => {
      this.incomingRefsMap = incoming_refs || {};
    });

    // lifecycle wiring
    this.app.onGo(() => this._start());
    this.app.onStop(() => this._stop());
    this.app.onClear(() => this._clear());
  }

  // ─── overridable: count ──────────────────────────────────────────────────────
  // Return the number to display in the counter + use for legend. Override
  // when the mode's visual unit differs from raw nodes (e.g. creatures, drops).
  count() { return this.nodes.length; }

  // ─── overridable: legend items ───────────────────────────────────────────────
  // Return the items array passed to updateLegend. Override when the visual
  // unit differs from raw nodes.
  legendItems() { return this.nodes; }

  // ─── overridable: resize ─────────────────────────────────────────────────────
  // Logical dimensions (W/H) stay in CSS pixels so mode layout code is unchanged.
  // Physical canvas is scaled by devicePixelRatio for crisp rendering on retina,
  // capped at 1.5× — the visual gain above 1.5 is imperceptible while the pixel
  // cost grows quadratically (2× DPR = 4× pixels). Big perf win on retina.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.W = innerWidth;
    this.H = innerHeight;
    this.canvas.width  = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ─── utility: nodeIncoming ───────────────────────────────────────────────────
  // Count incoming refs for a node id, using the graph-complete map when
  // available, falling back to live scan. Available as a class method so modes
  // don't need to inline this pattern.
  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.nodes);
  }

  // Session metadata for the closing counter line —
  // topic count + pivot count (nodes with ≥3 inbound refs).
  // Pivots only meaningful after the graph event arrives at session end.
  #sessionMeta() {
    const pivotCount = this.nodes.filter(n => this.nodeIncoming(n.id) >= 3).length;
    return {
      topicCount: this.topics.length,
      pivotCount,
    };
  }

  // ─── shared utilities ────────────────────────────────────────────────────────

  // Look up a topic by id; fall back to the mode's configured fallback colour.
  // Modes that need a different fallback pass topicFallbackColor to super().
  // Override entirely if the fallback needs extra fields (e.g. subway adds label:).
  topicInfo(id) {
    return this.topics.find(t => t.id === id) || { color: this._topicFallbackColor, note: 440 };
  }

  // Deterministic hash of a string → non-negative integer.
  // Used by prompt-unpack to place elements at stable positions.
  hashToken(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // One-shot aural initialiser guard. Call from initAural():
  //   initAural() { this.initAuralOnce(() => { setAesthetic(…); pickSessionKey(…); }); }
  initAuralOnce(fn) {
    if (this._auralReady) return;
    this._auralReady = true;
    fn();
  }

  // True if any raw node in this.nodes has external-source because references.
  // Modes whose visual array differs from this.nodes should override.
  nodeHasExternalBecause(n) {
    return Array.isArray(n.because) && n.because.some(b => typeof b === 'string');
  }

  // True if the session contains any ref relationships.
  // Modes whose visual array differs from this.nodes should override.
  sessionHasRefs() {
    for (const n of this.nodes) if (Array.isArray(n.refs) && n.refs.length > 0) return true;
    return false;
  }

  // Tokenize a prompt into meaningful words for prompt-unpack animations.
  // Strips stopwords, filters short tokens, caps at 12.
  tokenize(prompt) {
    const stop = new Set([
      'the','a','an','to','of','in','for','and','or','with',
      'on','at','by','is','are','be','i','you','my','your',
      'how','what','when','where','why','should','can','do',
      'this','that','these','those','it','its','as','from',
    ]);
    return (prompt || '').toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 3 && !stop.has(w))
      .slice(0, 12);
  }

  // ─── RAF loop ────────────────────────────────────────────────────────────────
  // Runs continuously. Calls draw() each frame unless paused or tab hidden.
  // FPS capped at 30 — halves CPU/GPU budget vs 60fps with no perceptual
  // penalty for this kind of animation.
  #tabHidden = false;
  #lastDraw  = 0;
  loop() {
    requestAnimationFrame(() => this.loop());
    if (this.app.isPaused() || this.#tabHidden) return;
    const now = performance.now();
    if (now - this.#lastDraw < 1000 / 30) return;
    this.#lastDraw = now;
    this.draw();
  }

  // ─── abstract ────────────────────────────────────────────────────────────────
  // Modes MUST implement draw().
  draw() {}

  // ─── optional hooks (override as needed) ────────────────────────────────────
  // onStart()             — fires before streaming begins (good for initAural)
  // onTopics(topics)      — fires when topic palette arrives
  // onNode(node)          — fires for each node (after base pushes to this.nodes)
  // onDone()              — fires when stream completes (before setState done)
  // onError()             — fires on stream error (before setState done)
  // onStop()              — fires on manual stop (before setState done)
  // onClear()             — fires when canvas should wipe (before base resets state)

  // ─── internal lifecycle (not overridden — use hooks above) ──────────────────

  _start() {
    if (this.stream) this.stream.close();
    // Auto-clear previous session — without this, running prompt B after
    // prompt A appends new nodes/topics to the old set, so the canvas shows
    // the union of two unrelated sessions.
    this._clear();
    this.app.setState('thinking');
    this.onStart?.();
    this.stream = this.app.think(this.app.prompt(), {
      nodeStagger: this._nodeStagger,
      onTopics: t => {
        t.forEach(nt => {
          if (!this.topics.find(et => et.id === nt.id)) this.topics.push(nt);
        });
        this.onTopics?.(t);
        this.app.updateLegend(this.topics, this.legendItems());
      },
      onNode: n => {
        // Reflections bypass the regular pipeline — they're meta-commentary
        // on the session, not part of the thought graph. Stored separately
        // so the counter, legend, and visual nodes are unaffected.
        if (n.type === 'reflection') {
          this.reflections ??= [];
          this.reflections.push(n);
          this.onReflection?.(n);
          return;
        }
        this.app.setState('streaming');
        this.nodes.push(n);
        // Fire subclass hook FIRST so its visual array (e.g. typeBlocks,
        // creatures, drops) gets the new node before the legend counts it.
        this.onNode?.(n);
        // Counter shows live topic of the most recent node — pulses with each arrival
        this.app.updateCounter({ topic: n.topic });
        this.app.updateLegend(this.topics, this.legendItems());
      },
      onBatch:  this.essay.captureBatch,
      onDone:   () => {
        this.onDone?.();
        this.app.updateCounter(this.#sessionMeta());
        this.app.setState('done');
      },
      onError:  (err) => {
        this.app.showError(err);
        this.onError?.(err);
        this.app.updateCounter(this.#sessionMeta());
        this.app.setState('done');
      },
      onStatus: () => {},
    });
  }

  _stop() {
    if (this.stream) { this.stream.close(); this.stream = null; }
    this.onStop?.();
    this.app.updateCounter(this.#sessionMeta());
    this.app.setState('done');
  }

  _clear() {
    this.topics = [];
    this.nodes  = [];
    this.reflections = [];
    this.onClear?.();
    this.app.setState('idle');
    this.app.updateLegend([], []);
  }

  // ─── mount ───────────────────────────────────────────────────────────────────
  // Internal — call via the boot() helper instead of directly.
  mount() {
    this.resize();        // first sizing — subclass fields are now initialized
    // Pause RAF when tab is hidden — saves CPU when the user has switched away.
    document.addEventListener('visibilitychange', () => {
      this.#tabHidden = document.hidden;
    });
    this.loop();
    return this;
  }
}

// ─── boot helper ──────────────────────────────────────────────────────────────
// Functional bootstrap. Modes use this in their HTML:
//   import { boot } from '/mode.js';
//   import { AntminMode } from '/modes/antmin.js';
//   boot(AntminMode);
export function boot(ModeClass) {
  return new ModeClass().mount();
}
