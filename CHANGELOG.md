# Changelog

## Unreleased

### Commands and terminal interface

- Add the read-only `inspect-wordpress` environment report and `setup-wordpress`
  wizard for local DDEV configuration from the remote PHP CLI and database versions.
- Add the local `configure-wordpress` wizard with the `standard` profile,
  page assignments, settings, media defaults, optional cleanup, preview, and drift check.
- Add `setup-theme` for customer themes based on a local With Base starter, and `sync-tools`
  for local With Patterns, With Theme Tools, and With Site Tools runtimes.
- Add `push-wordpress` for reviewed full-site replacement, including repeated pushes,
  explicit target/PHP selection, a local preparation mode, and a read-only preflight.
- Add `setup-deployment` with workflow preview, dedicated SSH-key authorization,
  trusted host-key verification, remote path checks, and repository-secret setup.
  Resolve real setup from the website Git root, including calls from subdirectories.
- Add `setup-deployment --demo` for five simulated stages from any folder.
- Add a shared Clack terminal interface with command selection, prompts, summaries,
  confirmations, and download progress. Add category selection and plugin multiselect
  to local configuration, preserve line prompts for pipes/CI, and honor `NO_COLOR`.
  Require Node.js 20.12.0 or newer.
- Add command-specific help, early unsupported-option errors, and actionable closed-input
  errors. Close setup prompts before DDEV can request local administrator input.

### Pull and push behavior

- Stream pull databases/files into private local temporary storage, validate both
  downloads, show received bytes, and stop streams after 90 seconds without progress.
  Remote pull scripts create no archive files on the host.
- Support optional remote WP-CLI with PHP/database fallbacks. Accept safe home-relative
  roots for inspection, setup, and pull; full-site push requires an absolute root.
  Remove the pull preflight's unnecessary remote `awk` dependency.
- Respect DDEV `project_tld` when deriving local pull URLs.
- Create a database snapshot before local replacement. Preserve tracked files through
  extraction and preserve complete Git-managed plugin/theme packages. Replace matching
  untracked packages completely to avoid mixed versions.
- Add optional mirror cleanup for local-only unprotected files, while preserving
  tracked files, Git-managed packages, and explicit local-system/cache/backup exclusions.
- Show the pull impact summary and require confirmation. Existing installations
  without project-root Git protection require `PULL WITHOUT BACKUP`; normal pulls
  use a yes/no confirmation that defaults to no.
- Validate remote inputs, downloads, saved settings, and patched local `wp-config.php`.
  Report stage-specific errors and recovery guidance according to actual progress.
  Treat files changing during download as a retryable error before local replacement.
- Export every source-prefixed table during a full-site push, including plugin tables.
  Check exported/imported table inventories, imported row counts, content hashes,
  revisions, autosaves, and protected Custom CSS.
- Preserve target credentials/configuration during push, adjust its table prefix,
  retain web-readable runtime permissions, and create validated target backups.
  Run content, bootstrap, and HTTPS checks within the rollback boundary and retain
  backup/workspace status for recovery and review.

### Local configuration, themes, and tools

- Reuse marked page assignments on repeated local configuration runs. Install selected
  Query Monitor, WPvivid Backup, and Activity Log plugins, configure Activity Log
  retention, and verify the applied profile settings.
- Treat already-disabled plugin auto-updates as the desired state on repeated runs.
  Keep profile application local and leave licenses/remote backup destinations to
  their separate setup processes.
- Check local WordPress before applying theme setup or shared-tool synchronization.
  Report installation, source, dependency, build, and activation failures with their
  actual recovery limits.
- Personalize With Base identities, initialize shared tools, build/lint the generated
  theme, and protect eligible existing theme repositories with a Git branch, database
  snapshot, and recoverable file backup. Restore theme files on preparation failure;
  shared plugin files and activation state require separate recovery.
- Install With Theme Tools as an independent plugin from its ZIP. Synchronize With
  Patterns into the theme and With Site Tools into its plugin directory from local
  source checkouts. Keep customer features and stored Global Styles outside the
  generic theme bootstrap.
- Install a project DDEV WP-CLI wrapper and use matching internal CLI invocations
  that suppress PHP deprecation notices while preserving warnings and errors.

### Templates and documentation

- Add provider-neutral project Git-ignore and theme/theme-plus-plugin release
  workflow templates. Keep public deployment values in workflow configuration and
  private-key content in GitHub Actions secrets.
- Use neutral example projects and the `standard` WordPress profile. Read the
  starter theme from an explicitly selected local directory.
- Organize commands into separate source files with shared CLI and remote helpers.
  Add fixture-backed checks for generated scripts, transfers, setup failures, and
  terminal interaction.
- Rewrite the documentation using the Diátaxis structure and current implementations.
  Cover all commands/options, configuration precedence, profile values, requirements,
  template behavior, previews, file boundaries, and recovery limits. Add installation,
  shared-tool synchronization, and development guides.

## 0.1.0

- Add the initial `with-scripts pull-wordpress` wizard for SSH-based WordPress to DDEV pulls.
