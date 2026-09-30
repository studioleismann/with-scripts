import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { log, note, outro } from '@clack/prompts';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ask, askRequired, createPrompts, readConfig, run, runCapture, runToFile } from './cli.mjs';
import { normalizeUrl, validateRemoteInput } from './remote-wordpress.mjs';
import { ddevUrl } from './pull-wordpress.mjs';

const CONTENT_SCRIPT = readFileSync(new URL('./push-content.php', import.meta.url), 'utf8');
const REMOTE_SCRIPT = readFileSync(new URL('./push-remote.sh', import.meta.url), 'utf8');
export const CORE_PATHS = [
  'index.php',
  'wp-activate.php',
  'wp-admin',
  'wp-blog-header.php',
  'wp-comments-post.php',
  'wp-cron.php',
  'wp-includes',
  'wp-links-opml.php',
  'wp-load.php',
  'wp-login.php',
  'wp-mail.php',
  'wp-settings.php',
  'wp-signup.php',
  'wp-trackback.php',
  'xmlrpc.php',
];
const CONTENT_PATHS = ['plugins', 'themes', 'mu-plugins', 'languages', 'uploads'];

export function exportUrlPattern(urls) {
  const variants = [
    ...new Set(
      urls.flatMap((value) => {
        const url = new URL(value);
        return ['http:', 'https:'].map((protocol) => `${protocol}//${url.host}`);
      }),
    ),
  ];
  // CSS JSON strings are opaque protected data, including escaped quotes/backslashes.
  const alternatives = variants
    .flatMap((value) => [value, value.replaceAll('/', '\\/')])
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\~]/g, '\\$&'));
  return `"css"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"(*SKIP)(*F)|(?:${alternatives.join('|')})(?=$|[/\\\\\\s"'<>?#])`;
}

export function validatePushSettings(settings) {
  validateRemoteInput(settings.sshTarget, settings.remoteRoot);
  if (settings.remotePhp && !/^(?:php|\/[a-zA-Z0-9_./-]+)$/.test(settings.remotePhp))
    throw new Error('Remote PHP must be php or an absolute executable path.');
  const url = new URL(normalizeUrl(settings.liveUrl));
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.port ||
    /(?:\.ddev\.site|\.local|\.test|localhost)$/.test(url.hostname)
  ) {
    throw new Error('Push requires a public HTTPS URL at the domain root.');
  }
  if (
    !settings.remoteRoot.startsWith('/') ||
    settings.remoteRoot.split('/').filter(Boolean).length < 2
  ) {
    throw new Error('Push requires an explicit absolute document root below a site directory.');
  }
}

export function copyRuntime(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      if (
        [
          'node_modules',
          '.git',
          '.github',
          '.ddev',
          '.DS_Store',
          '.with-scripts.json',
          '.env',
          '.env.local',
          '.webpack-cache',
          '.npmrc',
          '.netrc',
          '.vscode',
          '.idea',
          'wpvividbackups',
          'wpvivid_uploads',
          'wpvivid_staging',
          'ai1wm-backups',
          'updraft',
          'logs',
        ].includes(name) ||
        name.startsWith('._') ||
        name.startsWith('.env.') ||
        /\.(?:sql|sql\.gz|tar|tar\.gz|tgz|log|pem|key)$/i.test(name)
      )
        return false;
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`Unsupported link or special file in runtime: ${entry}`);
      return true;
    },
  });
  // Runtime files must remain readable by the hosting web server.
  execFileSync('chmod', ['-R', 'u=rwX,go=rX', destination]);
}

export function buildPushPreflightScript() {
  return `set -eu
ROOT="$1"
PHP_BIN="${'$'}{3:-php}"
test -d "$ROOT" && test ! -L "$ROOT"
cd "$ROOT"
test "$PWD" = "$(pwd -P)"
test ! -e .maintenance || { echo "Target is in maintenance mode. Finish its current operation before pushing." >&2; exit 1; }
test -r wp-config.php && test -f wp-load.php || { echo 'Install WordPress at this document root first.' >&2; exit 1; }
for cmd in "$PHP_BIN" mysql mysqldump gzip tar curl sha256sum; do command -v "$cmd" >/dev/null; done
"$PHP_BIN" -r '
  define("SHORTINIT", true);
  require "wp-load.php";
  ini_set("display_errors", "stderr");
  if (defined("MULTISITE") && MULTISITE) { throw new RuntimeException("Multisite is not supported."); }
  if (defined("WP_CONTENT_DIR") && WP_CONTENT_DIR !== __DIR__ . "/wp-content") { throw new RuntimeException("Custom content directories are not supported."); }
  $home = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = \\"home\\"");
  $site = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = \\"siteurl\\"");
  if ($home !== $argv[1] || $site !== $argv[1]) { throw new RuntimeException("Target URL does not match the installed WordPress database."); }
  $tables = [];
  foreach ($wpdb->get_results("SHOW FULL TABLES", ARRAY_N) as $table) {
    if (!str_starts_with($table[0], $wpdb->prefix) || $table[1] !== "BASE TABLE" || !preg_match("/^[a-zA-Z0-9_]+$/", $table[0])) { throw new RuntimeException("Shared databases and views are not supported."); }
    $tables[] = $table[0];
  }
  if ($wpdb->last_error || !$tables) { throw new RuntimeException("Target database inspection failed."); }
  echo json_encode(["root" => getcwd(), "home" => $home, "prefix" => $wpdb->prefix, "tables" => $tables, "php" => PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION]);
' "$2"
`;
}

export async function pushWordPress(argv = []) {
  const options = {};
  for (const arg of argv) {
    if (['--dry-run', '--prepare-only'].includes(arg)) options[arg.slice(2)] = true;
    else if (/^--(?:ssh|root|url|php)=.+/.test(arg))
      options[arg.slice(2, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
    else throw new Error(`Unknown push option: ${arg}`);
  }
  if (options['dry-run'] && options['prepare-only'])
    throw new Error('Choose --dry-run or --prepare-only.');
  const projectRoot = process.cwd();
  if (!existsSync(path.join(projectRoot, '.ddev/config.yaml')))
    throw new Error('Run push-wordpress from the DDEV WordPress document root.');
  // Deliberately never inherit wordpressPull: a local beta may pull the main site.
  const defaults = readConfig(projectRoot).wordpressPush || {};
  const rl = createPrompts();
  let temporaryRoot;
  let remoteWorkspace;
  let sshTarget;
  let remoteApplyStarted = false;
  try {
    log.warn('WordPress push replaces the target website with the local site.');
    sshTarget = options.ssh || defaults.sshTarget || (await askRequired(rl, 'SSH target'));
    const remoteRoot = (
      options.root ||
      defaults.remoteRoot ||
      (await askRequired(rl, 'Target document root'))
    ).replace(/\/+$/, '');
    const liveUrl = normalizeUrl(
      options.url || defaults.liveUrl || (await askRequired(rl, 'Target HTTPS URL')),
    );
    const remotePhp = options.php || defaults.remotePhp || 'php';
    validatePushSettings({ sshTarget, remoteRoot, liveUrl, remotePhp });
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const sshOptions = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      sshTarget,
    ];
    const localUrl = normalizeUrl(
      runCapture('Reading local URL', 'ddev', [
        'wp',
        'option',
        'get',
        'home',
        '--skip-plugins',
        '--skip-themes',
      ]).trim(),
    );
    if (
      new URL(localUrl).pathname !== '/' ||
      new URL(localUrl).hostname === new URL(liveUrl).hostname
    )
      throw new Error('Local and target URLs must be different domain-root URLs.');
    const pattern = exportUrlPattern([localUrl, ddevUrl(projectRoot, liveUrl)]);
    const auditSettings = Buffer.from(
      JSON.stringify({ pattern: `~${pattern}~`, replacement: liveUrl.replace(/[\\$]/g, '\\$&') }),
    ).toString('base64');
    const source = JSON.parse(
      runCapture('Inventorying content, revisions, autosaves and custom CSS', 'ddev', [
        'wp',
        'eval',
        `$args = array('inspect', '${auditSettings}');\n${CONTENT_SCRIPT.slice(5)}`,
        '--skip-plugins',
        '--skip-themes',
      ]),
    );
    if (
      !/^[a-zA-Z0-9_]+$/.test(source.prefix) ||
      !source.tables.length ||
      source.tables.some(
        (table) => !/^[a-zA-Z0-9_]+$/.test(table) || !table.startsWith(source.prefix),
      )
    )
      throw new Error('Unsafe source table names.');
    for (const slug of [source.theme, source.template]) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(slug) ||
        !existsSync(path.join(projectRoot, 'wp-content/themes', slug, 'style.css'))
      )
        throw new Error(`Missing active theme: ${slug}`);
    }
    const preflight = buildPushPreflightScript();
    let target;
    if (!options['prepare-only']) {
      target = JSON.parse(
        runCapture(
          'Checking target without changes',
          'ssh',
          [...sshOptions, `bash -s -- ${quote(remoteRoot)} ${quote(liveUrl)} ${quote(remotePhp)}`],
          preflight,
        ),
      );
      if (target.php !== source.php)
        throw new Error(
          `Select matching PHP versions with --php=/path/to/php before pushing (local ${source.php}, remote ${target.php}).`,
        );
    }
    note([
      `Source: ${localUrl}\nTarget: ${sshTarget}:${remoteRoot}\nWebsite: ${liveUrl}`,
      `WordPress ${source.version}; theme ${source.theme}; ${source.posts.length} content/revision rows.`,
      'Replaces the target database, core, plugins, themes and uploads. Accounts come from the local site.',
      'Keeps target database credentials, salts and server configuration; changes only its table prefix if needed.',
    ].join('\n\n'), 'Review the push target');
    if (options['dry-run']) {
      outro('Read-only preflight passed. No package, upload or database change was made.');
      return;
    }

    temporaryRoot = mkdtempSync(path.join(tmpdir(), 'with-scripts-push-'));
    chmodSync(temporaryRoot, 0o700);
    const candidate = path.join(temporaryRoot, 'candidate');
    mkdirSync(candidate, { mode: 0o700 });
    for (const entry of CORE_PATHS) {
      if (!existsSync(path.join(projectRoot, entry)))
        throw new Error(`Missing WordPress core path: ${entry}`);
      copyRuntime(path.join(projectRoot, entry), path.join(candidate, entry));
    }
    for (const entry of CONTENT_PATHS) {
      const destination = path.join(candidate, 'wp-content', entry);
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      if (existsSync(path.join(projectRoot, 'wp-content', entry)))
        copyRuntime(path.join(projectRoot, 'wp-content', entry), destination);
    }
    writeFileSync(path.join(candidate, 'wp-content/index.php'), '<?php // Silence is golden.\n');
    // Build only version-controlled packages, in the disposable copy. Never npm ci in the source.
    let tracked = [];
    try {
      tracked = execFileSync('git', ['ls-files', '-z', '--', 'wp-content'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).split('\0');
    } catch {
      /* Prebuilt runtime without a repository is supported. */
    }
    const packages = new Set(
      tracked
        .map((entry) => entry.match(/^(wp-content\/(?:themes|plugins)\/[^/]+)\//)?.[1])
        .filter(Boolean),
    );
    for (const entry of packages) {
      const directory = path.join(candidate, entry);
      if (!existsSync(path.join(directory, 'package.json'))) continue;
      const json = JSON.parse(readFileSync(path.join(directory, 'package.json')));
      if (json.scripts?.build) {
        const dependencies = path.join(projectRoot, entry, 'node_modules');
        if (!existsSync(dependencies))
          throw new Error(`Install build dependencies locally first: ${entry}`);
        symlinkSync(dependencies, path.join(directory, 'node_modules'), 'dir');
        try {
          execFileSync('npm', ['run', 'build'], { cwd: directory, stdio: 'inherit' });
        } finally {
          rmSync(path.join(directory, 'node_modules'));
        }
      }
    }
    // Recheck the staged tree: build scripts must not leave links, secrets or caches behind.
    const runtime = path.join(temporaryRoot, 'runtime');
    copyRuntime(candidate, runtime);
    rmSync(candidate, { recursive: true });
    await runToFile(
      'Exporting URLs without modifying the local database',
      'ddev',
      [
        'exec',
        '--raw',
        '--',
        'php',
        '-d',
        'error_reporting=24575',
        '/usr/local/bin/wp-cli',
        "--exec=WP_CLI::add_hook('after_wp_load', function () { error_reporting(E_ALL & ~E_DEPRECATED); ini_set('display_errors', 'stderr'); });",
        'search-replace',
        pattern,
        liveUrl.replace(/[\\$]/g, '\\$&'),
        ...source.tables,
        '--all-tables-with-prefix',
        '--regex',
        '--regex-delimiter=~',
        '--precise',
        '--skip-columns=guid',
        '--export',
        '--quiet',
        '--skip-plugins',
        '--skip-themes',
      ],
      undefined,
      path.join(temporaryRoot, 'database.sql'),
    );
    // WP-CLI otherwise intersects explicit table names with its registered core tables.
    // Verify the SQL before uploading so omitted plugin tables cannot reach the target.
    const exportedTables = [];
    const sqlLines = createInterface({
      input: createReadStream(path.join(temporaryRoot, 'database.sql')),
      crlfDelay: Infinity,
    });
    for await (const line of sqlLines) {
      const table = line.match(/^CREATE TABLE `([a-zA-Z0-9_]+)`/);
      if (table) exportedTables.push(table[1]);
    }
    if (JSON.stringify(exportedTables.sort()) !== JSON.stringify([...source.tables].sort())) {
      throw new Error(
        'Database export is incomplete. Expected every source table, including plugin tables.',
      );
    }
    const after = JSON.parse(
      runCapture('Verifying the local content stayed unchanged during export', 'ddev', [
        'wp',
        'eval',
        `$args = array('inspect', '${auditSettings}');\n${CONTENT_SCRIPT.slice(5)}`,
        '--skip-plugins',
        '--skip-themes',
      ]),
    );
    if (JSON.stringify(source) !== JSON.stringify(after))
      throw new Error(
        'The local site changed during preparation. Retry after editing has stopped.',
      );
    // WP-CLI search-replace exports table SQL without mysqldump's session preamble.
    // WordPress zero dates require a compatible session mode; preserve UTF-8 bytes.
    await pipeline(
      Readable.from(
        (async function* () {
          yield "SET NAMES utf8mb4;\nSET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO';\nSET FOREIGN_KEY_CHECKS=0;\n";
          yield* createReadStream(path.join(temporaryRoot, 'database.sql'));
          yield '\nSET FOREIGN_KEY_CHECKS=1;\n';
        })(),
      ),
      createGzip(),
      createWriteStream(path.join(temporaryRoot, 'database.sql.gz'), { mode: 0o600, flags: 'wx' }),
    );
    rmSync(path.join(temporaryRoot, 'database.sql'));
    execFileSync(
      'tar',
      ['--no-xattrs', '-czf', path.join(temporaryRoot, 'files.tar.gz'), '-C', runtime, '.'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' },
    );
    run('Checking database archive', 'gzip', ['-t', path.join(temporaryRoot, 'database.sql.gz')]);
    run('Checking runtime archive', 'tar', ['-tzf', path.join(temporaryRoot, 'files.tar.gz')], {
      stdout: 'ignore',
    });
    await runToFile(
      'Bundling the installed WP-CLI for hosts without it',
      'ddev',
      ['exec', '--raw', '--', 'cat', '/usr/local/bin/wp-cli'],
      undefined,
      path.join(temporaryRoot, 'wp-cli.phar'),
    );
    writeFileSync(path.join(temporaryRoot, 'content.json'), JSON.stringify(source), {
      mode: 0o600,
    });
    writeFileSync(path.join(temporaryRoot, 'content.php'), CONTENT_SCRIPT, { mode: 0o600 });
    const managed = [...CORE_PATHS, 'wp-content', 'wp-config.php', 'index.html'];
    writeFileSync(path.join(temporaryRoot, 'managed-paths'), managed.join('\n') + '\n', {
      mode: 0o600,
    });
    writeFileSync(path.join(temporaryRoot, 'source-tables'), source.tables.join('\n') + '\n', {
      mode: 0o600,
    });
    writeFileSync(path.join(temporaryRoot, 'preflight.sh'), preflight, { mode: 0o600 });
    if (options['prepare-only']) {
      console.log(`\nLocal package prepared and retained privately: ${temporaryRoot}`);
      console.log('Target was not checked or contacted. This is not a completed deployment.');
      temporaryRoot = undefined;
      return;
    }
    console.log(
      '\nPackage ready. Target backup and rollback remain private outside the document root.',
    );
    if (
      (await ask(rl, `Type PUSH ${liveUrl} to overwrite the target website`)) !== `PUSH ${liveUrl}`
    ) {
      outro('Stopped before uploading or changing the target.');
      return;
    }
    rl?.close();
    // Recheck the exact target after the user has reviewed the package.
    const checked = JSON.parse(
      runCapture(
        'Rechecking the target',
        'ssh',
        [...sshOptions, `bash -s -- ${quote(remoteRoot)} ${quote(liveUrl)} ${quote(remotePhp)}`],
        preflight,
      ),
    );
    if (JSON.stringify(checked) !== JSON.stringify(target))
      throw new Error('Target changed during preparation. Run the push again.');
    const workspace = runCapture(
      'Creating private target workspace',
      'ssh',
      [...sshOptions, `bash -s -- ${quote(remoteRoot)}`],
      `set -eu\ncd "$1"\ntest "$PWD" = "$(pwd -P)"\nparent="$(dirname "$PWD")"\numask 077\nmkdir "$parent/.with-scripts-push.lock" || { echo 'Another push or an interrupted run owns the lock.' >&2; exit 1; }\ntrap 'rmdir "$parent/.with-scripts-push.lock"' ERR\nworkspace="$(mktemp -d "$parent/.with-scripts-push.XXXXXXXX")"\nprintf 'UPLOADING\\n' > "$workspace/status"\nprintf '%s\\n' "$workspace"\n`,
    ).trim();
    if (
      !/^\/[a-zA-Z0-9_./-]+$/.test(workspace) ||
      !workspace.startsWith(path.posix.dirname(remoteRoot) + '/.with-scripts-push.')
    )
      throw new Error('Server returned an unexpected workspace.');
    remoteWorkspace = workspace;
    writeFileSync(path.join(temporaryRoot, 'target-tables'), target.tables.join('\n') + '\n', {
      mode: 0o600,
    });
    const uploads = [
      'files.tar.gz',
      'database.sql.gz',
      'wp-cli.phar',
      'content.php',
      'content.json',
      'managed-paths',
      'source-tables',
      'target-tables',
      'preflight.sh',
    ];
    const checksums = [];
    for (const name of uploads) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path.join(temporaryRoot, name)))
        hash.update(chunk);
      checksums.push(`${hash.digest('hex')}  ${name}`);
    }
    writeFileSync(path.join(temporaryRoot, 'SHA256SUMS'), checksums.join('\n') + '\n', {
      mode: 0o600,
    });
    run('Uploading verified WordPress package', 'scp', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      ...[...uploads, 'SHA256SUMS'].map((name) => path.join(temporaryRoot, name)),
      `${sshTarget}:${remoteWorkspace}/`,
    ]);
    remoteApplyStarted = true;
    run(
      'Applying and checking the WordPress push',
      'ssh',
      [
        ...sshOptions,
        `bash -s -- ${quote(remoteRoot)} ${quote(remoteWorkspace)} ${quote(liveUrl)} ${quote(source.prefix)} ${quote(source.version)} ${quote(remotePhp)}`,
      ],
      { input: REMOTE_SCRIPT },
    );
    outro(
      `\nWordPress push complete: ${liveUrl}\nVerified rollback backup retained at ${sshTarget}:${remoteWorkspace}/rollback`,
    );
  } catch (error) {
    if (remoteWorkspace && !remoteApplyStarted) {
      // The transaction was never dispatched, so an incomplete upload can release its lock.
      try {
        runCapture(
          'Releasing the unused upload lock',
          'ssh',
          [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=15',
            sshTarget,
            `bash -s -- '${remoteWorkspace}'`,
          ],
          `set -eu\nworkspace="$1"\ntest "$(cat "$workspace/status")" = UPLOADING\nprintf 'UPLOAD_FAILED\\n' > "$workspace/status"\nrmdir "$(dirname "$workspace")/.with-scripts-push.lock"\n`,
        );
      } catch {
        console.error(
          'Could not release the upload lock. Inspect the remote workspace before retrying.',
        );
      }
    }
    if (remoteWorkspace)
      console.error(
        `\nRemote workspace retained at ${sshTarget}:${remoteWorkspace}. Check its status before retrying; never assume rollback succeeded after a lost SSH connection.`,
      );
    throw error;
  } finally {
    rl?.close();
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
