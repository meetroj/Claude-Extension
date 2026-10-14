# Status for Claude Code

See your Claude Code usage at a glance, right in the VS Code status bar.

- **What Claude is doing**: working, done or stopped, for the folder you have open.
- **Today's tokens**: input and output tokens across all your folders. Cache re-reads are not counted, so the number matches what Claude actually wrote and read fresh.
- **Hover card**: your plan limits (5h, 7d, per model), today's tokens by model and the current prompt.
- **Click it** to open the **Claude Usage** view with every session and subagent, with tokens for each.

Everything is read from files Claude Code already keeps on disk, and nothing is sent anywhere. Plan limits are whatever Claude Code last fetched, so the card says when that was.

## Extras

Run **Claude Status: Walk in the status bar** from the Command Palette to get a small cat walking along the middle of the status bar. Click it to stop it.

## npm-guard (malware loader check)

Looks for the obfuscated `api.js` loader family that hides in `package.json` scripts, config files and fake font files, and for a tampered VS Code startup file.

- **On open**: the folder is scanned. Scanning reads file contents without executing or modifying project code, so it is allowed in an untrusted workspace. The status bar shows `Guard: none found` or `Guard: N found`; click it to scan again. "None found" means no threats were detected by the current rules, not that the folder is proven safe.
- **Fix**: **npm-guard: Fix** never deletes a file. It changes a file only where the malicious part has an exact boundary (code after a long run of spaces, or from a loader marker to the end of that line), and it drops a `node file.js &&` prefix from a script only when that file is itself flagged by what it contains. A file name such as `api.js` is never a reason to change anything. A loader file, or anything it cannot place exactly, is listed for you to deal with.
  - It shows the exact changes first (line, characters removed, the removed text), then asks, and asks again.
  - Originals are saved to `~/.npm-guard/quarantine/` before anything is written, and the whole folder is scanned again afterwards.
  - If a file changed between the preview and the apply, it is left alone.
- **Restore**: **npm-guard: Restore** asks first, because it puts the original (infected) version back. A file you edited after the fix is not overwritten.
- **Git is not the backup**: git only brings back what was committed. Uncommitted edits and untracked or ignored files are not in git, so for those the npm-guard backup is the only copy. Fix shows, per file, what git can and cannot bring back.
- **Protect this repository**: a repository with its own hooks folder (husky) is not reached by the machine-wide git hooks. **npm-guard: Protect this repository** previews, then adds a five-line block to that repository's own pre-commit and pre-push (after you confirm twice); **Unprotect** removes exactly those lines. When protection is on and a repository bypasses it, the editor says so once.
- **Turn on protection** (opt in): git refuses to commit or push an infected tree, warns after a pull or branch switch, and Claude Code is stopped from running `npm`/`node`/`git push` in an infected folder. **npm-guard: Turn off protection** reverses exactly that.

Turning protection on installs no npm package and downloads nothing: it copies the guard's own files, sets git's hooks path only if you have none, and adds one hook to Claude Code's settings. Turning it off removes only those, and keeps any settings you changed since.

The same tool runs outside the editor: `node ~/.npm-guard/cli.js scan|fix|restore|status|protect-repo`.

- **As an npm command**: `cli/` is the installable `npm-guard` package (`npm run build:cli`). Installing it changes nothing but adds the command; `npm-guard install` is a separate step. It is marked `private` until you choose the name and licence.
- **Server side**: `ci/` has a GitHub Actions workflow and a Dockerfile gate. See `ci/README.md` for what they detect and what they cannot prevent.
