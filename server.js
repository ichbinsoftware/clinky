// clinky/server.js — send a prompt, get classified thought nodes via SSE
// usage: node server.js [--port 4243] [--agent claude|copilot|codex|antigravity|cursor|qwen] [--record] [--verbose]
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
import { claude }      from './agents/claude.js';
import { copilot }     from './agents/copilot.js';
import { codex }       from './agents/codex.js';
import { antigravity } from './agents/antigravity.js';
import { cursor }      from './agents/cursor.js';
import { qwen }        from './agents/qwen.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT       = Number(process.argv.includes('--port')  ? process.argv[process.argv.indexOf('--port')  + 1] : 4243);
const CLI_AGENT  = process.argv.includes('--agent') ? process.argv[process.argv.indexOf('--agent') + 1] : null;
const CLI_MODEL  = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
// Sessions are opt-in. --record turns recording on by default for every request
// on this server invocation; otherwise callers must pass ?record=1.
const CLI_RECORD   = process.argv.includes('--record');
const CLI_VERBOSE  = process.argv.includes('--verbose');

// Per-agent model defaults (refreshed 2026-08-29). codex follows the vendor
// default (gpt-5.6-sol; gpt-5.4 / gpt-5.4-mini retire from Codex 2026-08-31).
// qwen ids must exist in the user's ~/.qwen/settings.json modelProviders — an
// id the CLI does not know fails loudly on stderr.
const DEFAULT_MODELS = { claude: 'claude-sonnet-5', copilot: 'claude-sonnet-5', codex: 'gpt-5.6-sol', antigravity: 'Gemini 3.1 Pro (High)', cursor: 'composer-2.5', qwen: 'qwen3.8-flash' };

// Own-property lookups only: these tables are indexed by request-supplied
// strings, and a bare `obj[key]` would resolve inherited Object.prototype
// members ("constructor", "__proto__") as truthy values.
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);
const DEFAULT_EFFORT = 'high';
const VALID_EFFORTS  = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const providers = { claude, copilot, codex, antigravity, cursor, qwen };

// Resolve the server-wide default agent ONCE, through the same own() guard the
// request path uses. An unknown --agent value (typo, or a backend this build
// doesn't have) falls back to claude with a startup warning — it must never
// reach a bare providers[...] index anywhere.
const CLI_AGENT_UNKNOWN = !!CLI_AGENT && !own(providers, CLI_AGENT);
const SERVER_AGENT = CLI_AGENT_UNKNOWN || !CLI_AGENT ? 'claude' : CLI_AGENT;

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
    const COLORS = own(MODE_PALETTES, replayMode) || DEFAULT_COLORS;

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
    // Resolve the agent key ONCE, so model default and provider derive from
    // the same backend — an unknown key must not pair claude's provider
    // with another backend's (or a null) model.
    const requestedAgent = u.searchParams.get('agent') || SERVER_AGENT;
    const agentKnown = !!own(providers, requestedAgent);
    const agentKey = agentKnown ? requestedAgent : 'claude';
    // Narrate defaults to on — the batch-transition voice track fills `text_chars` on the
    // Record opt-in: ?record=1 turns it on for this request, ?record=0 forces
    // off even when the server was started with --record. Default follows the
    // CLI flag.
    const recordParam = u.searchParams.get('record');
    const record     = recordParam === '1' ? true : recordParam === '0' ? false : CLI_RECORD;
    const modelParam = u.searchParams.get('model');
    const effortParam = u.searchParams.get('effort');
    // --model belongs to the server's default agent only: a codex id handed
    // to a ?agent=claude request would be a cross-backend model. Other agents
    // fall through to their own defaults unless the request names a model.
    const cliModel = agentKey === SERVER_AGENT ? CLI_MODEL : null;
    // ?model= names a model for the agent the request asked for. When that agent
    // is unknown we fall back to claude, and the model must not ride along — a
    // qwen id handed to claude only fails as unrecognized_model.
    const reqModel = agentKnown ? modelParam?.trim() : null;
    const model  = reqModel || cliModel || own(DEFAULT_MODELS, agentKey) || null;
    if (!prompt.trim()) { res.writeHead(400); res.end('no prompt'); return; }

    const provider = providers[agentKey];   // agentKey is a known own key by construction
    // Backends that encode reasoning depth in the model id or name take no
    // effort flag. Record null rather than the default, so session metadata
    // never claims an effort the run did not actually have.
    const effort = provider.noEffort ? null : (VALID_EFFORTS.has(effortParam) ? effortParam : DEFAULT_EFFORT);

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

// Which backend CLIs are actually on PATH. Each provider names its binary in
// spawn(); resolve it the way child_process will, so the console says up
// front what a "spawn X ENOENT" would otherwise say mid-session.
function backendBinary(provider) {
  try { return provider.spawn('', null, 'high').cmd || provider.name; } catch { return provider?.name || ''; }
}
function onPath(bin) {
  if (!bin) return false;
  if (bin.includes(path.sep)) return fs.existsSync(bin);
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; }
  });
}

server.listen(PORT, () => {
  const agent = SERVER_AGENT;
  const model = CLI_MODEL || own(DEFAULT_MODELS, agent) || 'CLI default';
  console.log(`\n  clinky — http://localhost:${PORT}`);
  console.log(`  agent: ${agent}  model: ${model}`);
  if (CLI_AGENT_UNKNOWN) {
    console.log(`  ⚠ unknown --agent "${CLI_AGENT}" (valid: ${Object.keys(providers).join(', ')}) — using claude`);
  }
  const status = Object.entries(providers).map(([key, prov]) => {
    const bin = backendBinary(prov);
    return onPath(bin) ? `${key} ✓` : `${key} ✗ (${bin} not on PATH)`;
  });
  console.log(`  backends: ${status.join('  ')}`);
  const defaultBin = backendBinary(providers[agent]);   // agent is a known key by construction
  if (!onPath(defaultBin)) {
    console.log(`  ⚠ default agent "${agent}" needs the ${defaultBin} CLI, which is not on PATH — requests to it will fail with a not-installed error until it is`);
  }
  console.log(`  31 modes — see http://localhost:${PORT} for the full list\n`);
});
