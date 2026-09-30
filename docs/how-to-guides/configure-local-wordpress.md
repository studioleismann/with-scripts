# Configure local WordPress

Apply the standard profile to an installed single-site WordPress database in
the current DDEV project. The command works locally and starts DDEV itself.

## Preview your choices

From the document root containing `.ddev/config.yaml`, run:

```sh
with-scripts configure-wordpress --profile=standard --dry-run
```

The wizard loads WordPress, lists existing pages, and collects your choices. Select
whether the site is fresh, then assign each page role to an existing ID or a title.
Use distinct pages for home, blog, legal parent, privacy, and imprint.

- A new home/blog page is published; new legal pages start as drafts.
- Selecting an existing ID keeps its title and status. Privacy and imprint are
  assigned below the legal parent.
- On later runs, marked page IDs are offered again. Entering a title instead can
  update the already marked page's identity and status.

Review language, site details, search visibility, avatars, upload folders, category,
comments, media sizes, and plugins. Interactive plugin selection starts with all
three plugins selected; use Space to toggle and Enter to continue. Clearing all
plugins is allowed. Line mode asks about each plugin separately.

Review sample candidates by their displayed IDs and titles/authors. The candidates
are IDs `1`, `2`, and comment `1`; actual content at those IDs can still matter to
your site. Keep any page that you selected for an assignment.

The summary shows page selections, language, media, plugins, sample-deletion count,
and snapshot choice. Dry run stops there. It starts DDEV and loads WordPress, while
skipping profile application, downloads, cleanup, and snapshot creation.

## Apply the profile

```sh
with-scripts configure-wordpress --profile=standard
```

Enter the reviewed choices again. For an existing site, keep the offered database
snapshot unless you already have the required recovery copy. The final **Apply this
configuration to the local DDEV site now?** prompt defaults to **No**.

Apply installs the selected language/plugins, sets the page roles and options,
configures selected media/Activity Log values, disables plugin auto-update selections,
and applies confirmed cleanup. It then reads the relevant settings again and reports
verification. See the [profile reference](../reference/wordpress-profile.md) for all
values and the precise check scope.

## Repeat or check the configuration

Run the wizard again to change choices. Accepting the marked page IDs reuses those
pages. Installed plugins are reused, and selected inactive plugins are activated.

For the fixed profile report:

```sh
with-scripts configure-wordpress --profile=standard --check
```

The report prints `OK` or `MISSING` and returns status `1` on drift. It compares with
the full built-in profile, including `de_DE`, all three plugins, and media defaults.
An intentionally skipped plugin or different language can therefore report
`MISSING`. The command does not remember your previous optional choices as a custom
profile. Choose `--dry-run` or `--check` separately.

## Recover from a failed apply

Use the exact snapshot name printed during creation or successful completion. If
output was interrupted, list snapshots:

```sh
ddev snapshot --list
```

Then restore the selected database snapshot:

```text
ddev snapshot restore <exact-before-configure-wordpress-snapshot>
```

Application has no automatic rollback. A snapshot restores database state; restore
plugin/language/theme files and `wp-config.php` from a separate file backup when
needed. Review installed plugins and active components after recovery.

Use [Set up a customer theme](set-up-customer-theme.md) for theme creation. Configure
legal content, plugin licenses, and WPvivid remote storage as separate tasks.
