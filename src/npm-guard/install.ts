import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Put the guard on a machine, and take it off again exactly.
 *
 * Installing copies the tool to ~/.npm-guard/ (so a hook never depends on the extension's folder,
 * which changes with every version, or on the network), points git at its hooks, and adds one
 * entry to Claude Code's settings. Everything it changes is written to state.json so `uninstall`
 * reverses precisely that and nothing else.
 */

export const HOOKS = ['pre-commit', 'pre-push', 'post-merge', 'post-checkout'] as const;
const FILES = ['core.js', 'cli.js', 'install.js'];
const MARK = '.npm-guard';
const BAK = '.npm-guard.bak';

export type Options = {
  /** The user's home folder. Tests pass a temporary one. */
  home: string;
  /** The folder holding the compiled core.js, cli.js and install.js. */
  sourceDir: string;
  /** Extra environment for git, so a test never touches the real global config. */
  gitEnv?: NodeJS.ProcessEnv;
};

type State = {
  installedAt: string;
  hooksPath: 'set' | 'already' | 'kept-existing';
  previousHooksPath: string | null;
  claude: 'added' | 'present' | 'skipped';
  claudeBackup: string | null;
};

const dirOf = (home: string) => join(home, '.npm-guard');
const fwd = (p: string) => p.replace(/\\/g, '/');
const statePath = (home: string) => join(dirOf(home), 'state.json');
const claudePath = (home: string) => join(home, '.claude', 'settings.json');

function git(o: Options, args: string[]) {
  const r = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, ...o.gitEnv } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

function hookScript(name: string): string {
  // Fails open: a missing node or a crashed guard never stops your work. A FINDING does.
  return [
    '#!/bin/sh',
    '# npm-guard (managed): scans, then runs the repository\'s own hook if it has one.',
    'command -v node >/dev/null 2>&1 || exit 0',
    `node "$HOME/.npm-guard/cli.js" hook ${name} || exit $?`,
    'gd="$(git rev-parse --git-dir 2>/dev/null)"',
    `[ -n "$gd" ] && [ -x "$gd/hooks/${name}" ] && exec "$gd/hooks/${name}" "$@"`,
    'exit 0',
    '',
  ].join('\n');
}

function readClaude(home: string): { json: Record<string, unknown> | null; existed: boolean } {
  const p = claudePath(home);
  if (!existsSync(p)) return { json: {}, existed: false };
  try {
    return { json: JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>, existed: true };
  } catch {
    return { json: null, existed: true };
  }
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
const isOurs = (e: HookEntry) => (e.hooks ?? []).some((h) => (h.command ?? '').includes(MARK));

/** Plain-language list of what installing will change, for the confirmation. */
export function plan(o: Options): string[] {
  const lines = [
    `Copy the guard to ${fwd(dirOf(o.home))}`,
    `Point git at its hooks (commit, push, pull, branch switch) for every repository on this machine`,
    `Add one hook to ${fwd(claudePath(o.home))} so Claude Code checks a folder before it commits, pushes or runs it`,
  ];
  const cur = git(o, ['config', '--global', '--get', 'core.hooksPath']);
  if (cur.ok && cur.out && fwd(cur.out) !== fwd(join(dirOf(o.home), 'hooks'))) {
    lines[1] = `Git already uses hooks from ${cur.out}: the guard will leave that alone`;
  }
  if (existsSync(claudePath(o.home))) {
    lines.push(`Save a copy of that file first, next to it, as settings.json${BAK}`);
  }
  lines.push('Install no npm package and download nothing: the guard is the files it copies, and it uses only Node and git');
  return lines;
}

export function install(o: Options): { notes: string[] } {
  const notes: string[] = [];
  const dir = dirOf(o.home);
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  for (const f of FILES) copyFileSync(join(o.sourceDir, f), join(dir, f));
  for (const h of HOOKS) {
    const p = join(dir, 'hooks', h);
    writeFileSync(p, hookScript(h), { mode: 0o755 });
    try {
      chmodSync(p, 0o755);
    } catch {
      /* Windows has no execute bit; Git for Windows runs hooks through sh anyway */
    }
  }

  const ours = fwd(join(dir, 'hooks'));
  const cur = git(o, ['config', '--global', '--get', 'core.hooksPath']);
  const state: State = {
    installedAt: new Date().toISOString(),
    hooksPath: 'set',
    previousHooksPath: null,
    claude: 'skipped',
    claudeBackup: null,
  };
  if (cur.ok && cur.out && fwd(cur.out) === ours) {
    state.hooksPath = 'already';
  } else if (cur.ok && cur.out) {
    state.hooksPath = 'kept-existing';
    notes.push(`Git already uses hooks from ${cur.out}. The guard did not replace them.`);
  } else if (git(o, ['config', '--global', 'core.hooksPath', ours]).ok) {
    state.hooksPath = 'set';
  } else {
    notes.push('Could not set the git hooks path.');
  }

  const { json, existed } = readClaude(o.home);
  if (json === null) {
    notes.push('Claude Code settings could not be read, so that hook was not added.');
  } else {
    const hooks = (json.hooks ??= {}) as { PreToolUse?: HookEntry[] };
    const list = (hooks.PreToolUse ??= []);
    if (list.some(isOurs)) {
      state.claude = 'present';
    } else {
      if (existed) {
        state.claudeBackup = `${claudePath(o.home)}${BAK}`;
        copyFileSync(claudePath(o.home), state.claudeBackup);
      }
      list.push({ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `node "${fwd(join(dir, 'cli.js'))}" claude-hook` }] });
      mkdirSync(join(o.home, '.claude'), { recursive: true });
      writeFileSync(claudePath(o.home), `${JSON.stringify(json, null, 2)}\n`);
      state.claude = 'added';
    }
  }
  writeFileSync(statePath(o.home), JSON.stringify(state, null, 2));
  return { notes };
}

/** Reverse exactly what `install` recorded. Backups of removed files are kept. */
export function uninstall(o: Options): string[] {
  const done: string[] = [];
  const dir = dirOf(o.home);
  const ours = fwd(join(dir, 'hooks'));
  const cur = git(o, ['config', '--global', '--get', 'core.hooksPath']);
  if (cur.ok && fwd(cur.out) === ours) {
    git(o, ['config', '--global', '--unset', 'core.hooksPath']);
    done.push('Git no longer uses the guard\'s hooks');
  }
  const { json } = readClaude(o.home);
  if (json && typeof json.hooks === 'object' && json.hooks) {
    const hooks = json.hooks as { PreToolUse?: HookEntry[] };
    if (Array.isArray(hooks.PreToolUse)) {
      const kept = hooks.PreToolUse.filter((e) => !isOurs(e));
      if (kept.length !== hooks.PreToolUse.length) {
        if (kept.length) hooks.PreToolUse = kept;
        else delete hooks.PreToolUse;
        if (!Object.keys(hooks).length) delete json.hooks;
        writeFileSync(claudePath(o.home), `${JSON.stringify(json, null, 2)}\n`);
        done.push('Removed the Claude Code hook');
      }
    }
  }
  for (const f of [...FILES, 'state.json', 'scan-cache.json']) rmSync(join(dir, f), { force: true });
  rmSync(join(dir, 'hooks'), { recursive: true, force: true });
  done.push('Removed the guard\'s files (backups in quarantine/ are kept)');
  return done;
}

export function status(o: Options): string[] {
  const out: string[] = [];
  const dir = dirOf(o.home);
  if (!existsSync(statePath(o.home))) return ['npm-guard is not installed on this machine.'];
  const s = JSON.parse(readFileSync(statePath(o.home), 'utf8')) as State;
  const cur = git(o, ['config', '--global', '--get', 'core.hooksPath']);
  out.push(`Installed ${s.installedAt}`);
  out.push(cur.ok && fwd(cur.out) === fwd(join(dir, 'hooks')) ? 'Git hooks: on (commit, push, pull, branch switch)' : 'Git hooks: OFF (git is not pointing at the guard)');
  const { json } = readClaude(o.home);
  const hooks = (json?.hooks ?? {}) as { PreToolUse?: HookEntry[] };
  out.push((hooks.PreToolUse ?? []).some(isOurs) ? 'Claude Code hook: on' : 'Claude Code hook: OFF');
  return out;
}

/* --------------------- repositories that bypass the machine-wide hooks --------------------- */

/*
 * A repository can set its own `core.hooksPath` (husky does, to `.husky`), and a repository's own
 * setting wins over the machine-wide one, so the guard's git hooks never run there. The fix is one
 * short block in that repository's own pre-commit and pre-push. It is explicit (a command you run),
 * previewed, and removed exactly by `unprotectRepo`. It does not need the guard to be installed for
 * a teammate: the block does nothing when ~/.npm-guard/cli.js is not there.
 */

const REPO_HOOKS = ['pre-commit', 'pre-push'] as const;
const REPO_BEGIN = '# npm-guard (managed)';
const REPO_END = '# end npm-guard';
const repoBlock = (name: string) =>
  [
    REPO_BEGIN,
    'if [ -f "$HOME/.npm-guard/cli.js" ] && command -v node >/dev/null 2>&1; then',
    `  node "$HOME/.npm-guard/cli.js" hook ${name} || exit 1`,
    'fi',
    REPO_END,
  ];

/** The folder git really takes this repository's hooks from. */
function repoHooksDir(root: string, o: Options): string {
  const r = git(o, ['-C', root, 'rev-parse', '--git-path', 'hooks']);
  const p = r.ok && r.out ? r.out : join(root, '.git', 'hooks');
  let dir = isAbsolute(p) ? p : resolve(root, p);
  // husky 9 generates `.husky/_` and runs the hooks a person writes in `.husky`
  if (basename(dir) === '_' && basename(dirname(dir)) === '.husky') dir = dirname(dir);
  return dir;
}

export type RepoState = {
  dir: string;
  /** machine: the guard's own hooks run here. repo: this repo carries the block. none: nothing runs. */
  covered: 'machine' | 'repo' | 'none';
};

export function repoState(root: string, o: Options): RepoState {
  const dir = repoHooksDir(root, o);
  if (fwd(dir) === fwd(join(dirOf(o.home), 'hooks'))) return { dir, covered: 'machine' };
  const all = REPO_HOOKS.every((h) => {
    try {
      return readFileSync(join(dir, h), 'utf8').includes(REPO_BEGIN);
    } catch {
      return false;
    }
  });
  return { dir, covered: all ? 'repo' : 'none' };
}

export type RepoStep = {
  file: string;
  /** The file as it is now, or null if it does not exist yet. Applying refuses if it differs by then. */
  before: string | null;
  after: string;
  /** The lines being added, for the preview. */
  added: string[];
};

/** What protecting this repository would write. Changes nothing. */
export function planRepo(root: string, o: Options): { dir: string; covered: RepoState['covered']; steps: RepoStep[] } {
  const st = repoState(root, o);
  const steps: RepoStep[] = [];
  if (st.covered !== 'none') return { ...st, steps };
  for (const name of REPO_HOOKS) {
    const file = join(st.dir, name);
    let before: string | null = null;
    try {
      before = readFileSync(file, 'utf8');
    } catch {
      /* no such hook yet */
    }
    if (before !== null && before.includes(REPO_BEGIN)) continue;
    const added = repoBlock(name);
    let after: string;
    if (before === null) {
      after = `#!/bin/sh\n${added.join('\n')}\n`;
    } else {
      const lines = before.split('\n');
      let at = lines[0]?.startsWith('#!') ? 1 : 0;
      // husky 8 sources its own helper first; the guard goes after that line, before the real checks
      while (at < lines.length && /husky\.sh/.test(lines[at])) at++;
      lines.splice(at, 0, ...added);
      after = lines.join('\n');
    }
    steps.push({ file, before, after, added });
  }
  return { ...st, steps };
}

/** Write a plan. A file that is not what was previewed is left alone. */
export function applyRepo(steps: RepoStep[]): { applied: string[]; failed: string[] } {
  const applied: string[] = [];
  const failed: string[] = [];
  for (const s of steps) {
    let now: string | null = null;
    try {
      now = readFileSync(s.file, 'utf8');
    } catch {
      /* not there */
    }
    if (now !== s.before) {
      failed.push(`${s.file}: it changed after the preview, so it was not touched`);
      continue;
    }
    try {
      mkdirSync(dirname(s.file), { recursive: true });
      writeFileSync(s.file, s.after, { mode: 0o755 });
      try {
        chmodSync(s.file, 0o755);
      } catch {
        /* no execute bit on Windows */
      }
      applied.push(s.file);
    } catch (e) {
      failed.push(`${s.file}: ${(e as Error).message}`);
    }
  }
  return { applied, failed };
}

/** Remove exactly the block `planRepo` added, from every hook that carries it. Nothing else is touched. */
export function unprotectRepo(root: string, o: Options): string[] {
  const dir = repoHooksDir(root, o);
  const done: string[] = [];
  for (const name of REPO_HOOKS) {
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const next = text.replace(/^# npm-guard \(managed\)\n[\s\S]*?^# end npm-guard\n?/m, '');
    if (next !== text) {
      writeFileSync(file, next);
      done.push(file);
    }
  }
  return done;
}
