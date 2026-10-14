import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

/**
 * The scanner. Scanning reads file contents without executing or modifying project code, and
 * imports nothing from VS Code, so the git hooks and Claude Code can use the same code the editor does.
 * Only `applyFix` and `restore` write, and only when a caller has asked a person first.
 *
 * A scan reports "no threats detected by the current rules", never "safe": a rule set cannot prove
 * that nothing malicious is present.
 *
 * The injected-loader family seen in October 2026 hides in four shapes, so each has a rule:
 *   marker       the campaign's own strings and known hosts
 *   hidden-tail  code placed after 100+ spaces on a long line, so an editor shows a short one
 *   obfuscated   `_0x1a2b3c` style identifiers: a file that is mostly one
 *   encoded      a base64 blob that decodes to code that spawns processes
 *   fake-binary  a font that is really JavaScript
 *   chain-c2     spawns processes and talks to a blockchain RPC
 *   script       a build/start script that runs a file before the real command
 * The marker changes between waves. The structural rules are what catch the next one.
 */

export type Severity = 'block' | 'warn';
export type Finding = { file: string; rule: string; severity: Severity; detail: string };

// Built from pieces so this file never matches itself, or an antivirus.
const J = (...p: string[]) => p.join('');
// The loader's own strings. A fix may cut at one of these.
const LOADER = [
  J("global\\.i ?= ?'", 'A10'),
  J('Z2xvYmFs', 'LnI9cmVxdWlyZ'), // base64 of "global.r=require"
  J('__', 'inzV'),
  J('__', 'inzCR'),
  J('main\\.', 'inz\\.cjs'),
];
// Addresses seen in the campaign. They are reported, but never a place to cut: a legitimate
// blocklist or an incident note can contain one.
const HOSTS = [J('193\\.247\\.', '144\\.'), J('194\\.11\\.', '226\\.')];
// Words of the chain-RPC rule, also built from pieces: this file spawns git, so it must not
// contain them whole or the rule below would flag the scanner itself.
const CHAIN_RPC = new RegExp(
  [J('\\beth_', '[a-zA-Z]+'), J('block', 'scout'), J('getTransaction', 'By'), J('1rpc', '\\.io'), J('drpc', '\\.org'), J('publicnode', '\\.com')].join('|'),
);
export const LOADER_MARKERS = new RegExp(LOADER.join('|'));
export const MARKERS = new RegExp([...LOADER, ...HOSTS].join('|'));

const CODE_EXT = /\.(?:[cm]?[jt]sx?|json)$/i;
const FONT_EXT = /\.(?:otf|ttf|woff2?|eot)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.gradle', 'Pods', '.next', '.cache']);
const MAX_BYTES = 1_500_000;
const LIFECYCLE = /^(?:pre|post)?(?:build|start|dev|serve|test|install|prepare|publish|pack)$/;

/** Look at one file. `has` says whether a path exists in the same tree. */
export function examine(path: string, buf: Buffer, has: (p: string) => boolean = () => true): Finding[] {
  const out: Finding[] = [];
  const name = basename(path);
  if (/\.min\.[cm]?js$/i.test(name) || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)) return out;
  if (buf.length === 0 || buf.length > MAX_BYTES) return out;
  const isFont = FONT_EXT.test(name);
  if (!CODE_EXT.test(name) && !isFont) return out;

  const text = buf.toString('utf8');
  const add = (rule: string, severity: Severity, detail: string) => out.push({ file: path, rule, severity, detail });

  if (isFont) {
    const binary = buf.subarray(0, 512).includes(0);
    if (!binary && /\b(?:require|global|function|const|var)\b/.test(text.slice(0, 4096))) {
      add('fake-binary', 'block', `${name} is not a font: it is JavaScript text (${buf.length} bytes)`);
    }
    if (MARKERS.test(text)) add('marker', 'block', 'carries the campaign marker');
    return out;
  }

  const m = MARKERS.exec(text);
  if (m) add('marker', 'block', `matches a known marker: ${m[0].slice(0, 24)}`);

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 1000 && /\S[ \t]{100,}\S/.test(l)) {
      add('hidden-tail', 'block', `line ${i + 1} is ${l.length} characters: code after a long run of spaces`);
      break;
    }
  }

  if (/\.[cm]?[jt]sx?$/i.test(name)) {
    const hex = text.match(/\b_0x[0-9a-f]{4,6}\b/g);
    if (hex && hex.length >= 20) add('obfuscated', 'block', `${hex.length} obfuscator-style identifiers (_0x...)`);

    const parts = [...text.matchAll(/["']([A-Za-z0-9+/=]{20,})["']/g)].map((x) => x[1]);
    if (parts.length >= 4) {
      const decoded = Buffer.from(parts.join(''), 'base64').toString('utf8');
      const printable = decoded.length ? (decoded.match(/[\x20-\x7e\n\r\t]/g) ?? []).length / decoded.length : 0;
      if (printable > 0.9 && /\brequire\(|child_process|\bglobal\./.test(decoded)) {
        add('encoded', 'block', `a base64 blob (${decoded.length} characters) decodes to code`);
      }
    }
    if (/child_process/.test(text) && CHAIN_RPC.test(text)) {
      add('chain-c2', 'block', 'spawns processes and talks to a blockchain RPC');
    }
  }

  if (name === 'package.json') {
    let pkg: { scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(text);
    } catch {
      return out;
    }
    for (const [key, cmd] of Object.entries(pkg.scripts ?? {})) {
      if (!LIFECYCLE.test(key) || typeof cmd !== 'string') continue;
      const s = /^\s*(?:npx\s+)?node\s+((?:\.\/)?[\w.-]+\.[cm]?js)\s*&&/.exec(cmd);
      if (!s) continue;
      const target = s[1].replace(/^\.\//, '');
      const dir = dirname(path) === '.' ? '' : `${dirname(path)}/`;
      // both messages keep "runs <file> first": `crossCheck` reads the file name from it
      if (!has(dir + target)) add('script', 'warn', `"${key}" runs ${target} first, and it is not in the repository`);
      else if (target === 'api.js') add('script', 'warn', `"${key}" runs api.js first, before the real command`);
    }
  }
  return out;
}

/** A script that runs a file which is itself flagged is a block, not a warning. */
export function crossCheck(findings: Finding[]): Finding[] {
  const flagged = new Set(findings.filter((f) => f.severity === 'block').map((f) => f.file));
  return findings.map((f) => {
    if (f.rule !== 'script') return f;
    const target = /runs ([^\s]+) first/.exec(f.detail)?.[1];
    const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/') + 1) : '';
    return target && flagged.has(dir + target) ? { ...f, severity: 'block' as const, detail: `${f.detail} (and that file is the loader)` } : f;
  });
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) visit(join(dir, e.name));
      } else if (e.isFile()) files.push(join(dir, e.name));
    }
  };
  visit(root);
  return files;
}

/** Scan a folder on disk. */
export function scanDir(root: string): Finding[] {
  const files = walk(root);
  const rel = (f: string) => relative(root, f).split(sep).join('/');
  const present = new Set(files.map(rel));
  const all: Finding[] = [];
  for (const f of files) {
    if (!CODE_EXT.test(f) && !FONT_EXT.test(f)) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(f);
    } catch {
      all.push({ file: rel(f), rule: 'unreadable', severity: 'warn', detail: 'could not be read (antivirus or permissions)' });
      continue;
    }
    all.push(...examine(rel(f), buf, (p) => present.has(p)));
  }
  return crossCheck(all);
}

/* ---------------------------------- fixing --------------------------------- */

/*
 * What a fix may do, and what it never does:
 *  - It NEVER deletes a file. A file that is the loader, or that it cannot make sense of, is listed
 *    for a person to deal with.
 *  - It changes a file only where the malicious part has an exact boundary: a line after a long run of
 *    spaces, or from a campaign marker to the end of that line. A file name such as api.js is never
 *    a reason to change anything.
 *  - A script's `node <file> &&` prefix is dropped only when <file> is itself flagged by what it contains.
 *  - Every change is planned first as exact text (`after`), shown as a diff, and applied only if the file
 *    still has the bytes it had when it was planned. The original is backed up first, and the whole
 *    folder is scanned again afterwards.
 */

export type FixStep = {
  file: string;
  kind: 'cut' | 'script';
  summary: string;
  /** What git can and cannot bring back for this file. Shown to the person; changes nothing. */
  git: string;
  /** sha256 of the file as it was when planned. Applying refuses a file that no longer matches. */
  before: string;
  /** The exact text that will be written. Applying writes this and nothing it works out later. */
  after: string;
  /** The exact changes as lines to show, built from `before` and `after`. */
  diff: string[];
};
export type FixPlan = { steps: FixStep[]; /** found, but not something it will change on its own */ manual: Finding[] };

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Where git stands on one file. Git restores what was COMMITTED. It does not keep uncommitted
 * edits, and it never held untracked or ignored files at all, so for those the npm-guard backup
 * is the only copy.
 */
export function gitNote(root: string, file: string): string {
  const run = (...a: string[]) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  if (run('rev-parse', '--is-inside-work-tree').status !== 0) {
    return 'not in a git repository: only the npm-guard backup can bring it back';
  }
  if (run('ls-files', '--error-unmatch', '--', file).status !== 0) {
    return 'not tracked by git (new or ignored): git cannot bring it back, only the npm-guard backup can';
  }
  return (run('status', '--porcelain', '--', file).stdout ?? '').trim()
    ? 'tracked but has uncommitted changes: git only brings back the last commit, so those changes survive only in the npm-guard backup'
    : 'tracked and unchanged: git holds this same version, so git can bring it back too';
}

/** Keep the real part of a line: cut at the run of spaces that hides the tail, or at a loader marker. */
export function cutLine(l: string): string {
  const pad = /\S[ \t]{100,}\S/.exec(l);
  if (pad && l.length > 1000) return l.slice(0, pad.index + 1);
  const k = LOADER_MARKERS.exec(l);
  return k ? l.slice(0, k.index).trimEnd() : l;
}

/** Remove `node <file> &&` from script values, for the files `strip` says are the loader. */
export function fixPackageScripts(text: string, strip: (file: string) => boolean): string {
  return text.replace(
    /("(?:[^"\\]|\\.)*"\s*:\s*")(\s*(?:npx\s+)?node\s+(?:\.\/)?([\w.-]+\.[cm]?js)\s*&&\s*)/g,
    (whole, pre: string, _prefix: string, file: string) => (strip(file) ? pre : whole),
  );
}

const clip = (s: string, n = 160): string => {
  const t = s.replace(/[ \t]{10,}/g, (r) => `<${r.length} spaces>`);
  return t.length > n ? `${JSON.stringify(t.slice(0, n))} ...(+${t.length - n} more characters)` : JSON.stringify(t);
};

/**
 * The exact changes between two texts, line by line: which line, how many characters go, and the
 * removed text (long text is shortened for display only; the whole original is in the backup).
 */
export function renderDiff(file: string, before: string, after: string, max = 12): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [`${file}: ${before.length} -> ${after.length} characters`];
  let shown = 0;
  let more = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i] ?? '';
    if (x === y) continue;
    if (shown >= max) {
      more++;
      continue;
    }
    shown++;
    let p = 0;
    while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let s = 0;
    while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    out.push(`  line ${i + 1} (${x.length} characters): ${x.length - p - s} removed, ${y.length - p - s} added`);
    out.push(`    - ${clip(x.slice(p, x.length - s))}`);
    if (y.length - p - s > 0) out.push(`    + ${clip(y.slice(p, y.length - s))}`);
    out.push(`    line keeps: ${clip(y, 100)}`);
  }
  if (more) out.push(`  ... and ${more} more changed line(s)`);
  return out;
}

/** What it would change. Changes nothing. */
export function planFix(root: string, findings: Finding[]): FixPlan {
  const flagged = new Set(findings.filter((f) => f.severity === 'block').map((f) => f.file));
  const candidates = new Set(findings.filter((f) => f.severity === 'block' || f.rule === 'script').map((f) => f.file));
  const steps: FixStep[] = [];
  for (const file of candidates) {
    const name = basename(file);
    if (FONT_EXT.test(name)) continue; // a fake font has no part to cut: it is a person's call
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      continue;
    }
    const text = buf.toString('utf8');
    if (Buffer.compare(Buffer.from(text, 'utf8'), buf) !== 0) continue; // not plain UTF-8: never rewrite it
    const dir = dirname(file) === '.' ? '' : `${dirname(file)}/`;
    const isPkg = name === 'package.json';
    let after = text.split('\n').map(cutLine).join('\n');
    if (isPkg) after = fixPackageScripts(after, (t) => flagged.has(dir + t));
    if (after === text) continue; // no exact boundary: left for a person
    if (after.trim() === '') continue; // the whole file is the loader: npm-guard never deletes a file
    if (/\.json$/i.test(name)) {
      try {
        JSON.parse(after);
      } catch {
        continue;
      }
    }
    if (examine(file, Buffer.from(after, 'utf8')).some((f) => f.severity === 'block')) continue; // still looks wrong after the cut
    const lines = text.split('\n');
    const next = after.split('\n');
    const changed = lines.filter((l, i) => l !== next[i]).length;
    steps.push({
      file,
      kind: isPkg ? 'script' : 'cut',
      summary: isPkg
        ? `remove the "node <file> &&" prefix from ${changed} script line(s), only where that file is flagged as the loader`
        : `cut hidden code from ${changed} line(s), removing ${text.length - after.length} characters; the rest of the file stays`,
      git: gitNote(root, file),
      before: sha(buf),
      after,
      diff: renderDiff(file, text, after),
    });
  }
  const handled = new Set(steps.map((s) => s.file));
  return { steps, manual: findings.filter((f) => !handled.has(f.file)) };
}

export type FixResult = {
  dir: string;
  applied: string[];
  failed: string[];
  /** A fresh scan of the whole folder after the changes: what is still flagged. */
  remaining: Finding[];
};

/**
 * Apply a plan. For each step: refuse if the file is not byte-for-byte what was previewed, back the
 * original up and check the copy, then write exactly `after`. The folder is scanned again at the end.
 */
export function applyFix(root: string, steps: FixStep[], backupRoot: string): FixResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(backupRoot, stamp);
  const applied: string[] = [];
  const failed: string[] = [];
  const saved: { file: string; after: string }[] = [];
  for (const s of steps) {
    const p = join(root, s.file);
    let original: Buffer;
    try {
      original = readFileSync(p);
    } catch {
      failed.push(`${s.file}: cannot be read now, so it was not changed`);
      continue;
    }
    if (sha(original) !== s.before) {
      failed.push(`${s.file}: it changed after the preview, so it was not touched. Run fix again to see what it would do now`);
      continue;
    }
    const copy = join(dir, 'files', s.file);
    try {
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, original);
      if (sha(readFileSync(copy)) !== s.before) throw new Error('the copy does not match');
    } catch {
      failed.push(`${s.file}: could not be backed up, so it was not changed`);
      continue;
    }
    const tmp = `${p}.npm-guard.tmp`;
    try {
      writeFileSync(tmp, s.after, 'utf8');
      renameSync(tmp, p);
      saved.push({ file: s.file, after: sha(s.after) });
      applied.push(`${s.file}: ${s.summary}`);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
        writeFileSync(p, original);
      } catch {
        /* the backup is still there */
      }
      failed.push(`${s.file}: ${(e as Error).message}`);
    }
  }
  if (saved.length) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ root, createdAt: stamp, files: saved }, null, 2));
  return { dir, applied, failed, remaining: scanDir(root).filter((f) => f.severity === 'block') };
}

type Manifest = { root: string; files: { file: string; after: string }[] };

/** Which files of a backup can be put back right now: only those still exactly as the fix left them. */
function restorable(backupDir: string) {
  const m = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  const files: string[] = [];
  const skipped: string[] = [];
  for (const { file, after } of m.files) {
    let now: string | null = null;
    try {
      now = sha(readFileSync(join(m.root, file)));
    } catch {
      /* gone */
    }
    if (now === after && existsSync(join(backupDir, 'files', file))) files.push(file);
    else skipped.push(file);
  }
  return { root: m.root, files, skipped };
}

/** What restoring would do. Changes nothing. `skipped` files were changed after the fix and are left alone. */
export function planRestore(backupDir: string): { root: string; files: string[]; skipped: string[] } {
  return restorable(backupDir);
}

/**
 * Put a backup set back. A file you edited after the fix is not overwritten: the check is made again
 * here, at the moment of writing, not only at the preview.
 */
export function restore(backupDir: string): { restored: string[]; skipped: string[] } {
  const { root, files, skipped } = restorable(backupDir);
  for (const rel of files) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(backupDir, 'files', rel), dest);
  }
  return { restored: files, skipped };
}

/** The newest backup set, or undefined. */
export function latestBackup(backupRoot: string): string | undefined {
  if (!existsSync(backupRoot)) return undefined;
  const sets = readdirSync(backupRoot).filter((d) => existsSync(join(backupRoot, d, 'manifest.json'))).sort();
  return sets.length ? join(backupRoot, sets[sets.length - 1]) : undefined;
}

/* ------------------------------ the editor itself --------------------------- */

/**
 * Was VS Code's own startup file tampered with? This is how the October 2026 implant survived a
 * reinstall of everything else: `out/main.js` is not in VS Code's checksum list, so its own
 * "installation is corrupt" check never saw it.
 */
export function checkEditor(appRoot: string): Finding[] {
  const out: Finding[] = [];
  const dir = join(appRoot, 'out');
  if (!existsSync(dir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (/\.inz\./.test(e)) out.push({ file: join(dir, e), rule: 'editor-patched', severity: 'block', detail: `VS Code has an extra startup file: ${e}` });
  }
  const main = join(dir, 'main.js');
  if (existsSync(main)) {
    let head = '';
    try {
      head = readFileSync(main).subarray(0, 4096).toString('utf8');
    } catch {
      return out;
    }
    if (MARKERS.test(head)) out.push({ file: main, rule: 'editor-patched', severity: 'block', detail: "VS Code's main.js has been modified to load another file" });
    else if (!head.startsWith('/*!')) out.push({ file: main, rule: 'editor-changed', severity: 'warn', detail: "VS Code's main.js starts differently from a normal install" });
  }
  return out;
}

export function summarize(findings: Finding[]): string[] {
  return findings.map((f) => `${f.severity === 'block' ? 'BLOCK' : 'warn '}  ${f.file}  [${f.rule}]  ${f.detail}`);
}
