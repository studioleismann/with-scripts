# Set up an existing WordPress site locally

This tutorial brings an existing hosted WordPress website into a new DDEV folder,
opens the local copy, and puts its custom code under Git protection.

Use one folder for one WordPress installation. The examples use `example-host`,
`/srv/example/httpdocs`, and a local project named `example`; substitute the values
for your site.

## Before you begin

Prepare [with-scripts](../how-to-guides/install-and-update.md), DDEV, a working
Docker provider, and SSH key access to the server. Check the tools:

```sh
with-scripts --help
ddev version
```

The server needs the [inspection and pull tools](../reference/requirements.md#remote-inspection-and-pull).
Use a WordPress installation with its configuration and standard directories in the
same remote root.

## 1. Identify the remote root

Connect through the SSH alias configured on your computer:

```sh
ssh example-host
```

Enter the website's directory and inspect it:

```sh
cd /srv/example/httpdocs
pwd
ls wp-config.php wp-admin wp-content wp-includes
exit
```

Record the path printed by `pwd`. Key authentication must work without an SSH
password prompt; the wizard uses non-interactive SSH. Establish host-key trust
through your normal SSH setup before continuing.

## 2. Create the local folder

```sh
mkdir -p ~/code/projects/example/website
cd ~/code/projects/example/website
```

Run the remaining project commands from this directory.

## 3. Configure and start DDEV

```sh
with-scripts setup-wordpress
```

Use the following choices:

| Prompt | Choice |
| --- | --- |
| SSH target | `example-host` |
| Remote WordPress root | `/srv/example/httpdocs`, or the root you verified |
| Local DDEV URL | Accept the generated URL for this exercise |
| DDEV project name | Accept the matching generated name, provided it is unique locally |
| Save settings for future pulls | Yes |
| Configure and start DDEV | Yes |

The wizard reads PHP CLI and database versions, saves connection defaults, configures
DDEV, installs its project WP-CLI wrapper, and starts the containers. It may ask for
your local macOS administrator password while DDEV configures hostnames. Password
characters remain invisible during entry.

At this point, DDEV is prepared. The next step supplies the website files and database.

## 4. Pull the website

```sh
with-scripts pull-wordpress
```

Review the saved SSH target, remote root, live URL, and generated local URL. Keep
**Delete local files that no longer exist on production?** set to **No**. At the
final **Continue?** prompt, choose **Yes**; line mode accepts `y`.

Pull creates a local database snapshot, downloads and checks both archives, copies
files, prepares `wp-config.php` for DDEV, imports the database, and replaces the live
URL variants locally. The server remains the read-only source.

The completion message prints the local URL. If a step fails, follow
[Troubleshoot a WordPress pull](../how-to-guides/troubleshoot-a-wordpress-pull.md)
before proceeding.

## 5. Check the local copy

```sh
ddev launch
```

Open the homepage and the local `/wp-admin/` page. The imported database contains
the source site's accounts. Check representative pages, images, and the active
theme, and confirm that navigation stays on the local hostname.

## 6. Track the custom code

For this new repository, replace the small pull-generated ignore file with the
broader project baseline:

```sh
cp ~/code/packages/with-scripts/templates/wordpress-project/gitignore .gitignore
```

Edit the file: replace `{{THEME_SLUG}}` with the custom theme's directory name. If
there is a custom plugin, replace `{{PLUGIN_SLUG}}` too; otherwise remove its plugin
rules. Add explicit allowlist entries for any other custom components you maintain.
An existing repository should merge these rules into its current ignore file.

Initialize Git and inspect what will be tracked:

```sh
git init
git add .
git diff --cached --stat
git status
```

Confirm that the staged files are project configuration and intended custom source.
WordPress Core, uploads, third-party packages, database dumps, and `wp-config.php`
should remain outside the commit. Commit the reviewed baseline:

```sh
git commit -m "Initialize WordPress project"
```

You now have a local working copy with Git protection for its tracked code. Future
pulls require this project repository to be clean.

## Next steps

- [Pull fresh production data](../how-to-guides/pull-the-latest-production-copy.md)
- [Configure local WordPress](../how-to-guides/configure-local-wordpress.md)
- [Create a customer theme](../how-to-guides/set-up-customer-theme.md)
- [Prepare release deployments](../how-to-guides/set-up-release-deployments.md)
