# Invoked by push-wordpress over SSH only after package review and confirmation.
set -Eeuo pipefail
umask 077
ROOT="$1"
WORKSPACE="$2"
LIVE_URL="$3"
SOURCE_PREFIX="$4"
SOURCE_VERSION="$5"
PHP_BIN="${6:-php}"
cd "$ROOT"
test "$PWD" = "$(pwd -P)"
PARENT="$(dirname "$ROOT")"
case "$WORKSPACE" in "$PARENT"/.with-scripts-push.*) ;; *) exit 1 ;; esac
test -d "$WORKSPACE" && test ! -L "$WORKSPACE"
test -d "$PARENT/.with-scripts-push.lock"
cd "$WORKSPACE"
sha256sum -c SHA256SUMS
printf 'PREPARING\n' > status
CANDIDATE="$WORKSPACE/candidate"
ROLLBACK="$WORKSPACE/rollback"
mkdir "$CANDIDATE" "$ROLLBACK" "$ROLLBACK/paths" "$WORKSPACE/empty-mu"
: > switched-paths
: > originally-present
DB_CHANGED=0
MAINTENANCE_OWNED=0
PROBE=
PHASE="target checks"

# Every rollback step is checked. A failed restore retains maintenance and recovery data.
rollback_push() {
  result="$1"
  trap - ERR INT TERM HUP EXIT
  set +e
  failed=0
  echo "Push failed during $PHASE. Checking recovery." >&2
  if [ -n "$PROBE" ]; then rm -f "$ROOT/$PROBE" || failed=1; fi
  if [ "$MAINTENANCE_OWNED" -eq 1 ]; then
    printf '%s\n' '<?php $upgrading = time();' > "$ROOT/.maintenance" || failed=1
  fi
  if [ "$DB_CHANGED" -eq 1 ]; then
    MYSQL_PWD="$DB_PASSWORD" mysql "${MYSQL_ARGS[@]}" "$DB_NAME" < "$WORKSPACE/drop-tables.sql" || failed=1
    gzip -dc "$ROLLBACK/database.sql.gz" | MYSQL_PWD="$DB_PASSWORD" mysql "${MYSQL_ARGS[@]}" "$DB_NAME" || failed=1
  fi
  while IFS= read -r entry; do
    if [ -e "$ROLLBACK/paths/$entry" ]; then
      rm -rf "$ROOT/$entry" || failed=1
      mv "$ROLLBACK/paths/$entry" "$ROOT/$entry" || failed=1
    elif ! grep -Fxq "$entry" "$WORKSPACE/originally-present"; then
      rm -rf "$ROOT/$entry" || failed=1
    fi
  done < "$WORKSPACE/switched-paths"
  if [ "$DB_CHANGED" -eq 1 ]; then
    "$PHP_BIN" "$WORKSPACE/wp-cli.phar" --path="$ROOT" --skip-plugins --skip-themes --exec="define('WPMU_PLUGIN_DIR', '$WORKSPACE/empty-mu');" eval-file "$WORKSPACE/content.php" verify "$ROLLBACK/content.json" before || failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    if [ "$MAINTENANCE_OWNED" -eq 1 ]; then rm -f "$ROOT/.maintenance" || failed=1; fi
  fi
  if [ "$failed" -eq 0 ]; then
    printf 'ROLLED_BACK\n' > "$WORKSPACE/status"
    rmdir "$PARENT/.with-scripts-push.lock"
    if [ "$DB_CHANGED" -eq 1 ]; then
      echo 'The previous target state was restored and its content verified.' >&2
    else
      echo 'The target database and runtime files were not replaced.' >&2
    fi
  else
    printf 'ROLLBACK_FAILED\n' > "$WORKSPACE/status"
    echo "Push and rollback failed. Keep maintenance active; recovery data: $ROLLBACK" >&2
  fi
  exit "$result"
}
trap 'rollback_push $?' ERR
trap 'result=$?; if [ "$result" -ne 0 ]; then rollback_push "$result"; fi' EXIT
trap 'rollback_push 130' INT
trap 'rollback_push 143' TERM
trap 'rollback_push 129' HUP

# Do not accept a stale approval or a target that was installed at another URL.
bash "$WORKSPACE/preflight.sh" "$ROOT" "$LIVE_URL" "$PHP_BIN" > target-now.json
"$PHP_BIN" -r '$actual=json_decode(file_get_contents("target-now.json"),true,512,JSON_THROW_ON_ERROR)["tables"]; $expected=file("target-tables", FILE_IGNORE_NEW_LINES); sort($actual); sort($expected); if ($actual !== $expected) { exit(1); }'
test ! -e "$ROOT/.maintenance"
test ! -L "$ROOT/wp-config.php"
for entry in $(cat managed-paths); do
  case "$entry" in
    index.php|wp-activate.php|wp-admin|wp-blog-header.php|wp-comments-post.php|wp-cron.php|wp-includes|wp-links-opml.php|wp-load.php|wp-login.php|wp-mail.php|wp-settings.php|wp-signup.php|wp-trackback.php|xmlrpc.php|wp-content|wp-config.php|index.html|.htaccess) ;;
    *) echo 'Unsafe managed path.' >&2; exit 1 ;;
  esac
  test ! -L "$ROOT/$entry"
done
# Verify that HTTPS actually serves this document root, not another virtual host.
PROBE="with-scripts-check-$("$PHP_BIN" -r 'echo bin2hex(random_bytes(16));').txt"
PROBE_VALUE="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(24));')"
(set -o noclobber; printf '%s' "$PROBE_VALUE" > "$ROOT/$PROBE")
chmod 644 "$ROOT/$PROBE"
PROBE_RESPONSE="$(curl --fail --silent --show-error --connect-timeout 15 --max-time 60 "$LIVE_URL/$PROBE")"
test "$PROBE_RESPONSE" = "$PROBE_VALUE"
rm "$ROOT/$PROBE"
PROBE=
WP=("$PHP_BIN" "$WORKSPACE/wp-cli.phar" --path="$ROOT" --skip-plugins --skip-themes --exec="define('WPMU_PLUGIN_DIR', '$WORKSPACE/empty-mu');")
DB_NAME="$("${WP[@]}" config get DB_NAME --type=constant)"
DB_USER="$("${WP[@]}" config get DB_USER --type=constant)"
DB_PASSWORD="$("${WP[@]}" config get DB_PASSWORD --type=constant)"
DB_HOST_RAW="$("${WP[@]}" config get DB_HOST --type=constant)"
DB_HOST="${DB_HOST_RAW%%:*}"
DB_PORT=3306
if [ "$DB_HOST_RAW" != "$DB_HOST" ]; then DB_PORT="${DB_HOST_RAW##*:}"; fi
case "$DB_PORT" in ''|*[!0-9]*) echo 'DB_HOST must use a hostname or hostname:port.' >&2; exit 1 ;; esac
MYSQL_ARGS=(--host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER")
# Only the captured source/target tables may be removed, never another database.
"$PHP_BIN" -r '
  $tables=array_unique(array_merge(file("source-tables", FILE_IGNORE_NEW_LINES),file("target-tables", FILE_IGNORE_NEW_LINES)));
  echo "SET FOREIGN_KEY_CHECKS=0;\n";
  foreach ($tables as $table) {
    if (!preg_match("/^[a-zA-Z0-9_]+$/",$table)) { exit(1); }
    echo "DROP TABLE IF EXISTS `".$table."`;\n";
  }
  echo "SET FOREIGN_KEY_CHECKS=1;\n";
' > drop-tables.sql
PHASE="target backup"
# Count the raw imported data before WordPress can refresh transients/options.
"$PHP_BIN" -r '
  $manifest=json_decode(file_get_contents("content.json"),true,512,JSON_THROW_ON_ERROR);
  foreach ($manifest["tableRows"] as $table => $count) {
    if (!preg_match("/^[a-zA-Z0-9_]+$/",$table)) { exit(1); }
    echo "SELECT COUNT(*) FROM `".$table."`;\n";
  }
' > count-tables.sql
# Obtain a complete original content/revision/CSS inventory before any DB write.
AUDIT_SETTINGS="$("$PHP_BIN" -r 'echo base64_encode(json_encode(["pattern"=>"~(?!)~", "replacement"=>""]));')"
"${WP[@]}" eval-file "$WORKSPACE/content.php" inspect "$AUDIT_SETTINGS" > "$ROLLBACK/content.json"
printf '%s\n' '<?php $upgrading = time();' > "$ROOT/.maintenance"
MAINTENANCE_OWNED=1
cp -p "$ROOT/wp-config.php" "$ROLLBACK/wp-config.php"
tar --exclude=./.maintenance -czf "$ROLLBACK/files.tar.gz" -C "$ROOT" .
MYSQL_PWD="$DB_PASSWORD" mysqldump "${MYSQL_ARGS[@]}" --single-transaction --quick --skip-lock-tables --no-tablespaces --skip-comments "$DB_NAME" > "$ROLLBACK/database.sql"
gzip "$ROLLBACK/database.sql"
gzip -t "$ROLLBACK/database.sql.gz"
tar -tzf "$ROLLBACK/files.tar.gz" >/dev/null
"${WP[@]}" eval-file "$WORKSPACE/content.php" verify "$ROLLBACK/content.json" before


PHASE="runtime preparation"
# The archive was produced from regular files only; checksum verification precedes extraction.
tar --no-same-owner --same-permissions -xzf files.tar.gz -C "$CANDIDATE"
test -z "$(find "$CANDIDATE" -type l -print -quit)"
cp -p "$ROOT/wp-config.php" "$CANDIDATE/wp-config.php"
CWP=("$PHP_BIN" "$WORKSPACE/wp-cli.phar" --path="$CANDIDATE" --skip-plugins --skip-themes --exec="define('WPMU_PLUGIN_DIR', '$WORKSPACE/empty-mu');")
"${CWP[@]}" config set table_prefix "$SOURCE_PREFIX" --type=variable
"$PHP_BIN" -l "$CANDIDATE/wp-config.php"
# Read config constants without loading WordPress against the not-yet-imported prefix.
"${CWP[@]}" config get table_prefix --type=variable | grep -Fx "$SOURCE_PREFIX"

PHASE="database import and content verification"
printf 'APPLYING\n' > status
DB_CHANGED=1
MYSQL_PWD="$DB_PASSWORD" mysql "${MYSQL_ARGS[@]}" "$DB_NAME" < drop-tables.sql
gzip -dc database.sql.gz | MYSQL_PWD="$DB_PASSWORD" mysql "${MYSQL_ARGS[@]}" "$DB_NAME"
# Read-only checks immediately after import, before any WordPress bootstrap writes.
MYSQL_PWD="$DB_PASSWORD" mysql --batch --skip-column-names "${MYSQL_ARGS[@]}" "$DB_NAME" < count-tables.sql > table-counts
"$PHP_BIN" -r '
  $expected=json_decode(file_get_contents("content.json"),true,512,JSON_THROW_ON_ERROR)["tableRows"];
  $actual=array_map("intval",file("table-counts",FILE_IGNORE_NEW_LINES));
  if ($actual !== array_values($expected)) { throw new RuntimeException("Imported table row counts differ from the source."); }
'
# Verify every content row and all protected CSS.
"${CWP[@]}" eval-file "$WORKSPACE/content.php" verify "$WORKSPACE/content.json" after
"${CWP[@]}" eval-file "$WORKSPACE/content.php" settings "$WORKSPACE/content.json" "$LIVE_URL" "$SOURCE_VERSION" "$CANDIDATE"
# Keep existing server rules. A fresh hosting installation may not have rewrite rules yet.
if [ ! -e "$ROOT/.htaccess" ]; then
  "${CWP[@]}" eval 'global $wp_rewrite; echo "# BEGIN WordPress\n" . $wp_rewrite->mod_rewrite_rules() . "# END WordPress\n";' > "$CANDIDATE/.htaccess"
  chmod 644 "$CANDIDATE/.htaccess"
  printf '.htaccess\n' >> managed-paths
fi
PHASE="WordPress bootstrap"
# Plugin/theme bootstrap remains inside the rollback boundary.
"$PHP_BIN" "$WORKSPACE/wp-cli.phar" --path="$CANDIDATE" eval 'if (wp_get_theme()->errors()) { throw new RuntimeException("Active theme is incomplete."); } foreach (get_option("active_plugins") as $plugin) { if (!is_file(WP_PLUGIN_DIR . "/" . $plugin)) { throw new RuntimeException("Active plugin is missing."); } }'
"${CWP[@]}" eval-file "$WORKSPACE/content.php" verify "$WORKSPACE/content.json" after
PHASE="runtime switch"
while IFS= read -r entry; do
  if [ -e "$ROOT/$entry" ]; then printf '%s\n' "$entry" >> originally-present; fi
  printf '%s\n' "$entry" >> switched-paths
  if [ -e "$ROOT/$entry" ]; then mv "$ROOT/$entry" "$ROLLBACK/paths/$entry"; fi
  if [ -e "$CANDIDATE/$entry" ]; then mv "$CANDIDATE/$entry" "$ROOT/$entry"; fi
done < managed-paths
"$PHP_BIN" "$WORKSPACE/wp-cli.phar" --path="$ROOT" eval 'if (wp_get_theme()->errors()) { throw new RuntimeException("Active theme failed after the switch."); }'
"${WP[@]}" eval-file "$WORKSPACE/content.php" verify "$WORKSPACE/content.json" after
PHASE="HTTPS verification"
rm "$ROOT/.maintenance"
for endpoint in "$LIVE_URL/" "$LIVE_URL/wp-login.php"; do
  code="$(curl --silent --show-error --connect-timeout 15 --max-time 60 --output "$WORKSPACE/http-check.html" --write-out '%{http_code}' "$endpoint")"
  test "$code" = 200
  test -s "$WORKSPACE/http-check.html"
  if grep -Eiq 'There has been a critical error|Fatal error:|Error establishing a database connection' "$WORKSPACE/http-check.html"; then exit 1; fi
done
PERMALINK="$("${WP[@]}" eval '$pages=get_posts(["post_type"=>"page","post_status"=>"publish","numberposts"=>1]); if ($pages) { echo get_permalink($pages[0]); }')"
if [ -n "$PERMALINK" ]; then
  case "$PERMALINK" in "$LIVE_URL"/*) ;; *) echo 'Unexpected page permalink.' >&2; exit 1 ;; esac
  code="$(curl --silent --show-error --connect-timeout 15 --max-time 60 --output "$WORKSPACE/page-check.html" --write-out '%{http_code}' "$PERMALINK")"
  test "$code" = 200
fi
"${WP[@]}" eval-file "$WORKSPACE/content.php" verify "$WORKSPACE/content.json" after
printf 'VERIFIED\n' > status
trap - ERR INT TERM HUP EXIT
rmdir "$PARENT/.with-scripts-push.lock"
# Keep both rollback archives until the operator deliberately removes them.
rm -f database.sql.gz files.tar.gz http-check.html page-check.html
printf 'Verified WordPress push. Backup retained outside the public document root: %s\n' "$ROLLBACK"
