import * as vscode from 'vscode';
import { LapPet } from './lap';
import { EditorPet } from './editorPet';
import { showUsage } from './usage';

const PET = '\u{1F408}';

/** If VS Code died mid-shout, the borrowed title is still in settings. Take it back. */
function recoverTitle() {
  const cfg = vscode.workspace.getConfiguration('window');
  const stuck = cfg.inspect<string>('title')?.globalValue;
  if (stuck?.includes(PET)) {
    cfg.update('title', undefined, vscode.ConfigurationTarget.Global);
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  recoverTitle();

  const lap = new LapPet();
  const roamer = new EditorPet(ctx.extensionUri);
  const stop = () => {
    lap.stop();
    roamer.stop();
  };

  ctx.subscriptions.push(
    lap,
    vscode.window.registerWebviewViewProvider('oi.walk', lap),
    roamer,
    showUsage(),
    vscode.commands.registerCommand('oi.start', () => roamer.start()),
    vscode.commands.registerCommand('oi.lap', () => lap.start()),
    vscode.commands.registerCommand('oi.shout', () => lap.shout('meeettt!!')),
    vscode.commands.registerCommand('oi.stop', stop),
    vscode.commands.registerCommand('oi.ack', stop)
  );
}

export function deactivate() {}
