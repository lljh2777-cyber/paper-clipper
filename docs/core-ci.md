# Core Continuous Integration

[Paper Core](../.github/workflows/paper-core.yml) runs on pushes to `main`, pull
requests, and manual Actions dispatch. Its four jobs cover GitHub-hosted Windows
and Linux with Node.js 22.12.0 (the declared minimum) and Node.js 24.

Each job tests the exporter using Node alone, then exports the allowlisted core
into the runner's temporary directory, outside the source checkout. The source
repository's extension dependencies are never installed. This keeps a missing
core file or dependency from being accidentally supplied by the parent checkout.

The exported lockfile is seeded from the full repository. CI first runs
`npm install --package-lock-only --ignore-scripts` to prune it without creating
`node_modules`, then installs with `npm ci`. The source lockfile is not modified.
CI installs Chromium and its platform dependencies through the installed
Playwright CLI, runs the core's `npm test` (including the CLI build), and checks
the Agent command's `--help` entry point. Export, install, build and test failures
all fail the job; other matrix jobs still run to expose platform-specific failures.

## Boundaries

- Tests use synthetic HTML, stubbed requests, temporary profiles/Vaults and
  loopback HTTP servers. They do not need publisher credentials or API keys.
- The eight private real-paper acceptance captures are not in Git and are not
  run or downloaded in CI. Their local acceptance procedure remains separate.
- The pipeline does not test extension UI, Obsidian desktop rendering, live
  publisher access, institutional authentication, or whole-paper equivalence.
- Dependency, Node and Chromium installation need network access. Test fixtures
  do not require a live publisher. Browser installation failures are not skipped.
- No output directories, browser profiles or paper artifacts are uploaded.
  Actions logs contain the synthetic test output only.
- Workflow permissions are read-only, checkout does not persist credentials,
  actions are pinned to release commits, and no repository secrets are passed
  to the tests. Only ordinary `pull_request`, not `pull_request_target`, is used.

The workflow is a test configuration, not evidence that a hosted run succeeded.
After pushing it, inspect all four jobs in GitHub Actions. Repository Actions
settings may require enabling workflows or approving a first-time contributor.
Required status checks/branch protection are separate repository settings and
are not changed by adding this file.

## Local Reproduction

From the full repository, export into a **new directory outside the checkout**:

```sh
node --test scripts/export-paper-core.test.mjs
node scripts/export-paper-core.mjs -o ../paper-core-ci-check
```

In that new directory (before `node_modules` exists):

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci --no-audit --no-fund
node node_modules/playwright/cli.js install --with-deps chromium
npm test
node scripts/save-paper.mjs --help
```

Keep the existing working core and personal data unchanged. To repeat this fresh
installation check, choose another new directory; no recursive cleanup is needed.
Do not run these install commands against an existing working `node_modules` if
you need to preserve it. Local tests on one platform are not substitutes for the
other hosted matrix jobs.

Configuration references: [checkout](https://github.com/actions/checkout),
[setup-node](https://github.com/actions/setup-node),
[npm lock-only installation](https://docs.npmjs.com/cli/v11/commands/npm-install/),
and [Playwright CI](https://playwright.dev/docs/ci).
