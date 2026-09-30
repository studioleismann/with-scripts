import { runCapture } from './cli.mjs';

export const FILE_EXCLUDES = [
  './.ddev',
  './.git',
  './.gitignore',
  './.with-scripts.json',
  './node_modules',
  './wp-config-ddev.php',
  './wp-content/cache',
  './wp-content/upgrade',
  './wp-content/upgrade-temp-backup',
  './wp-content/wpvividbackups',
  './wp-content/wpvivid_uploads',
  './wp-content/wpvivid_staging',
  './wp-content/wpvivid_image_optimization',
];

export function inspectEnvironment(sshTarget, remoteRoot) {
  const stdout = runCapture(
    'Inspecting production environment',
    'ssh',
    sshArgs(sshTarget, remoteRoot),
    buildEnvironmentScript(),
  );
  const values = Object.fromEntries(
    stdout
      .split('\n')
      .map((line) => line.match(/^WITH_SCRIPTS_([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].trim()]),
  );

  for (const key of ['PHP_VERSION', 'DATABASE_ENGINE', 'DATABASE_VERSION', 'LIVE_URL']) {
    if (!values[key]) {
      throw new Error(`Could not detect ${key.toLowerCase().replaceAll('_', ' ')}.`);
    }
  }

  return {
    phpVersion: values.PHP_VERSION,
    databaseEngine: values.DATABASE_ENGINE,
    databaseVersion: values.DATABASE_VERSION,
    liveUrl: values.LIVE_URL,
  };
}

export function validateRemoteInput(sshTarget, remoteRoot) {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(sshTarget) || sshTarget.startsWith('-')) {
    throw new Error('SSH target must be a host alias or user@host.');
  }
  if (!/^(?:\/|~\/)[a-zA-Z0-9_./-]+$/.test(remoteRoot) || remoteRoot.split('/').includes('..')) {
    throw new Error('Remote WordPress root must start with / or ~/ and contain only normal path characters.');
  }
}

export function sshArgs(sshTarget, remoteRoot) {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    sshTarget,
    `bash -s -- ${shellQuote(remoteRoot)}`,
  ];
}

export function normalizeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL must be a valid http or https URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('URL must be a plain http or https URL without credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function deriveDdevUrl(liveUrl, projectTld = 'ddev.site') {
  const hostname = new URL(liveUrl).hostname
    .replace(/^www\./, '')
    .split('.')
    .slice(0, -1)
    .join('-');
  return `https://${hostname}.${projectTld}`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function rootShellHelpers() {
  const D = '$';
  return String.raw`resolve_root() {
  case "$1" in
    "~") ROOT="$HOME" ;;
    "~/"*) ROOT="${D}{HOME%/}/${D}{1:2}" ;;
    /*) ROOT="$1" ;;
    *) echo "Invalid remote WordPress root." >&2; exit 1 ;;
  esac
  cd "$ROOT"
}`;
}

function databaseShellHelpers() {
  const D = '$';
  return String.raw`read_constant() {
  if command -v wp >/dev/null 2>&1; then
    wp config get "$1" --type=constant 2>/dev/null && return
  fi
  php -r '
    $name = $argv[1];
    $config = file_get_contents("wp-config.php");
    $pattern = "/define\\s*\\(\\s*[\"'"'"']" . preg_quote($name, "/") . "[\"'"'"']\\s*,\\s*[\"'"'"']([^\"'"'"']*)[\"'"'"']\\s*\\)/";
    if (preg_match($pattern, $config, $match)) {
      echo $match[1];
      exit;
    }
    fwrite(STDERR, "Could not read " . $name . " from wp-config.php.\n");
    exit(1);
  ' "$1"
}

DB_NAME="$(read_constant DB_NAME)"
DB_USER="$(read_constant DB_USER)"
DB_PASSWORD="$(read_constant DB_PASSWORD)"
DB_HOST_RAW="$(read_constant DB_HOST)"
DB_HOST="${D}{DB_HOST_RAW%%:*}"
DB_PORT="3306"
if [ "$DB_HOST_RAW" != "$DB_HOST" ]; then
  DB_PORT="${D}{DB_HOST_RAW##*:}"
  case "$DB_PORT" in
    ''|*[!0-9]*) echo "Unsupported DB_HOST. Expected host or host:port." >&2; exit 1 ;;
  esac
fi
MYSQL_ARGS=(-h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER")

mysql_value() {
  MYSQL_PWD="$DB_PASSWORD" mysql -N -B "${D}{MYSQL_ARGS[@]}" "$DB_NAME" -e "$1"
}`;
}

function tablePrefixShellHelper() {
  return String.raw`read_table_prefix() {
  if command -v wp >/dev/null 2>&1; then
    wp config get table_prefix --type=variable 2>/dev/null && return
  fi
  php -r '
    $config = file_get_contents("wp-config.php");
    $variable = "$" . "table_prefix";
    $pattern = "/" . preg_quote($variable, "/") . "\\s*=\\s*[\"'"'"']([A-Za-z0-9_]+)[\"'"'"']/";
    if (preg_match($pattern, $config, $match)) {
      echo $match[1];
      exit;
    }
    fwrite(STDERR, "Could not read the WordPress table prefix.\n");
    exit(1);
  '
}
TABLE_PREFIX="$(read_table_prefix)"`;
}

export function buildPreflightScript() {
  return String.raw`set -eu
${rootShellHelpers()}
resolve_root "$1"
test -r wp-config.php || { echo "Remote wp-config.php is not readable." >&2; exit 1; }
test -d wp-admin || { echo "Remote wp-admin directory is missing." >&2; exit 1; }
test -d wp-content || { echo "Remote wp-content directory is missing." >&2; exit 1; }
test -d wp-includes || { echo "Remote wp-includes directory is missing." >&2; exit 1; }
for required_command in php mysqldump gzip tar; do
  command -v "$required_command" >/dev/null || {
    printf 'Required remote command is unavailable: %s.\n' "$required_command" >&2
    exit 1
  }
done
printf 'Remote root: %s\nProduction access: read only\n' "$PWD"
`;
}

export function buildEnvironmentScript() {
  return String.raw`set -eu
${rootShellHelpers()}
resolve_root "$1"
${databaseShellHelpers()}
${tablePrefixShellHelper()}

PHP_VERSION="$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')"
LIVE_URL="$(mysql_value "SELECT option_value FROM ${'$'}{TABLE_PREFIX}options WHERE option_name='home' LIMIT 1")"
DB_VERSION_RAW="$(mysql_value "SELECT VERSION()")"
DB_COMMENT="$(mysql_value "SELECT @@version_comment")"
DB_ENGINE="mysql"
case "$DB_COMMENT $DB_VERSION_RAW" in
  *MariaDB*|*mariadb*) DB_ENGINE="mariadb" ;;
esac
DB_VERSION="$(php -r '$parts = explode(".", $argv[1]); echo $parts[0] . "." . $parts[1];' "$DB_VERSION_RAW")"

printf 'WITH_SCRIPTS_PHP_VERSION=%s\n' "$PHP_VERSION"
printf 'WITH_SCRIPTS_DATABASE_ENGINE=%s\n' "$DB_ENGINE"
printf 'WITH_SCRIPTS_DATABASE_VERSION=%s\n' "$DB_VERSION"
printf 'WITH_SCRIPTS_LIVE_URL=%s\n' "$LIVE_URL"
`;
}

export function buildInspectionScript() {
  const D = '$';
  return String.raw`set -eu
${rootShellHelpers()}
resolve_root "$1"
${databaseShellHelpers()}
${tablePrefixShellHelper()}

echo "=== Remote WordPress ==="
printf 'Root: %s\n' "$PWD"
php -r 'include "wp-includes/version.php"; echo "WordPress " . $wp_version . PHP_EOL;'
if command -v wp >/dev/null 2>&1; then echo "WP-CLI: available"; else echo "WP-CLI: not available"; fi

echo
echo "=== PHP CLI ==="
php -v
php -r '
  foreach (["memory_limit", "upload_max_filesize", "post_max_size", "max_execution_time", "max_input_vars"] as $key) {
    echo $key . "=" . ini_get($key) . PHP_EOL;
  }
'

echo
echo "=== PHP extensions ==="
php -m

echo
echo "=== WordPress URLs ==="
mysql_value "SELECT CONCAT(option_name, '=', option_value) FROM ${D}{TABLE_PREFIX}options WHERE option_name IN ('home', 'siteurl') ORDER BY option_name"

echo
echo "=== Database ==="
MYSQL_PWD="$DB_PASSWORD" mysql -B "${D}{MYSQL_ARGS[@]}" "$DB_NAME" -e "SELECT VERSION() AS version, @@version_comment AS engine, @@character_set_database AS charset, @@collation_database AS collation"
`;
}

export function buildDatabaseStreamScript() {
  const D = '$';
  return String.raw`set -euo pipefail
${rootShellHelpers()}
resolve_root "$1"
${databaseShellHelpers()}
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --no-tablespaces \
  --single-transaction \
  --quick \
  --skip-lock-tables \
  "${D}{MYSQL_ARGS[@]}" \
  "$DB_NAME" | gzip -c
`;
}

export function buildFileStreamScript() {
  const excludes = FILE_EXCLUDES.map((entry) => `  --exclude=${shellQuote(entry)} \\\n`).join('');
  return String.raw`set -eu
${rootShellHelpers()}
resolve_root "$1"
tar \
${excludes}  -czf - .
`;
}
