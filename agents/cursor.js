// clinky/agents/cursor.js — Cursor CLI (cursor-agent) provider
//
// Probe-established 2026-08-27 against cursor-agent 2026.08.25-3e8eec8 (and the
// acf-cli probes against 2026.08.11). `-p --output-format stream-json` emits one
// JSON event per line:
//   { type: "system",    subtype: "init", model, permissionMode, cwd }
//   { type: "user",      message }                       — echo of the prompt
//   { type: "thinking",  subtype: "delta"|"completed", text }   — true token stream
//   { type: "assistant", message: { content: [{ type: "text", text }] } }
//   { type: "tool_call", subtype: "started"|"completed", call_id,
//                        tool_call: { shellToolCall: { args: { command }, result: { success: { stdout } } } } }
//   { type: "result",    subtype, is_error, duration_ms, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }
//
// A shell call arrives as `tool_call started` the moment the model invokes it,
// carrying the full command string — so nodes stream per-call like claude.
// Headless execution needs `--trust --force`: without --force the CLI rejects
// tool calls even in print mode (measured by acf-cli, probe3-noforce-rejected).
// There is no system-prompt flag (fold into the user prompt) and no effort
// flag — reasoning depth is encoded in the model id (cursor-grok-4.6-high,
// claude-opus-5-low, gpt-5.3-codex-xhigh …; `cursor-agent --list-models`).

import { SYSTEM_PROMPT, extractNodeStrings } from './shared.js';

export const cursor = {
  name: 'cursor',

  noEffort: true,   // depth is encoded in the model id (claude-opus-5-low, …)
  logStart: (model) => `${model || 'auto'} (effort ignored — encoded in model id)`,

  spawn(prompt, model /* , effort — unused */) {
    // No --append-system-prompt equivalent; fold the schema into the prompt.
    const fullPrompt = `${SYSTEM_PROMPT}\n\n--- USER PROMPT ---\n${prompt}`;
    const args = [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      // Headless grants: trust the (empty scratch) workspace, auto-run the
      // echo commands. No --stream-partial-output: with it every assistant
      // text block is emitted twice (word deltas + the full block), and the
      // full-block form is all clinky needs for narration. Thinking deltas
      // stream regardless.
      '--trust', '--force',
    ];
    if (model) args.push('--model', model);
    return { cmd: 'cursor-agent', args };
  },

  // Per-session state (runWithProvider calls parseLine on an Object.create
  // wrapper, so writes to `this._*` are scoped to one run).
  _yield: null,   // Map call_id → node count extracted from the command string

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'thinking') {
        return (msg.subtype === 'delta' && msg.text)
          ? [{ type: 'pendingThinking', text: msg.text }]
          : [];
      }

      if (msg.type === 'assistant') {
        const actions = [];
        for (const block of msg.message?.content || []) {
          if (block?.type === 'text' && block.text) actions.push({ type: 'pendingText', text: block.text });
        }
        return actions;
      }

      if (msg.type === 'tool_call') {
        const shell = msg.tool_call?.shellToolCall;
        if (!shell) return [];   // read/grep/glob/mcp calls carry no thoughts
        const command = shell.args?.command || '';
        // Correlate started↔completed by call id; if the event carries none,
        // key on the command string itself (identical on both events) rather
        // than letting `undefined` become a shared Map key.
        const id = msg.call_id || msg.tool_call?.toolCallId || `cmd:${command}`;

        if (msg.subtype === 'started') {
          // Extract from the command string immediately — this is the
          // real-time hook; execution has not happened yet. Only open a batch
          // when the command actually carries thought JSON, so a non-echo
          // shell call (ls, date …) cannot create a phantom empty batch.
          const count = extractNodeStrings(command).found.length;
          (this._yield ||= new Map()).set(id, count);
          return count > 0 ? [{ type: 'batch', nodesText: command }] : [];
        }

        if (msg.subtype === 'completed') {
          // Only a call whose `started` we tracked is eligible for stdout
          // recovery, and only once — the entry is consumed here, so a
          // second `completed` for the same key (duplicate event, or two
          // identical commands sharing the cmd: fallback key) is ignored
          // rather than republishing the batch.
          if (!this._yield?.has(id)) return [];
          const yielded = this._yield.get(id);
          this._yield.delete(id);
          if (yielded > 0) return [];   // already streamed at `started`
          // Command-string extraction found nothing (shell quoting hid the
          // JSON, or it was not an echo call) — recover from the executed
          // stdout, where quoting is resolved. Open the batch only if stdout
          // really carries thoughts.
          const stdout = shell.result?.success?.stdout || '';
          if (extractNodeStrings(stdout).found.length > 0) return [{ type: 'batch', nodesText: stdout }];
          return [];
        }
        return [];
      }

      if (msg.type === 'result') {
        if (msg.is_error) {
          return [{ type: 'fatalError', message: msg.result || msg.subtype || 'unknown error' }];
        }
        const u = msg.usage || {};
        return [{ type: 'usage', data: {
          input_tokens:          u.inputTokens ?? null,
          output_tokens:         u.outputTokens ?? null,
          cache_read_tokens:     u.cacheReadTokens ?? null,
          cache_creation_tokens: u.cacheWriteTokens ?? null,
          thinking_tokens:       null,
          total_cost_usd:        null,
          duration_ms:           msg.duration_ms ?? null,
          duration_api_ms:       msg.duration_api_ms ?? null,
          stop_reason:           msg.subtype ?? null,
          num_turns:             null,
        }}];
      }
    } catch {}
    return [];
  },
};
