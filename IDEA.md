# Oi! — the agent mascot that will not let you ignore it

> Working name. Alternatives: `Nudge`, `Pester`, `Hey!`
> The pet shouts **your own name**, so the extension is named after the gag, not the pet.

---

## 1. One-line pitch

A tiny pixel pet lives at the bottom of VS Code. It paces while your AI agent
works, and when the agent finishes it starts jumping and shouting your name —
and the longer you ignore it, the more of VS Code it takes over.

---

## 2. The three states

| State | When | What the pet does |
|---|---|---|
| `idle` | nothing running | sits still in the status bar, blinks occasionally |
| `working` | agent is running | paces left and right along the status bar |
| `done` | agent finished | climbs up into the panel, jumps, shouts your name |

The `done` state does not stop on its own. It escalates until you come back.

---

## 3. Where it lives on screen

Two surfaces, on purpose.

```
├──────────────────────────────────────────────────────┤
│ TERMINAL  PROBLEMS  meeett! ✕                        │  <- PANEL
│                                                      │     webview, full HTML/CSS
│                  (cat)                               │     this is where it JUMPS
│                 meeett!                              │
├──────────────────────────────────────────────────────┤
│ main  0 errors     (cat) ->      Ln 4, Col 9  UTF-8  │  <- STATUS BAR
└──────────────────────────────────────────────────────┘     text only
                                                             this is where it WALKS
```

**Why split it**

- The status bar is one line of fixed height. It is a perfect *corridor* for
  pacing left and right, and it costs nothing — no webview, no build step.
- The status bar physically **cannot jump**. There is no vertical space and no
  API for it. So the jump happens one level up, in the panel.
- That limitation becomes the joke: the pet starts at the very bottom edge of
  the screen and works its way **upward and outward** as it gets more desperate.

**What is NOT possible — do not promise this**

Drawing the pet on top of the Claude Code / Codex chat input. Those extensions
render their chat inside their own sandboxed webview. No VS Code extension can
inject DOM into another extension's webview. The only way to get overlapping
pixels is patching VS Code's own `workbench.html` (the "Custom CSS and JS
Loader" route), which triggers the corruption warning, breaks on every VS Code
update, and cannot be published to the Marketplace. The panel directly beneath
the chat is as close as the platform allows.

---

## 4. The escalation ladder — this is the actual product

Every rung invades a **new** VS Code surface. Nobody has built this.

| Ignored for | What happens | API used |
|---|---|---|
| 0s | small bounce in the panel, text reads `meet!` | webview |
| ~20s | status bar joins in — `meet!` down in the corner | `createStatusBarItem` |
| ~40s | the **panel tab title itself** starts stretching -> `meeett!` | `webviewView.title = ...` |
| ~60s | blue badge appears on the view, counting the jumps | `webviewView.badge = {value, tooltip}` |
| ~90s | it **clones** — a second pet appears in the status bar | second `createStatusBarItem` |
| ~2m | `MEEETTT!!!` across the tab, 4-5 clones, panel shakes | all of the above |
| ~3m | desktop notification — it has left VS Code entirely | `showInformationMessage` |

**Stop condition:** any acknowledgement -> everything snaps back instantly, one
confetti burst, pet returns to `idle`, all clones removed.

---

## 5. The name-stretch rule

The original example, which the rule must reproduce exactly:

```
meet!  ->  meeett!  ->  meeettt!!
```

Split the name into `head` + `vowelRun` + `tail`. For `meet`: `m` + `ee` + `t`.

```
level n:
  vowels = baseVowels + ceil(n / 2)      // "ee" grows every OTHER level
  tail   = baseTail   + n                // "t"  grows every level
  bangs  = 1 + floor(n / 2)              // "!"  grows every other level
```

Verified output:

| n | vowels | tail | bangs | result |
|---|---|---|---|---|
| 0 | 2 | 1 | 1 | `meet!` |
| 1 | 3 | 2 | 1 | `meeett!` |
| 2 | 3 | 3 | 2 | `meeettt!!` |
| 3 | 4 | 4 | 2 | `meeeetttt!!` |
| 4 | 4 | 5 | 3 | `meeeettttt!!!` |

The first three match the original example exactly.

Jump height rises alongside it: `height = min(20 + n * 8, 120)` px — capped so
the pet does not leave the panel.

Runnable check: `node name-stretch.js`

---

## 6. How the extension knows the agent is running

This is the half people get wrong. Agent extensions do not broadcast "I am
thinking" events to other extensions. Two real mechanisms plus a fallback.

### A. Claude Code hooks — the clean way

Claude Code runs shell commands on lifecycle events. Write state to one file,
watch that file. Goes in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "echo working > %USERPROFILE%\\.oi-state" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "echo done > %USERPROFILE%\\.oi-state" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "echo blocked > %USERPROFILE%\\.oi-state" }] }]
  }
}
```

Extension side: `fs.watch` on that file -> `webview.postMessage({state})`.

Ship a one-click **"Oi: Set up Claude Code hooks"** command that writes this
block for the user. Hand-editing JSON is where people give up.

### B. Terminal shell execution — Codex and any CLI agent

```ts
vscode.window.onDidStartTerminalShellExecution(e => { /* working */ })
vscode.window.onDidEndTerminalShellExecution(e => { /* done */ })
```

Real API. Needs shell integration, which is on by default for pwsh, bash, zsh.

### C. Manual fallback

A status bar button that toggles the state by hand. Ugly, but it means the
extension is never dead on arrival for an agent nobody has integrated yet.

---

## 7. What counts as "the developer came back"

You cannot detect a click inside the Claude Code chat box. Detectable
acknowledgements, all real APIs:

- click the pet itself -> `webview.onDidReceiveMessage` / status bar `command`
- VS Code window regained focus -> `vscode.window.onDidChangeWindowState`
- caret moved or typing started -> `vscode.window.onDidChangeTextEditorSelection`
- a new agent run started -> the hook fires again

Any of these = acknowledged. Reset to `idle`.

---

## 8. Files to build

```
extension/
├── package.json          contributes: viewsContainers.panel, views (type: webview),
│                         commands, configuration, icons (custom sprite font)
├── src/
│   ├── extension.ts      activate() — wires everything together
│   ├── agentState.ts     THE ENGINE: hooks file watcher + terminal events.
│   │                     Emits 'idle' | 'working' | 'done' | 'blocked'
│   ├── statusBar.ts      the walking pet (text + spaces, rewritten on a timer)
│   ├── panelView.ts      registerWebviewViewProvider — the jumping pet
│   ├── escalation.ts     the ladder from section 4, one timer
│   └── nameStretch.ts    the rule from section 5
├── media/
│   ├── pet.html / pet.css / pet.js
│   └── sprites/          32x32 frames: walk, idle, sleep, jump, shout
└── name-stretch.js       standalone self-check for the stretch rule
```

**Keep `agentState.ts` as its own module from day one.** It is the reusable
engine — the same file powers every follow-up idea (multi-agent dashboard,
"it needs you" alerter, session cost tracker). The pet is just the first thing
plugged into it.

---

## 9. Settings

| Setting | Default | What it does |
|---|---|---|
| `oi.name` | `"meet"` | the name it shouts |
| `oi.pet` | `"cat"` | sprite set |
| `oi.escalate` | `true` | off = one polite jump, no ladder |
| `oi.maxLevel` | `8` | where the escalation stops climbing |
| `oi.sound` | `false` | opt-in, off by default |
| `oi.notifyAfter` | `180` | seconds before the desktop-notification rung |

Escalation must be capped and disableable. A pet that will not shut up during a
screenshare is an uninstall.

---

## 10. Build order

1. `npx --package yo --package generator-code -- yo code` -> TypeScript extension
2. **Status bar walker only.** Emoji, no webview, no build step. Fake the state
   with two commands (`Oi: Start` / `Oi: Stop`). About 40 lines. Proves the walk.
3. **Wire `agentState.ts`** to the Claude Code hooks file. Now it moves on its own.
4. **Add the panel webview.** Emoji again, plain HTML. Get the jump and the name
   stretch working.
5. **Add the escalation ladder.** Tab title, badge, clones, notification.
6. **Swap emoji for sprites.** Webview assets need `webview.asWebviewUri`,
   `localResourceRoots`, and a `nonce` on the script tag — VS Code webview CSP
   blocks everything else.
7. `npx vsce package` -> `.vsix` -> install locally, live with it for a week.
8. `npx vsce publish` once it stops annoying you personally.

---

## 11. Why anyone downloads it

The escalation is the share, not the pet. A screenshot of a status bar with five
cats in it all screaming `MEEETTT!!!` is the post. Every existing mascot
extension is one widget sitting in one spot doing one loop — none of them
escalate across surfaces, and none of them are wired to an AI agent's lifecycle.

---

## 12. Open questions

- Sprite art: draw it, commission it, or ship emoji v1 and add art later?
- Does the pet get a name of its own, or is it always just your name?
- Multi-agent: one pet per running session, or one pet total?
