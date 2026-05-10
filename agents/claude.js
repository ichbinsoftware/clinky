// clinky/agents/claude.js — Claude CLI provider

import { SYSTEM_PROMPT } from './shared.js';

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
        '--allowedTools', 'Bash',
        // Move dynamic sections out of the system prompt so the 23K-token block
        // stays cacheable across requests (5-min TTL).
        '--exclude-dynamic-system-prompt-sections',
        '--model', model,
        '--effort', effort,
        '--append-system-prompt', systemPrompt,
      ],
    };
  },

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

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

      if (msg.type === 'assistant' && msg.message?.content) {
        const actions = [];
        for (const block of msg.message.content) {
          if (block.type === 'thinking') {
            actions.push({ type: 'pendingThinking', text: block.thinking || '' });
          } else if (block.type === 'text') {
            actions.push({ type: 'pendingText', text: block.text || '' });
          } else if (block.type === 'tool_use' && block.name === 'Bash' && block.input?.command) {
            actions.push({ type: 'batch', nodesText: block.input.command });
          }
        }
        return actions;
      }
    } catch {}
    return [];
  },
};
