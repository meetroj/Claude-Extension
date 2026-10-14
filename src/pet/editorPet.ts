import * as vscode from 'vscode';

const PET = '🐈'; // right margin is text, so emoji works there
const RIGHT_COL = 66; // where the right-hand lane sits, in character cells
const TICK = 160;

type Step = { side: 'L' | 'R'; line: number };

/**
 * The pet traces the inside edge of the editor without covering a single character:
 * down the gutter (an icon beside the line numbers), then back up the right margin
 * (an emoji parked past end-of-line). Corners are a hop - there is no floor to cross.
 */
export class EditorPet {
  private readonly gutter: vscode.TextEditorDecorationType;
  private right?: vscode.TextEditorDecorationType;
  private timer?: NodeJS.Timeout;
  private i = 0;

  constructor(extensionUri: vscode.Uri) {
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'cat.svg'),
      gutterIconSize: 'contain',
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), TICK);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.clear(vscode.window.activeTextEditor);
  }

  get running() {
    return !!this.timer;
  }

  private step() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const path = this.path(ed);
    if (!path.length) return;
    this.i = (this.i + 1) % path.length;
    this.draw(ed, path[this.i]);
  }

  /** Down the left gutter, back up the right margin. */
  private path(ed: vscode.TextEditor): Step[] {
    const vr = ed.visibleRanges[0];
    if (!vr) return [];
    const last = ed.document.lineCount - 1;
    const top = Math.min(vr.start.line, last);
    const bot = Math.min(Math.max(vr.end.line - 1, top), last);
    const steps: Step[] = [];
    for (let l = top; l <= bot; l++) steps.push({ side: 'L', line: l });
    for (let l = bot; l >= top; l--) steps.push({ side: 'R', line: l });
    return steps;
  }

  private draw(ed: vscode.TextEditor, { side, line }: Step) {
    const at = new vscode.Range(line, 0, line, 0);
    if (side === 'L') {
      ed.setDecorations(this.gutter, [at]);
      this.right?.dispose();
      this.right = undefined;
      return;
    }
    ed.setDecorations(this.gutter, []);
    const end = ed.document.lineAt(line).text.length;
    this.right?.dispose(); // contentText lives on the type, so each frame needs a fresh one
    this.right = vscode.window.createTextEditorDecorationType({
      after: { contentText: PET, margin: `0 0 0 ${Math.max(RIGHT_COL - end, 1)}ch` },
    });
    ed.setDecorations(this.right, [new vscode.Range(line, end, line, end)]);
  }

  private clear(ed?: vscode.TextEditor) {
    ed?.setDecorations(this.gutter, []);
    this.right?.dispose();
    this.right = undefined;
  }

  dispose() {
    this.stop();
    this.gutter.dispose();
  }
}
