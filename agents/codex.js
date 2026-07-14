// clinky/agents/codex.js — OpenAI Codex CLI provider

import { SYSTEM_PROMPT, extractNodeStrings } from './shared.js';

export const codex = {
  name: 'codex',

  logStart: (model, effort) => `${model || ''}${effort ? ` · effort ${effort}` : ''}`,

  spawn(prompt, model, effort) {
    const systemPrompt = SYSTEM_PROMPT;
    // No --append-system-prompt flag; fold system prompt into the user prompt.
    const fullPrompt = `${systemPrompt}\n\n--- USER PROMPT ---\n${prompt}`;
    // Codex tops out at xhigh; clamp max down.
    const codexEffort = effort === 'max' ? 'xhigh' : effort;
    // --model and -c are global flags; they must come before the subcommand.
    const args = [];
    if (model) args.push('--model', model);
    if (codexEffort) args.push('-c', `model_reasoning_effort="${codexEffort}"`);
    args.push(
      'exec', '--json', '--skip-git-repo-check',
      // Echo commands need no filesystem access — pin the sandbox instead of
      // inheriting whatever ~/.codex/config.toml says.
      '--sandbox', 'read-only',
      // Isolation: skip user config (MCP servers, profiles); auth still works.
      '--ignore-user-config',
      // Don't persist resumable sessions — Recorder covers replay.
      '--ephemeral',
      fullPrompt,
    );
    return { cmd: 'codex', args };
  },

  filterStderr: (text) => text.includes('Reading additional input from stdin'),

  // Per-session state: item ids whose nodes were already emitted at
  // item.started (runWithProvider calls parseLine on an Object.create wrapper,
  // so this is scoped per run).
  _streamedItems: null,

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'item.started' && msg.item?.type === 'command_execution' && msg.item.id != null) {
        // Emit nodes from the command string the moment the call starts —
        // don't wait for execution. Only open a batch when the command
        // actually carries node JSON, so non-echo commands can't create
        // phantom empty batches (the reason batch originally moved to
        // item.completed).
        const { found } = extractNodeStrings(msg.item.command || '');
        if (!found.length) return [];
        (this._streamedItems ||= new Set()).add(msg.item.id);
        return [
          { type: 'batch', nodesText: null },
          ...found.map(s => ({ type: 'nodes', text: s })),
        ];
      }
      if (msg.type === 'item.completed' && msg.item?.type === 'command_execution') {
        // Fallback for items not handled at item.started (e.g. no command
        // field on the started event). Extracts from the executed command's
        // stdout, so it arrives post-execution.
        if (this._streamedItems?.has(msg.item.id)) return [];
        const text = msg.item.aggregated_output || '';
        if (!text.trim()) return [];
        return [
          { type: 'batch', nodesText: null },
          { type: 'nodes', text },
        ];
      }
      if (msg.type === 'item.completed' && msg.item?.type === 'agent_message') {
        return [{ type: 'pendingText', text: msg.item.text || '' }];
      }
      if (msg.type === 'item.completed' && msg.item?.type === 'reasoning') {
        return [{ type: 'pendingThinking', text: msg.item.text || '' }];
      }
      if (msg.type === 'error') {
        return [{ type: 'fatalError', message: msg.message || 'unknown error' }];
      }
      if (msg.type === 'turn.failed') {
        return [{ type: 'fatalError', message: msg.error?.message || 'turn failed' }];
      }
      if (msg.type === 'turn.completed') {
        const u = msg.usage || {};
        return [{ type: 'usage', data: {
          input_tokens:          u.input_tokens ?? null,
          output_tokens:         u.output_tokens ?? null,
          cache_read_tokens:     u.cached_input_tokens ?? null,
          cache_creation_tokens: null,
          thinking_tokens:       u.reasoning_output_tokens ?? null,
          total_cost_usd:        null,
          premium_requests:      null,
          duration_ms:           null,
          duration_api_ms:       null,
          stop_reason:           null,
          num_turns:             null,
        }}];
      }
    } catch {}
    return [];
  },
};
