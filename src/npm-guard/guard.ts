import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyFix, checkEditor, latestBackup, planFix, planRestore, restore, scanDir, summarize, type Finding } from './core';
import { existsSync } from 'node:fs';
import { applyRepo, install, plan, planRepo, repoState, status, uninstall, unprotectRepo } from './install';

const BACKUPS = join(homedir(), '.npm-guard', 'quarantine');

/**
 * npm-guard inside VS Code: scans a folder when it opens, shows the result in the status bar, and
 * offers the same fix the command line does, with the same two questions.
 *
 * Scanning reads file contents without executing or modifying project code, which is why it is
 * declared safe to run in a folder you have not trusted yet: that is exactly the moment an infected
 * project would otherwise be opened. It reports "no threats detected by the current rules", never "safe".
 *
 * ponytail: the scan runs on the extension host's thread. It skips node_modules and big files, which
 * is milliseconds for a normal project; a monorepo with a huge tree would want a worker.
 */
export function registerGuard(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('npm-guard');
  const bar = vscode.window.createStatusBarItem('npmGuard.status', vscode.StatusBarAlignment.Right, -900);
  bar.name = 'npm-guard';
  bar.command = 'npmGuard.scan';
  const sourceDir = join(ctx.extensionPath, 'out', 'npm-guard');
  const opts = () => ({ home: homedir(), sourceDir });

  const folders = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');

  const setBar = (blocks: number, scanned: boolean) => {
    bar.text = blocks ? `$(warning) Guard: ${blocks} found` : scanned ? '$(shield) Guard: none found' : '$(shield) Guard';
    bar.tooltip = blocks
      ? 'A malware loader was found in this folder. Click to scan again.'
      : scanned
        ? 'No threats detected by the current rules. That is not a guarantee. Click to scan again.'
        : 'npm-guard: click to scan this folder';
    bar.backgroundColor = blocks ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    bar.show();
  };

  async function scan(announce: boolean): Promise<{ folder: string; findings: Finding[] }[]> {
    const results: { folder: string; findings: Finding[] }[] = [];
    for (const f of folders()) {
      await new Promise((r) => setImmediate(r)); // let the editor breathe between folders
      results.push({ folder: f.uri.fsPath, findings: scanDir(f.uri.fsPath) });
    }
    const blocks = results.flatMap((r) => r.findings.filter((x) => x.severity === 'block'));
    setBar(blocks.length, true);
    out.clear();
    for (const r of results) {
      out.appendLine(`${r.folder}`);
      (r.findings.length ? summarize(r.findings) : ['  no threats detected by the current rules']).forEach((l) => out.appendLine(`  ${l}`));
    }
    hintBypassedRepos();
    if (blocks.length) {
      const pick = await vscode.window.showWarningMessage(
        `npm-guard: ${blocks.length} malware-loader problem(s) found in this folder. Do not trust it, and do not run or commit anything here.`,
        'Show details',
        'Fix...',
      );
      if (pick === 'Show details') out.show(true);
      if (pick === 'Fix...') void fix();
    } else if (announce) {
      void vscode.window.showInformationMessage('npm-guard: no threats detected by the current rules.');
    }
    return results;
  }

  async function pickFolder(): Promise<string | undefined> {
    const fs = folders();
    if (!fs.length) {
      void vscode.window.showInformationMessage('npm-guard: open a folder first.');
      return undefined;
    }
    if (fs.length === 1) return fs[0].uri.fsPath;
    return (await vscode.window.showQuickPick(fs.map((f) => f.uri.fsPath), { placeHolder: 'Which folder?' })) ?? undefined;
  }

  /** Two questions, both modal, both default to No: closing either does nothing. */
  async function fix() {
    const root = await pickFolder();
    if (!root) return;
    const { steps, manual } = planFix(root, scanDir(root));
    if (manual.length) {
      out.appendLine('Needs a person (npm-guard never deletes a file and will not guess where malicious code ends):');
      summarize(manual).forEach((l) => out.appendLine(`  ${l}`));
    }
    if (!steps.length) {
      void vscode.window.showInformationMessage(
        manual.length
          ? 'npm-guard: nothing it can change safely. It never deletes a file. See the npm-guard output for what needs a person.'
          : 'npm-guard: no threats detected by the current rules.',
      );
      if (manual.length) out.show(true);
      return;
    }
    // The exact changes go to the output panel first, so they can be read before either question.
    out.appendLine(`Planned changes in ${root}:`);
    steps.forEach((s, i) => {
      out.appendLine(`${i + 1}. ${s.summary}`);
      s.diff.forEach((l) => out.appendLine(`     ${l}`));
      out.appendLine(`     git: ${s.git}`);
    });
    out.show(true);
    const detail = [
      ...steps.map((s, i) => `${i + 1}. ${s.diff.join('\n    ')}\n    git: ${s.git}`),
      '',
      'Nothing is deleted. The same list is in the npm-guard output panel.',
      `A backup of every file is saved to ${BACKUPS} first, and "npm-guard: Restore" puts it back.`,
      'Git only brings back what was committed. For uncommitted edits and untracked files, that backup is the only copy.',
      'A file that changes between this preview and the apply is left alone.',
    ].join('\n');
    const first = await vscode.window.showWarningMessage(`Make these ${steps.length} change(s) in ${root}?`, { modal: true, detail }, 'Make changes');
    if (first !== 'Make changes') return;
    const second = await vscode.window.showWarningMessage(
      `Last check: change ${steps.length} file(s) in ${root}?`,
      { modal: true, detail: 'Originals are saved first.' },
      'Yes, apply',
    );
    if (second !== 'Yes, apply') return;
    const res = applyFix(root, steps, BACKUPS);
    res.applied.forEach((l) => out.appendLine(`done     ${l}`));
    res.failed.forEach((l) => out.appendLine(`SKIPPED  ${l}`));
    out.show(true);
    setBar(res.remaining.length, true);
    void vscode.window.showInformationMessage(
      res.remaining.length || res.failed.length
        ? `npm-guard: ${res.applied.length} changed, ${res.remaining.length + res.failed.length} still need a person.`
        : 'npm-guard: changed. A rescan detected no threats by the current rules.',
    );
  }

  /** Puts the ORIGINAL files back, so it asks, and it will not overwrite a file you edited after the fix. */
  async function restoreBackup() {
    const b = latestBackup(BACKUPS);
    if (!b) return void vscode.window.showInformationMessage('npm-guard: there is no backup to restore.');
    const p = planRestore(b);
    if (!p.files.length) {
      return void vscode.window.showInformationMessage(
        p.skipped.length ? 'npm-guard: nothing restored: those files were changed after the fix, so they were left alone.' : 'npm-guard: nothing to restore.',
      );
    }
    const detail = [
      ...p.files.map((f) => `- ${f}`),
      '',
      'This puts back the original version, including the part that was removed.',
      ...(p.skipped.length ? ['', 'Left alone, because they were changed after the fix:', ...p.skipped.map((f) => `- ${f}`)] : []),
    ].join('\n');
    const ok = await vscode.window.showWarningMessage(`Put back ${p.files.length} original file(s) in ${p.root}?`, { modal: true, detail }, 'Restore');
    if (ok !== 'Restore') return;
    const r = restore(b); // checks every file again at the moment of writing
    void vscode.window.showInformationMessage(
      `npm-guard: restored ${r.restored.length} file(s)${r.skipped.length ? `, left ${r.skipped.length} alone (changed since the fix)` : ''}.`,
    );
  }

  /**
   * A repository with its own hooks folder (husky) is not reached by the machine-wide git hooks.
   * Adds a short block to that repository's own pre-commit and pre-push, after a preview and two questions.
   */
  async function protectRepo() {
    const root = await pickFolder();
    if (!root) return;
    const p = planRepo(root, opts());
    if (p.covered !== 'none') {
      void vscode.window.showInformationMessage(
        p.covered === 'machine' ? "npm-guard: git already uses the guard's own hooks in this repository." : 'npm-guard: this repository already carries the guard block.',
      );
      return;
    }
    const detail = [
      ...p.steps.flatMap((s) => [`${s.file}${s.before === null ? '  (new file)' : ''}`, ...s.added.map((l) => `    + ${l}`)]),
      '',
      'Nothing else is changed. The block does nothing on a machine without the guard, so teammates are not blocked by it.',
      '"npm-guard: Unprotect this repository" removes exactly these lines.',
    ].join('\n');
    const first = await vscode.window.showWarningMessage(
      `Add the guard to this repository's own git hooks (${p.dir})?`,
      { modal: true, detail },
      'Add lines',
    );
    if (first !== 'Add lines') return;
    const second = await vscode.window.showWarningMessage(`Last check: edit ${p.steps.length} hook file(s)?`, { modal: true }, 'Yes, apply');
    if (second !== 'Yes, apply') return;
    const r = applyRepo(p.steps);
    r.applied.forEach((f) => out.appendLine(`done     ${f}`));
    r.failed.forEach((f) => out.appendLine(`SKIPPED  ${f}`));
    void vscode.window.showInformationMessage(
      r.failed.length ? `npm-guard: ${r.applied.length} hook(s) edited, ${r.failed.length} skipped. See the npm-guard output.` : 'npm-guard: this repository now runs the guard on commit and push.',
    );
  }

  async function unprotectThisRepo() {
    const root = await pickFolder();
    if (!root) return;
    const ok = await vscode.window.showWarningMessage('Remove the guard block from this repository\'s git hooks?', { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    const done = unprotectRepo(root, opts());
    void vscode.window.showInformationMessage(done.length ? `npm-guard: removed the block from ${done.length} hook file(s).` : 'npm-guard: no guard block found in this repository\'s hooks.');
  }

  /** Once per folder per session: say so when protection is on but this repository's hooks bypass it. */
  const hinted = new Set<string>();
  function hintBypassedRepos() {
    if (!existsSync(join(homedir(), '.npm-guard', 'state.json'))) return; // protection is not on: nothing is being bypassed
    for (const f of folders()) {
      const root = f.uri.fsPath;
      if (hinted.has(root) || !existsSync(join(root, '.git'))) continue;
      const st = repoState(root, opts());
      if (st.covered !== 'none') continue;
      hinted.add(root);
      out.appendLine(`${root}: git takes its hooks from ${st.dir}, so the machine-wide guard hooks do not run here`);
      void vscode.window
        .showInformationMessage(`npm-guard: this repository takes its git hooks from ${st.dir}, so the guard's git hooks do not run here.`, 'Protect this repository...')
        .then((pick) => pick && void protectRepo());
    }
  }

  async function installProtection() {
    const detail = plan(opts()).map((l) => `- ${l}`).join('\n');
    const ok = await vscode.window.showWarningMessage('Turn on npm-guard protection on this machine?', { modal: true, detail }, 'Turn on');
    if (ok !== 'Turn on') return;
    const r = install(opts());
    void vscode.window.showInformationMessage(['npm-guard protection is on.', ...r.notes].join(' '));
  }

  async function removeProtection() {
    const ok = await vscode.window.showWarningMessage('Turn off npm-guard protection on this machine?', { modal: true }, 'Turn off');
    if (ok !== 'Turn off') return;
    void vscode.window.showInformationMessage(uninstall(opts()).join(' · '));
  }

  /** VS Code's own startup file is where the October 2026 implant lived; check it once per session. */
  function checkEditorOnce() {
    const bad = checkEditor(vscode.env.appRoot);
    const blocks = bad.filter((f) => f.severity === 'block');
    if (!blocks.length && !bad.length) return;
    bad.forEach((f) => out.appendLine(`${f.severity === 'block' ? 'BLOCK' : 'warn '}  ${f.file}  ${f.detail}`));
    if (blocks.length) {
      void vscode.window.showErrorMessage(
        "npm-guard: VS Code's own files look tampered with. Close VS Code and reinstall it from code.visualstudio.com, then change your passwords.",
        'Show details',
      ).then((p) => p && out.show(true));
    }
  }

  ctx.subscriptions.push(
    out,
    bar,
    vscode.commands.registerCommand('npmGuard.scan', () => void scan(true)),
    vscode.commands.registerCommand('npmGuard.fix', () => void fix()),
    vscode.commands.registerCommand('npmGuard.restore', () => void restoreBackup()),
    vscode.commands.registerCommand('npmGuard.protectRepo', () => void protectRepo()),
    vscode.commands.registerCommand('npmGuard.unprotectRepo', () => void unprotectThisRepo()),
    vscode.commands.registerCommand('npmGuard.install', () => void installProtection()),
    vscode.commands.registerCommand('npmGuard.uninstall', () => void removeProtection()),
    vscode.commands.registerCommand('npmGuard.status', () => {
      status(opts()).forEach((l) => out.appendLine(l));
      out.show(true);
    }),
  );

  setBar(0, false);
  checkEditorOnce();
  if (vscode.workspace.getConfiguration('npmGuard').get<boolean>('scanOnOpen', true)) {
    setTimeout(() => void scan(false), 1500); // after the window has settled
  }
}
