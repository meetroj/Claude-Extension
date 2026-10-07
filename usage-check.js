// Token counting for the Claude Usage view - the part that lies quietly if it breaks.
// Run: npm test   (reads ./out, so it compiles first)

const assert = require('assert');
const { parse, sum, total } = require('./out/transcript');

const usage = (input, output, read, write) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});
const AT = '2026-10-05T08:00:00.000Z';
const reply = (id, stop_reason, u, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  timestamp: AT,
  message: { id, model, stop_reason, usage: u },
});
const typed = (...texts) => ({
  type: 'user',
  origin: { kind: 'human' },
  message: { content: texts.map((text) => ({ type: 'text', text })) },
});
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');

// --- a finished turn, shaped like a real session ------------------------------
const done = parse(
  jsonl(
    { type: 'ai-title', aiTitle: 'Fix login' },
    typed('<ide_opened_file>auth.ts</ide_opened_file>', 'fix the login bug'),
    // one response, three lines, same usage on each: must count once
    reply('msg_A', null, usage(2, 100, 1000, 50)),
    reply('msg_A', null, usage(2, 100, 1000, 50)),
    reply('msg_A', 'tool_use', usage(2, 100, 1000, 50)),
    toolResult,
    reply('msg_B', 'end_turn', usage(3, 20, 1100, 10)),
    // a locally generated notice must not zero the context or steal the model name
    reply('msg_C', 'stop_sequence', usage(0, 0, 0, 0), '<synthetic>'),
    { type: 'last-prompt', lastPrompt: 'stale copy' }
  ) + '\n{"type":"assist' // the line Claude Code is halfway through writing
);

assert.deepStrictEqual(done.tokens, { input: 5, output: 120 });
assert.strictEqual(total(done.tokens), 125); // cache read 2100 + write 60 never counted
assert.strictEqual(done.context, 3 + 1100 + 10);
assert.strictEqual(done.model, 'claude-opus-5-5');
assert.strictEqual(done.title, 'Fix login');
assert.strictEqual(done.prompt, 'fix the login bug'); // the typed text, not the editor context
assert.strictEqual(done.ended, true);

// each response keeps its time and model: that is what "today" and "by model" are built from
assert.strictEqual(done.responses.size, 2);
assert.deepStrictEqual(done.responses.get('msg_B'), {
  at: Date.parse(AT),
  model: 'claude-opus-5-5',
  tokens: { input: 3, output: 20 },
});

// --- fed in pieces (how a growing file is tailed) = read in one go -------------
const grown = [
  typed('go'),
  reply('m1', null, usage(1, 5, 10, 0)),
  reply('m1', 'tool_use', usage(1, 9, 10, 0)), // same response, final count: replaces, never adds
  toolResult,
  reply('m2', 'end_turn', usage(2, 3, 20, 1)),
];
const whole = parse(jsonl(...grown));
assert.deepStrictEqual(parse(jsonl(...grown.slice(2)), parse(jsonl(...grown.slice(0, 2)))), whole);
assert.strictEqual(whole.tokens.output, 12);

// --- still working: waiting on a tool, or a fresh prompt ----------------------
assert.strictEqual(parse(jsonl(typed('go'), reply('m', 'tool_use', usage(1, 1, 0, 0)))).ended, false);
assert.strictEqual(parse(jsonl(reply('m', 'end_turn', usage(1, 1, 0, 0)), typed('and again'))).ended, false);
assert.strictEqual(parse(jsonl(reply('m', 'tool_use', usage(1, 1, 0, 0)), toolResult)).ended, false);

// --- interrupted counts as ended, and is not mistaken for a prompt ------------
const cut = parse(
  jsonl(typed('go'), reply('m', 'tool_use', usage(1, 1, 0, 0)), {
    type: 'user',
    message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  })
);
assert.strictEqual(cut.ended, true);
assert.strictEqual(cut.prompt, 'go');

// --- a subagent is handed its prompt as a plain string ------------------------
const agentPrompt = { type: 'user', isSidechain: true, message: { content: 'map the auth code' } };
assert.strictEqual(parse(jsonl(agentPrompt)).prompt, 'map the auth code');
assert.strictEqual(
  parse(jsonl(agentPrompt, { type: 'user', isSidechain: true, isMeta: true, message: { content: '<system-reminder>' } })).prompt,
  'map the auth code'
);

// --- in a session a plain string is machinery, never what the user typed -------
const noise = (content, origin) => ({ type: 'user', origin, message: { content } });
assert.strictEqual(
  parse(
    jsonl(
      typed('ship it'),
      noise('<task-notification><task-id>b1</task-id></task-notification>', { kind: 'task-notification' }),
      noise('<command-name>/model</command-name>')
    )
  ).prompt,
  'ship it'
);

// --- no typed prompt on record: fall back to last-prompt ----------------------
assert.strictEqual(parse(jsonl({ type: 'last-prompt', lastPrompt: 'hello' })).prompt, 'hello');

// --- junk in, zeros out -------------------------------------------------------
assert.deepStrictEqual(parse('').tokens, sum());
assert.deepStrictEqual(parse('null\n42\nnot json\n{"type":"assistant"}').tokens, sum());

console.log('usage ok');
