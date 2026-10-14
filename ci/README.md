# Server-side check

The guard on a developer's machine only helps machines that have it. These two pieces check the
repository itself, so an infected branch is noticed even when it comes from a machine without the guard.

## 1. GitHub Actions: scan every push and pull request

1. Build the scanner and copy its three files into the repository you want to watch:

   ```
   npm run build:cli                         # in this repository
   mkdir -p <repo>/tools/npm-guard
   cp cli/dist/cli.js cli/dist/core.js cli/dist/install.js <repo>/tools/npm-guard/
   ```

2. Copy `ci/npm-guard.yml` to `<repo>/.github/workflows/npm-guard.yml` and commit both.

The job runs `node tools/npm-guard/cli.js scan .` and fails (exit code 1) when the loader is found.

Once the `npm-guard` package is published you can replace step 1 with
`npx --yes @meetroj/npm-guard@<exact version> scan .` in the workflow and skip vendoring.

### What this does and does not do

- **It detects, after the push.** A push to `main` is already on `main` when the job runs. The job
  turns red and GitHub emails whoever pushed, which is how an infected commit gets noticed. It does
  not undo the push.
- **To actually stop a bad commit reaching `main`**, make this job a *required status check* and
  protect the branch (Settings, Branches, branch protection rule). That also forces changes to
  arrive by pull request, so it conflicts with pushing straight to `main`. That trade-off is yours.
- It reports "no threats detected by the current rules", which is not a guarantee.

## 2. A deploy gate: scan inside the image build

For a service that deploys from a Dockerfile, scan before the build continues, so an infected tree
never becomes a running image. Add this near the top of the build stage, after the source is copied
and before `npm install` runs anything:

```dockerfile
COPY tools/npm-guard /tmp/npm-guard
RUN node /tmp/npm-guard/cli.js scan . && rm -rf /tmp/npm-guard
```

If the scan finds the loader the build fails and nothing is deployed.

**Not applied anywhere yet.** For the CoraCure backend a push to `main` deploys at once, so this
change should be made deliberately, by you, in that repository, and checked on a build first.
