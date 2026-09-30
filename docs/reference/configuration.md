# Configuration reference

## `.with-scripts.json`

Commands read this optional JSON object from their resolved project directory.
Inspection, setup, and pull use the current directory; deployment setup resolves the
website Git root. Writes preserve other top-level sections and set file mode `0600`.
Malformed JSON or a non-object root stops commands that read the file.

Keep it ignored by Git. Its fields hold connection defaults and local paths.
Private keys, passwords, and database credentials belong in their existing SSH,
WordPress, or GitHub secret stores. The file has no general secret-redaction or
schema-validation mechanism: store only the documented non-secret values.
When editing one section manually, merge it into the existing object so other
command defaults remain available.

## `wordpressPull`

```json
{
  "wordpressPull": {
    "sshTarget": "example-host",
    "remoteRoot": "/srv/example/httpdocs",
    "liveUrl": "https://example.org",
    "localUrl": "https://example.ddev.site",
    "projectName": "example"
  }
}
```

| Field | Use |
| --- | --- |
| `sshTarget` | SSH alias or `user@host` |
| `remoteRoot` | Absolute or `~/`-relative WordPress root |
| `liveUrl` | Production URL used for pull search/replace |
| `localUrl` | Suggested local URL during a pull, subject to the generated-URL rule below |
| `projectName` | Suggested DDEV name during setup |

When saving is selected, inspection updates SSH/root; setup updates all five fields;
pull updates SSH/root/live/local URL while retaining other existing pull values.
Setup saves before DDEV configuration/start. Pull saves after remote preflight and
before DDEV startup. Those local settings may therefore remain after a later failure.
Inspection saves after a successful report.

### Local URL precedence

`pull-wordpress` reads `name` and `project_tld` from `.ddev/config.yaml`. The TLD
fallback is `ddev.site`. A DDEV name produces `https://<name>.<project_tld>`; without
a name, the fallback strips `www.` and the final hostname segment from the live URL
and joins remaining labels with hyphens.

A saved `localUrl` usually wins. One migration rule replaces a saved
`https://<current-name>.ddev.site` with the URL generated from the current DDEV name
and TLD. Custom saved domains remain suggested, and every pull allows an override.
For example:

| DDEV settings | Saved URL | Suggested URL |
| --- | --- | --- |
| `name: example`, no `project_tld` | absent | `https://example.ddev.site` |
| `name: example`, `project_tld: local` | `https://example.ddev.site` | `https://example.local` |
| `name: example`, `project_tld: local` | `https://preview.example.test` | `https://preview.example.test` |

Setup derives its initial URL directly from the remote home URL with the
`ddev.site` default. Its URL prompt saves a future pull value; DDEV's project name,
TLD, and additional hostnames still control actual routing.
Theme setup also derives its BrowserSync URL from DDEV's name and TLD, independently
of the pull section's saved custom URL.

Pull also tries HTTP/HTTPS and bare/`www` forms of the live hostname, retaining its
path. Each variant runs through a dry-run search/replace before apply. All tables
with the WordPress prefix are included and `guid` is skipped.

## `wordpressPush`

```json
{
  "wordpressPush": {
    "sshTarget": "example-host",
    "remoteRoot": "/srv/example/httpdocs",
    "liveUrl": "https://example.org",
    "remotePhp": "/usr/local/php84/bin/php"
  }
}
```

| Field | Use |
| --- | --- |
| `sshTarget` | Fallback for `--ssh` |
| `remoteRoot` | Fallback for `--root` |
| `liveUrl` | Fallback for `--url` |
| `remotePhp` | Fallback for `--php`; otherwise `php` |

Maintain these values manually if you want reusable defaults. `push-wordpress`
reads this section but never saves it. Explicit options take precedence; missing
SSH/root/URL values prompt. Pull defaults are independent.

Push accepts only an explicit absolute target root below a site directory and a
public HTTPS domain-root URL. The selected PHP must match the local major/minor
version. Target database credentials and salts come from its existing
`wp-config.php`; that file is copied into the candidate and its table prefix is
changed to the source prefix.

## `wordpressDeployment`

```json
{
  "wordpressDeployment": {
    "theme": "example-theme",
    "plugin": "none",
    "root": "/srv/example/httpdocs",
    "temp": "/srv/example/deployment-temp/",
    "url": "https://example.org",
    "host": "server.example.org",
    "user": "example-account",
    "port": "22",
    "key-file": "/Users/example/.ssh/example-owner-example-site-deployment",
    "hosting-url": "https://hosting.example.org"
  }
}
```

Keys match the command's value-option names. Selecting a built plugin adds
`plugin-main` and `plugin-health`. Flags such as `dry-run` and `demo` are command
modes, rather than persisted project settings.

Precedence is explicit option, saved field, then inferred/default value. Normal mode
prompts for unresolved values. Dry run reports missing values instead of prompting.
The repository always comes from the website's current `origin`. Deployment setup
uses its own section, independent of pull and push targets.

Successful real setup saves these fields after the SSH/GitHub stages and workflow
write. `key-file` contains a path, never the key bytes. Use a hosting URL that is
safe to save, without session tokens or embedded credentials. The trusted server
fingerprint is confirmed again on each real run and sent to GitHub.

The five repository Actions secrets are `HOST`, `USERNAME`, `KEY`, `PORT`, and
`FINGERPRINT`. Public runtime paths, slugs, and the website URL go into the workflow
`env` block. See [project templates](project-templates.md).

## WordPress profile settings

`configure-wordpress` stores page markers and settings in local WordPress. Its
built-in profile lives in the package source; `.with-scripts.json` provides no
profile override. See the [complete profile](wordpress-profile.md).

## DDEV configuration and WP-CLI

Setup runs `ddev config --auto --project-type=wordpress --docroot=.` with the chosen
name and detected PHP/database versions. DDEV manages `.ddev/config.yaml` and its
runtime files.

Setup also installs or overwrites `.ddev/commands/web/wp` from the bundled template
and marks it executable. The wrapper uses the bundled `/usr/local/bin/wp-cli`,
suppresses PHP deprecation notices before/after WordPress loads, and retains warnings
and errors. It supplies the DDEV docroot when no explicit or project-configured
WP-CLI path exists. Package-internal DDEV WP-CLI calls use a similar PHP invocation.
This behavior applies to CLI output; web-server PHP settings remain separate.

## Pull file exclusions

The production file archive excludes these exact root-relative paths. Optional
mirror cleanup also preserves them locally:

```text
.ddev
.git
.gitignore
.with-scripts.json
node_modules
wp-config-ddev.php
wp-content/cache
wp-content/upgrade
wp-content/upgrade-temp-backup
wp-content/wpvividbackups
wp-content/wpvivid_uploads
wp-content/wpvivid_staging
wp-content/wpvivid_image_optimization
```

In a protected project, a plugin/theme package containing any Git-tracked path is
preserved as a whole. Other tracked files are restored after extraction. Matching
untracked production packages are replaced completely. The optional delete-missing
prompt defaults to no and is asked on every pull; its answer is not saved.

Pull appends missing literal ignore lines for `.with-scripts.json`, `wp-config.php`,
`.maintenance*`, `*.sql`, `*.sql.gz`, `*.tar.gz`, uploads, cache, upgrade, and
`wp-content/wpvividbackups/`. This small addition differs from the broader
[project Git-ignore template](project-templates.md#gitignore).

## Push runtime filter

Push copies these WordPress Core paths:

```text
index.php             wp-activate.php       wp-admin/
wp-blog-header.php    wp-comments-post.php  wp-cron.php
wp-includes/          wp-links-opml.php     wp-load.php
wp-login.php          wp-mail.php           wp-settings.php
wp-signup.php         wp-trackback.php      xmlrpc.php
```

It copies `plugins`, `themes`, `mu-plugins`, `languages`, and `uploads` below
`wp-content` and writes a standard content `index.php`. It replaces the complete
target `wp-content` directory, so other target content-root files leave the runtime.
Local `wp-config.php`, root server configuration, and content-root drop-ins are
outside the upload set. Managed target `index.html` is removed during the switch.

The recursive filter omits these basenames at any copied depth:

```text
node_modules  .git  .github  .ddev  .DS_Store  .with-scripts.json
.env  .env.local  .webpack-cache  .npmrc  .netrc  .vscode  .idea
wpvividbackups  wpvivid_uploads  wpvivid_staging  ai1wm-backups  updraft  logs
```

It also omits names beginning with `._` or `.env.`, and case-insensitive suffixes
`.sql`, `.sql.gz`, `.tar`, `.tar.gz`, `.tgz`, `.log`, `.pem`, and `.key`.
Other symbolic links and special files fail preparation. Files receive readable
runtime permissions with `chmod -R u=rwX,go=rX`. The same filter runs after builds.
This is an explicit path filter; review any project-specific credential or backup
file stored under another name before packaging.
