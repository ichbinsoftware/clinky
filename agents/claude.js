// clinky/agents/claude.js — Claude CLI provider

import { SYSTEM_PROMPT, extractNodeStrings } from './shared.js';

export const claude = {
  name: 'claude',

  logStart: (model, effort) => `${model} · effort ${effort}`,

  spawn(prompt, model, effort) {
    const systemPrompt = SYSTEM_PROMPT;
    return {
      cmd: 'claude',
      args: [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        // Stream tool-call input as it generates so nodes can be emitted the
        // moment each thought's JSON closes, not when the whole batch lands.
        '--include-partial-messages',
        // Bash is the only tool the session needs: --tools strips the other
        // built-in tool schemas from context, --allowedTools auto-approves it.
        '--tools', 'Bash',
        '--allowedTools', 'Bash',
        // Session isolation — skip user MCP servers, skills, and hooks. The
        // scratch-dir cwd (shared.js) already prevents CLAUDE.md pickup.
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--settings', '{"disableAllHooks": true}',
        // Guardrails: don't persist resumable sessions (Recorder covers
        // replay), fall back when the primary model is overloaded, and cap
        // spend per session well above the ~$0.10-0.50 a normal run costs.
        '--no-session-persistence',
        '--fallback-model', 'sonnet',
        '--max-budget-usd', '1',
        // Move dynamic sections out of the system prompt so the 23K-token block
        // stays cacheable across requests (5-min TTL).
        '--exclude-dynamic-system-prompt-sections',
        '--model', model,
        '--effort', effort,
        '--append-system-prompt', systemPrompt,
      ],
    };
  },

  // Per-session streaming state. runWithProvider invokes parseLine on an
  // Object.create(provider) wrapper, so writes to `this._*` shadow these
  // prototype defaults per run instead of leaking across concurrent sessions.
  _bash: null,        // Bash tool_use block currently streaming, or null
  _streamed: null,    // Set of tool_use ids fully handled via stream events
  _sawDeltas: false,  // text/thinking arrived as deltas (skip them in full msgs)
  _yield: null,       // Map tool_use id → node count extracted from its command

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'stream_event' && msg.event) {
        return this._onStreamEvent(msg.event);
      }

      if (msg.type === 'result') {
        if (msg.is_error) {
          const errText = typeof msg.error === 'string' ? msg.error
            : (msg.result || msg.subtype || 'unknown error');
          return [{ type: 'fatalError', message: errText }];
        }
        const u = msg.usage || {};
        return [{ type: 'usage', data: {
          input_tokens:          u.input_tokens ?? null,
          output_tokens:         u.output_tokens ?? null,
          cache_read_tokens:     u.cache_read_input_tokens ?? null,
          cache_creation_tokens: u.cache_creation_input_tokens ?? null,
          thinking_tokens:       u.thinking_tokens ?? null,
          total_cost_usd:        msg.total_cost_usd ?? null,
          duration_ms:           msg.duration_ms ?? null,
          duration_api_ms:       msg.duration_api_ms ?? null,
          stop_reason:           msg.subtype ?? null,
          num_turns:             msg.num_turns ?? null,
        }}];
      }

      if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
        // Tool results. If a Bash call's command-string extraction yielded
        // zero nodes (e.g. the model double-quoted the echo, so the JSON
        // arrived shell-escaped and unparseable), recover the batch from the
        // echoed stdout — the shell has resolved all quoting there. Partial
        // losses (some nodes parsed, some not) are not recovered, since
        // re-extracting would duplicate the parsed ones.
        const actions = [];
        for (const block of msg.message.content) {
          if (block?.type !== 'tool_result' || !this._yield?.has(block.tool_use_id)) continue;
          const yielded = this._yield.get(block.tool_use_id);
          this._yield.delete(block.tool_use_id);
          if (yielded > 0) continue;
          const text = typeof block.content === 'string'
            ? block.content
            : (block.content || []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
          if (text) actions.push({ type: 'nodes', text });
        }
        return actions;
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        const actions = [];
        for (const block of msg.message.content) {
          if (block.type === 'thinking') {
            if (!this._sawDeltas) actions.push({ type: 'pendingThinking', text: block.thinking || '' });
          } else if (block.type === 'text') {
            if (!this._sawDeltas) actions.push({ type: 'pendingText', text: block.text || '' });
          } else if (block.type === 'tool_use' && block.name === 'Bash' && block.input?.command) {
            if (this._bash && block.id === this._bash.id) {
              // The CLI emits the complete assistant message BEFORE
              // content_block_stop. Finish the in-flight batch from the
              // authoritative full command: emit whatever the incremental
              // decoder hasn't reached yet (scanFrom is an offset into the
              // decoded command, which this string is the complete form of).
              const { found } = extractNodeStrings(block.input.command, this._bash.scanFrom);
              for (const s of found) actions.push({ type: 'nodes', text: s });
              (this._yield ||= new Map()).set(block.id, this._bash.emitted + found.length);
              (this._streamed ||= new Set()).add(block.id);
              this._bash = null;
            } else if (!this._streamed?.has(block.id)) {
              // True fallback — this block never streamed.
              const count = extractNodeStrings(block.input.command).found.length;
              (this._yield ||= new Map()).set(block.id, count);
              actions.push({ type: 'batch', nodesText: block.input.command });
            }
          }
        }
        return actions;
      }
    } catch {}
    return [];
  },

  _onStreamEvent(ev) {
    if (ev.type === 'content_block_start'
        && ev.content_block?.type === 'tool_use' && ev.content_block.name === 'Bash') {
      this._bash = {
        id: ev.content_block.id, index: ev.index,
        buf: '', valueStart: null, scanFrom: 0, emitted: 0, handled: false,
      };
      // Open the batch the moment the model starts the call — this also
      // flushes narration/thinking accumulated since the previous batch.
      return [{ type: 'batch', nodesText: null }];
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (this._bash && ev.index === this._bash.index && d.type === 'input_json_delta') {
        this._bash.buf += d.partial_json || '';
        return this._drainBash(false);
      }
      if (d.type === 'thinking_delta') { this._sawDeltas = true; return [{ type: 'pendingThinking', text: d.thinking || '' }]; }
      if (d.type === 'text_delta')     { this._sawDeltas = true; return [{ type: 'pendingText', text: d.text || '' }]; }
      return [];
    }
    if (ev.type === 'content_block_stop' && this._bash && ev.index === this._bash.index) {
      const actions = this._drainBash(true);
      (this._yield ||= new Map()).set(this._bash.id, this._bash.emitted);
      if (this._bash.handled) (this._streamed ||= new Set()).add(this._bash.id);
      this._bash = null;
      return actions;
    }
    return [];
  },

  // Incrementally decode the streaming {"command": "echo ..."} input JSON and
  // emit each complete thought object the moment it closes. The decoded prefix
  // is stable as the buffer grows, so scanFrom (an offset into the decoded
  // command) stays valid across calls.
  _drainBash(final) {
    const b = this._bash;
    if (b.valueStart == null) {
      const m = /"command"\s*:\s*"/.exec(b.buf);
      if (!m) return final ? this._drainFallback() : [];
      b.valueStart = m.index + m[0].length;
    }
    // Find the unescaped closing quote of the command value, if streamed yet.
    let end = -1, esc = false;
    for (let i = b.valueStart; i < b.buf.length; i++) {
      const c = b.buf[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { end = i; break; }
    }
    let raw = b.buf.slice(b.valueStart, end === -1 ? b.buf.length : end);
    if (end === -1 && esc) raw = raw.slice(0, -1); // drop trailing half-escape
    let decoded;
    try { decoded = JSON.parse('"' + raw + '"'); }
    catch { return final ? this._drainFallback() : []; } // split \uXXXX — wait for more
    const { found, consumedTo } = extractNodeStrings(decoded, b.scanFrom);
    b.scanFrom = consumedTo;
    b.emitted += found.length;
    if (final) b.handled = true;
    return found.map(s => ({ type: 'nodes', text: s }));
  },

  // Stream decoding never engaged (no "command" key found, or a decode error
  // at stop). Parse the now-complete input JSON instead. If nodes were already
  // emitted incrementally, do nothing — re-extracting would duplicate them.
  _drainFallback() {
    const b = this._bash;
    if (b.emitted > 0) { b.handled = true; return []; }
    try {
      const input = JSON.parse(b.buf);
      if (input && typeof input.command === 'string') {
        b.handled = true;
        return [{ type: 'nodes', text: input.command }];
      }
    } catch {}
    return []; // not handled — the full assistant message will emit this batch
  },
};
