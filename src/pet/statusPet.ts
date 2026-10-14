import * as vscode from 'vscode';

const PET = '🐈';
const SPAN = 150; // walk length in padding characters; the knob to tune if the cat hits the right icons
const STEP = 2;
const TICK = 150;

/**
 * The pet walks inside the status bar, in the empty stretch between the left and right items.
 * Left items run left to right by descending priority, so this one has the lowest: it is the
 * last on the left and nothing sits to its right to get pushed. The cat moves by growing the
 * padding in front of it.
 *
 * ponytail: padding is non-breaking spaces, whose pixel width depends on font and zoom, so SPAN
 * is calibrated by eye. A narrow window clips the cat instead of turning it round.
 */
export class StatusPet {
  private readonly item = vscode.window.createStatusBarItem('oi.pet', vscode.StatusBarAlignment.Left, -1000);
  private timer?: NodeJS.Timeout;
  private pos = 0;
  private dir = STEP;

  constructor() {
    this.item.name = 'Claude Status pet';
    this.item.command = 'oi.ack';
    this.item.tooltip = 'Click to stop';
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), TICK);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.item.hide();
  }

  private step() {
    if (this.pos + this.dir < 0 || this.pos + this.dir > SPAN) this.dir = -this.dir;
    this.pos += this.dir;
    this.item.text = ' '.repeat(this.pos) + PET;
    this.item.show();
  }

  dispose() {
    this.stop();
    this.item.dispose();
  }
}
