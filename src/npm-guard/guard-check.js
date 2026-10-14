// The npm-guard scanner, its fix, and its install - the parts that must not lie quietly.
// Run: npm test   (reads ./out, so it compiles first)
//
// Every sample is built from fragments: nothing in this repository is itself the malware, and this
// file does not trip its own scanner or an antivirus.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../../out/npm-guard/core');
const inst = require('../../out/npm-guard/install');
const CLI = path.join(__dirname, '..', '..', 'out', 'npm-guard', 'cli.js');
const SRC = path.join(__dirname, '..', '..', 'out', 'npm-guard');

const PAD = ' '.repeat(220);
const marker = `global.i = '${'A10'}-*0000-00';`;
const b64 = (s) => Buffer.from(s).toString('base64');
const rules = (fs_) => fs_.map((f) => `${f.rule}:${f.severity}`).sort();
const find = (p, text, has) => core.crossCheck(core.examine(p, Buffer.from(text), has));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `npm-guard-${name}-`));
const write = (root, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
const obfuscated = Array.from({ length: 30 }, (_, i) => `var _0x${(0xa000 + i).toString(16)}=${i};`).join('\n');
const infected = () => {
  const d = tmp('tree');
  write(d, 'src/ok.ts', 'export const ok = true;\n');
  write(d, 'package.json', JSON.stringify({ scripts: { build: 'node api.js && vite build', test: 'vitest' } }, null, 2));
  write(d, 'eslint.config.mjs', `export default [{ rules: {} }];\n;${PAD}${marker}${'y'.repeat(1200)}\n`);
  write(d, 'api.js', obfuscated);
  return d;
};

// --- what it finds ----------------------------------------------------------
assert.deepStrictEqual(rules(find('src/a.ts', `export const a = 1;\n${marker}\n`)), ['marker:block']);

assert.ok(rules(find('eslint.config.mjs', `export default [];\n};${PAD}${'x'.repeat(1500)}\n`)).includes('hidden-tail:block'));

// the marker can change between waves; the SHAPE is what gives it away
assert.deepStrictEqual(rules(find('vite.config.js', `export default {};${PAD}const q=${JSON.stringify('z'.repeat(1400))};\n`)), ['hidden-tail:block']);

assert.deepStrictEqual(rules(find('api.js', obfuscated)), ['obfuscated:block']);

{
  const code = "global.r=require;const {spawn}=require('child_process');".repeat(6);
  const chunks = b64(code).match(/.{1,60}/g).map((c) => `"${c}"`);
  assert.ok(rules(find('tools/x.js', `var p=[${chunks.join(',')}];\n`)).includes('encoded:block'));
}

// built from pieces, like the markers in core.ts: this file must not match its own scanner
assert.deepStrictEqual(
  rules(find('lib/boot.js', `const {spawn}=require('child_process');fetch('https://eth.${'block' + 'scout'}.com/api');`)),
  ['chain-c2:block'],
);

assert.ok(rules(core.examine('public/fonts/fa-solid-700.otf', Buffer.from(`${marker} const r = require;`))).includes('fake-binary:block'));
assert.deepStrictEqual(core.examine('public/fonts/real.otf', Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(300), Buffer.from('glyphs')])), []);

{
  const pkg = JSON.stringify({ scripts: { build: 'node api.js && react-scripts build' } });
  assert.deepStrictEqual(rules(find('package.json', pkg, () => false)), ['script:warn']);
  const both = core.crossCheck([...core.examine('package.json', Buffer.from(pkg), () => true), { file: 'api.js', rule: 'obfuscated', severity: 'block', detail: '' }]);
  assert.ok(both.filter((f) => f.rule === 'script').every((f) => f.severity === 'block'));
}

// --- and what it must leave alone ---------------------------------------------
assert.deepStrictEqual(find('src/app.tsx', 'export const App = () => <div />;\n'), []);
assert.deepStrictEqual(find('tsconfig.json', '{"compilerOptions":{"strict":true}}'), []);
assert.deepStrictEqual(find('package.json', JSON.stringify({ scripts: { build: 'node scripts/gen.js && vite build' } }), (p) => p === 'scripts/gen.js'), []);
assert.deepStrictEqual(core.examine('vendor/lib.min.js', Buffer.from(`a${PAD}${'x'.repeat(5000)}`)), []);
assert.deepStrictEqual(find('src/data.ts', `export const d = [${'1,'.repeat(2000)}];\n`), []); // long, but no hidden tail
{
  const png = b64(Buffer.alloc(900, 7).toString('latin1')).match(/.{1,60}/g).map((c) => `"${c}"`);
  assert.deepStrictEqual(find('src/icons.ts', `export const i=[${png.join(',')}];\n`), []); // inlined image is not code
}

// --- the fix: it trims at an exact boundary, shows exactly what, and never deletes ---
{
  const d = infected();
  const found = core.scanDir(d);
  assert.ok(found.some((f) => f.file === 'api.js'));
  assert.ok(found.some((f) => f.file === 'eslint.config.mjs'));
  assert.ok(found.some((f) => f.file === 'package.json' && f.rule === 'script' && f.severity === 'block'));

  const { steps, manual } = core.planFix(d, found);
  // api.js has no exact boundary (obfuscated, no marker): a person decides. It is not deleted.
  assert.deepStrictEqual(steps.map((s) => `${s.file}:${s.kind}`).sort(), ['eslint.config.mjs:cut', 'package.json:script']);
  assert.ok(manual.some((f) => f.file === 'api.js'));
  assert.ok(steps.every((s) => s.before && typeof s.after === 'string' && s.diff.length > 1 && s.git));
  assert.ok(steps.find((s) => s.file === 'eslint.config.mjs').diff.join('\n').includes('removed'));
  // planning changes nothing
  assert.ok(fs.readFileSync(path.join(d, 'package.json'), 'utf8').includes('node api.js &&'));

  const back = tmp('backup');
  const res = core.applyFix(d, steps, back);
  assert.deepStrictEqual(res.failed, []);
  // what was written is exactly what was previewed
  for (const s of steps) assert.strictEqual(fs.readFileSync(path.join(d, s.file), 'utf8'), s.after);
  assert.ok(fs.existsSync(path.join(d, 'api.js'))); // never deleted
  const eslint = fs.readFileSync(path.join(d, 'eslint.config.mjs'), 'utf8');
  assert.ok(eslint.startsWith('export default [{ rules: {} }];'));
  assert.ok(!eslint.includes('A10'));
  const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.build, 'vite build');
  assert.strictEqual(pkg.scripts.test, 'vitest');
  assert.strictEqual(fs.readFileSync(path.join(d, 'src/ok.ts'), 'utf8'), 'export const ok = true;\n'); // untouched
  // the rescan is part of fix, and it does not pretend: the loader file is still reported
  assert.deepStrictEqual(res.remaining.map((f) => f.file), ['api.js']);

  // undo asks first (planRestore), then puts both back
  const latest = core.latestBackup(back);
  const p = core.planRestore(latest);
  assert.deepStrictEqual([...p.files].sort(), ['eslint.config.mjs', 'package.json']);
  assert.deepStrictEqual(p.skipped, []);
  assert.strictEqual(core.restore(latest).restored.length, 2);
  assert.ok(core.scanDir(d).some((f) => f.file === 'eslint.config.mjs'));
}

// a file that changes between the preview and the apply is left alone; the others still go through
{
  const d = infected();
  const { steps } = core.planFix(d, core.scanDir(d));
  const file = path.join(d, 'eslint.config.mjs');
  const edited = `${fs.readFileSync(file, 'utf8')}// my own edit\n`;
  fs.writeFileSync(file, edited);
  const res = core.applyFix(d, steps, tmp('backup'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), edited);
  assert.ok(res.failed.some((l) => l.startsWith('eslint.config.mjs') && l.includes('changed after the preview')));
  assert.ok(res.applied.some((l) => l.startsWith('package.json')));
}

// restore never overwrites what you changed after the fix
{
  const d = infected();
  const back = tmp('backup');
  core.applyFix(d, core.planFix(d, core.scanDir(d)).steps, back);
  const file = path.join(d, 'eslint.config.mjs');
  const mine = 'export default [{ rules: { semi: 2 } }];\n';
  fs.writeFileSync(file, mine);
  const latest = core.latestBackup(back);
  assert.deepStrictEqual(core.planRestore(latest).skipped, ['eslint.config.mjs']);
  assert.deepStrictEqual(core.restore(latest).skipped, ['eslint.config.mjs']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), mine);
}

// --- nothing is deleted or changed because of a NAME, or on weak evidence ---------------
{
  // a real api.js, and a script that runs it: reported, not touched
  const d = tmp('benign-api');
  write(d, 'api.js', 'export const get = () => fetch("/health");\n');
  write(d, 'package.json', JSON.stringify({ scripts: { build: 'node api.js && vite build' } }, null, 2));
  const found = core.scanDir(d);
  assert.deepStrictEqual(rules(found), ['script:warn']);
  const { steps, manual } = core.planFix(d, found);
  assert.deepStrictEqual(steps, []);
  assert.strictEqual(manual.length, 1);
}
{
  // 20+ obfuscator-style identifiers alone: blocked, but there is no boundary, so nothing is changed
  const d = tmp('obf');
  write(d, 'vendor-licence.js', obfuscated);
  const found = core.scanDir(d);
  assert.ok(found.some((f) => f.rule === 'obfuscated'));
  assert.deepStrictEqual(core.planFix(d, found).steps, []);
  assert.strictEqual(fs.readFileSync(path.join(d, 'vendor-licence.js'), 'utf8'), obfuscated);
}
{
  // a file that is nothing but the loader: cutting would leave an empty file, and it never deletes
  const d = tmp('whole');
  write(d, 'api.js', `${marker}\n`);
  const found = core.scanDir(d);
  assert.ok(found.some((f) => f.file === 'api.js' && f.rule === 'marker'));
  const { steps, manual } = core.planFix(d, found);
  assert.deepStrictEqual(steps, []);
  assert.ok(manual.some((f) => f.file === 'api.js'));
  assert.strictEqual(fs.readFileSync(path.join(d, 'api.js'), 'utf8'), `${marker}\n`);
}
{
  // an address from the campaign is reported, but it is never a place to cut
  const d = tmp('ip');
  const text = `export const bad = ['${'193.247.' + '144.38'}', 'x'];\n`;
  write(d, 'blocklist.js', text);
  const found = core.scanDir(d);
  assert.ok(found.some((f) => f.rule === 'marker'));
  assert.deepStrictEqual(core.planFix(d, found).steps, []);
  assert.strictEqual(fs.readFileSync(path.join(d, 'blocklist.js'), 'utf8'), text);
}
{
  // a fake font is never deleted by name or extension either
  const d = tmp('font');
  write(d, 'public/fonts/fa.otf', `${marker} const r = require;`);
  const found = core.scanDir(d);
  assert.ok(found.some((f) => f.rule === 'fake-binary'));
  assert.deepStrictEqual(core.planFix(d, found).steps, []);
  assert.ok(fs.existsSync(path.join(d, 'public/fonts/fa.otf')));
}

// it will not guess: a script that runs a file it cannot account for is reported, not changed
{
  const d = tmp('manual');
  write(d, 'package.json', JSON.stringify({ scripts: { build: 'node prebuild.js && vite build' } }));
  const found = core.scanDir(d);
  const { steps, manual } = core.planFix(d, found);
  assert.deepStrictEqual(steps, []);
  assert.strictEqual(manual.length, 1);
}

// installing adds no package: no runtime dependency, no install script
{
  const pkg = require('../../package.json');
  assert.strictEqual(Object.keys(pkg.dependencies ?? {}).length, 0);
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) assert.strictEqual(pkg.scripts[k], undefined, k);
}

// --- the guard's own repository is not flagged by the guard -------------------------
{
  const self = core.scanDir(path.join(__dirname, '..', '..')).filter((f) => f.severity === 'block');
  assert.deepStrictEqual(self, []);
}

// --- VS Code's own startup file -------------------------------------------------
{
  const app = tmp('app');
  write(app, 'out/main.js', '/*!--------------------\n * Copyright (c) Microsoft\n */\nconsole.log(1);\n');
  assert.deepStrictEqual(core.checkEditor(app), []);
  const patched = ['__' + 'inzCR', '__' + 'inzV', 'main.' + 'inz.cjs'];
  write(app, 'out/main.js', `import{createRequire as ${patched[0]}}from'module';const ${patched[1]}="x";/*!--*/\n`);
  write(app, `out/${patched[2]}`, '//');
  assert.ok(core.checkEditor(app).some((f) => f.rule === 'editor-patched' && f.severity === 'block'));
}

// --- install puts hooks in place, and uninstall puts everything back exactly ----
{
  const home = tmp('home');
  const gitEnv = { GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') };
  const o = { home, sourceDir: SRC, gitEnv };
  const original = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  write(home, '.claude/settings.json', `${JSON.stringify(original, null, 2)}\n`);

  assert.ok(inst.plan(o).length >= 3);
  const r = inst.install(o);
  assert.deepStrictEqual(r.notes, []);
  assert.ok(inst.plan(o).some((l) => l.includes('Install no npm package')));
  assert.deepStrictEqual(fs.readdirSync(path.join(home, '.npm-guard')).sort(), ['cli.js', 'core.js', 'hooks', 'install.js', 'state.json']);
  for (const h of inst.HOOKS) assert.ok(fs.existsSync(path.join(home, '.npm-guard', 'hooks', h)), h);
  assert.ok(fs.existsSync(path.join(home, '.npm-guard', 'cli.js')));
  const set = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(set.model, 'opus'); // the user's own settings survive
  assert.strictEqual(set.hooks.PreToolUse.length, 2);
  assert.ok(set.hooks.PreToolUse[0].hooks[0].command === 'echo mine');
  assert.ok(inst.status(o).join('\n').includes('Git hooks: on'));
  inst.install(o); // twice is the same as once
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length, 2);

  inst.uninstall(o);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')), original);
  assert.ok(!fs.existsSync(path.join(home, '.npm-guard', 'cli.js')));
  assert.ok(inst.status(o)[0].includes('not installed'));
}

// settings you change AFTER installing survive uninstall: it removes its own entry and restores nothing
{
  const home = tmp('home3');
  const gitEnv = { GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') };
  const o = { home, sourceDir: SRC, gitEnv };
  const file = path.join(home, '.claude', 'settings.json');
  write(home, '.claude/settings.json', `${JSON.stringify({ model: 'opus' }, null, 2)}
`);
  inst.install(o);
  const later = JSON.parse(fs.readFileSync(file, 'utf8'));
  later.theme = 'dark';
  later.hooks.PreToolUse.push({ matcher: 'Write', hooks: [{ type: 'command', command: 'echo later' }] });
  later.hooks.PostToolUse = [{ matcher: '*', hooks: [{ type: 'command', command: 'echo post' }] }];
  fs.writeFileSync(file, JSON.stringify(later, null, 2));
  inst.uninstall(o);
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(now.model, 'opus');
  assert.strictEqual(now.theme, 'dark');
  assert.deepStrictEqual(now.hooks.PreToolUse.map((e) => e.matcher), ['Write']);
  assert.ok(now.hooks.PostToolUse);
}

// a git setup that already has its own global hooks is left alone, and said so
{
  const home = tmp('home2');
  const gitEnv = { GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') };
  spawnSync('git', ['config', '--global', 'core.hooksPath', '/somewhere/else'], { env: { ...process.env, ...gitEnv } });
  const r = inst.install({ home, sourceDir: SRC, gitEnv });
  assert.ok(r.notes.join(' ').includes('did not replace'));
  const now = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
  assert.strictEqual(now.stdout.trim(), '/somewhere/else');
}

// --- what git can and cannot bring back, said per file -----------------------------
{
  const repo = tmp('gitnote');
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  write(repo, 'kept.js', 'a\n');
  g('add', '-A');
  g('commit', '-q', '--no-verify', '-m', 'x');
  assert.ok(core.gitNote(repo, 'kept.js').includes('git can bring it back too'));
  write(repo, 'kept.js', 'a\nedited\n');
  assert.ok(core.gitNote(repo, 'kept.js').includes('uncommitted changes'));
  write(repo, 'new.js', 'b\n');
  assert.ok(core.gitNote(repo, 'new.js').includes('git cannot bring it back'));
  assert.ok(core.gitNote(tmp('nogit'), 'x.js').includes('not in a git repository'));
  // and every step the fix would take carries one
  const d = infected();
  assert.ok(core.planFix(d, core.scanDir(d)).steps.every((s) => typeof s.git === 'string' && s.git.length > 0));
}

// --- real `git commit` runs: the machine-wide hooks, and a repo whose own hooks bypass them ---
{
  const home = tmp('home-e2e');
  const gitEnv = { GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), HOME: home, USERPROFILE: home };
  const o = { home, sourceDir: SRC, gitEnv };
  inst.install(o);
  const env = { ...process.env, ...gitEnv };
  const mk = (name) => {
    const repo = tmp(name);
    const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8', env });
    g('init', '-q');
    return { repo, g };
  };

  // 1. a plain repo is covered by the machine-wide hooks: an infected commit is refused, a clean one is not
  {
    const { repo, g } = mk('plain');
    assert.strictEqual(inst.repoState(repo, o).covered, 'machine');
    write(repo, 'bad.js', obfuscated);
    g('add', '-A');
    const refused = g('commit', '-q', '-m', 'x');
    assert.notStrictEqual(refused.status, 0);
    assert.ok(refused.stderr.includes('STOP - npm-guard'), refused.stderr);
    g('reset', '-q');
    fs.rmSync(path.join(repo, 'bad.js'));
    write(repo, 'ok.js', 'console.log(1);\n');
    g('add', '-A');
    assert.strictEqual(g('commit', '-q', '-m', 'x').status, 0);
  }

  // 2. a repo with its own hooks folder (husky) is NOT covered: that is the gap
  {
    const { repo, g } = mk('husky');
    g('config', '--local', 'core.hooksPath', '.husky');
    const original = '#!/bin/sh\necho lint-ok\n';
    write(repo, '.husky/pre-commit', original);
    assert.strictEqual(inst.repoState(repo, o).covered, 'none');
    write(repo, 'bad.js', obfuscated);
    g('add', '-A');
    assert.strictEqual(g('commit', '-q', '-m', 'gap').status, 0, 'without protect-repo the infected commit goes through');

    // protect-repo: previewed, exact, and it keeps the repo's own hook
    const p = inst.planRepo(repo, o);
    assert.deepStrictEqual(p.steps.map((s) => path.basename(s.file)).sort(), ['pre-commit', 'pre-push']);
    assert.strictEqual(p.steps.find((s) => s.file.endsWith('pre-push')).before, null);
    assert.ok(p.steps.every((s) => s.added.length === 5));
    assert.deepStrictEqual(inst.applyRepo(p.steps).failed, []);
    assert.strictEqual(inst.repoState(repo, o).covered, 'repo');
    assert.deepStrictEqual(inst.planRepo(repo, o).steps, []); // twice is the same as once

    write(repo, 'bad2.js', obfuscated);
    g('add', '-A');
    const refused = g('commit', '-q', '-m', 'x');
    assert.notStrictEqual(refused.status, 0);
    assert.ok(refused.stderr.includes('STOP - npm-guard'), refused.stderr);
    g('reset', '-q');
    fs.rmSync(path.join(repo, 'bad2.js'));
    write(repo, 'ok.js', 'console.log(1);\n');
    g('add', '-A');
    const clean = g('commit', '-m', 'x');
    assert.strictEqual(clean.status, 0);
    assert.ok(`${clean.stdout}${clean.stderr}`.includes('lint-ok'), 'the repo\'s own hook still runs');

    // and it comes out exactly
    assert.strictEqual(inst.unprotectRepo(repo, o).length, 2);
    assert.strictEqual(fs.readFileSync(path.join(repo, '.husky/pre-commit'), 'utf8'), original);
    assert.strictEqual(inst.repoState(repo, o).covered, 'none');
  }

  // 3. where the block goes: after husky 8's own helper line, and husky 9's generated folder is not edited
  {
    const { repo, g } = mk('husky8');
    g('config', '--local', 'core.hooksPath', '.husky');
    write(repo, '.husky/pre-commit', '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\nnpx lint-staged\n');
    const lines = inst.planRepo(repo, o).steps.find((s) => s.file.endsWith('pre-commit')).after.split('\n');
    assert.strictEqual(lines[1].includes('husky.sh'), true);
    assert.strictEqual(lines[2], '# npm-guard (managed)');
    assert.strictEqual(lines[lines.indexOf('# end npm-guard') + 2], 'npx lint-staged');

    g('config', '--local', 'core.hooksPath', '.husky/_');
    assert.strictEqual(path.basename(inst.planRepo(repo, o).dir), '.husky');
  }

  // 4. a hook file that changed between the preview and the apply is left alone
  {
    const { repo, g } = mk('husky-race');
    g('config', '--local', 'core.hooksPath', '.husky');
    write(repo, '.husky/pre-commit', '#!/bin/sh\necho a\n');
    const p = inst.planRepo(repo, o);
    write(repo, '.husky/pre-commit', '#!/bin/sh\necho changed\n');
    const r = inst.applyRepo(p.steps);
    assert.ok(r.failed.some((l) => l.includes('pre-commit')));
    assert.strictEqual(fs.readFileSync(path.join(repo, '.husky/pre-commit'), 'utf8'), '#!/bin/sh\necho changed\n');
  }
}

// --- the command line the hooks and Claude Code call ------------------------------
{
  const run = (args, cwd, input) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, NPM_GUARD_HOME: tmp('cli-home') } });
  const dirty = infected();
  const clean = tmp('clean');
  write(clean, 'index.js', 'console.log(1);\n');

  assert.strictEqual(run(['scan', dirty], dirty).status, 1);
  assert.strictEqual(run(['scan', clean], clean).status, 0);
  // it never claims more than the rules can show
  const said = run(['scan', clean], clean).stdout;
  assert.ok(said.includes('No threats detected by the current rules.'));
  assert.ok(!/\b(clean|safe)\b/i.test(said));

  // Claude Code: a risky command in an infected folder is refused with exit 2; a harmless one is not
  const hook = (cwd, command) => run(['claude-hook'], cwd, JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  const stopped = hook(dirty, 'npm start');
  assert.strictEqual(stopped.status, 2);
  assert.ok(stopped.stderr.includes('STOP - npm-guard'));
  assert.strictEqual(hook(dirty, 'ls -la').status, 0);
  assert.strictEqual(hook(clean, 'npm start').status, 0);
  assert.strictEqual(run(['claude-hook'], clean, 'not json').status, 0); // fails open

  // `fix` needs a person: with no keyboard it refuses and changes nothing
  const refused = run(['fix', dirty], dirty, '');
  assert.strictEqual(refused.status, 1);
  assert.ok(fs.existsSync(path.join(dirty, 'api.js')));
  const noRestore = run(['restore'], dirty, '');
  assert.strictEqual(noRestore.status, 1);
  assert.ok(noRestore.stderr.includes('needs a person at a keyboard'));
}

// --- git hooks: a commit of the loader is refused, a clean one is not -------------
{
  const repo = tmp('repo');
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  write(repo, 'a.js', 'console.log(1);\n');
  g('add', '-A');
  assert.strictEqual(spawnSync(process.execPath, [CLI, 'hook', 'pre-commit'], { cwd: repo }).status, 0);
  write(repo, 'api.js', obfuscated);
  g('add', '-A');
  const blocked = spawnSync(process.execPath, [CLI, 'hook', 'pre-commit'], { cwd: repo, encoding: 'utf8', env: { ...process.env, NPM_GUARD_HOME: tmp('h') } });
  assert.strictEqual(blocked.status, 1);
  assert.ok(blocked.stderr.includes('api.js'));
}

console.log('npm-guard: all checks passed');
