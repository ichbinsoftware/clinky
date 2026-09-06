// clinky/agents/qwen.js — Qwen Code CLI provider
//
// Probe-established 2026-08-27 against qwen 0.22.2 (and the acf-cli probes
// against 0.21.14). `-p -o stream-json` is CLAUDE-SHAPED: one JSON event per
// line, complete assistant messages (no partial-message deltas):
//   { type: "system",       subtype: "init", model, permission_mode, tools[] }
//   { type: "stream_event", event: { type: "goal_state" } }       — ignored
//   { type: "assistant",    message: { content: [ { type: "thinking", thinking }
//                                                | { type: "text", text }
//                                                | { type: "tool_use", name: "run_shell_command", input: { command } } ] } }
//   { type: "user",         message: { content: [ { type: "tool_result", tool_use_id, content } ] } }
//   { type: "result",       subtype, is_error, num_turns, duration_ms, usage: { input_tokens, … } }
//
// The shell tool is `run_shell_command`. Headless `-p` DENIES it by default
// ("Matching deny rule: run_shell_command") — `--approval-mode yolo` is
// required and is hidden from `qwen --help`. `--safe-mode` disables
// customizations (QWEN.md, hooks, extensions, skills, MCP servers) but keeps
// the built-in shell tool: that is clinky's isolation flag here (like claude's
// --strict-mcp-config) and it also cut the platform preamble ~30% in probes.
// No system-prompt flag (fold into the user prompt), no effort flag.

import { SYSTEM_PROMPT, extractNodeStrings } from './shared.js';

export const qwen = {
  name: 'qwen',

  noEffort: true,   // qwen exposes no effort flag at all
  logStart: (model) => `${model || 'CLI default'} (effort ignored — qwen has no effort flag)`,

  spawn(prompt, model /* , effort — unused */) {
    const fullPrompt = `${SYSTEM_PROMPT}\n\n--- USER PROMPT ---\n${prompt}`;
    const args = [
      '-p', fullPrompt,
      '-o', 'stream-json',
      '--approval-mode', 'yolo',
      '--safe-mode',
    ];
    if (model) args.push('-m', model);
    return {
      cmd: 'qwen',
      args,
      // Silence the headless-yolo notice qwen prints to stderr on every run.
      env: { QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
    };
  },

  // The safe-mode banner is informational; keep --verbose output readable.
  filterStderr: (text) => text.includes('SAFE MODE') || text.includes('approval-mode=yolo'),

  // Per-session state (scoped per run via Object.create in runWithProvider).
  _yield: null,   // Map tool_use id → node count extracted from the command

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        const actions = [];
        for (const block of msg.message.content) {
          if (block?.type === 'thinking' && block.thinking) {
            actions.push({ type: 'pendingThinking', text: block.thinking });
          } else if (block?.type === 'text' && block.text) {
            actions.push({ type: 'pendingText', text: block.text });
          } else if (block?.type === 'tool_use' && block.name === 'run_shell_command') {
            // Only open a batch when the command actually carries thought
            // JSON — a non-echo shell call must not create a phantom empty
            // batch. Zero-yield calls are retried from stdout at tool_result.
            const command = block.input?.command || '';
            const count = extractNodeStrings(command).found.length;
            // Key on the tool_use id; if the block carries none, key on the
            // command string rather than letting `undefined` become a shared
            // Map key (same guard as cursor.js). An id-less call can still
            // stream at tool_use time; only the stdout recovery path needs
            // the id, and its has() gate simply won't match.
            const id = block.id || `cmd:${command}`;
            (this._yield ||= new Map()).set(id, count);
            if (count > 0) actions.push({ type: 'batch', nodesText: command });
          }
        }
        return actions;
      }

      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        // Tool results: recover a batch whose command string yielded nothing
        // (shell quoting hid the JSON) from the executed stdout. The batch is
        // opened here, late, and only if stdout really carries thoughts.
        const actions = [];
        for (const block of msg.message.content) {
          if (block?.type !== 'tool_result' || !this._yield?.has(block.tool_use_id)) continue;
          const yielded = this._yield.get(block.tool_use_id);
          this._yield.delete(block.tool_use_id);
          if (yielded > 0 || block.is_error) continue;
          const text = typeof block.content === 'string'
            ? block.content
            : (block.content || []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
          if (extractNodeStrings(text).found.length > 0) actions.push({ type: 'batch', nodesText: text });
        }
        return actions;
      }

      if (msg.type === 'result') {
        if (msg.is_error) {
          return [{ type: 'fatalError', message: msg.result || msg.subtype || 'unknown error' }];
        }
        const u = msg.usage || {};
        return [{ type: 'usage', data: {
          input_tokens:          u.input_tokens ?? null,
          output_tokens:         u.output_tokens ?? null,
          cache_read_tokens:     u.cache_read_input_tokens ?? null,
          cache_creation_tokens: null,
          thinking_tokens:       null,
          total_cost_usd:        null,
          duration_ms:           msg.duration_ms ?? null,
          duration_api_ms:       msg.duration_api_ms ?? null,
          stop_reason:           msg.subtype ?? null,
          num_turns:             msg.num_turns ?? null,
        }}];
      }
    } catch {}
    return [];
  },
};
