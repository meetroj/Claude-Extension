/**
 * Reads one Claude Code transcript: ~/.claude/projects/<folder>/<session>.jsonl, one JSON
 * entry per line. No vscode imports, so usage-check.js can run it under plain node.
 */

export interface Tokens {
  input: number;
  output: number;
}

/** One API response: when it came back, from which model, and what it used. */
export interface Response {
  at: number;
  model: string;
  tokens: Tokens;
}

export interface Run {
  tokens: Tokens;
  /** Tokens sent with the most recent request - how full the context window is right now. */
  context: number;
  /** The last turn finished or was interrupted, so nothing is in flight. */
  ended: boolean;
  prompt?: string;
  /** `prompt` is what the user typed, not the last-prompt fallback. */
  typed?: boolean;
  title?: string;
  model?: string;
  /**
   * By message id. One response is written as several lines (thinking, text, tool call) and
   * every one repeats the full usage, so the id is what makes it count once.
   */
  responses: Map<string, Response>;
}

export const sum = (...all: Tokens[]): Tokens =>
  all.reduce(
    (a, b) => ({
      input: a.input + b.input,
      output: a.output + b.output,
    }),
    { input: 0, output: 0 }
  );

/** Cache tokens are never counted: each turn re-sends the whole conversation through the cache. */
export const total = (t: Tokens) => t.input + t.output;

export const empty = (): Run => ({ tokens: sum(), context: 0, ended: false, responses: new Map() });

/**
 * Fold transcript lines into `run`. A transcript only ever grows, so a caller can pass just the
 * lines added since last time - as long as every call ends on a line break.
 */
export function parse(jsonl: string, run: Run = empty()): Run {
  for (const line of jsonl.split('\n')) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // blank, or the final line is still being written
    }
    const m = e?.message;
    switch (e?.type) {
      case 'ai-title':
        run.title = e.aiTitle;
        break;
      case 'last-prompt':
        if (!run.typed) run.prompt = e.lastPrompt; // written a little after the prompt itself, so only a fallback
        break;
      case 'assistant': {
        run.ended = !!m?.stop_reason && m.stop_reason !== 'tool_use';
        if (!m?.usage || m.model === '<synthetic>') break; // a local notice, not an API call
        const tokens: Tokens = {
          input: m.usage.input_tokens ?? 0,
          output: m.usage.output_tokens ?? 0,
        };
        run.responses.set(m.id ?? e.uuid, { at: Date.parse(e.timestamp), model: String(m.model), tokens });
        // the context window does hold the cached part, so it is the one place cache sizes are used
        run.context = tokens.input + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
        run.model = m.model;
        break;
      }
      case 'user': {
        const c = m?.content;
        const text: string | undefined =
          typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').at(-1)?.text : undefined;
        run.ended = !!text?.startsWith('[Request interrupted');
        // A subagent is handed its prompt as a plain string. In a session a plain string is a
        // slash command or task notification; what the user typed is tagged human, with any
        // editor context in the text blocks before it.
        if (text && !e.isMeta && (e.isSidechain ? typeof c === 'string' : e.origin?.kind === 'human')) {
          run.prompt = text;
          run.typed = true;
        }
        break;
      }
    }
  }

  run.tokens = sum(...[...run.responses.values()].map((r) => r.tokens));
  return run;
}
