# Set up a website repository and release deployment

Run this command inside the local WordPress website or one of its subdirectories:

```sh
with-scripts setup-deployment
```

It prepares the complete website **code repository**: selected custom themes and
plugins, DDEV configuration, documentation, and release deployment. WordPress Core,
third-party code, uploads, database dumps, and local credentials stay outside Git.
The command creates a private GitHub repository when needed and commits/pushes the
validated source. Publishing a release later starts the production deployment.

## Choose the GitHub repository

The GitHub owner is freely selectable. An existing `origin` supplies `owner/name`;
otherwise the wizard asks for the owner/organization and repository name. Pass a
fully qualified name to choose it explicitly:

```sh
with-scripts setup-deployment --repo=example-owner/example.org
```

A different existing origin is preserved and stops setup. Existing GitHub
repositories must be private, and the signed-in account needs administrator access
for repository configuration. Setup creates no releases and changes no repository
visibility. Use a clean default-branch checkout; it preserves unrelated work and
never force-pushes.

## Reuse the site's settings

`wordpressDeployment` in the ignored `.with-scripts.json` stores repeatable setup
settings. Explicit options override these defaults. On first setup, `wordpressPull`
supplies `sshTarget`, `remoteRoot`, and `liveUrl`; `ssh -G` resolves that alias to the
real hostname, user, and port required by GitHub Actions. An alias/target mismatch
stops setup.

The SSH alias uses the existing local SSH configuration and agent for the setup
connection. A separate passphrase-free Ed25519 key is used by GitHub Actions. It is
kept in a regular private file outside the repository, by default
`~/.ssh/<owner>-<repository>-deployment`. Keep the containing directory available.
Passwords, when needed for the setup connection, are entered in the terminal.

The server's ED25519 key is pinned from an existing `known_hosts` entry, or matched
against `--fingerprint` supplied from an independently trusted provider/server
source. A key scan discovers candidates; it does not establish trust by itself.

## Select owned code and preview

Already tracked theme/plugin/MU-plugin roots retain ownership. Use repeatable
`--component` options to add components, or the shorter `--theme`/`--plugin` options.
With no existing selection, the interactive wizard asks; a non-interactive preview
requires explicit components. Running from a theme subdirectory selects that theme.

```sh
with-scripts setup-deployment --dry-run \
  --repo=example-owner/example.org \
  --ssh=example-site \
  --root=/srv/example/httpdocs \
  --url=https://example.org \
  --theme=example-theme \
  --component=wp-content/plugins/example-plugin
```

A preview assembles a temporary local Git tree, checks selection and exclusion rules,
and prints the plan. It writes no project files, keys, GitHub settings, or server
files; it may run `ssh -G` to read local alias settings. It performs no network,
dependency installation, or build. Existing template conflicts include a diff.

A component with `package.json` needs a non-empty `files` array describing its
production package. A `build` script also requires `package-lock.json`. Components
without a manifest are exported from the release Git tree. Mark development-only
source files with `.gitattributes` `export-ignore` when appropriate.

## Apply and verify

Remove `--dry-run` and review the plan. Real setup performs:

1. GitHub access and branch checks, source/credential-pattern checks, and inspection
   of unpublished Git history for credential files and key/token patterns.
2. The full deployment integration suite and actual package build in an isolated
   Git copy, preferring Node.js 24 in the running DDEV web container and falling
   back to local Node.js 24. Project
   source, dependencies, build output, and DDEV configuration stay unchanged.
3. Setup confirmation, host-key verification, dedicated key generation/reuse, and
   idempotent public-key authorization through existing SSH access. Existing
   `authorized_keys` bytes and permissions are preserved; symlinks are rejected.
4. Dedicated key authentication with the agent disabled and a read-only server
   preflight against the production WordPress root.
5. Private repository creation/reuse, two repository variables and five secrets,
   followed by variable-value and secret-name read-back.
6. Local template installation, commit and push, then comparison with the remote
   commit. The validated source is checked again before committing/pushing.

Prerequisites: Git with configured author identity, authenticated `gh`, SSH tools,
existing SSH access to the account, and Node.js 24 locally or in running DDEV. Builds
may download npm dependencies. The target needs a public IPv4 SSH endpoint, POSIX
shell and standard file/tar utilities, plus write access below `wp-content`.

For non-interactive execution, `--yes` accepts the printed setup plan when all
inputs are resolved. It preserves unknown/different existing secrets. Use
`--replace-secrets` only after deliberately reviewing their replacement.

| GitHub values | Names |
| --- | --- |
| Repository variables | `WORDPRESS_ROOT`, `LIVE_URL` |
| Repository secrets | `HOST`, `USERNAME`, `PORT`, `FINGERPRINT`, `KEY` |

Private-key bytes are sent through GitHub CLI stdin, never command arguments or
saved project settings. GitHub returns secret names, not stored secret values;
setup verifies successful writes and the returned names. A completed setup is local
build, SSH, and configuration evidence. The first published release's Actions run
still needs verification from GitHub's runner.

## Repeat, resume, and update templates

Retry with the same command or saved settings. An existing repository/key is reused.
Each successful secret write is recorded in `.with-scripts.json`; completed writes
are skipped on an unchanged retry. Missing values are repaired. If existing secrets
have no matching saved setup, replacing them requires explicit confirmation or
`--replace-secrets`. Keep the local settings file to preserve this progress.

A failed build leaves the project and external services unchanged. Later failures
retain the generated key, repository, and successful configuration steps. A failed
push retains the local commit. If a commit hook fails, review the staged files and
complete or unstage that commit before retrying.

The versioned template lives in `templates/wordpress-site`. The installed
`.github/with-scripts-deployment.json` records its version and generated file hashes.
A rerun can update files that still match their recorded version. Changed deployment
files produce a diff and stop setup. Existing documentation and custom ignore rules
are preserved; a managed ignore block carries the shared exclusions and component
allowlist. DDEV settings are kept as configured.

Older custom deployment workflows need a deliberate merge into the new template.
Legacy `--temp`, `--hosting-url`, `--plugin-main`, and `--plugin-health` options are
superseded by the transaction workflow and repository-derived component ownership.

## Publish the first deployment

Follow [Deploy custom WordPress code](deploy-custom-wordpress-code.md). The workflow
uses `release: published` and checks out the published tag. Published prereleases
also deploy. Review the release commit and target before publishing, then inspect
the Actions run and the changed live behavior.

## Try an offline demonstration

```sh
with-scripts setup-deployment --demo
```

Use `--demo` on its own from any folder. Enter advances through five simulated
stages; Ctrl-C exits. No project, account, key, or server access is needed.
