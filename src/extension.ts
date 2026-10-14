import * as vscode from 'vscode';
import { LapPet } from './pet/lap';
import { EditorPet } from './pet/editorPet';
import { StatusPet } from './pet/statusPet';
import { showUsage, Status } from './status/usage';
import { registerGuard } from './npm-guard/guard';

const PET = '\u{1F408}';

// the removed search-bar status left these in settings if VS Code died while it was on
const OLD_TITLE = '✻ Claude';
const OLD_COLOR = '#B5502F';

/** If VS Code died while the title or search-bar colour was borrowed, it is still in settings. Take it back. */
function recoverTitle() {
  const cfg = vscode.workspace.getConfiguration('window');
  const stuck = cfg.inspect<string>('title')?.globalValue;
  if (stuck?.includes(PET) || stuck?.includes(OLD_TITLE)) {
    cfg.update('title', undefined, vscode.ConfigurationTarget.Global);
  }
  const wb = vscode.workspace.getConfiguration('workbench');
  const colors = wb.inspect<Record<string, string>>('colorCustomizations')?.globalValue;
  if (colors?.['commandCenter.foreground'] === OLD_COLOR) {
    const { ['commandCenter.foreground']: _, ...rest } = colors;
    wb.update('colorCustomizations', Object.keys(rest).length ? rest : undefined, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Opt-in (oi.autoPet): the pet walks while Claude works and shouts when it finishes, until
 * clicked or until the next run starts. Only a working -> done change shouts, so opening
 * VS Code on a finished session stays quiet.
 */
function followClaude(lap: LapPet, walker: StatusPet): (live: Status | undefined) => void {
  let prev: Status | undefined;
  return (live) => {
    const was = prev;
    prev = live;
    if (live === was || !vscode.workspace.getConfiguration('oi').get<boolean>('autoPet')) return;
    if (live === 'working') {
      lap.stop(); // hands the title back if the last run was still shouting
      walker.start();
    } else if (live === 'done' && was === 'working') {
      lap.shout(`${vscode.workspace.getConfiguration('oi').get<string>('name')}!`);
    } else if (live !== 'done') {
      lap.stop();
      walker.stop();
    }
  };
}

export function activate(ctx: vscode.ExtensionContext) {
  recoverTitle();
  registerGuard(ctx);

  const lap = new LapPet();
  const roamer = new EditorPet(ctx.extensionUri);
  const walker = new StatusPet();
  const stop = () => {
    lap.stop();
    walker.stop();
    roamer.stop();
  };

  ctx.subscriptions.push(
    lap,
    vscode.window.registerWebviewViewProvider('oi.walk', lap),
    roamer,
    walker,
    showUsage(followClaude(lap, walker)),
    vscode.commands.registerCommand('oi.start', () => roamer.start()),
    vscode.commands.registerCommand('oi.lap', () => walker.start()),
    vscode.commands.registerCommand('oi.shout', () => lap.shout('meeettt!!')),
    vscode.commands.registerCommand('oi.stop', stop),
    vscode.commands.registerCommand('oi.ack', stop)
  );
}

export function deactivate() {}
