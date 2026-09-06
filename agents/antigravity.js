// clinky/agents/antigravity.js — Google Antigravity CLI (agy) provider

import { SYSTEM_PROMPT, extractNodeStrings } from './shared.js';

// agy print mode supports `--output-format stream-json` (undocumented in
// --help; per antigravity.google/docs/cli-using): one JSON event per line.
//   { event: "init",        init: { model, cwd, tools, permission_mode } }
//   { event: "step_update", step_update: { step_index, state, step_type, ... } }
//   { event: "result",      result: { status, response, usage, num_turns, duration_seconds } }
// Tool steps arrive with state=ACTIVE the moment the model invokes them —
// but tool_info.parameters.CommandLine is TRUNCATED to ~512 chars in the
// event payload, so a 3-4-thought echo batch loses everything past the cut.
// The DONE event's tool_info.output (the executed stdout) is complete, so:
// batch opens at ACTIVE (real-time signal, flushes narration), nodes are
// extracted at DONE from output. Echo commands run in ~80ms, so the delivery
// difference is imperceptible.
export const antigravity = {
  name: 'antigravity',

  // agy 1.1.22 does accept `--effort low|medium|high`, but its model values are
  // display names that already encode depth ("Gemini 3.1 Pro (High)"), and which
  // of the two wins when they disagree is undocumented and unbenchmarked. clinky
  // sets depth through the model name only and passes no --effort, so there is
  // never a conflict to resolve. Revisit if the precedence is ever established.
  noEffort: true,
  logStart: (model) => `${model || 'CLI default'}`,

  spawn(prompt, model /* , effort — unused */) {
    // No system-prompt flag; fold it into the user prompt (as codex/copilot).
    const fullPrompt = `${SYSTEM_PROMPT}\n\n--- USER PROMPT ---\n${prompt}`;
    const args = [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      // Headless runs soft-deny tools that need confirmation; the echo
      // commands must auto-approve or no thoughts ever execute.
      '--dangerously-skip-permissions',
      '--print-timeout', '5m',
    ];
    // Model values are agy's display names, e.g. "Gemini 3.1 Pro (High)" —
    // spaces are fine, spawn() passes args without a shell. Invalid names
    // hard-fail with a non-zero exit and a list of valid models on stderr,
    // which runWithProvider surfaces via the error SSE event.
    if (model) args.push('--model', model);
    return { cmd: 'agy', args };
  },

  // Per-session state (runWithProvider calls parseLine on an Object.create
  // wrapper, so this is scoped per run): step indices whose batch was opened
  // at ACTIVE, so DONE neither duplicates nor drops the batch event.
  _batchOpened: null,

  parseLine(line) {
    try {
      const msg = JSON.parse(line);

      if (msg.event === 'step_update' && msg.step_update) {
        const su = msg.step_update;

        if (su.step_type === 'tool' && su.tool_name === 'run_command') {
          if (su.state === 'ACTIVE') {
            if (this._batchOpened?.has(su.step_index)) return []; // repeated ACTIVE
            // Only open a batch when the (truncated) command looks like a
            // thought echo — the {"topic"/{"type" marker appears within the
            // first line, well inside the truncation window. Stray non-echo
            // commands must not create phantom empty batches.
            const cmd = su.tool_info?.parameters?.CommandLine || '';
            if (!/\{\s*"(topic|type)"/.test(cmd)) return [];
            (this._batchOpened ||= new Set()).add(su.step_index);
            return [{ type: 'batch', nodesText: null }];
          }
          if (su.state === 'DONE') {
            // Extract from the executed stdout — complete, shell-resolved.
            // Fall back to the (truncated) command string if output is empty.
            const out = su.tool_info?.output || '';
            const src = out.trim() ? out : (su.tool_info?.parameters?.CommandLine || '');
            const { found } = extractNodeStrings(src);
            if (!found.length) return [];
            const actions = [];
            if (!this._batchOpened?.has(su.step_index)) {
              actions.push({ type: 'batch', nodesText: null });
            }
            for (const s of found) actions.push({ type: 'nodes', text: s });
            return actions;
          }
          return [];
        }

        // Narration between tool calls arrives as agent_response text deltas.
        if (su.step_type === 'agent_response' && su.text_delta) {
          return [{ type: 'pendingText', text: su.text_delta }];
        }
        return [];
      }

      if (msg.event === 'result' && msg.result) {
        const r = msg.result;
        const actions = [];
        if (r.status && r.status !== 'SUCCESS') {
          actions.push({ type: 'fatalError', message: `agy run ended with status ${r.status}` });
        }
        const u = r.usage || {};
        actions.push({ type: 'usage', data: {
          input_tokens:          u.input_tokens ?? null,
          output_tokens:         u.output_tokens ?? null,
          cache_read_tokens:     null,
          cache_creation_tokens: null,
          thinking_tokens:       u.thinking_tokens ?? null,
          total_cost_usd:        null,
          duration_ms:           r.duration_seconds != null ? Math.round(r.duration_seconds * 1000) : null,
          duration_api_ms:       null,
          stop_reason:           r.status ?? null,
          num_turns:             r.num_turns ?? null,
        }});
        return actions;
      }
    } catch {}
    return [];
  },
};
