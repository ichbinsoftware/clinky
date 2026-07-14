// clinky/server.js — send a prompt, get classified thought nodes via SSE
// usage: node server.js [--port 4243] [--agent claude|copilot|codex] [--record] [--verbose]
// env:   ~/.clinky/.env and ./.env are loaded at startup (shell vars take precedence)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

// Load .env files before anything else. ~/.clinky/.env is the base config;
// ./.env in the working directory overrides it. Shell env vars always win.
function loadEnv(filepath) {
  try {
    for (const line of fs.readFileSync(filepath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv(path.join(os.homedir(), '.clinky', '.env'));
loadEnv(path.join(process.cwd(), '.env'));

import { runWithProvider, SESSIONS_DIR, MODE_PALETTES, DEFAULT_COLORS } from './agents/shared.js';
import { claude }   from './agents/claude.js';
import { copilot }  from './agents/copilot.js';
import { codex }    from './agents/codex.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT       = Number(process.argv.includes('--port')  ? process.argv[process.argv.indexOf('--port')  + 1] : 4243);
const CLI_AGENT  = process.argv.includes('--agent') ? process.argv[process.argv.indexOf('--agent') + 1] : null;
const CLI_MODEL  = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
// Sessions are opt-in. --record turns recording on by default for every request
// on this server invocation; otherwise callers must pass ?record=1.
const CLI_RECORD   = process.argv.includes('--record');
const CLI_VERBOSE  = process.argv.includes('--verbose');

// Per-agent model defaults. Claude needs an explicit model; copilot and codex
// are better left to their own CLI defaults (new models ship regularly).
const DEFAULT_MODELS = { claude: 'claude-sonnet-4-6', copilot: 'claude-sonnet-4.6', codex: 'gpt-5.4' };
const DEFAULT_EFFORT = 'high';
const VALID_EFFORTS  = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const providers = { claude, copilot, codex };

// --- http ---

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

function serveFile(res, abs) {
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'text/plain' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));

  const modes = [
    // originals
    '/gravity','/antmin','/conway','/marko','/tracer','/bounce','/luminaria','/snowfall','/loop','/sequencer',
    // painterly
    '/splatter',
    // natural
    '/mycelium','/galaxy',
    // typography
    '/concrete',
    // architectural
    '/subway','/clockwork','/loom','/city',
    // celestial
    '/constellation',
    // data & ai
    '/attention','/dendrogram',
    // signal
    '/waveform',
    // radial
    '/chord',
    // brushwork
    '/ink',
    // frame & chart
    '/mindmap','/stickies','/swot','/fishbone','/pyramid','/matrix','/journey',
    // diagnostic
    '/inspect',
  ];
  if (modes.includes(p)) return serveFile(res, path.join(PUBLIC, p.slice(1) + '.html'));
  if (p.startsWith('/ui-tests/')) return serveFile(res, path.join(PUBLIC, p));
  const safePath = path.join(PUBLIC, p);
  if (safePath.startsWith(PUBLIC) && fs.existsSync(safePath)) return serveFile(res, safePath);

  // Session index — one row per saved JSONL file under clinky/sessions/.
  // Reads the meta line, counts node events, and pulls duration from the last
  // event's t. Cheap; the dir is small and rarely huge.
  if (p === '/api/sessions') {
    let files = [];
    try { files = (await fs.promises.readdir(SESSIONS_DIR)).filter(f => f.endsWith('.jsonl')); }
    catch { files = []; }
    const sessions = [];
    await Promise.all(files.map(async f => {
      try {
        const raw = await fs.promises.readFile(path.join(SESSIONS_DIR, f), 'utf8');
        const lines = raw.split('\n').filter(l => l.trim());
        if (!lines.length) return;
        const meta = JSON.parse(lines[0]);
        if (meta.event !== 'meta') return;
        let nodeCount = 0, lastT = 0, usage = null;
        for (const line of lines) {
          const ev = JSON.parse(line);
          if (ev.event === 'node') nodeCount++;
          if (ev.event === 'usage') usage = ev.data;
          if (ev.t > lastT) lastT = ev.t;
        }
        sessions.push({
          id:          meta.data.id,
          prompt:      meta.data.prompt,
          model:       meta.data.model,
          effort:      meta.data.effort,
          agent:       meta.data.agent,
          narrate:     meta.data.narrate,
          mode:        meta.data.mode,
          started_at:  meta.data.started_at,
          node_count:  nodeCount,
          duration_ms: lastT,
          cost_usd:    usage?.total_cost_usd ?? null,
        });
      } catch {}
    }));
    sessions.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // Replay a saved session as SSE. The JSONL was recorded by Recorder, so each
  // line is { event, data, t }. We re-emit those events in order. Meta lines
  // are skipped — they're recorder bookkeeping, not part of the original stream.
  //
  // Speed control:
  //   ?speed=0  → instant (no delays; modes catch up via their own draw loops)
  //   ?speed=1  → real-time (honour original t deltas)
  //   ?speed=N  → N× faster than real-time (default 4 — fast enough to feel
  //              live, slow enough to see arrivals)
  if (p.startsWith('/api/replay/')) {
    const id = p.slice('/api/replay/'.length);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) { res.writeHead(400); res.end('bad id'); return; }
    const fp = path.join(SESSIONS_DIR, id + '.jsonl');
    if (!fp.startsWith(SESSIONS_DIR + path.sep) || !fs.existsSync(fp)) {
      res.writeHead(404); res.end('not found'); return;
    }
    const speedRaw = u.searchParams.get('speed');
    const speed = speedRaw == null ? 4 : Number(speedRaw);  // 0 = instant
    const replayMode = u.searchParams.get('mode') || '';
    const COLORS = MODE_PALETTES[replayMode] || DEFAULT_COLORS;

    // Read async — don't block the event loop while loading the session file.
    let raw;
    try { raw = await fs.promises.readFile(fp, 'utf8'); }
    catch { res.writeHead(404); res.end('not found'); return; }

    res.writeHead(200, {
      'content-type':  'text/event-stream',
      'cache-control': 'no-cache',
      'connection':    'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'meta') continue;  // recorder bookkeeping
        events.push(ev);
      } catch {}
    }

    // Shift timestamps so the first node arrives at ~5s wall-clock regardless
    // of how long the original model took before its first thought.
    if (speed > 0) {
      const firstNode = events.find(e => e.event === 'node');
      if (firstNode) {
        const offset = Math.max(0, firstNode.t - 5000 * speed);
        if (offset > 0) {
          for (const e of events) e.t = Math.max(0, e.t - offset);
        }
      }
    }

    let i = 0;
    function emitNext() {
      if (cancelled) { try { res.end(); } catch {} return; }
      if (i >= events.length) { try { res.end(); } catch {} return; }
      const ev = events[i++];
      // Respect backpressure — wait for drain if buffer is full
      let data = ev.data;
      if (ev.event === 'topics' && Array.isArray(data)) {
        data = data.map((t, i) => ({ ...t, color: COLORS[i % COLORS.length] }));
      }
      const ok = res.write(`event: ${ev.event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (!ok) { res.once('drain', emitNext); return; }
      if (i >= events.length) { setImmediate(emitNext); return; }
      if (speed === 0) { setImmediate(emitNext); return; }
      const dt = Math.max(0, (events[i].t - ev.t) / speed);
      setTimeout(emitNext, dt);
    }
    emitNext();
    return;
  }

  if (p === '/api/think') {
    const prompt     = u.searchParams.get('prompt') || '';
    const mode       = u.searchParams.get('mode') || '';
    const agentKey   = u.searchParams.get('agent') || CLI_AGENT || 'claude';
    // Narrate defaults to on — the batch-transition voice track fills `text_chars` on the
    // Record opt-in: ?record=1 turns it on for this request, ?record=0 forces
    // off even when the server was started with --record. Default follows the
    // CLI flag.
    const recordParam = u.searchParams.get('record');
    const record     = recordParam === '1' ? true : recordParam === '0' ? false : CLI_RECORD;
    const modelParam = u.searchParams.get('model');
    const effortParam = u.searchParams.get('effort');
    const model  = modelParam?.trim() || CLI_MODEL || DEFAULT_MODELS[agentKey] || null;
    const effort = VALID_EFFORTS.has(effortParam) ? effortParam : DEFAULT_EFFORT;
    if (!prompt.trim()) { res.writeHead(400); res.end('no prompt'); return; }

    const provider = providers[agentKey] ?? providers.claude;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection':    'keep-alive',
    });

    process.stderr.write(`[clinky/${provider.name}] ${provider.logStart(model, effort)}${record ? ' · record' : ''}\n`);
    return runWithProvider(provider, req, res, prompt, mode, model, effort, record, CLI_VERBOSE);
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  const agent = CLI_AGENT || 'claude';
  const model = CLI_MODEL || DEFAULT_MODELS[agent] || 'unknown';
  console.log(`\n  clinky — http://localhost:${PORT}`);
  console.log(`  agent: ${agent}  model: ${model}`);
  console.log(`  31 modes — see http://localhost:${PORT} for the full list\n`);
});
