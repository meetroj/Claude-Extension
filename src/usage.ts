import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { empty, parse, Response, Run, sum, Tokens, total } from './transcript';

const POLL = 2000;
const SHOWN = 3; // most recent sessions of this folder
/**
 * ponytail: a transcript has no "still alive" signal, so an unfinished one that has been quiet
 * this long is called stopped. A single tool call that runs longer shows as stopped until it
 * writes again. Claude Code hooks (IDEA.md section 6A) are the exact fix.
 */
const STALE = 5 * 60_000;
const QUIET = 60 * 60_000; // past this a session is history, and the status bar stops naming its state
const CLAUDE_ORANGE = '#D97757';

type Status = 'working' | 'done' | 'stopped';
const ICON: Record<Status, string> = { working: 'loading~spin', done: 'check', stopped: 'circle-slash' };

interface Seen {
  run: Run;
  mtime: number;
}
interface Agent extends Seen {
  id: string;
  type: string;
  description: string;
}
interface Session extends Seen {
  id: string;
  agents: Agent[];
}
interface Node {
  item: vscode.TreeItem;
  children?: Node[];
}
interface Plan {
  tier: string;
  asOf: number;
  limits: { label: string; percent: number; resetsAt: number }[];
}

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(configDir(), 'projects');
/** Claude Code files a folder's sessions under its path with every non-alphanumeric turned into '-'. */
const projectDir = (cwd: string) => path.join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
/** A folder that is not there (yet) is just an empty one. */
const ls = (dir: string) => fs.readdir(dir).catch(() => [] as string[]);

const cache = new Map<string, { size: number; rest: Buffer; run: Run }>();

/**
 * A transcript's running totals. Transcripts only grow, so after the first read this parses
 * just the bytes appended since - they reach tens of MB and change every few seconds.
 */
async function read(file: string): Promise<Seen> {
  const st = await fs.stat(file);
  let tail = cache.get(file);
  if (!tail || st.size < tail.size) {
    tail = { size: 0, rest: Buffer.alloc(0), run: empty() }; // first sight, or rewritten: start over
    cache.set(file, tail);
  }
  if (st.size > tail.size) {
    const fh = await fs.open(file, 'r');
    try {
      const chunk = Buffer.allocUnsafe(st.size - tail.size);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, tail.size);
      const bytes = Buffer.concat([tail.rest, chunk.subarray(0, bytesRead)]);
      const end = bytes.lastIndexOf(10) + 1; // whole lines only: the last may still be being written
      parse(bytes.toString('utf8', 0, end), tail.run);
      tail.rest = Buffer.from(bytes.subarray(end)); // a copy, or it would pin the whole chunk in memory
      tail.size += bytesRead;
    } finally {
      await fh.close();
    }
  }
  return { run: tail.run, mtime: st.mtimeMs };
}

async function loadAgents(dir: string): Promise<Agent[]> {
  const agents = await Promise.all(
    (await ls(dir))
      .filter((n) => n.endsWith('.jsonl'))
      .map(async (n) => {
        const meta = await fs
          .readFile(path.join(dir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8')
          .then(JSON.parse)
          .catch(() => ({}));
        return {
          id: n,
          type: String(meta.agentType ?? 'agent'),
          description: String(meta.description ?? ''),
          ...(await read(path.join(dir, n))),
        };
      })
  );
  return agents.sort((a, b) => b.mtime - a.mtime);
}

async function loadSessions(dir: string): Promise<Session[]> {
  const files = await Promise.all(
    (await ls(dir))
      .filter((n) => n.endsWith('.jsonl'))
      .map(async (n) => ({ n, mtime: (await fs.stat(path.join(dir, n))).mtimeMs }))
  );
  files.sort((a, b) => b.mtime - a.mtime);
  return Promise.all(
    files.slice(0, SHOWN).map(async ({ n }) => {
      const id = n.replace(/\.jsonl$/, '');
      return {
        id,
        ...(await read(path.join(dir, n))),
        agents: await loadAgents(path.join(dir, id, 'subagents')),
      };
    })
  );
}

/** Every response since `since` on this machine, whichever folder it ran in. */
async function loadSince(since: number): Promise<Response[]> {
  const found = new Map<string, Response>(); // by id: a forked session repeats its parent's responses
  const add = async (file: string) => {
    const st = await fs.stat(file).catch(() => undefined);
    if (!st || st.mtimeMs < since) return false;
    for (const [id, r] of (await read(file)).run.responses) if (r.at >= since) found.set(id, r);
    return true;
  };
  for (const project of await ls(projectsDir())) {
    const dir = path.join(projectsDir(), project);
    for (const n of await ls(dir)) {
      // a session untouched since then cannot have subagents that were
      if (!n.endsWith('.jsonl') || !(await add(path.join(dir, n)))) continue;
      const agents = path.join(dir, n.replace(/\.jsonl$/, ''), 'subagents');
      for (const a of await ls(agents)) if (a.endsWith('.jsonl')) await add(path.join(agents, a));
    }
  }
  return [...found.values()];
}

/** Labels read from Claude Code's files go into a markdown table; keep only what cannot break one. */
const plain = (s: string) => s.replace(/[^\w .:-]/g, '');

/**
 * Plan limits as Claude Code last fetched them. It keeps them in its own config file, so this
 * needs no login token and no network - but it is only as fresh as Claude Code's last check.
 */
async function loadPlan(): Promise<Plan | undefined> {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json');
  const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
  const limits = cfg.cachedUsageUtilization?.utilization?.limits;
  if (!Array.isArray(limits)) return undefined;
  return {
    tier: plain(String(cfg.oauthAccount?.organizationRateLimitTier ?? '').replace(/^default_claude_/, '').replace(/_/g, ' ')),
    asOf: Number(cfg.cachedUsageUtilization.fetchedAtMs),
    limits: limits.map((l: any) => ({
      label:
        l.kind === 'session' ? '5h' : l.kind === 'weekly_all' ? '7d' : plain(String(l.scope?.model?.display_name ?? l.kind)),
      percent: Number(l.percent) || 0,
      resetsAt: Date.parse(l.resets_at),
    })),
  };
}

const status = ({ run, mtime }: Seen, now: number): Status =>
  run.ended ? 'done' : now - mtime < STALE ? 'working' : 'stopped';

const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const breakdown = (t: Tokens) =>
  `${fmt(total(t))} total · in ${fmt(t.input)} · out ${fmt(t.output)}`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function meter(percent: number): string {
  const full = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '█'.repeat(full) + '░'.repeat(10 - full);
}

function until(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

function row(id: string, icon: string, label: string, description: string, tooltip?: string, children?: Node[]): Node {
  const item = new vscode.TreeItem(
    label,
    children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
  );
  // a stable id is what keeps a row expanded and scrolled-to across refreshes
  Object.assign(item, { id, description, tooltip, iconPath: new vscode.ThemeIcon(icon) });
  return { item, children };
}

/** A session together with its subagents: combined tokens, overall status, last activity. */
function summarize(s: Session, now: number) {
  const agents = s.agents.map((a) => ({ a, st: status(a, now) }));
  // a background agent can still be running after the session's own turn has ended
  const st: Status = agents.some((x) => x.st === 'working') ? 'working' : status(s, now);
  return {
    agents,
    st,
    busy: agents.filter((x) => x.st === 'working').length,
    all: sum(s.run.tokens, ...s.agents.map((a) => a.run.tokens)),
    mtime: Math.max(s.mtime, ...s.agents.map((a) => a.mtime)),
  };
}

/** The status bar line: what this folder's session is doing, and today's tokens on this machine. */
function headline(newest: Session | undefined, today: Response[], now: number): string {
  const s = newest && summarize(newest, now);
  const live = s && now - s.mtime <= QUIET ? s.st : undefined;
  const tokens = fmt(total(sum(...today.map((r) => r.tokens))));
  return `$(${live ? ICON[live] : 'sparkle'}) Claude${live ? ' ' + live : ''} · ${tokens} today`;
}

/** The hover card behind the status bar line. */
function card(plan: Plan | undefined, today: Response[], newest: Session | undefined, now: number) {
  const md = new vscode.MarkdownString('', true);
  // prompts end up in here, and a prompt can contain a link: this is the only command one may run
  md.isTrusted = { enabledCommands: ['oi.usage.focus'] };
  md.appendMarkdown(`**Claude Usage**${plan?.tier ? ` &nbsp;·&nbsp; ${plan.tier}` : ''}\n\n`);

  if (plan) {
    md.appendMarkdown('| | Used | | Resets in |\n|:--|:--|--:|:--|\n');
    for (const l of plan.limits) {
      // once a window has reset, the percentage Claude Code cached belongs to the old one
      const open = l.resetsAt > now;
      md.appendMarkdown(
        `| **${l.label}** | \`${meter(open ? l.percent : 0)}\` | ${open ? l.percent + '%' : '–'} | ${open ? until(l.resetsAt - now) : 'reset'} |\n`
      );
    }
    if (plan.limits.some((l) => l.resetsAt > now && l.percent >= 80)) {
      md.appendMarkdown(`\n$(warning) You're approaching your usage limits.\n`);
    }
  } else {
    md.appendMarkdown('Plan limits are not available: Claude Code has not saved them yet.\n');
  }

  const all = sum(...today.map((r) => r.tokens));
  md.appendMarkdown(`\n---\n\n**Today, all folders** &nbsp; ${breakdown(all)}\n\n`);
  const byModel = new Map<string, number>();
  for (const r of today) byModel.set(r.model, (byModel.get(r.model) ?? 0) + total(r.tokens));
  if (byModel.size) {
    md.appendMarkdown('| Model | Share | Tokens |\n|:--|:--|--:|\n');
    for (const [model, n] of [...byModel].sort((a, b) => b[1] - a[1])) {
      md.appendMarkdown(`| ${plain(model)} | \`${meter((100 * n) / total(all))}\` | ${fmt(n)} |\n`);
    }
  }

  if (newest) {
    const { st, busy, all: used } = summarize(newest, now);
    md.appendMarkdown(
      `\n---\n\n**This folder** &nbsp; $(${ICON[st]}) ${st} · ${fmt(total(used))} tokens · context ${fmt(newest.run.context)}` +
        `${busy ? ` · ${busy} agent${busy > 1 ? 's' : ''} working` : ''}\n\n`
    );
    if (newest.run.prompt) {
      md.appendMarkdown('$(comment) ');
      md.appendText(clip(oneLine(newest.run.prompt), 160));
      md.appendMarkdown('\n');
    }
  }

  md.appendMarkdown(
    `\n---\n\n$(list-tree) [Full breakdown](command:oi.usage.focus)` +
      `${plan ? ` &nbsp;·&nbsp; $(history) limits as of ${clock(plan.asOf)}` : ''}\n`
  );
  return md;
}

function sessionNode(s: Session, now: number): Node {
  const { agents, st, all } = summarize(s, now);
  const prompt = s.run.prompt;

  return row(s.id, ICON[st], s.run.title ?? 'Claude Code session', `${fmt(total(all))} tokens`, st, [
    row(
      `${s.id}:prompt`,
      'comment',
      prompt ? clip(oneLine(prompt), 200) : 'No prompt yet',
      '',
      prompt && clip(prompt, 2000)
    ),
    row(`${s.id}:tokens`, 'graph', 'Tokens', breakdown(all), `This session and its subagents.\n${breakdown(all)}`),
    row(
      `${s.id}:context`,
      'layers',
      'Context',
      `${fmt(s.run.context)} tokens · ${s.run.model ?? 'no reply yet'}`,
      'Tokens sent with the most recent request.'
    ),
    ...agents.map(({ a, st }) =>
      row(
        `${s.id}:${a.id}`,
        ICON[st],
        a.type,
        `${fmt(total(a.run.tokens))} tokens · ${a.description}`,
        `${st} · ${breakdown(a.run.tokens)}${a.run.prompt ? '\n\n' + clip(a.run.prompt, 2000) : ''}`
      )
    ),
  ]);
}

/**
 * Claude Code usage, read straight from the files Claude Code already writes. Three surfaces:
 * a status bar line (today's tokens), a hover card on it (plan limits, today by model, this
 * folder's session), and the "Claude Usage" view with every session and subagent in full.
 */
export function showUsage(): vscode.Disposable {
  const changed = new vscode.EventEmitter<void>();
  let roots: Node[] = [];
  let shown = '';
  let busy = false;
  let plan: Plan | undefined;
  let tip = '';

  // The toolbar beside the search box is internal to VS Code - no extension can add to the title
  // bar. The status bar is the one place that takes live, coloured text. Its card opens on hover
  // only (click-to-open is reserved for VS Code's own items), so a click goes to the full view.
  const bar = vscode.window.createStatusBarItem('oi.usage', vscode.StatusBarAlignment.Left, 100);
  bar.name = 'Claude Usage';
  bar.color = CLAUDE_ORANGE;
  bar.command = 'oi.usage.focus';

  const view = vscode.window.createTreeView<Node>('oi.usage', {
    treeDataProvider: {
      onDidChangeTreeData: changed.event,
      getTreeItem: (n) => n.item,
      getChildren: (n) => (n ? n.children ?? [] : roots),
    },
  });

  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sessions = cwd ? await loadSessions(projectDir(cwd)) : [];
      const today = await loadSince(new Date(now).setHours(0, 0, 0, 0));
      plan = await loadPlan().catch(() => plan); // missing, or caught mid-write: keep the last good one

      const line = headline(sessions[0], today, now);
      if (line !== bar.text) {
        bar.text = line;
        bar.show();
      }
      const details = card(plan, today, sessions[0], now);
      if (details.value !== tip) {
        tip = details.value;
        bar.tooltip = details;
      }

      const next = sessions.map((s) => sessionNode(s, now));
      view.message = next.length
        ? undefined
        : cwd
          ? 'No Claude Code sessions for this folder yet.'
          : 'Open a folder to see its Claude Code sessions.';
      const snapshot = JSON.stringify(next);
      if (snapshot !== shown) {
        shown = snapshot;
        roots = next;
        changed.fire();
      }
    } catch (err) {
      // usually a transcript deleted mid-read; the last good tree stays up and the next tick retries
      view.message = `Could not read Claude Code sessions: ${err instanceof Error ? err.message : err}`;
    } finally {
      busy = false;
    }
  };

  // ponytail: polls for as long as the window is open, since the status bar is always on screen.
  // Each tick stats every transcript on the machine (about a hundred here) and reads only the
  // bytes appended to the ones that grew. The timer is also what flips working -> stopped.
  // Swap for fs.watch if it shows in a profile.
  const timer = setInterval(refresh, POLL);
  refresh();
  return vscode.Disposable.from(view, changed, bar, { dispose: () => clearInterval(timer) });
}
