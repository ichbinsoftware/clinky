// clinky/public/essay.js — slide-in reading-pane panel.
// Instantiated via app.essay({...}) on a Clinky instance.
// Imports nothing from clinky.js — uses the app interface duck-typed.
import { IC_READ } from '/clinky.js';

export class Essay {
  #panel; #scrim; #btn; #close; #print; #page;
  #app;
  #mode;
  #aesthetic;
  #getSession;
  #sessionStart = null;
  #sessionEnd = null;
  #narration = [];

  constructor({ app, mode, aesthetic = 'ambient', vars = {}, getSession }) {
    this.#app = app;
    this.#mode = mode;
    this.#aesthetic = aesthetic;
    this.#getSession = getSession;
    this.#injectDOM(vars);
    this.#wireEvents();
    this.#bindLifecycle();
  }

  // ────────── public surface ──────────

  open() {
    if (typeof this.#getSession === 'function') {
      try { this.#render(this.#getSession()); } catch (e) { console.warn('[clinky] essay render error', e); }
    }
    this.#page.scrollTop = 0;
    this.#panel.classList.add('open');
    this.#scrim.classList.add('open');
    this.#panel.setAttribute('aria-hidden', 'false');
  }

  close() {
    this.#panel.classList.remove('open');
    this.#scrim.classList.remove('open');
    this.#panel.setAttribute('aria-hidden', 'true');
  }

  enable()  { this.#btn.disabled = false; }
  disable() { this.#btn.disabled = true; }

  // Arrow class field — bound to instance, safe to pass as `onBatch: essay.captureBatch`.
  captureBatch = (b) => {
    if (b && b.text_excerpt) this.#narration.push(b.text_excerpt);
  };

  // ────────── private helpers ──────────

  #injectDOM(vars) {
    const mini = document.getElementById('fl-mini');
    if (!mini) { console.warn('[clinky] Essay constructed before mini-controls — call clinky() first'); return; }

    this.#btn = document.createElement('button');
    this.#btn.id = 'fl-read';
    this.#btn.disabled = true;
    this.#btn.title = 'read';
    this.#btn.setAttribute('aria-label', 'open reading pane');
    this.#btn.innerHTML = IC_READ;
    const sep = document.createElement('div');
    sep.className = 'sep';
    mini.appendChild(sep);
    mini.appendChild(this.#btn);

    this.#scrim = document.createElement('div');
    this.#scrim.className = 'fl-essay-scrim';
    this.#panel = document.createElement('aside');
    this.#panel.className = 'fl-essay voice-' + this.#aesthetic;
    this.#panel.setAttribute('aria-hidden', 'true');
    Object.entries(vars).forEach(([k, v]) => this.#panel.style.setProperty(k, v));

    this.#close = document.createElement('button');
    this.#close.className = 'fl-essay-close';
    this.#close.title = 'close';
    this.#close.textContent = '×';
    this.#print = document.createElement('button');
    this.#print.className = 'fl-essay-print';
    this.#print.title = 'download as PDF';
    this.#print.textContent = '⬇';
    this.#page = document.createElement('div');
    this.#page.className = 'fl-essay-page';
    this.#panel.appendChild(this.#close);
    this.#panel.appendChild(this.#print);
    this.#panel.appendChild(this.#page);
    document.body.appendChild(this.#scrim);
    document.body.appendChild(this.#panel);
  }

  #wireEvents() {
    this.#btn.addEventListener('click', () => this.open());
    this.#close.addEventListener('click', () => this.close());
    this.#scrim.addEventListener('click', () => this.close());
    this.#print.addEventListener('click', () => this.#downloadPdf());
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.#panel.classList.contains('open')) this.close();
    });
  }

  // Open a new window with print-styled essay HTML and trigger the browser's
  // print dialog. User picks "Save as PDF" → clean PDF with no clinky chrome.
  #downloadPdf() {
    const essayHtml = this.#page.innerHTML;
    const prompt = this.#app.prompt() || 'clinky session';
    const title = prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt;
    const styles = `
      @page { margin: 1.4cm; }
      * { box-sizing: border-box; }
      body {
        font-family: 'Space Grotesk', system-ui, sans-serif;
        max-width: 720px;
        margin: 0 auto;
        padding: 1rem;
        color: #1a1208;
        background: #ffffff;
        line-height: 1.55;
      }
      .essay-eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.7rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #888;
        margin-bottom: 0.5rem;
      }
      .essay-title {
        font-family: 'Cormorant Garamond', 'Georgia', serif;
        font-weight: 400;
        font-size: 2.2rem;
        line-height: 1.15;
        margin: 0 0 0.6rem 0;
      }
      .essay-meta {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        color: #888;
        margin-bottom: 1.6rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid #ddd;
      }
      .essay-narration {
        font-style: italic;
        color: #555;
        margin: 1.2rem 0 1rem 0;
        padding-left: 0.8rem;
        border-left: 2px solid #ccc;
      }
      .essay-row {
        display: grid;
        grid-template-columns: 32px 14px 1fr;
        gap: 0.5rem;
        margin-bottom: 0.7rem;
        page-break-inside: avoid;
      }
      .essay-row.essay-pivot {
        background: rgba(245, 230, 200, 0.5);
        padding: 0.5rem;
        margin-left: -0.5rem;
        border-radius: 3px;
      }
      .row-id {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.7rem;
        color: #888;
      }
      .row-topic {
        width: 8px; height: 8px;
        border-radius: 50%;
        margin-top: 0.45rem;
      }
      .row-text { font-size: 1rem; }
      .row-type {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.6rem;
        letter-spacing: 0.08em;
        color: #999;
        text-transform: uppercase;
        display: block;
        margin-top: 0.15rem;
      }
      .essay-closing {
        margin-top: 2rem;
        padding: 1.2rem;
        background: rgba(245, 230, 200, 0.3);
        border-left: 3px solid #c2562a;
        font-size: 1.1rem;
        page-break-inside: avoid;
      }
      .essay-closing .closing-eyebrow {
        display: block;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.6rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #888;
        margin-bottom: 0.4rem;
      }
      .essay-reflections {
        margin-top: 1.5rem;
        padding-top: 1.2rem;
        border-top: 1px solid #ddd;
        page-break-inside: avoid;
      }
      .essay-reflection {
        font-style: italic;
        font-size: 1.05rem;
        line-height: 1.6;
        margin-bottom: 1rem;
      }
      .reflection-eyebrow {
        display: block;
        font-style: normal;
        font-size: 0.78rem;
        color: #c2562a;
        margin-bottom: 0.5rem;
        font-weight: 500;
      }
      .essay-colophon {
        margin-top: 2rem;
        padding-top: 1rem;
        border-top: 1px solid #ddd;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.6rem;
        letter-spacing: 0.06em;
        color: #888;
      }
    `;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${this.#escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Cormorant+Garamond:wght@400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>${styles}</style>
</head>
<body>${essayHtml}</body>
</html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('Popup blocked — please allow popups to download as PDF'); return; }
    w.document.write(html);
    w.document.close();
    // Wait for fonts + layout, then auto-trigger print dialog
    w.onload = () => setTimeout(() => w.print(), 400);
  }

  #escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  #bindLifecycle() {
    if (typeof this.#app.onSessionStart === 'function') {
      this.#app.onSessionStart(() => {
        this.close();
        this.disable();
        this.#sessionStart = performance.now();
        this.#sessionEnd = null;
        this.#narration = [];
      });
    }
    if (typeof this.#app.onSessionEnd === 'function') {
      this.#app.onSessionEnd(() => {
        this.#sessionEnd = performance.now();
        this.enable();
      });
    }
  }

  #render(s) {
    const fmtTopicVar = t => '--t-' + (t || '').replace(/[^a-z0-9]/gi, '');
    const groupedNarration = (Array.isArray(s.narration) && s.narration.length ? s.narration : this.#narration).filter(Boolean);
    const sessionDone = this.#sessionEnd != null;
    const synth = sessionDone ? (s.synthesis || (s.nodes && s.nodes[s.nodes.length - 1])) : null;
    const isPivot = (n) => (n.incoming_refs_count ?? 0) >= 3;
    const pivots = (s.nodes || []).filter(isPivot);
    const duration = (this.#sessionEnd && this.#sessionStart)
      ? ((this.#sessionEnd - this.#sessionStart) / 1000).toFixed(1) + 's'
      : (s.duration || '');
    const sessionMode = this.#mode || s.mode || 'clinky';
    const date = s.date || new Date().toISOString().slice(0, 10);

    const batches = new Map();
    (s.nodes || []).forEach(n => {
      const b = n.batch_id || 1;
      if (!batches.has(b)) batches.set(b, []);
      batches.get(b).push(n);
    });

    const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const topicById = Object.fromEntries((s.topics || []).map(t => [t.id, t]));
    const colorOf = (n) => {
      const t = topicById[n.topic];
      if (t && t.color) return t.color;
      return 'var(' + fmtTopicVar(n.topic) + ', currentColor)';
    };

    const eyebrow = `${sessionMode} · ${date}`;
    const meta = [
      duration && 'duration ' + duration,
      s.nodes && s.nodes.length + ' nodes',
      (s.topics || []).length + ' topics',
      pivots.length && pivots.length + ' pivots ★',
    ].filter(Boolean).join(' · ');

    let bodyHtml = '';
    [...batches.entries()].sort((a, b) => a[0] - b[0]).forEach(([bid, ns], i) => {
      const lead = groupedNarration[i] || groupedNarration[bid - 1];
      if (lead) bodyHtml += `<div class="essay-narration">${escapeHtml(lead)}</div>`;
      ns.forEach(n => {
        const piv = isPivot(n) ? ' essay-pivot' : '';
        const star = isPivot(n) ? '★ ' : '';
        bodyHtml += `
          <div class="essay-row${piv}">
            <span class="row-id">${String(n.id ?? '').padStart(2, '0')}</span>
            <span class="row-topic" style="color:${colorOf(n)}"></span>
            <div>
              <div class="row-text">${star}${escapeHtml(n.text)}</div>
              <span class="row-type">${escapeHtml(n.type || '')} · ${escapeHtml(n.topic || '')}${isPivot(n) ? ' · pivot · ' + (n.incoming_refs_count ?? 0) + ' inbound' : ''}</span>
            </div>
          </div>`;
      });
    });

    const colophon = [
      'mode ' + sessionMode,
      duration && 'duration ' + duration,
      s.model && 'model ' + s.model,
      'aesthetic ' + this.#aesthetic,
    ].filter(Boolean).join(' · ');

    // Reflections — meta-commentary on the session, rendered as italic
    // closing block(s) with their own eyebrow. Comes from session.reflections,
    // populated by the Mode base class when type=reflection nodes arrive.
    const reflections = Array.isArray(s.reflections) ? s.reflections : [];
    const reflectionsHtml = reflections.length > 0 ? `
      <div class="essay-reflections">
        ${reflections.map(r => `
          <div class="essay-reflection">
            <span class="reflection-eyebrow">★ the model reflecting on its own thinking</span>
            ${escapeHtml(r.text || '')}
          </div>
        `).join('')}
      </div>` : '';

    this.#page.innerHTML = `
      <div class="essay-eyebrow">${escapeHtml(eyebrow)}</div>
      <h1 class="essay-title">${escapeHtml(s.prompt || '')}</h1>
      <div class="essay-meta">${escapeHtml(meta)}</div>
      ${bodyHtml}
      ${synth ? `
      <div class="essay-closing">
        <span class="closing-eyebrow">— ${escapeHtml(synth.topic || 'closing')} · #${synth.id ?? ''}</span>
        ${escapeHtml(synth.text || '')}
      </div>` : ''}
      ${reflectionsHtml}
      <div class="essay-colophon">${escapeHtml(colophon)}</div>
    `;
  }
}
