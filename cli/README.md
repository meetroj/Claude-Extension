# npm-guard

Finds, and safely fixes, a family of obfuscated malware loaders that hide in a project: an `api.js`
file, a `node api.js &&` prefix in `package.json` scripts, a payload hidden after a long run of spaces
at the end of a config file, and fake font files that are really JavaScript.

```
npm install -g @meetroj/npm-guard      # installs the command only; it changes nothing else
npm-guard scan [folder]       # look; exit code 1 if something is found
npm-guard fix [folder]        # shows the exact changes, asks twice, backs up first
npm-guard restore             # asks first; will not overwrite edits you made after the fix
```

**Installing the package does not touch your git or editor settings.** Protection is a separate,
explicit step that lists everything it will change and asks first:

```
npm-guard install             # git hooks (commit, push, pull, branch switch) + Claude Code hook
npm-guard uninstall           # removes exactly that, and keeps settings you changed since
npm-guard protect-repo        # a repo with its own hooks folder (husky) bypasses the machine-wide hooks
npm-guard unprotect-repo      # removes exactly that block again
```

## What it will and will not do

- Scanning reads file contents without executing or modifying project code.
- It reports "no threats detected by the current rules". That is not a guarantee that nothing is there.
- **It never deletes a file.** A loader file is listed for you to remove yourself.
- It changes a file only where the malicious part has an exact boundary, and shows you that change first.
- A file that changed between the preview and the apply is left alone.
- Git only brings back what was committed. Uncommitted edits and untracked files are not in git, so for
  those the npm-guard backup (`~/.npm-guard/quarantine/`) is the only copy.
- It installs no npm package and downloads nothing. It needs only Node 18+ and git.

## In CI

See `ci/README.md` in the repository for a GitHub Actions workflow that runs `npm-guard scan`.
