# Repository-driven WordPress deployment specification

Status: Implemented locally. Production rollout and acceptance remain pending.

The previous theme-only draft is withdrawn. This document starts from the
website repository as the deployment source and treats themes and plugins as
equal deployable components.

## Purpose

Deploy the source-controlled custom code of a WordPress website from a
published GitHub Release to production over SSH.

The production result must match the released code inside every
repository-managed component, including file deletions. WordPress Core,
uploads, configuration, the database, third-party packages, and other
live-only data must remain untouched.

The same workflow design must support a website repository containing:

- one or more custom themes;
- one or more custom plugins;
- MU-plugins;
- components with an npm build;
- components without a build step; and
- live themes and plugins that are intentionally not version-controlled.

No customer-specific theme slug, plugin slug, or internal component directory
may be hard-coded into the deployment logic.

## Core decisions for review

- The release belongs to the website repository, not to one theme.
- Git automatically identifies every repository-managed WordPress component.
- Themes, plugins, and MU-plugins use the same deployment transaction.
- Each component defines its own package contents; the workflow has no
  component-internal file list.
- Whole components are replaced so deleted files disappear reliably.
- A small production manifest distinguishes formerly repository-managed
  components from unrelated live-only components.
- One failed component restores the complete previous component set.

## Rejected approaches

- Overlay extraction is rejected because files deleted in Git remain live.
- Replacing all of `themes` or `plugins` is rejected because it would delete
  unrelated live-only components.
- Hard-coded theme, plugin, or internal file lists are rejected because the
  workflow would stop representing the website repository as it evolves.
- Directly deleting a target before upload is rejected because a failed
  transfer could leave production without working code.
- Server-side Git and remote `rsync` are rejected because they are not part of
  the shared hosting baseline.
- A permanent release-and-symlink tree is rejected as unnecessary for the
  current hosting and availability requirements.

An SSH or SCP GitHub Action can provide transport, but it cannot by itself
decide which production components belong to this repository or perform a
multi-component rollback. The workflow therefore must not rely on an action's
`overwrite` or target-removal option as its consistency model.

## System model

The GitHub repository represents the version-controlled website project. It
also contains local DDEV configuration, documentation, and the GitHub
workflow, but those project files are not production WordPress code.

The deployment source is the release tag's Git tree below these standard
WordPress locations:

- `wp-content/themes`;
- `wp-content/plugins`;
- `wp-content/mu-plugins`.

Every version-controlled first-level entry below one of those locations is a
managed component. A component can be a directory or, where WordPress permits
it, a single file.

Examples of component paths are:

```text
wp-content/themes/customer-theme
wp-content/plugins/customer-plugin
wp-content/plugins/single-file-plugin.php
wp-content/mu-plugins/customer-loader.php
wp-content/mu-plugins/customer-module
```

These examples explain the path shape only. Their names must not appear in the
workflow.

The current Natascha release contains one managed component because only one
custom theme is tracked. If a custom plugin is later committed below
`wp-content/plugins`, the same workflow must discover, build, package, deploy,
verify, and roll it back without adding a plugin slug to the workflow.

## Ownership boundary

Git tracking establishes component ownership.

Once a component has been deployed by this workflow, its complete production
path is repository-managed. A successful release replaces the whole component
with the packaged release version. Manual production edits inside that path
are unsupported and are removed by a later deployment.

Paths that have never been listed as managed components remain outside this
workflow. In particular, an ignored or live-only plugin must not be modified
merely because it is located beside a repository-managed plugin.

A component must have only one update owner:

- a component tracked in the website repository is updated by website
  releases; or
- an independently released plugin is updated by its own WordPress updater.

The same component must not use both mechanisms. Independently managed plugins
that are not tracked by the website repository remain untouched.

WordPress auto-updates and independent updater integrations must be disabled
for repository-managed components so they cannot change production behind the
website release workflow.

## Explicit exclusions

The normal website release must not deploy or modify:

- WordPress Core;
- `wp-config.php`, server configuration, or environment secrets;
- the database or database-backed WordPress content;
- uploads, caches, backups, logs, or temporary runtime files;
- third-party themes or plugins not tracked by the repository;
- independently released plugins not tracked by the repository; or
- DDEV configuration, project documentation, or GitHub configuration.

A first launch, a database migration, plugin activation, and WordPress Core or
third-party package updates are separate operations.

## Release trigger and configuration

The workflow continues to run only when a GitHub Release is published. It must
check out `github.event.release.tag_name`, not the current state of `main`.

The existing repository variables remain:

- `WORDPRESS_ROOT`: absolute production WordPress root;
- `LIVE_URL`: public production URL.

The existing repository secrets remain:

- `HOST`;
- `USERNAME`;
- `KEY`;
- `PORT`;
- `FINGERPRINT`.

Component slugs are not configuration. `THEME_SLUG` and `PLUGIN_SLUG` are not
part of the workflow because Git discovers the components.

The production concurrency group remains serialized with
`cancel-in-progress: false`.

## Component discovery

Discovery must use `git ls-files` after checking out the release tag. It must
not scan the local WordPress installation because ignored third-party code may
be present locally but is absent from the release's ownership model.

```text
tracked_paths = git ls-files below the three supported wp-content roots
components = empty set

for each tracked_path:
    validate that the path is relative and contains no traversal
    identify its first-level entry below themes, plugins, or mu-plugins
    add that entry's complete relative path to components

sort components deterministically
fail if components is empty
fail if two component paths overlap
fail if a component resolves outside its expected WordPress root
```

The first-level name must start with a letter or number and may then contain
only letters, numbers, dots, underscores, and hyphens. `.` and `..` are always
invalid. A path that cannot be represented safely in the deployment manifest
must fail the workflow instead of being silently skipped.

Tracked production code elsewhere below `wp-content` is outside the initial
implementation. If such a path is added later, discovery must fail and explain
that the supported ownership model needs to be extended. It must not silently
leave version-controlled production code undeployed.

## Build and packaging contract

Each component owns its internal production-file definition. The deployment
workflow owns only component discovery and transport; it must not contain a
list such as `assets`, `build`, `inc`, `templates`, or individual PHP files.

### Components with package metadata

For a component containing `package.json`:

1. If `package-lock.json` exists, run `npm ci` inside that component.
2. If `scripts.build` exists, run `npm run build`.
3. Require an explicit `package.json#files` distribution contract.
4. Run `npm pack --json` after the build.
5. Extract the package contents into the component's clean staging path.

`npm pack` is used because it is the standard packaging mechanism already
underlying the existing `@wordpress/scripts` ZIP command. The workflow does
not need to know whether the component is a theme or a plugin, nor where that
component stores its generated assets.

If a build requires npm dependencies but has no lockfile, the workflow must
fail because the release would not be reproducible.

The Natascha theme's former broad `package.json#files` pattern included
development-only files. The implementation replaces it with an explicit
runtime package contract in the component metadata, not in a
workflow-specific file list.

### Components without package metadata

A component without `package.json` is treated as source-only WordPress code.
Its staged package is created with `git archive` from the release tag and
contains its Git-tracked files, respecting standard `export-ignore`
attributes. This supports small PHP-only plugins and MU-plugins without adding
npm solely for deployment.

For such a component, every tracked file is intentionally part of production.
Development-only tracked files can be marked `export-ignore` in a versioned
`.gitattributes` file. The workflow still does not contain component-specific
paths.

Such a component cannot rely on untracked generated runtime files. If it later
requires a build, it must add an explicit reproducible packaging contract.

### Package validation

Every staged component must be non-empty. The runner must also verify:

- every staged path remains below its component root;
- no package contains an absolute path or parent-directory traversal;
- no package contains `node_modules` or a nested `.git` directory;
- no package contains a symbolic link;
- a component root is not itself a symbolic link;
- an npm package was created by the current workflow run; and
- the final site artifact contains exactly the staged component contents.

Theme- or plugin-specific runtime files are not listed in the workflow. Their
presence is part of the component's own package contract and its normal tests.

## Site artifact and generated manifest

After all components are staged, the runner creates one gzip-compressed tar
artifact for the website release.

The artifact contains:

- each staged component below `payload/` at its production-relative path; and
- a generated component manifest at the archive root.

The manifest is generated from Git discovery. It is not maintained manually
and contains no credentials, hostnames, server paths, or URLs. It records only
the manifest format version plus each component's type and sorted
production-relative path.

The artifact must be completely readable by `tar` before upload.

## Why production needs the previous manifest

The current release tells the workflow what exists now, but not which missing
production components were previously owned by the repository.

Without previous ownership information, a component removed from Git is
indistinguishable from an unrelated live-only plugin and therefore cannot be
deleted safely.

After the first successful deployment, production retains one small component
manifest at:

```text
$WORDPRESS_ROOT/wp-content/.with-deploy-manifest
```

This is deployment metadata, not a release directory. It contains only the
managed relative component paths and no sensitive values.

The next release compares the previous manifest with the newly generated one:

- present in both: replace the component;
- present only in the new manifest: adopt and install the component, while
  backing up an existing same-path production target when present;
- present only in the previous manifest: remove the formerly managed
  component as part of the recoverable transaction;
- present in neither: do nothing.

If no previous manifest exists, the deployment is a bootstrap. It installs or
replaces current components but does not delete unknown production paths. This
prevents the first deployment from guessing ownership.

A malformed previous manifest must stop the deployment before production is
changed.

## SSH and server requirements

Transport and remote commands use the existing native OpenSSH connection. The
production server does not need Git, Node.js, npm, ZIP tooling, `rsync`, SFTP,
or a deployment agent.

The SSH account needs these standard capabilities:

- POSIX-compatible `sh`;
- `cat`;
- `find`;
- `tar` with gzip support;
- `mkdir`;
- `mv`;
- `rm`;
- `test`.

The account must be able to write below `wp-content` and rename each managed
component within its existing filesystem.

The server must have enough temporary space for the uploaded artifact, all new
component candidates, and rollback copies of every affected current component.

The workflow must continue to verify the server's exact stored SHA256 host-key
fingerprint before uploading or running remote commands. It must never use
`StrictHostKeyChecking=no`.

## Transient transaction workspace

One run-specific hidden workspace is created below `wp-content`, using only
validated `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` values.

It contains:

- the uploaded site artifact;
- extracted candidate components; and
- rollback copies of production components touched by this run.

Candidate and rollback data stay on the same filesystem as the component
targets so activation and restoration use directory renames rather than file
copies. The workspace is removed after success or a completed rollback. It is
not a permanent `releases`, `current`, `incoming`, or `previous` architecture.

The workflow must never recursively remove an unresolved variable, a glob,
`WORDPRESS_ROOT`, `wp-content`, or a complete WordPress component root such as
`themes` or `plugins`.

## Main workflow pseudocode

```text
on published GitHub Release:
    acquire the production concurrency group
    check out the exact release tag
    run the deployment integration suite

    discover all Git-managed WordPress components

    for each component:
        install locked build dependencies when declared
        run its build when declared
        create its package from its own package contract
        validate and stage the complete component

    generate the new component manifest
    create and validate one site artifact

    configure OpenSSH
    verify the stored production host fingerprint
    run read-only remote preflight checks
    create the validated run-specific workspace
    upload the complete site artifact

    extract and validate every candidate component remotely
    calculate replace, add, and remove operations from both manifests
    switch all affected components as one recoverable transaction

    run public production smoke tests

    if smoke tests pass:
        keep the new component manifest
        delete rollback data and the transient workspace
        finish successfully

    if smoke tests fail:
        restore every previous component and the previous manifest
        remove newly added components
        remove the transient workspace after successful restoration
        verify that the restored website responds
        finish as a failed, rolled-back deployment
```

## Remote preflight pseudocode

```text
validate WORDPRESS_ROOT as a non-empty absolute path
validate that WORDPRESS_ROOT contains a WordPress installation
validate the numeric run id and run attempt
validate the exact run-specific workspace path
validate required shell commands
validate write permissions below wp-content

read the previous component manifest when present
validate every previous component path

for each previous component:
    assert path is below themes, plugins, or mu-plugins
    assert the first-level component name uses the accepted character set
    assert the resolved target cannot escape wp-content
    assert its production target exists with the recorded component type

assert the transaction workspace does not already exist
assert no unrelated WordPress path can be selected by the operation plan
```

All validation completes before an active component is renamed.

## Candidate preparation pseudocode

```text
assert the run-specific workspace was created after preflight
store the uploaded artifact inside that workspace
verify that tar can read the complete artifact
extract the artifact into the candidate area

read the new component manifest from the extracted artifact
validate the manifest version, component types, and component paths

for each new manifest component:
    assert path is below themes, plugins, or mu-plugins
    assert the first-level component name uses the accepted character set
    assert the resolved target cannot escape wp-content
    assert the candidate exists at the exact declared relative path
    assert the candidate is non-empty
    assert the candidate type matches the manifest
    assert the candidate contains no symbolic link or special filesystem entry

old = components from the previous production manifest, or empty on bootstrap
new = components from the release manifest

replace = old intersect new
add = new minus old
remove = old minus new
touch = old union new

for each component in touch:
    record whether its production target currently exists

report the complete operation plan before switching
```

If upload, extraction, or candidate validation fails, production remains
unchanged. A failure cleanup may remove only the validated workspace belonging
to the current run. If that cleanup also fails, the workflow reports the exact
leftover path for manual inspection.

## Multi-component switch pseudocode

The switch occurs in one remote shell. A shell trap remains active throughout
the transaction and restores the previous state after any normal error or
handled `HUP`, `INT`, or `TERM` signal.

```text
fail if WORDPRESS_ROOT/.maintenance already exists
create a run-marked WordPress .maintenance file
enable the rollback trap

for each component in touch:
    if its production target exists:
        rename target into the run-specific rollback area

for each component in new:
    rename its prepared candidate to the production target

move the previous production manifest into rollback when present
move the new manifest to the canonical production manifest path

assert every new component exists at its production target
assert every removed component is absent from its production target
assert the canonical manifest equals the new manifest

remove only this run's .maintenance file
disable the switch trap
report that the switch completed
```

The component renames are not globally atomic. The temporary WordPress
maintenance file prevents public requests from observing a partly switched
set. The file must contain a run marker, and cleanup may remove it only when
that marker matches the current run.

## Rollback pseudocode

```text
validate the run workspace, rollback area, and both manifests again
create or retain this run's WordPress maintenance file

for each component in new:
    if its production target exists:
        move the failed candidate back into the run workspace

for each component backed up by this run:
    restore it to its original production target

remove the new canonical manifest
restore the previous manifest when one existed

assert every previous component is restored
assert every pre-existing same-path target is restored
assert new component targets that did not exist before the switch are absent
assert the canonical manifest equals the previous manifest state

if every restoration check passes:
    remove only this run's .maintenance file
    remove failed candidates and the uploaded artifact
    remove the run workspace
    report the release as failed and rolled back
```

A successful rollback never changes the failed workflow into a successful
deployment.

If rollback itself fails, the workflow must retain all remaining evidence and
its run-marked maintenance file, report the exact affected component, and must
not attempt broad cleanup.

## Smoke tests

After the switch and removal of the workflow-owned maintenance file, the
runner must:

- request the homepage with retries;
- accept HTTP 200;
- accept HTTP 503 only when the body is the explicitly recognized Admin Site
  Enhancements maintenance page; and
- request `style.css` for every deployed theme component.

The theme URLs are derived from the generated component manifest, not from a
configured theme slug.

There is no universal public asset URL for a plugin. Candidate validation and
the homepage request provide the generic deployment check; project-specific
plugin behavior remains part of pre-release testing unless a separate
explicit health endpoint is later justified.

## Failure behavior

| Failure                                              | Required production result                           |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Checkout, discovery, build, or packaging fails       | Unchanged                                            |
| Artifact validation fails                            | Unchanged                                            |
| SSH authentication or fingerprint verification fails | Unchanged                                            |
| Upload or candidate extraction fails                 | Unchanged                                            |
| Either component manifest is invalid                 | Unchanged                                            |
| Candidate validation fails                           | Unchanged                                            |
| Creating maintenance mode fails                      | Unchanged                                            |
| Backing up any target fails                          | Rollback trap restores all earlier targets           |
| Activating any candidate fails                       | Rollback trap restores all previous components       |
| Installing the new manifest fails                    | Rollback trap restores components and old manifest   |
| Public smoke test fails                              | All previous components and old manifest restored    |
| Rollback fails                                       | Maintenance and evidence retained; failure reported  |
| Cleanup after verification fails                     | New release and manifest stay active; workflow fails |

## Cancellation behavior

Cancellation before the switch leaves production unchanged.

During the switch, the remote shell trap must restore the previous state when
the SSH session receives a normal termination signal.

After a completed switch, the new components and new manifest are active while
rollback data remains available until verification succeeds. An abrupt runner
or server failure at this point cannot be made perfectly atomic without a
permanent release-and-symlink architecture, which is intentionally out of
scope. The workflow must leave evidence for an explicit recovery and must not
silently delete another run's workspace.

## Security requirements

- Use a dedicated non-root SSH deployment account.
- Preserve exact host-fingerprint verification.
- Keep private-key material only in the existing GitHub secret.
- Quote every local and remote path.
- Treat manifest contents as untrusted input and validate every entry.
- Reject absolute paths, traversal, unsupported roots, overlapping components,
  and unsafe component names.
- Reject archive entries not declared by the generated manifest structure.
- Reject symbolic links in staged components and standard production component
  roots.
- Never use wildcards as destructive targets.
- Never modify a component absent from both the previous and new manifests.
- Do not expose production paths, credentials, or host details in repository
  documentation.

## Local verification plan

The implementation must use a disposable local WordPress directory to test
the complete remote script without contacting production.

It must cover at least:

1. discovery of one tracked theme;
2. discovery of a theme and multiple plugins without configured slugs;
3. a PHP-only plugin without npm, including `export-ignore` handling;
4. a built component packaged through `package.json#files`;
5. removal of a file deleted inside a managed theme;
6. removal of a file deleted inside a managed plugin;
7. addition of a newly tracked plugin;
8. removal of a formerly managed plugin using the previous manifest;
9. preservation of an unrelated live-only plugin;
10. bootstrap behavior without a previous manifest;
11. rejection of a missing or malformed component package;
12. rejection of traversal, an unsafe slug, and a symbolic link;
13. rollback when the second of several components cannot activate;
14. rollback after a forced public smoke-test failure;
15. restoration of the previous component manifest;
16. preservation of uploads, WordPress Core, configuration, and the database;
17. cleanup of only the current run's workspace; and
18. operation without `rsync`, SFTP, Git, Node.js, or npm on the simulated
    production server.

The workflow YAML must pass a syntax check and `git diff --check`.

## Production acceptance criteria

The first controlled Natascha release is accepted only when:

- the workflow checked out the published release tag;
- the generated manifest contains the components derived from that tag;
- no component slug was configured manually in the workflow;
- every packaged component matches its production target;
- a file deliberately absent from the release is absent from its managed
  production component;
- an unrelated live-only plugin remains unchanged;
- Core, uploads, configuration, and the database remain unchanged;
- the homepage and derived theme checks succeed;
- the canonical component manifest matches the release manifest; and
- no run-specific transaction workspace remains.

## Consequences for the current repositories

For Natascha, the first implementation discovers the existing custom theme but
is not structurally limited to it. A later tracked plugin is picked up
automatically.

For Bittner-Krull Main, the same discovery model currently finds both the
custom theme and the project-specific plugin. Its plugin package metadata will
need an explicit production `files` contract before that repository is moved
to the new workflow.

The customer portal currently discovers only its custom theme. All ignored
third-party code remains outside the deployment.

These observations come from the current Git trees. They are not separate
workflow variants.

After the Natascha implementation is accepted in production, the verified
workflow should replace the current theme-only and theme-plus-plugin variants
in the `with-scripts` project templates with one repository-driven website-code
template. The shared template must not be changed before the first production
implementation has passed its failure-path tests and controlled rollout.

## Rollout sequence

1. Review and approve this specification. Completed.
2. Correct the Natascha component packaging contract. Completed locally.
3. Implement the generic workflow on a dedicated Natascha branch. Completed
   locally.
4. Run all local success and failure simulations. Completed locally; production
   remains untouched.
5. Review the workflow diff and evidence in a pull request. Pending.
6. Publish one controlled Natascha release.
7. Verify production state read-only after the workflow succeeds.
8. Amend the specification for any observed hosting constraint.
9. Update the `with-scripts` deployment template from the accepted workflow.
10. Migrate the Bittner-Krull repositories separately from that verified
    template and preserve their unrelated local changes.

## Documentation rule

`docs/deployment.md` documents the implemented operational workflow. This
specification remains the design and failure-model reference until the
controlled production rollout is accepted.
