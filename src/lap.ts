import * as vscode from 'vscode';

/** Borrow a user setting, then hand it back exactly as it was. */
class Borrowed<T> {
  private saved?: T;
  private held = false;

  constructor(private readonly section: string, private readonly key: string) {}

  take(value: T) {
    const cfg = vscode.workspace.getConfiguration(this.section);
    if (!this.held) {
      this.saved = cfg.inspect<T>(this.key)?.globalValue;
      this.held = true;
    }
    cfg.update(this.key, value, vscode.ConfigurationTarget.Global);
  }

  giveBack() {
    if (!this.held) return;
    this.held = false;
    vscode.workspace
      .getConfiguration(this.section)
      .update(this.key, this.saved, vscode.ConfigurationTarget.Global);
  }
}

const page = (walking: boolean) => `<!DOCTYPE html>
<html><body style="margin:0;height:100vh;overflow:hidden">
<style>
  #pet { position: absolute; bottom: 0; font-size: 22px; cursor: pointer; animation: walk 12s linear infinite; }
  /* the emoji faces left; flip it for the walk to the right */
  @keyframes walk {
    0%    { left: 0; transform: scaleX(-1); }
    49.9% { transform: scaleX(-1); }
    50%   { left: calc(100% - 1.2em); transform: scaleX(1); }
    100%  { left: 0; transform: scaleX(1); }
  }
</style>
${walking ? '<div id="pet" title="Oi! — click to acknowledge">🐈</div>' : ''}
<script>
  const vs = acquireVsCodeApi();
  document.getElementById('pet')?.addEventListener('click', () => vs.postMessage('ack'));
</script>
</body></html>`;

/**
 * One pet walking the bottom edge of the panel - the line right above the status bar -
 * plus a shout parked in the window title.
 *
 * ponytail: the status bar can't host anything above itself, so the walk lives in a panel
 * webview. It's only visible while its tab (or a split beside the terminal) is showing.
 *
 * ponytail: there is no title bar API - the shout is written into the `window.title`
 * SETTING, and every write hits disk and fires a config-change event to every installed
 * extension. So the title is set ONCE per shout, never per frame. Animating it made
 * VS Code spin its cursor permanently; do not put that back.
 */
export class LapPet implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly title = new Borrowed<string>('window', 'title');
  private readonly commandCenter = new Borrowed<boolean>('window', 'commandCenter');
  private walking = false;

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(() => vscode.commands.executeCommand('oi.ack'));
    view.webview.html = page(this.walking);
  }

  start() {
    if (this.walking) return;
    this.walking = true;
    if (this.view) this.view.webview.html = page(true);
    vscode.commands.executeCommand('oi.walk.focus', { preserveFocus: true }); // resolves the view if it never opened
  }

  /** The escalation rung that takes over the title bar. One write, not one per frame. */
  shout(text: string) {
    this.commandCenter.take(false); // else the title renders inside the pill, not across the bar
    this.title.take(text);
  }

  stop() {
    this.walking = false;
    if (this.view) this.view.webview.html = page(false);
    this.title.giveBack();
    this.commandCenter.giveBack();
  }

  get running() {
    return this.walking;
  }

  dispose() {
    this.stop();
  }
}
