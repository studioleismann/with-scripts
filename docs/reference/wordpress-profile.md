# Standard WordPress profile

`configure-wordpress` has one built-in profile, `standard`, which is also the
default. It operates on the current local DDEV installation and rejects Multisite.
The profile is defined in [`src/configure-wordpress.mjs`](../../src/configure-wordpress.mjs).

## Page assignments

Every page prompt accepts an existing page ID or a title. On later runs, the default
is the ID marked with `_with_scripts_setup_key` for that role.

| Marker | Default title | Status for a created or title-updated page | Parent |
| --- | --- | --- | --- |
| `home` | Startseite | Published | Root |
| `blog` | Blog | Published | Root |
| `legal` | Rechtliches | Draft | Root |
| `privacy` | Datenschutzerklärung | Draft | Selected legal page |
| `imprint` | Impressum | Draft | Selected legal page |

Selecting an existing ID preserves its title and status. Privacy/imprint selections
are placed below the chosen legal parent. Entering a title reuses a marked page when
one exists, updating its title, slug, status, parent, and comment/ping settings;
otherwise it creates the page with empty content. Old markers for the same role
are removed from other pages.

Assignments set `show_on_front=page`, `page_on_front`, `page_for_posts`, and
`wp_page_for_privacy_policy`. These page titles are intentional German content
defaults. The command supplies page structure; legal text and other content are
written separately.

## Prompted choices

| Choice | Initial value/behavior |
| --- | --- |
| Fresh installation | Suggested when there are at most two inspected pages and at most one published/draft post |
| WordPress language | `de_DE`; another locale can be entered |
| Site title and administrator email | Current values, required |
| Tagline | Current value; `-` clears it |
| Search-engine visibility | Current `blog_public` value |
| Avatars | Current `show_avatars` value |
| Upload year/month folders | Current `uploads_use_yearmonth_folders` value |
| Default post category | Current category; select from the terminal list or enter a numeric ID in line mode |
| Close existing comments/pingbacks | Defaults to the fresh-installation answer |
| Configure media sizes | Yes |
| Install/activate profile plugins | All three selected; the selection can be empty |
| Delete Hello Dolly | Defaults to the fresh-installation answer |
| Delete older inactive default themes | No; asked only when more than one inactive `twentytwenty*` theme exists |
| Delete displayed sample candidates | Defaults to the fresh-installation answer |
| Create a database snapshot | Yes for an existing site; skipped for a site marked fresh |
| Apply the plan | No |

Fresh-site detection only suggests answers. Inspect the listed records before
accepting cleanup.

## Fixed settings applied on every normal run

| Setting | Value |
| --- | --- |
| `timezone_string` | `Europe/Berlin` |
| `date_format` | `d.m.Y` |
| `time_format` | `H:i` |
| `permalink_structure` | `/%postname%/` |
| `default_comment_status` | `closed` |
| `default_ping_status` | `closed` |
| `WP_AUTO_UPDATE_CORE` in local `wp-config.php` | String `minor` |
| Plugin auto-update selections | Disabled for all selected auto-updating plugins |

The command installs/activates the chosen core language, applies the page/option
plan, and flushes rewrite rules. Existing active plugins are reused. Selected
installed-but-inactive plugins are activated; missing selected plugins are installed.
Unselected plugins keep their existing installation/activation state.

## Plugins

| Name | WordPress slug | Profile behavior |
| --- | --- | --- |
| Query Monitor | `query-monitor` | Install and activate when selected |
| WPvivid Backup | `wpvivid-backuprestore` | Install and activate when selected |
| Activity Log | `aryo-activity-log` | Install/activate and configure retention when selected |

Activity Log gets `logs_lifespan="128"` in `activity-log-settings`. The command fills
missing `logs_failed_login` and `logs_email` values with `yes` and preserves other
settings. WPvivid remote storage and plugin licenses require separate configuration.
Theme installation uses the separate `setup-theme` command.

## Media sizes

When selected, media sizing reads base-origin global layout settings through
`wp_get_global_settings`. Positive numbers and plain pixel strings are rounded to
integers; other units and expressions use the fallback.

| Options | Value |
| --- | --- |
| `medium_size_w`, `medium_size_h` | Theme `layout.contentSize`, fallback `640` |
| `large_size_w`, `large_size_h` | Theme `layout.wideSize`, fallback `1280` |
| `thumbnail_size_w`, `thumbnail_size_h` | `160` |
| `thumbnail_crop` | `1` |

These settings affect future image-size generation. Existing media regeneration is
outside this command.

## Optional cleanup

The candidates are specifically post ID `1` when its type is `post`, page ID `2`
when its type is `page`, and comment ID `1` when present. The wizard displays their
current title/author. These IDs alone do not establish that the content is disposable.
Choose page assignments and cleanup together so a selected page is retained.

Confirmed deletions are permanent. Before deleting, the command rechecks post type,
title, and slug, or comment author and parent post. Optional Hello Dolly cleanup
first deactivates an active `hello` plugin. Default-theme cleanup keeps the first
inactive `twentytwenty*` slug after descending lexical sorting and deletes the
remaining inactive matches; the active theme stays.

## Verification and `--check`

After apply, verification checks role markers, selected plugin activation, the
chosen general options, homepage/posts/privacy assignments, selected media widths,
Activity Log retention when selected, and core/plugin auto-update settings.

`--check` runs without prompts and compares against the full fixed profile:

- language `de_DE`, timezone, date/time, permalink, and new comment/ping settings;
- core updates set to `minor` and an empty plugin auto-update selection;
- Activity Log retention of 128 days;
- theme-derived medium/large widths, 160px thumbnail width, and thumbnail cropping;
- all five page markers and matching home/posts/privacy assignments;
- all three profile plugins active.

It prints `OK` or `MISSING` and returns `1` if any check fails. It checks neither
previous wizard choices nor all WordPress configuration: page text/titles/parent
relationships, general site identity, optional cleanup, category, and media heights
are outside this report. A deliberate skipped plugin or alternate language can
therefore produce `MISSING` after an otherwise successful run.

## Snapshot boundary

Existing-site apply can create `before-configure-wordpress-<timestamp>`. Restore it
with `ddev snapshot restore <exact-name>`. Successful output includes that name;
use `ddev snapshot --list` if a failure interrupted the run. Restoring the snapshot
covers the database. Language/plugin/theme files and `wp-config.php` need a separate
file backup. Profile application has no automatic rollback.
