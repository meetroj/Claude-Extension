#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { applyFix, crossCheck, examine, latestBackup, planFix, planRestore, restore, scanDir, summarize, type Finding } from './core';
import { applyRepo, install, plan, planRepo, status, uninstall, unprotectRepo } from './install';

/**
 * The command the git hooks and Claude Code call, and that a person can run.
 *
 *   npm-guard scan [folder]      look for the loader (exit 1 if found)
 *   npm-guard fix [folder]       change what it can: shows the exact diff, asks twice, backs up first.
 *                                It never deletes a file.
 *   npm-guard restore            put the last backup back (asks first, leaves files you changed since)
 *   npm-guard install | uninstall | status
 *   npm-guard protect-repo [folder]    add the guard to a repo whose own hooks (husky) bypass the machine-wide ones
 *   npm-guard unprotect-repo [folder]  remove exactly that block again
 *   npm-guard hook <name>        called by git (pre-commit, pre-push, post-merge, post-checkout)
 *   npm-guard claude-hook        called by Claude Code before a Bash command
 *
 * Decisions in here:
 *  - A hook BLOCKS on a finding, but FAILS OPEN on its own crash: a broken guard must not stop all work.
 *  - `fix` and `restore` need a person at a keyboard. A script or an AI tool cannot answer their questions.
 */

const home = process.env.NPM_GUARD_HOME ?? homedir();
const guardDir = join(home, '.npm-guard');
const backups = join(guardDir, 'quarantine');
const here = __dirname;

const say = (s = '') => process.stdout.write(`${s}\n`);
const warn = (s = '') => process.stderr.write(`${s}\n`);

function git(args: string[], cwd: string): Buffer | null {
  const r = spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
const names = (b: Buffer | null) => (b ? b.toString('utf8').split('\0').filter(Boolean) : []);
const repoRoot = (cwd: string) => git(['rev-parse', '--show-toplevel'], cwd)?.toString('utf8').trim() || cwd;

function scanIndex(cwd: string, ref: 'staged' | 'head'): Finding[] {
  const tracked = new Set(names(git(['ls-files', '-z'], cwd)));
  const list =
    ref === 'staged'
      ? names(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], cwd))
      : names(git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], cwd));
  const out: Finding[] = [];
  for (const n of list) {
    const blob = git(['show', ref === 'staged' ? `:${n}` : `HEAD:${n}`], cwd);
    if (blob) out.push(...examine(n, blob, (p) => tracked.has(p) || ref === 'head'));
  }
  return crossCheck(out);
}

function stopMessage(findings: Finding[], where: string): string {
  const blocks = findings.filter((f) => f.severity === 'block');
  return [
    '',
    'STOP - npm-guard',
    `A malware loader was found ${where}:`,
    ...blocks.slice(0, 8).map((f) => `  - ${f.file}: ${f.detail}`),
    blocks.length > 8 ? `  ... and ${blocks.length - 8} more` : '',
    '',
    'Do not commit, push or run anything in this folder.',
    'Tell your team lead. Do not delete files yourself.',
    'To fix what it safely can (it shows the exact changes, asks twice and keeps a backup):  npm-guard fix',
    'It never deletes a file: a loader file is left for you to deal with.',
    '',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

/** A scan of the same folder in the last 30 seconds that detected nothing is reused, so an AI session is not slowed down. */
function recentlyScanned(root: string): boolean {
  try {
    const c = JSON.parse(readFileSync(join(guardDir, 'scan-cache.json'), 'utf8')) as { root: string; at: number };
    return c.root === root && Date.now() - c.at < 30_000;
  } catch {
    return false;
  }
}
function markScanned(root: string) {
  try {
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(join(guardDir, 'scan-cache.json'), JSON.stringify({ root, at: Date.now() }));
  } catch {
    /* a cache that cannot be written only costs a rescan */
  }
}
function log(line: string) {
  try {
    mkdirSync(guardDir, { recursive: true });
    appendFileSync(join(guardDir, 'log.txt'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* nowhere to log */
  }
}

/* --------------------------------- commands -------------------------------- */

function cmdHook(name: string): number {
  const cwd = process.cwd();
  if (name === 'pre-commit' || name === 'pre-push') {
    const findings = scanIndex(cwd, name === 'pre-commit' ? 'staged' : 'head');
    const blocks = findings.filter((f) => f.severity === 'block');
    if (blocks.length) {
      warn(stopMessage(findings, name === 'pre-commit' ? 'in what you are about to commit' : 'in what you are about to push'));
      log(`blocked ${name} in ${cwd}: ${blocks.map((b) => b.file).join(', ')}`);
      return 1;
    }
    return 0;
  }
  // post-merge / post-checkout: git cannot refuse these, so it warns loudly
  const root = repoRoot(cwd);
  const blocks = scanDir(root).filter((f) => f.severity === 'block');
  if (blocks.length) {
    warn(stopMessage(blocks, 'in the code you just pulled or switched to'));
    log(`warned ${name} in ${root}: ${blocks.map((b) => b.file).join(', ')}`);
  }
  return 0;
}

const RISKY = /(^|[\s;&|(])(git\s+(commit|push|add\s+(-A|\.|--all))|npm\s+(run|start|test|install|i|ci|build)|npx|node|yarn|pnpm|bun)\b/;

function cmdClaudeHook(): number {
  let input: { tool_input?: { command?: string }; cwd?: string } = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  const command = input.tool_input?.command ?? '';
  if (!RISKY.test(command)) return 0;
  const root = repoRoot(input.cwd ?? process.cwd());
  if (recentlyScanned(root)) return 0;
  const blocks = scanDir(root).filter((f) => f.severity === 'block');
  if (blocks.length) {
    warn(stopMessage(blocks, 'in this project'));
    warn('This command was stopped. Tell the user what was found, and do not retry it.');
    log(`claude-hook stopped "${command.slice(0, 80)}" in ${root}`);
    return 2; // Claude Code: exit 2 refuses the command and shows stderr to the model
  }
  markScanned(root);
  return 0;
}

function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => (rl.close(), r(a.trim().toLowerCase()))));
}
const yes = (a: string) => a === 'y' || a === 'yes';

async function cmdFix(folder: string): Promise<number> {
  if (!process.stdin.isTTY) {
    warn('npm-guard fix needs a person at a keyboard: it asks you to confirm, and a script or an AI tool cannot.');
    return 1;
  }
  const root = resolve(folder);
  const findings = scanDir(root);
  const { steps, manual } = planFix(root, findings);
  if (!steps.length && !manual.length) {
    say('No threats detected by the current rules.');
    return 0;
  }
  say(`\nFound ${steps.length} change(s) it can make in ${root}. Nothing is deleted. This is exactly what would change:\n`);
  steps.forEach((s, i) => {
    say(`  ${i + 1}. ${s.summary}`);
    s.diff.forEach((l) => say(`       ${l}`));
    say(`       git: ${s.git}`);
  });
  if (manual.length) {
    say('\nThese need a person to look. npm-guard never deletes a file and will not guess where malicious code ends:');
    summarize(manual).forEach((l) => say(`  ${l}`));
  }
  if (!steps.length) return 1;
  say(`\nA backup of every file is saved to ${backups} first.`);
  say('Git only brings back what was committed. For uncommitted edits and untracked files, that backup is the only copy.');
  say('A file that changes between this preview and the apply is left alone.\n');
  if (!yes(await ask('Make these changes now? (yes / no) [no]: '))) {
    say('Nothing was changed.');
    return 0;
  }
  if (!yes(await ask(`Last check: change ${steps.length} file(s) in ${root}? (yes / no) [no]: `))) {
    say('Nothing was changed.');
    return 0;
  }
  const res = applyFix(root, steps, backups);
  res.applied.forEach((l) => say(`  done    ${l}`));
  res.failed.forEach((l) => say(`  SKIPPED ${l}`));
  say(
    res.remaining.length
      ? `\nScanned again: ${res.remaining.length} problem(s) still detected. Ask someone to look.`
      : '\nScanned again: no threats detected by the current rules.',
  );
  if (res.applied.length) say(`To undo this:  npm-guard restore   (backup: ${res.dir})`);
  return res.remaining.length || res.failed.length ? 1 : 0;
}

async function cmdProtectRepo(folder: string): Promise<number> {
  if (!process.stdin.isTTY) {
    warn('npm-guard protect-repo needs a person at a keyboard: it edits this repository\'s own git hooks, and a script or an AI tool cannot confirm that.');
    return 1;
  }
  const root = resolve(folder);
  const o = { home, sourceDir: here };
  const p = planRepo(root, o);
  if (p.covered === 'machine') {
    say('Already covered: git uses the guard\'s own hooks in this repository.');
    return 0;
  }
  if (p.covered === 'repo') {
    say('Already protected: this repository\'s own hooks carry the guard block.');
    return 0;
  }
  say(`\nThis repository takes its git hooks from ${p.dir}, so the machine-wide guard hooks do not run here.`);
  say('These lines would be added (nothing else is changed):\n');
  p.steps.forEach((s) => {
    say(`  ${s.file}${s.before === null ? '  (new file)' : ''}`);
    s.added.forEach((l) => say(`    + ${l}`));
  });
  say('\nThe block does nothing on a machine without ~/.npm-guard/cli.js, so teammates are not blocked by it.');
  if (!yes(await ask('\nAdd these lines now? (yes / no) [no]: '))) {
    say('Nothing was changed.');
    return 0;
  }
  if (!yes(await ask(`Last check: edit ${p.steps.length} hook file(s) in ${p.dir}? (yes / no) [no]: `))) {
    say('Nothing was changed.');
    return 0;
  }
  const r = applyRepo(p.steps);
  r.applied.forEach((f) => say(`  done    ${f}`));
  r.failed.forEach((f) => say(`  SKIPPED ${f}`));
  say('Undo any time with:  npm-guard unprotect-repo');
  return r.failed.length ? 1 : 0;
}

async function cmdUnprotectRepo(folder: string): Promise<number> {
  if (!process.stdin.isTTY) {
    warn('npm-guard unprotect-repo needs a person at a keyboard.');
    return 1;
  }
  const done = unprotectRepo(resolve(folder), { home, sourceDir: here });
  if (!done.length) say('Nothing to remove: no guard block found in this repository\'s hooks.');
  done.forEach((f) => say(`  removed the guard block from ${f}`));
  return 0;
}

async function cmdRestore(): Promise<number> {
  if (!process.stdin.isTTY) {
    warn('npm-guard restore needs a person at a keyboard: it puts the original files back, and a script or an AI tool cannot confirm that.');
    return 1;
  }
  const b = latestBackup(backups);
  if (!b) {
    say('There is no backup to restore.');
    return 1;
  }
  const plan = planRestore(b);
  if (plan.skipped.length) {
    say('Left alone, because they were changed after the fix:');
    plan.skipped.forEach((f) => say(`  ${f}`));
  }
  if (!plan.files.length) {
    say('Nothing to put back.');
    return 1;
  }
  say(`\nThis puts back the ORIGINAL version of ${plan.files.length} file(s) in ${plan.root}, including the part that was removed:`);
  plan.files.forEach((f) => say(`  ${f}`));
  if (!yes(await ask('\nRestore these now? (yes / no) [no]: '))) {
    say('Nothing was changed.');
    return 0;
  }
  const res = restore(b); // checks every file again at the moment of writing
  res.restored.forEach((f) => say(`  restored ${f}`));
  res.skipped.forEach((f) => say(`  left alone ${f} (changed since the fix)`));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  const opts = { home, sourceDir: here };
  switch (cmd) {
    case 'scan': {
      const root = resolve(arg ?? '.');
      const findings = scanDir(root);
      summarize(findings).forEach((l) => say(l));
      const bad = findings.filter((f) => f.severity === 'block').length;
      say(bad ? `\n${bad} problem(s).` : 'No threats detected by the current rules.');
      return bad ? 1 : 0;
    }
    case 'fix':
      return cmdFix(arg ?? '.');
    case 'restore':
      return cmdRestore();
    case 'protect-repo':
      return cmdProtectRepo(arg ?? '.');
    case 'unprotect-repo':
      return cmdUnprotectRepo(arg ?? '.');
    case 'hook':
      return cmdHook(arg ?? '');
    case 'claude-hook':
      return cmdClaudeHook();
    case 'install': {
      say('This will:');
      plan(opts).forEach((l) => say(`  - ${l}`));
      if (process.stdin.isTTY && !yes(await ask('\nGo ahead? (yes / no) [no]: '))) return 0;
      if (!process.stdin.isTTY && argv[1] !== '--yes') {
        warn('Run this at a keyboard, or pass --yes.');
        return 1;
      }
      const r = install(opts);
      r.notes.forEach((n) => say(`  note: ${n}`));
      say('Installed. Undo any time with:  npm-guard uninstall');
      return 0;
    }
    case 'uninstall':
      uninstall(opts).forEach((l) => say(`  ${l}`));
      return 0;
    case 'status':
      status(opts).forEach((l) => say(l));
      return 0;
    default:
      say('usage: npm-guard scan|fix|restore|install|uninstall|status|protect-repo|unprotect-repo');
      return cmd ? 3 : 0;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      // fail open: a broken guard must not stop the work (a finding does, a crash does not)
      log(`crashed: ${(e as Error).message}`);
      process.exit(0);
    },
  );
}
