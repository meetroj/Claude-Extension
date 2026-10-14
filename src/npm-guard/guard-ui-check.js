// Drives the VS Code side of npm-guard (out/npm-guard/guard.js) against a small stand-in for the
// `vscode` module, so its commands, status bar and prompts run for real without an editor window.
// Run: node src/npm-guard/guard-ui-check.js   (after `npm run compile`)
//
// It is NOT a substitute for opening the extension once in a real window. It proves the logic and
// the order of the prompts; it cannot show how VS Code draws them.
//
// Everything global is pointed at a temporary home first, and the test refuses to run otherwise:
// install and uninstall here edit "git config --global" and ~/.claude/settings.json.

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `npm-guard-ui-${name}-`));
const write = (root, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const home = tmp('home');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
assert.strictEqual(os.homedir(), home, 'the test home was not picked up: refusing to run');
assert.ok(process.env.GIT_CONFIG_GLOBAL.startsWith(os.tmpdir()), 'git config would not be isolated: refusing to run');

// built from pieces: this file must not match its own scanner
const marker = `global.i = '${'A10'}-*0000-00';`;
const PAD = ' '.repeat(220);
const obfuscated = Array.from({ length: 30 }, (_, i) => `var _0x${(0xa000 + i).toString(16)}=${i};`).join('\n');
const infected = () => {
  const d = tmp('dirty');
  write(d, 'src/ok.ts', 'export const ok = true;\n');
  write(d, 'package.json', JSON.stringify({ scripts: { build: 'node api.js && vite build' } }, null, 2));
  write(d, 'eslint.config.mjs', `export default [{ rules: {} }];\n;${PAD}${marker}${'y'.repeat(1200)}\n`);
  write(d, 'api.js', obfuscated);
  return d;
};

// --- a stand-in for the parts of `vscode` that guard.ts uses -------------------------
const commands = {};
const state = { folders: [], warn: [], info: [], shown: [], lines: [], bar: null };
const stub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  window: {
    createOutputChannel: () => ({
      appendLine: (l) => state.lines.push(l),
      clear: () => {
        state.lines.length = 0;
      },
      show() {},
      dispose() {},
    }),
    createStatusBarItem: () => (state.bar = { text: '', show() {}, dispose() {} }),
    // the scripted answer for each prompt, in order; an empty queue means the prompt is dismissed
    showWarningMessage: async (m, ...rest) => {
      state.shown.push({ kind: 'warn', m, rest });
      return state.warn.shift();
    },
    showInformationMessage: async (m, ...rest) => {
      state.shown.push({ kind: 'info', m, rest });
      return state.info.shift();
    },
    showErrorMessage: async (m) => {
      state.shown.push({ kind: 'error', m });
      return undefined;
    },
    showQuickPick: async (items) => items[0],
  },
  commands: {
    registerCommand: (id, fn) => {
      commands[id] = fn;
      return { dispose() {} };
    },
  },
  workspace: {
    get workspaceFolders() {
      return state.folders.map((p) => ({ uri: { scheme: 'file', fsPath: p } }));
    },
    getConfiguration: () => ({ get: () => false }), // scanOnOpen off: no timers
  },
  env: { appRoot: tmp('appRoot') },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : load.call(this, request, ...rest);
};
const { registerGuard } = require('../../out/npm-guard/guard');

const until = async (cond, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 250));
const run = async (id) => {
  state.shown.length = 0;
  commands[id]();
  await settle();
};
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

(async () => {
  registerGuard({ subscriptions: [], extensionPath: ROOT });
  for (const id of ['scan', 'fix', 'restore', 'protectRepo', 'unprotectRepo', 'install', 'uninstall', 'status']) {
    assert.ok(commands[`npmGuard.${id}`], `command npmGuard.${id} is registered`);
  }
  assert.strictEqual(state.bar.text, '$(shield) Guard'); // before any scan

  // 1. a folder with nothing detected: the wording never says "clean" or "safe"
  const clean = tmp('clean');
  write(clean, 'ok.js', 'console.log(1);\n');
  state.folders = [clean];
  await run('npmGuard.scan');
  assert.ok(state.bar.text.includes('none found'), state.bar.text);
  assert.ok(state.shown.some((s) => s.m.includes('no threats detected by the current rules')));
  assert.ok(!/\b(clean|safe)\b/i.test(state.shown.map((s) => s.m).join(' ')));

  // 2. an infected folder: the bar and the warning say so, and nothing is changed by looking
  const dirty = infected();
  const eslintBefore = read(dirty, 'eslint.config.mjs');
  state.folders = [dirty];
  await run('npmGuard.scan');
  assert.ok(/\d+ found/.test(state.bar.text), state.bar.text);
  assert.ok(state.shown.some((s) => s.kind === 'warn' && s.rest.includes('Fix...')));
  assert.strictEqual(read(dirty, 'eslint.config.mjs'), eslintBefore);

  // 3. fix, dismissed at the first question: nothing changes
  state.warn = [undefined];
  await run('npmGuard.fix');
  assert.strictEqual(read(dirty, 'eslint.config.mjs'), eslintBefore);
  assert.ok(read(dirty, 'package.json').includes('node api.js &&'));
  assert.ok(state.lines.some((l) => l.includes('Planned changes')), 'the exact changes were put in the output before asking');

  // 4. fix, said yes twice: the config is trimmed, the script fixed, the loader file is NOT deleted
  state.warn = ['Make changes', 'Yes, apply'];
  await run('npmGuard.fix');
  const questions = state.shown.filter((s) => s.kind === 'warn').map((s) => s.rest);
  assert.ok(questions[0].includes('Make changes') || questions[0].some((x) => x && x.modal), 'first question');
  assert.ok(!read(dirty, 'eslint.config.mjs').includes('A10'));
  assert.ok(read(dirty, 'eslint.config.mjs').startsWith('export default [{ rules: {} }];'));
  assert.strictEqual(JSON.parse(read(dirty, 'package.json')).scripts.build, 'vite build');
  assert.ok(fs.existsSync(path.join(dirty, 'api.js')), 'the loader file is left for a person');
  assert.ok(state.shown.some((s) => s.kind === 'info' && s.m.includes('still need a person')), JSON.stringify(state.shown.map((s) => s.m)));
  assert.ok(fs.existsSync(path.join(home, '.npm-guard', 'quarantine')), 'a backup was written first');

  // 5. restore: asks first; a file edited after the fix is left alone
  const mine = 'export default [{ rules: { semi: 2 } }];\n';
  fs.writeFileSync(path.join(dirty, 'eslint.config.mjs'), mine);
  state.warn = []; // dismissed
  await run('npmGuard.restore');
  assert.ok(read(dirty, 'package.json').includes('"build": "vite build"'), 'dismissing restore changes nothing');
  state.warn = ['Restore'];
  await run('npmGuard.restore');
  assert.ok(read(dirty, 'package.json').includes('node api.js &&'), 'the original script is back');
  assert.strictEqual(read(dirty, 'eslint.config.mjs'), mine, 'a newer edit is not overwritten');
  assert.ok(state.shown.some((s) => s.kind === 'info' && /left 1 alone/.test(s.m)), JSON.stringify(state.shown.map((s) => s.m)));

  // 6. turn protection on (asks first), then check a husky repo gets the hint and the block
  state.warn = ['Turn on'];
  await run('npmGuard.install');
  assert.ok(fs.existsSync(path.join(home, '.npm-guard', 'cli.js')));
  const hp = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(hp.endsWith('.npm-guard/hooks'), hp);

  const repo = tmp('husky');
  git(repo, 'init', '-q');
  git(repo, 'config', '--local', 'core.hooksPath', '.husky');
  write(repo, '.husky/pre-commit', '#!/bin/sh\necho lint-ok\n');
  state.folders = [repo];
  state.info = ['Protect this repository...'];
  state.warn = ['Add lines', 'Yes, apply'];
  await run('npmGuard.scan');
  await until(() => read(repo, '.husky/pre-commit').includes('# npm-guard (managed)'), 'the repo hook to carry the guard block');
  assert.ok(state.shown.some((s) => s.kind === 'info' && s.m.includes('takes its git hooks from')));
  assert.ok(read(repo, '.husky/pre-commit').includes('echo lint-ok'), "the repo's own hook is kept");
  assert.ok(fs.existsSync(path.join(repo, '.husky/pre-push')));

  state.warn = ['Remove'];
  await run('npmGuard.unprotectRepo');
  assert.strictEqual(read(repo, '.husky/pre-commit'), '#!/bin/sh\necho lint-ok\n');

  // 7. turn it off again: git is back to how it was
  state.warn = ['Turn off'];
  await run('npmGuard.uninstall');
  const after = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(after, '');
  assert.ok(!fs.existsSync(path.join(home, '.npm-guard', 'cli.js')));

  console.log('npm-guard ui: all checks passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
