# Deploy production

This is the operational guide for deploying the website repository. The
workflow is implemented in `.github/workflows/deploy-production.yml` and runs
only when a GitHub Release is published. A push to `main` or a draft release
does not deploy production.

## Configure the repository

Create these GitHub Actions repository secrets:

- `HOST`: SSH server hostname;
- `USERNAME`: dedicated SSH deployment account;
- `KEY`: private deployment key;
- `PORT`: SSH port; and
- `FINGERPRINT`: exact SHA256 fingerprint of the server host key selected by
  the deployment Actions. The current Actions prefer ECDSA over RSA and Ed25519.
  Confirm that key's fingerprint with the hosting provider or server console;
  a regular OpenSSH login may select a different key. The deployment login key
  and the server host key have separate fingerprints.

Create these GitHub Actions repository variables:

- `WORDPRESS_ROOT`: absolute path to the WordPress installation, without a
  trailing slash; and
- `LIVE_URL`: public production URL used by the smoke tests.

Do not commit either value to a reusable theme or plugin. They belong to the
website repository's GitHub configuration.

The SSH account must be able to write below `wp-content` and rename the
repository-managed components. The server needs a POSIX-compatible `sh` plus
`cat`, `find`, `mkdir`, `mv`, `rm`, `tar` with gzip support, and `test`. It does
not need Git, Node.js, npm, `rsync`, or SFTP. The WordPress root, `wp-content`,
and the standard component roots must not be symbolic links.

`HOST` must resolve to a public IPv4 address that accepts SSH connections on
`PORT`. The workflow checks IPv4 connectivity before uploading. Every SCP and
SSH Action verifies `FINGERPRINT` during its SSH handshake. If a handshake reports
a fingerprint mismatch, verify the host-key type selected by the Actions against
the provider's trusted fingerprint before updating the secret.

## Define deployable components

There is no configured theme or plugin slug. The release script derives
ownership from the tagged Git tree. Each first-level tracked entry below one of
these roots is one deployable component:

```text
wp-content/themes/
wp-content/plugins/
wp-content/mu-plugins/
```

A directory plugin and a single-file plugin are both supported. Ignored or
untracked live components are not adopted or removed. A tracked path elsewhere
below `wp-content` stops the build so production code cannot be skipped
silently.

For a component with `package.json`:

1. Add a non-empty `files` array that defines its production package.
2. Commit `package-lock.json` when the component has a `build` script.
3. Keep generated production files inside the package defined by `files`.

The workflow runs `npm ci` when a lockfile exists, runs `npm run build` when a
build script exists, and packages the component with `npm pack`.

A component without `package.json` is exported directly from the release Git
tree. Mark tracked development-only files with `export-ignore` in that
component's `.gitattributes` file.

Packages containing symbolic links, `node_modules`, a nested `.git` directory,
unsafe paths, or no files are rejected before upload.

## Publish a deployment

1. Develop and validate all component changes locally.
2. Commit the complete website revision and merge it to `main`.
3. In GitHub, create a release and create its version tag from the intended
   commit on `main`.
4. Publish the release.
5. Open the `Deploy production` workflow run and wait for every step to finish.
6. Verify the changed production behavior after the workflow succeeds.

The workflow checks out the release tag, not the latest state of `main`.

## Understand the production switch

The runner first executes the deployment integration suite. It then builds one
validated archive and a generated component manifest, verifies the configured
SSH host fingerprint, performs remote preflight checks, and uploads the archive
into a run-specific workspace below `wp-content`.

On the first successful deployment, current repository components are adopted
and replaced as complete units. Unknown live-only components remain untouched.
The resulting `.with-deploy-manifest` records repository ownership for later
releases.

On subsequent deployments:

- components in both manifests are replaced completely;
- newly tracked components are installed;
- components removed from Git are removed from production; and
- paths absent from both manifests remain untouched.

The switch temporarily enables WordPress filesystem maintenance mode, renames
the affected components into rollback storage, activates every candidate, and
installs the new manifest. Replacing complete component directories is why a
file deleted in Git also disappears from production.

After the switch, the workflow requests the homepage with a unique
`with_deploy_check` query value and a `Cache-Control: no-cache` request header,
plus `style.css` for every deployed theme. This exercises PHP instead of trusting
a previously cached homepage. The homepage must return HTTP 200, or the explicitly recognized
HTTP 503 page from Admin Site Enhancements.

If verification fails, the workflow restores the previous components and
manifest. A failed rollback retains both the run workspace and workflow-owned
maintenance mode for safe inspection and does not perform broad cleanup. A
successful deployment or rollback removes only its own workspace.

Do not edit a managed live component over SSH. The next successful deployment
replaces that complete component from the repository package.
