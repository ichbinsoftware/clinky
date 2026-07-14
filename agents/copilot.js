// clinky/agents/copilot.js — GitHub Copilot CLI provider

import { SYSTEM_PROMPT } from './shared.js';

export const copilot = {
  name: 'copilot',

  logStart: (model, effort) => `${model ? model + ' · ' : ''}effort ${effort}`,

  spawn(prompt, model, effort) {
    const systemPrompt = SYSTEM_PROMPT;
    // No --append-system-prompt flag; fold system prompt into the user prompt.
    const fullPrompt = `${systemPrompt}\n\n--- USER PROMPT ---\n${prompt}`;
    // Copilot tops out at xhigh; clamp max down.
    const copilotEffort = effort === 'max' ? 'xhigh' : effort;
    const args = [
      '-p', fullPrompt, '--output-format', 'json',
      // shell is the only tool the session needs: --available-tools strips the
      // rest from what the model sees; --allow-all-tools is still required for
      // non-interactive mode and auto-approves it. (Permission-layer name is
      // "shell"; the runtime event toolName is "bash".)
      '--available-tools=shell',
      '--allow-all-tools',
      // Isolation: skip AGENTS.md pickup, built-in MCP schemas, the ask_user
      // tool (which would stall a -p session), and the launch update check.
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--no-ask-user',
      '--no-auto-update',
      '--effort', copilotEffort,
    ];
    if (model) args.push('--model', model);
    return { cmd: 'copilot', args };
  },

  // Per-session usage state. runWithProvider invokes parseLine on an
  // Object.create(provider) wrapper, so writes to `this._*` shadow these
  // prototype defaults per run instead of leaking across concurrent sessions.
  _outputTokens: 0,
  _model: null,
  _numTurns: 0,

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'session.tools_updated' && msg.data?.model) {
        this._model = msg.data.model;
      }
      if (msg.type === 'tool.execution_start' && msg.data?.toolName === 'bash') {
        return [{ type: 'batch', nodesText: msg.data.arguments.command }];
      }
      if (msg.type === 'assistant.reasoning_delta') {
        return [{ type: 'pendingThinking', text: msg.data?.deltaContent || '' }];
      }
      if (msg.type === 'assistant.message_delta') {
        return [{ type: 'pendingText', text: msg.data?.deltaContent || '' }];
      }
      if (msg.type === 'assistant.turn_start' && msg.data?.turnId === '0') {
        this._outputTokens = 0;
        this._numTurns = 0;
      }
      if (msg.type === 'assistant.turn_end') {
        this._numTurns++;
      }
      if (msg.type === 'assistant.message' && msg.data?.outputTokens) {
        this._outputTokens += msg.data.outputTokens;
      }
      if (msg.type === 'result') {
        const u = msg.usage || {};
        const outputTokens = this._outputTokens || null;
        this._outputTokens = 0;
        return [{ type: 'usage', data: {
          input_tokens:          null,
          output_tokens:         outputTokens,
          cache_read_tokens:     null,
          cache_creation_tokens: null,
          thinking_tokens:       null,
          total_cost_usd:        null,
          premium_requests:      u.premiumRequests ?? null,
          duration_ms:           u.totalApiDurationMs ?? null,
          session_duration_ms:   u.sessionDurationMs ?? null,
          duration_api_ms:       null,
          stop_reason:           null,
          num_turns:             this._numTurns || null,
          model:                 this._model ?? null,
        }}];
      }
    } catch {}
    return [];
  },
};
