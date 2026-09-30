# Install and update with-scripts

Install the CLI from its Git repository. You need access to
`studioleismann/with-scripts`, Node.js 20.12.0 or newer, npm, and Git.

## Install once

The following example uses the shared layout for theme/tool sources. You can choose
another directory and pass explicit source paths to those commands:

```sh
mkdir -p ~/code/packages
cd ~/code/packages
git clone git@github.com:studioleismann/with-scripts.git
cd with-scripts
npm ci
npm link
```

Confirm that your shell resolves the command:

```sh
command -v with-scripts
with-scripts --help
```

`npm link` exposes this checkout's executable. Local source changes are available
through that link. If your shell cannot find it, check your Node installation's npm
prefix and executable path.

Prepare DDEV and a Docker provider before running local WordPress commands. For
`setup-theme` and `sync-tools`, also prepare the three
[shared tool repositories](../reference/requirements.md#shared-tool-repositories).

## Update an existing checkout

Inspect the package checkout and finish or preserve local work before updating:

```sh
cd ~/code/packages/with-scripts
git status
git branch --show-current
git remote -v
```

On the intended branch with a clean worktree, update and reinstall the locked
runtime dependencies:

```sh
git pull --ff-only
npm ci
with-scripts --help
```

If you changed Node installations or moved the checkout, run `npm link` again from
this package directory. Shared tool repositories have their own update process;
`with-scripts` uses their current local contents.

For development validation, install local PHP CLI and run `npm run verify` as
explained in [Develop and verify with-scripts](develop-with-scripts.md).
