// clinky/agents/codex.js — OpenAI Codex CLI provider

import { SYSTEM_PROMPT } from './shared.js';

export const codex = {
  name: 'codex',

  logStart: (model) => model || '',

  spawn(prompt, model) {
    const systemPrompt = SYSTEM_PROMPT;
    // No --append-system-prompt flag; fold system prompt into the user prompt.
    const fullPrompt = `${systemPrompt}\n\n--- USER PROMPT ---\n${prompt}`;
    // --model is a global flag; it must come before the subcommand.
    const args = model ? ['--model', model, 'exec', '--json', '--skip-git-repo-check'] : ['exec', '--json', '--skip-git-repo-check'];
    args.push(fullPrompt);
    return { cmd: 'codex', args };
  },

  filterStderr: (text) => text.includes('Reading additional input from stdin'),

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'item.completed' && msg.item?.type === 'command_execution') {
        // Batch fires here rather than on item.started. Codex emits no thinking
        // or narration text between start and completion, so the early signal had
        // no content to show — and commands that produce no node JSON created
        // phantom empty batches. Skipping empty output avoids those entirely.
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
