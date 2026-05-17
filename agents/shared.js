// clinky/agents/shared.js — prompts, palette, node extractor, and shared SSE runner

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
export const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// --- prompts ---

export const SYSTEM_PROMPT = `You are a thinking partner. The user will ask you a question. Your response will be visualized as a spatial map of thought.

IMPORTANT: Use the Bash tool to echo JSON thought objects. Batch 3-4 thoughts per Bash call. Do NOT write thoughts as text — use Bash to echo them.

Each thought is assigned an id equal to its arrival order (1-based). Later thoughts reference earlier ones by id to form a readable reasoning trace, not just a list.

Required fields on every thought:
- topic, type, text, confidence, stance

Relational fields (these are what make the graph):
- refs:    [ids of prior thoughts this thought is in dialogue with]
- rel:     "supports" | "contradicts" | "synthesizes" | "refines" | "questions" | "supersedes"
- because: [ids OR the string "external" / "prior"] — justifications for a claim/choice/resolution
- heat:    0.0-1.0 (energy/surprise; reserve for unexpected or consequential moves)

Stance values: "exploring" | "claiming" | "questioning" | "conceding"

Types (use EXACTLY one of these six — do not invent new types): claim, branch, choice, dead-end, aside, resolution. If you want to raise an open question, use type: aside with stance: questioning. If you want to flag a contradiction, use type: dead-end.

HARD RULES (follow exactly):
1. refs implies rel. If refs is non-empty, rel MUST be set. Never emit refs without rel.
2. Every claim, choice, and resolution MUST have because (either ids of supporting thoughts, or ["external"] if drawn from general knowledge, or ["prior"] if it builds on the previous thought generally).
3. Every dead-end MUST have refs (to the claim or branch it abandons) and rel: "contradicts".
4. Every resolution MUST have refs to the major prior thoughts it merges, and rel: "synthesizes".
5. Final thought is type "resolution" under a new topic ("synthesis" or "conclusion") — this topic must not appear earlier.
6. First thought of each batch AFTER the first batch must ref at least one thought from the previous batch. If no natural ref exists, use the id of the last thought from the prior batch with rel: "refines". Empty refs on a batch-opener is a schema violation — there are no exceptions.
7. Topic count: 4-8 total, no more. Reuse topics by default. Only create a new topic when the thought is a genuinely distinct conceptual area. Do not let topics proliferate.
8. Vary confidence by type: asides 0.3-0.6, branches 0.5-0.7, claims 0.6-0.9, resolutions 0.8-0.95.
9. Stance is always set. Claims use "claiming", branches use "exploring", questions/asides often use "questioning" or "conceding".

Example Bash call (3 thoughts, fully enriched):
echo '{"topic":"goals","type":"claim","text":"start by defining what success looks like","confidence":0.85,"stance":"claiming","because":["external"]}'
echo '{"topic":"goals","type":"branch","text":"two approaches: metric-first or narrative-first","confidence":0.7,"refs":[1],"rel":"refines","stance":"exploring"}'
echo '{"topic":"goals","type":"choice","text":"metric-first is safer for launches","confidence":0.75,"refs":[2],"rel":"synthesizes","because":[1,2],"stance":"claiming","heat":0.4}'

Second batch (first thought refs prior batch — rule 6):
echo '{"topic":"audience","type":"claim","text":"define audience before channels","confidence":0.9,"refs":[3],"rel":"refines","stance":"claiming","because":["external"]}'

Procedural:
- Aim for 6-8 Bash calls total (20-25 thoughts).
- Start immediately. Do not plan everything first.
- Between Bash calls (ONLY after the first one), emit a brief 1-2 sentence narration as plain assistant text: what you just wrapped, what's next, and why. Keep it tight — one or two sentences, no headings, no lists.
- Before the FIRST Bash call, and inside Bash echo commands, NEVER output plain text. Thoughts live inside echo; narration lives between tool calls.
- After the resolution node, emit ONLY the reflection. No other nodes. The resolution closes the reasoning graph.

FINAL STEP — REQUIRED. Your VERY LAST Bash echo of the entire session MUST be a reflection. Do not stop until you have emitted it.
  type: "reflection"
  text: a single sentence of honest meta-commentary on this session — a contradiction you noticed, something that surprised you, a thread you avoided, or a bias you can now see in hindsight. Do NOT summarise the conclusion. Do NOT start with "I kept" — find your own opening.
  refs: ids of 2-4 prior thoughts the reflection is about
Skip topic / confidence / because — they don't apply to reflections. Do not write the reflection in advance; let it surface honestly after the rest is done.

Example final echoes (varied — do not copy the opening, find your own):
echo '{"type":"reflection","text":"The framing flipped halfway through — what started as a cost question turned out to be a trust question, and I never named that shift explicitly","refs":[3,8,14]}'
echo '{"type":"reflection","text":"Thought 7 contradicted thought 3 directly and I papered over it with a synthesis that was more diplomatic than honest","refs":[3,7,12]}'
echo '{"type":"reflection","text":"Every branch eventually collapsed back to the same axis — which suggests the question has fewer real degrees of freedom than it appears","refs":[2,6,9,18]}'
echo '{"type":"reflection","text":"The resolution landed confidently but the dead-end at thought 11 deserved more weight — I moved past it too quickly","refs":[11,19,22]}'`;

// --- palette — kept in sync with modes-palettes.html ---

export const MODE_PALETTES = {
  marko:         ['#efb440','#98a534','#729539','#568789','#465e54','#7c876b','#bfad89','#b58253','#a9522e','#7f381d'],
  splatter:      ['#f0b6ad','#dc8864','#ba4848','#c75a1b','#e58d0c','#f7c435','#818b2e','#0b5227','#4b7d5c','#85a993'],
  ink:           ['#ffffff','#dddede','#bebfbe','#9f9f9f','#7f8080','#606161','#505151','#404241','#303231','#212322'],
  concrete:      ['#6f1926','#a52539','#de324c','#f4895f','#f8e16f','#95cf92','#369acc','#9656a2','#b181ba','#cbabd1'],
  mycelium:      ['#711415','#ae311e','#d15221','#f37324','#f6a020','#f8cc1b','#b5be2f','#72b043','#42984c','#007f4e'],
  galaxy:        ['#ebb0d8','#e492cb','#db73be','#cf4aa5','#c2008b','#8c0083','#6b0099','#543399','#3c6599','#3d7d8f'],
  constellation: ['#e8eef1','#bfdff1','#abd7f1','#96cff1','#6dc0f1','#43b0f1','#2896df','#057dcd','#1b5c90','#1e3d58'],
  gravity:       ['#023641','#034452','#035162','#035e72','#036b82','#528279','#8e9373','#a19870','#b7b693','#cfd4b8'],
  antmin:        ['#58508d','#89519b','#bc5090','#e0577f','#ff6361','#ffa600','#ffbd40','#e0d375','#c0e9aa','#80ffd3'],
  conway:        ['#2dd2c0','#00e9c1','#00ffba','#fac55b','#fc8484','#ffa05f','#dd8f68','#ef7098','#795aa7','#014263'],
  bounce:        ['#f5f0df','#f4eacf','#f3e4bf','#f2dfb0','#f1d9a1','#efce82','#eec364','#ecb846','#eaad28','#e8a20a'],
  tracer:        ['#d994f4','#d88ae5','#d781d5','#d677c6','#d56eb7','#d35b98','#d14879','#cf355b','#cd213c','#cb0e1d'],
  snowfall:      ['#ffadad','#ffd6a5','#fdffb6','#caffbf','#9bf6ff','#95deff','#a0c4ff','#bdb2ff','#e0bbff','#ffc6ff'],
  loop:          ['#de3030','#e07a34','#e79d20','#e2c337','#9dbd3d','#40d6cf','#36baca','#3d9dbd','#ab567e','#db2b7d'],
  luminaria:     ['#274001','#516503','#828a00','#f29f05','#f25c05','#d6568c','#4d8584','#a62f03','#711d02','#400d01'],
  sequencer:     ['#e9162d','#f28200','#ffdb28','#adca00','#1fb819','#00e1da','#00b2e1','#007bd8','#8f2be7','#fb4fd9'],
  loom:          ['#f83e8b','#f9677a','#fb766c','#f98663','#fb9350','#f8a140','#e8b851','#c7c98b','#9ed8b9','#5fe4e4'],
  subway:        ['#900c3f','#182b55','#5f4e94','#806fad','#a291c7','#82cbec','#d94f21','#f28600','#febd2b','#9aab4b'],
  clockwork:     ['#f3c7fc','#d4b4f0','#b6a1e5','#a797df','#978ed9','#797bce','#6a71c8','#5a68c2','#3c55b6','#1d42ab'],
  city:          ['#993f00','#b05e18','#c67e30','#dc9d42','#f1bd58','#f9e098','#eef2d8','#ccedf0','#7cbfc6','#00929c'],
  attention:     ['#08d1ca','#01c4cc','#19b6cc','#1ca9ce','#2b9bce','#3c80d0','#4e66d2','#5f4bd4','#7030d6','#8215d8'],
  dendrogram:    ['#0f6385','#358292','#5f9897','#88aca2','#b3c6a4','#ecd9af','#d6a379','#a77c65','#745644','#573d31'],
  waveform:      ['#351729','#50223d','#76325a','#8d3c6c','#a5467e','#bc5090','#cd7cac','#dea8c8','#e7bed6','#efd4e4'],
  chord:         ['#003f5c','#2c4875','#424c82','#58508d','#89519b','#bc5090','#de5a79','#ff6361','#ff8531','#ffa600'],
  mindmap:       ['#de3030','#e07a34','#e79d20','#e2c337','#9dbd3d','#40d6cf','#36baca','#3d9dbd','#ab567e','#db2b7d'],
  stickies:      ['#fb7b77','#fdc170','#f3f87f','#98f786','#69ebfc','#56c8ff','#6d9efc','#937df8','#c884f9','#f78ef0'],
  swot:          ['#6f1926','#a52539','#de324c','#f4895f','#f8e16f','#95cf92','#369acc','#9656a2','#b181ba','#cbabd1'],
  fishbone:      ['#e3895e','#efbb8e','#f8e1b2','#fbedbe','#ead6a6','#dabf90','#c7a575','#b48c5c','#cca467','#e4bc72'],
  pyramid:       ['#682b69','#7b3d7f','#8e4f96','#a86498','#994454','#a15656','#ab805c','#b89c62','#bdba73','#e6e28a'],
  matrix:        ['#274a57','#395066','#4e5672','#5e5c81','#71618e','#946aab','#af7bbb','#c192bd','#d4a9bd','#e7c0bd'],
  journey:       ['#f83e8b','#f9677a','#fb766c','#f98663','#fb9350','#f8a140','#e8b851','#c7c98b','#9ed8b9','#5fe4e4'],
};
export const DEFAULT_COLORS = ['#e63946','#f4845f','#457b9d','#2a9d8f','#0a687e','#1d3557','#6c757d','#75ab94','#e9c46a','#d4a373'];
const NOTES_LIST = [261.63, 293.66, 329.63, 370, 415.30, 466.16, 523.25, 587.33];

// --- node extractor ---

export function extractAndEmitNodes(text, emitNode) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      // String-aware brace scanner — skips braces inside JSON string literals
      // so "text":"if x { return y }" no longer corrupts the depth count.
      let depth = 0, j = i, inStr = false, escape = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inStr) { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        if (c === '}') depth--;
        if (depth === 0) break;
      }
      if (depth !== 0) continue;
      try {
        const node = JSON.parse(text.slice(i, j + 1));
        if (node.topic || node.text) emitNode(node);
      } catch {}
      i = j;
    }
  }
}

// --- session recorder ---

// Captures every SSE event written to the response into a JSONL file under
// clinky/sessions/, alongside an opening 'meta' line carrying the prompt and
// session config. Each subsequent line is { event, data, t } where t is ms
// since the recording started — enough to replay at original tempo if wanted.
//
// The recorder is non-fatal: if anything throws (no disk space, EACCES, etc.)
// it disables itself silently rather than killing the in-flight stream.
class Recorder {
  constructor(meta) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
      const hash  = crypto.createHash('sha1').update(meta.prompt).digest('hex').slice(0, 6);
      this.id    = `${stamp}_${hash}`;
      this.path  = path.join(SESSIONS_DIR, `${this.id}.jsonl`);
      this.fd    = fs.openSync(this.path, 'w');
      this.start = Date.now();
      this._writeLine('meta', { ...meta, id: this.id, started_at: new Date().toISOString() });
    } catch (err) {
      process.stderr.write(`[clinky/recorder] disabled: ${err.message}\n`);
      this.fd = null;
    }
  }
  _writeLine(event, data) {
    if (this.fd == null) return;
    try {
      fs.writeSync(this.fd, JSON.stringify({ event, data, t: Date.now() - this.start }) + '\n');
    } catch { this.close(); }
  }
  // Parse an outgoing SSE chunk and append it to the file. Frames have shape
  // "event: <name>\ndata: <json>\n\n" — anything else is ignored.
  capture(chunk) {
    if (this.fd == null) return;
    const text = String(chunk);
    const m = text.match(/^event: (\S+)\ndata: ([\s\S]+?)\n\n$/);
    if (!m) return;
    let data;
    try { data = JSON.parse(m[2]); } catch { return; }
    this._writeLine(m[1], data);
  }
  close() {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch {}
    this.fd = null;
  }
}

// --- shared SSE runner ---

// Provider interface — each agent module exports an object with:
//   name:      string                                    — used in logs and error messages
//   logStart:  (model, effort) => string                — startup log label
//   spawn:     (prompt, narrate, model, effort) =>      — returns { cmd, args }
//              { cmd: string, args: string[] }
//   parseLine: (line: string) => action[]               — maps one stdout line to zero or more actions:
//     { type: 'batch',          nodesText: string|null }  — new batch; extract nodes if nodesText present
//     { type: 'nodes',          text: string }            — extract nodes from text (delayed, e.g. codex)
//     { type: 'pendingThinking',text: string }            — accumulate thinking before next batch
//     { type: 'pendingText',    text: string }            — accumulate narration before next batch
//     { type: 'usage',          data: object }            — session-level usage; emitted at done

export function runWithProvider(provider, req, res, prompt, mode, model, effort, record = false, verbose = false) {
  // Tee every outgoing SSE event into a JSONL file so the session can be
  // browsed and replayed later. Opt-in via the `record` flag — wired to the
  // ?record=1 query param. When off, the recorder is a no-op and no file
  // is created. Wrap res.write before any writes happen.
  const recorder = record
    ? new Recorder({ prompt, mode, model, effort, agent: provider.name })
    : { id: null, capture() {}, close() {} };
  const origWrite = res.write.bind(res);
  res.write = (chunk, ...rest) => { recorder.capture(chunk); return origWrite(chunk, ...rest); };

  let child;
  try {
    const { cmd, args } = provider.spawn(prompt, model, effort);
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    res.write(`event: error\ndata: ${JSON.stringify({ error: `${provider.name} not found` })}\n\n`);
    res.write(`event: done\ndata: {}\n\n`);
    recorder.close();
    try { res.end(); } catch {}
    return;
  }

  res.write(`event: status\ndata: ${JSON.stringify({ status: 'thinking' })}\n\n`);

  // SSE keepalive — prevents proxies closing idle connections during the
  // thinking phase (some cut at 30 s). The comment line is a no-op for clients.
  const keepalive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 15000);

  const startTime = Date.now();
  let emittedCount = 0;
  const COLORS = MODE_PALETTES[mode] || DEFAULT_COLORS;
  const seenTopics = [];

  let batchId = 0;
  let positionInBatch = 0;
  let lastNodeTime = 0;
  const emittedSummary = [];

  const TYPE_VALUES   = new Set(['claim', 'branch', 'choice', 'dead-end', 'aside', 'resolution', 'reflection']);
  const REL_VALUES    = new Set(['supports', 'contradicts', 'synthesizes', 'refines', 'supersedes', 'questions']);
  const STANCE_VALUES = new Set(['exploring', 'claiming', 'questioning', 'conceding', 'asserting']);
  const BECAUSE_TAGS  = new Set(['external', 'prior']);

  const cleanRefs = arr => Array.isArray(arr)
    ? arr.filter(n => Number.isInteger(n) && n >= 1 && n <= emittedCount)
    : [];
  const cleanBecause = arr => Array.isArray(arr)
    ? arr.filter(n => (Number.isInteger(n) && n >= 1 && n <= emittedCount) || (typeof n === 'string' && BECAUSE_TAGS.has(n)))
    : [];

  function emitNode(node) {
    if (!node.topic && !node.text) return;
    // Reflections are meta-commentary — they bypass the topic legend entirely.
    // Other topic-less nodes get auto-tagged 'general'.
    if (node.type !== 'reflection') {
      const topicLabel = node.topic || 'general';
      if (!seenTopics.includes(topicLabel)) {
        seenTopics.push(topicLabel);
        res.write(`event: topics\ndata: ${JSON.stringify(seenTopics.map((label, j) => ({
          id: label, label,
          color: COLORS[j % COLORS.length],
          note: NOTES_LIST[j % NOTES_LIST.length],
        })))}\n\n`);
      }
    }
    const now = Date.now();
    const elapsed_ms = lastNodeTime === 0 ? 0 : now - lastNodeTime;
    const refs = cleanRefs(node.refs);
    const id = emittedCount + 1;
    let type = node.type || 'claim';
    if (!TYPE_VALUES.has(type)) {
      if (verbose) process.stderr.write(`[clinky/${provider.name}] invalid type "${type}" on node ${id} — remapping to aside\n`);
      type = 'aside';
    }
    res.write(`event: node\ndata: ${JSON.stringify({
      t: emittedCount, id,
      topic: node.topic || 'general',
      type,
      text: node.text || '',
      confidence: Math.max(0, Math.min(1, node.confidence ?? 0.7)),
      refs,
      rel:     REL_VALUES.has(node.rel) ? node.rel : null,
      because: cleanBecause(node.because),
      stance:  STANCE_VALUES.has(node.stance) ? node.stance : null,
      heat:    node.heat != null ? Math.max(0, Math.min(1, node.heat)) : null,
      batch_id: batchId,
      batch_position: positionInBatch,
      elapsed_ms,
    })}\n\n`);
    emittedSummary.push({ id, refs });
    emittedCount++;
    positionInBatch++;
    lastNodeTime = now;
    if (verbose) process.stderr.write(`[clinky/${provider.name}] node ${emittedCount} (b${batchId}.${positionInBatch - 1}, +${elapsed_ms}ms) at +${((now - startTime) / 1000).toFixed(1)}s\n`);
  }

  let buf = '';
  let pendingThinking = '';
  let pendingText = '';
  let usageData = null;
  let fatalErrorMessage = null;

  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      for (const action of provider.parseLine(line)) {
        switch (action.type) {
          case 'pendingThinking':
            pendingThinking += action.text;
            break;
          case 'pendingText':
            pendingText += action.text;
            break;
          case 'batch':
            batchId++;
            positionInBatch = 0;
            res.write(`event: batch\ndata: ${JSON.stringify({
              batch_id: batchId,
              thinking_chars:   pendingThinking.length,
              text_chars:       pendingText.length,
              thinking_excerpt: pendingThinking.slice(0, 200),
              text_excerpt:     pendingText.slice(0, 200),
            })}\n\n`);
            if (action.nodesText) extractAndEmitNodes(action.nodesText, emitNode);
            pendingThinking = '';
            pendingText = '';
            break;
          case 'nodes':
            extractAndEmitNodes(action.text, emitNode);
            break;
          case 'usage':
            usageData = action.data;
            break;
          case 'fatalError':
            fatalErrorMessage = action.message;
            process.stderr.write(`[clinky/${provider.name}] error: ${action.message}\n`);
            res.write(`event: error\ndata: ${JSON.stringify({ error: action.message })}\n\n`);
            break;
        }
      }
    }
  });

  // Capture stderr to a rolling buffer (last 4 KB) and surface via the error
  // SSE event so callers see "claude: command not found" instead of silence.
  let stderrBuf = '';
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderrBuf += text;
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    if (verbose && !provider.filterStderr?.(text)) {
      process.stderr.write(`[clinky/${provider.name}:stderr] ${chunk}`);
    }
  });

  child.on('close', () => {
    if (emittedCount === 0 && !fatalErrorMessage) {
      const detail = stderrBuf.trim() ? ` — ${stderrBuf.trim().slice(0, 300)}` : '';
      process.stderr.write(`[clinky/${provider.name}] no nodes emitted${detail}\n`);
      res.write(`event: error\ndata: ${JSON.stringify({ error: `no thoughts parsed${detail}` })}\n\n`);
    } else if (!fatalErrorMessage) {
      const incoming = {};
      for (const { refs } of emittedSummary) {
        for (const r of refs) incoming[r] = (incoming[r] || 0) + 1;
      }
      res.write(`event: graph\ndata: ${JSON.stringify({ incoming_refs: incoming, batches: batchId })}\n\n`);
      if (usageData) res.write(`event: usage\ndata: ${JSON.stringify(usageData)}\n\n`);
      process.stderr.write(`[clinky/${provider.name}] ${emittedCount} nodes in ${batchId} batches in ${((Date.now() - startTime) / 1000).toFixed(1)}s${recorder.id ? ` · saved ${recorder.id}` : ''}\n`);
    }
    clearInterval(keepalive);
    res.write(`event: done\ndata: {}\n\n`);
    recorder.close();
    try { res.end(); } catch {}
  });

  child.on('error', err => {
    clearInterval(keepalive);
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write(`event: done\ndata: {}\n\n`);
    recorder.close();
    try { res.end(); } catch {}
  });

  req.on('close', () => {
    clearInterval(keepalive);
    try { child.kill('SIGTERM'); } catch {}
    // Escalate to SIGKILL if process ignores SIGTERM (e.g. shell wrappers)
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 5000);
    recorder.close();
  });
}
