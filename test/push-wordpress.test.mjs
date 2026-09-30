import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  CORE_PATHS,
  copyRuntime,
  exportUrlPattern,
  validatePushSettings,
  buildPushPreflightScript,
} from '../src/push-wordpress.mjs';
const remoteScript = readFileSync(new URL('../src/push-remote.sh', import.meta.url), 'utf8');

test('push rejects unsafe targets and requires explicit public HTTPS', () => {
  const settings = {
    sshTarget: 'example-host',
    remoteRoot: '/example.test/httpdocs',
    liveUrl: 'https://example.org',
  };
  validatePushSettings(settings);
  validatePushSettings({ ...settings, remotePhp: '/usr/local/php84/bin/php' });
  assert.throws(() => validatePushSettings({ ...settings, remotePhp: 'php;bad' }));
  for (const remoteRoot of ['/', '/var', '~/httpdocs', '/example/../httpdocs'])
    assert.throws(() => validatePushSettings({ ...settings, remoteRoot }));
  for (const liveUrl of [
    'http://example.org',
    'https://example.ddev.site',
    'https://example.org/blog',
    'https://example.org:8443',
  ])
    assert.throws(() => validatePushSettings({ ...settings, liveUrl }));
  assert.throws(() => validatePushSettings({ ...settings, sshTarget: '-ProxyCommand=bad' }));
});

test('export replaces exact URLs and escaped JSON URLs without altering CSS bytes', () => {
  const original = String.raw`<!-- wp:group {"className":"hero","style":{"css":"& { background: url(\"https://example.ddev.site/a.jpg\"); content: \"\\\"\"; }"},"metadata":{"url":"https:\/\/example.ddev.site\/asset"}} -->
<a href="http://example.ddev.site/page">https://example.ddev.site</a>
https://example.ddev.site.evil.invalid https://example.ddev.site-other
<!-- /wp:group -->`;
  const expected = original
    .replace('https:\\/\\/example.ddev.site\\/asset', 'https://example.org\\/asset')
    .replace('http://example.ddev.site/page', 'https://example.org/page')
    .replace('>https://example.ddev.site<', '>https://example.org<');
  const input = JSON.stringify({
    pattern: `~${exportUrlPattern(['https://example.ddev.site'])}~`,
    original,
  });
  const output = execFileSync(
    'php',
    [
      '-r',
      '$v=json_decode(stream_get_contents(STDIN),true); $out=preg_replace($v["pattern"],"https://example.org",$v["original"]); if ($out===null) exit(1); echo $out;',
    ],
    { input, encoding: 'utf8' },
  );
  assert.equal(output, expected);
});

test('runtime copy omits credentials and backups and rejects nested links', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-runtime-test-'));
  try {
    const source = path.join(root, 'source');
    mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    writeFileSync(path.join(source, '.env'), 'secret');
    writeFileSync(path.join(source, 'plugin.php'), '<?php', { mode: 0o600 });
    writeFileSync(path.join(source, 'backup.sql.gz'), 'secret');
    copyRuntime(source, path.join(root, 'copy'));
    for (const name of ['.env', 'node_modules', 'backup.sql.gz'])
      assert.equal(existsSync(path.join(root, 'copy', name)), false);
    assert.equal(readFileSync(path.join(root, 'copy', 'plugin.php'), 'utf8'), '<?php');
    assert.equal(statSync(path.join(root, 'copy', 'plugin.php')).mode & 0o777, 0o644);
    symlinkSync('/etc/passwd', path.join(source, 'linked'));
    assert.throws(() => copyRuntime(source, path.join(root, 'unsafe')), /Unsupported link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote shell and generated preflight pass bash syntax checks', () => {
  for (const script of [remoteScript, buildPushPreflightScript()])
    execFileSync('bash', ['-n'], { input: script });
});

// Real transaction shell and filesystem; deterministic database/HTTP command doubles.
for (const failure of ['', 'backup', 'import', 'rows', 'content', 'http', 'move', 'restore']) {
  test(`push transaction: ${failure || 'success'}`, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-transaction-')));
    const documentRoot = path.join(root, 'httpdocs'),
      workspace = path.join(root, '.with-scripts-push.test'),
      bin = path.join(root, 'bin'),
      staging = path.join(root, 'staging');
    const php = execFileSync('which', ['php'], { encoding: 'utf8' }).trim(),
      mv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
    try {
      for (const dir of [
        documentRoot,
        workspace,
        bin,
        staging,
        path.join(root, '.with-scripts-push.lock'),
      ])
        mkdirSync(dir);
      for (const name of CORE_PATHS) {
        if (['wp-admin', 'wp-includes'].includes(name)) {
          mkdirSync(path.join(documentRoot, name));
          mkdirSync(path.join(staging, name));
          writeFileSync(path.join(documentRoot, name, 'old.txt'), 'original');
          writeFileSync(path.join(staging, name, 'new.txt'), 'candidate');
        } else {
          writeFileSync(path.join(documentRoot, name), 'original');
          writeFileSync(path.join(staging, name), 'candidate');
        }
      }
      mkdirSync(path.join(staging, 'wp-content'));
      mkdirSync(path.join(documentRoot, 'wp-content'));
      writeFileSync(path.join(documentRoot, 'wp-content', 'old.txt'), 'original');
      writeFileSync(path.join(staging, 'wp-content', 'new.txt'), 'candidate');
      writeFileSync(path.join(documentRoot, 'wp-config.php'), '<?php $table_prefix="old_";');
      writeFileSync(path.join(documentRoot, '.htaccess'), 'server configuration');
      writeFileSync(path.join(documentRoot, 'index.html'), 'placeholder');
      writeFileSync(path.join(root, 'database-state'), 'original-db');
      for (const name of ['wp-cli.phar', 'content.php'])
        writeFileSync(path.join(workspace, name), 'test-double');
      writeFileSync(
        path.join(workspace, 'content.json'),
        JSON.stringify({ tableRows: { source_posts: 1 } }),
      );
      writeFileSync(
        path.join(workspace, 'managed-paths'),
        [...CORE_PATHS, 'wp-content', 'wp-config.php', 'index.html'].join('\n') + '\n',
      );
      writeFileSync(path.join(workspace, 'source-tables'), 'source_posts\n');
      writeFileSync(path.join(workspace, 'target-tables'), 'old_posts\n');
      writeFileSync(
        path.join(workspace, 'preflight.sh'),
        'printf \'%s\' \'{"tables":["old_posts"]}\'\n',
      );
      writeFileSync(path.join(workspace, 'database.sql.gz'), gzipSync('candidate-db'));
      execFileSync('tar', ['-czf', path.join(workspace, 'files.tar.gz'), '-C', staging, '.']);
      const uploaded = [
        'wp-cli.phar',
        'content.php',
        'content.json',
        'managed-paths',
        'source-tables',
        'target-tables',
        'preflight.sh',
        'database.sql.gz',
        'files.tar.gz',
      ];
      writeFileSync(
        path.join(workspace, 'SHA256SUMS'),
        uploaded
          .map(
            (name) =>
              `${createHash('sha256')
                .update(readFileSync(path.join(workspace, name)))
                .digest('hex')}  ${name}`,
          )
          .join('\n') + '\n',
      );
      const mock = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2), name=path.basename(process.argv[1]), root=process.env.TEST_ROOT, failure=process.env.TEST_FAILURE;
if(name==='php') {
 if(!a[0]?.endsWith('wp-cli.phar')) {const r=spawnSync(${JSON.stringify(php)},a,{stdio:'inherit'}); process.exit(r.status??1);}
 const wpRoot=a.find(x=>x.startsWith('--path='))?.slice(7);
 if(a.includes('config')) {
  const i=a.indexOf('config');
  if(a[i+1]==='get') {const v={DB_NAME:'example_db',DB_USER:'example_user',DB_PASSWORD:'secret',DB_HOST:'localhost',table_prefix:'source_'}; process.stdout.write(v[a[i+2]]||'');}
  if(a[i+1]==='set') fs.writeFileSync(path.join(wpRoot,'wp-config.php'),'<?php $table_prefix="source_";');
 } else if(a.includes('db') && a.includes('export')) fs.writeFileSync(a[a.indexOf('export')+1],'original-db');
 else if(a.includes('eval-file')) {
  if(a.includes('inspect')) process.stdout.write('{}');
  if(a.includes('verify')) {if(failure==='content' && a.includes('after')) process.exit(1); const expected=a.includes('before')?'original-db':'candidate-db'; if(fs.readFileSync(path.join(root,'database-state'),'utf8')!==expected) process.exit(1);}
 }
} else if(name==='mysqldump') {
 if(failure==='backup') process.exit(1);
 process.stdout.write('original-db');
} else if(name==='mysql') {
 const sql=fs.readFileSync(0,'utf8');
 if(sql.startsWith('SELECT COUNT')) {process.stdout.write(failure==='rows'?'0\\n':'1\\n'); process.exit(0);}
 if(sql==='candidate-db' && failure==='import') {fs.writeFileSync(path.join(root,'database-state'),'partial'); process.exit(1);}
 if(sql==='original-db' && failure==='restore') process.exit(1);
 fs.writeFileSync(path.join(root,'database-state'),sql.startsWith('SET FOREIGN')?'empty':sql);
} else if(name==='curl') {
 if(!a.includes('--output')) {process.stdout.write(fs.readFileSync(path.join(root,'httpdocs',new URL(a.at(-1)).pathname))); process.exit(0);}
 fs.writeFileSync(a[a.indexOf('--output')+1],'<html>Example site</html>'); process.stdout.write(['http','restore'].includes(failure)?'500':'200');
} else if(name==='mv') {
 if(failure==='move' && a[0]===path.join(root,'httpdocs','wp-includes') && !fs.existsSync(path.join(root,'move-failed'))) {fs.writeFileSync(path.join(root,'move-failed'),'1'); process.exit(1);}
 const r=spawnSync(${JSON.stringify(mv)},a,{stdio:'inherit'}); process.exit(r.status??1);
}
`;
      for (const command of ['php', 'mysql', 'mysqldump', 'curl', 'mv']) {
        const file = path.join(bin, command);
        writeFileSync(file, mock);
        chmodSync(file, 0o755);
      }
      const result = spawnSync(
        'bash',
        ['-s', '--', documentRoot, workspace, 'https://example.org', 'source_', '7.0'],
        {
          input: remoteScript,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TEST_ROOT: root,
            TEST_FAILURE: failure,
          },
        },
      );
      const output = result.stdout + result.stderr;
      assert.equal(existsSync(path.join(workspace, 'status')), true, output);
      const status = readFileSync(path.join(workspace, 'status'), 'utf8').trim();
      assert.equal(
        readFileSync(path.join(documentRoot, '.htaccess'), 'utf8'),
        'server configuration',
      );
      if (!failure) {
        assert.equal(result.status, 0, output);
        assert.equal(status, 'VERIFIED');
        assert.equal(readFileSync(path.join(documentRoot, 'index.php'), 'utf8'), 'candidate');
        assert.equal(existsSync(path.join(documentRoot, 'index.html')), false);
        assert.equal(existsSync(path.join(workspace, 'rollback/database.sql.gz')), true);
        assert.equal(existsSync(path.join(root, '.with-scripts-first-launch')), false);
        assert.equal(statSync(path.join(documentRoot, 'wp-content')).mode & 0o777, 0o755);
        assert.equal(statSync(path.join(documentRoot, 'wp-content/new.txt')).mode & 0o777, 0o644);
      } else {
        assert.notEqual(result.status, 0, output);
        assert.equal(status, failure === 'restore' ? 'ROLLBACK_FAILED' : 'ROLLED_BACK', output);
        assert.equal(readFileSync(path.join(documentRoot, 'index.php'), 'utf8'), 'original');
        assert.equal(
          readFileSync(path.join(documentRoot, 'wp-includes/old.txt'), 'utf8'),
          'original',
        );
        assert.equal(readFileSync(path.join(documentRoot, 'index.html'), 'utf8'), 'placeholder');
        assert.equal(existsSync(path.join(documentRoot, '.maintenance')), failure === 'restore');
        if (failure !== 'restore')
          assert.equal(readFileSync(path.join(root, 'database-state'), 'utf8'), 'original-db');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// Execute the generated PHP rather than checking only the surrounding shell syntax.
test('preflight accepts an existing site and uses the selected PHP executable', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-preflight-')));
  try {
    writeFileSync(path.join(root, 'wp-config.php'), '<?php');
    writeFileSync(
      path.join(root, 'wp-load.php'),
      `<?php
      define('ARRAY_N', 'ARRAY_N');
      define('WP_CONTENT_DIR', __DIR__ . '/wp-content');
      $wpdb = new class {
        public $prefix = 'wp_'; public $options = 'wp_options'; public $last_error = '';
        public function get_var($sql) { return 'https://example.org'; }
        public function get_results($sql, $mode) { return [['wp_options', 'BASE TABLE'], ['wp_posts', 'BASE TABLE']]; }
      };
    `,
    );
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const name of ['mysql', 'mysqldump']) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
      chmodSync(path.join(bin, name), 0o755);
    }
    const php = execFileSync('which', ['php'], { encoding: 'utf8' }).trim();
    const result = spawnSync('bash', ['-s', '--', root, 'https://example.org', php], {
      input: buildPushPreflightScript(),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).home, 'https://example.org');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content verification rejects a missing plugin table before accepting an import', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-content-'));
  try {
    const manifest = path.join(root, 'content.json');
    writeFileSync(manifest, JSON.stringify({ tables: ['wp_posts', 'wp_plugin_data'], posts: [] }));
    const contentScript = new URL('../src/push-content.php', import.meta.url).pathname;
    const result = spawnSync(
      'php',
      [
        '-r',
        `
      $args = ['verify', $argv[1], 'after'];
      $wpdb = new class {
        public $last_error = '';
        public function get_col($sql) { return ['wp_posts']; }
      };
      require $argv[2];
    `,
        manifest,
        contentScript,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Imported database tables differ/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
