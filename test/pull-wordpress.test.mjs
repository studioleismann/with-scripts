import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backupTrackedFiles,
  ddevUrl,
  inspectLocalProtection,
  mirrorProductionFiles,
  patchWpConfig,
  prepareProductionPackages,
  urlVariants,
} from '../src/pull-wordpress.mjs';

test('existing WordPress without Git gets a warning', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  try {
    writeFileSync(path.join(root, 'index.php'), '<?php');
    assert.match(inspectLocalProtection(root).warning, /not protected by Git/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production extraction can restore every Git-tracked file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const source = path.join(root, 'wp-content/themes/custom-theme/src/main.js');
  const productionPlugin = path.join(root, 'wp-content/plugins/third-party/plugin.php');
  const backup = path.join(tmpdir(), `with-scripts-git-${process.pid}-${Date.now()}.tar.gz`);

  try {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, 'tracked source');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0);

    assert.equal(backupTrackedFiles(root, backup), true);
    writeFileSync(source, 'production source');
    mkdirSync(path.dirname(productionPlugin), { recursive: true });
    writeFileSync(productionPlugin, 'production plugin');

    assert.equal(spawnSync('tar', ['-xzf', backup, '-C', root]).status, 0);
    assert.equal(readFileSync(source, 'utf8'), 'tracked source');
    assert.equal(readFileSync(productionPlugin, 'utf8'), 'production plugin');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backup, { force: true });
  }
});

test('production packages replace local copies without mixing Git-managed packages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const production = mkdtempSync(path.join(tmpdir(), 'with-scripts-production-'));
  const archive = path.join(tmpdir(), `with-scripts-production-${process.pid}-${Date.now()}.tar.gz`);

  try {
    const localPlugin = path.join(root, 'wp-content/plugins/example-plugin');
    const localTheme = path.join(root, 'wp-content/themes/customer-theme');
    const localOnlyTheme = path.join(root, 'wp-content/themes/twentytwentyfive');
    const localIntegration = path.join(
      localPlugin,
      'src/plugins/admin-site-enhancements/form-builder-honeypot',
    );
    mkdirSync(localIntegration, { recursive: true });
    mkdirSync(localTheme, { recursive: true });
    mkdirSync(localOnlyTheme, { recursive: true });
    writeFileSync(path.join(localIntegration, 'index.php'), '<?php // Local plugin version.');
    writeFileSync(path.join(localTheme, 'functions.php'), '<?php // Tracked theme version.');
    writeFileSync(path.join(localOnlyTheme, 'style.css'), 'Local-only theme.');

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(
      spawnSync('git', ['add', 'wp-content/themes/customer-theme/functions.php'], { cwd: root }).status,
      0,
    );

    const productionPlugin = path.join(production, 'wp-content/plugins/example-plugin');
    const productionTheme = path.join(production, 'wp-content/themes/customer-theme');
    const productionIntegration = path.join(
      productionPlugin,
      'src/plugins/admin-site-enhancements-pro/form-builder-honeypot',
    );
    mkdirSync(productionIntegration, { recursive: true });
    mkdirSync(productionTheme, { recursive: true });
    writeFileSync(path.join(productionIntegration, 'index.php'), '<?php // Production plugin version.');
    writeFileSync(path.join(productionTheme, 'functions.php'), '<?php // Production theme version.');
    writeFileSync(path.join(productionTheme, 'legacy.php'), '<?php // Production-only theme file.');

    assert.equal(
      spawnSync('tar', ['-czf', archive, '-C', production, '.']).status,
      0,
    );

    const excludes = prepareProductionPackages(root, archive, true);
    assert.equal(
      spawnSync('tar', ['-xzf', archive, '-C', root, ...excludes]).status,
      0,
    );

    assert.equal(existsSync(localIntegration), false);
    assert.equal(
      readFileSync(
        path.join(
          localPlugin,
          'src/plugins/admin-site-enhancements-pro/form-builder-honeypot/index.php',
        ),
        'utf8',
      ),
      '<?php // Production plugin version.',
    );
    assert.equal(readFileSync(path.join(localTheme, 'functions.php'), 'utf8'), '<?php // Tracked theme version.');
    assert.equal(existsSync(path.join(localTheme, 'legacy.php')), false);
    assert.equal(existsSync(localOnlyTheme), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(production, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
});

test('mirror cleanup removes local-only files while preserving Git packages and local system paths', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const production = mkdtempSync(path.join(tmpdir(), 'with-scripts-production-'));
  const archive = path.join(tmpdir(), `with-scripts-production-${process.pid}-${Date.now()}.tar.gz`);

  try {
    const trackedTheme = path.join(root, 'wp-content/themes/customer-theme');
    const localOnlyTheme = path.join(root, 'wp-content/themes/twentytwentyfive');
    const localOnlyUpload = path.join(root, 'wp-content/uploads/local-only.jpg');
    const productionUpload = path.join(production, 'wp-content/uploads/production.jpg');

    mkdirSync(trackedTheme, { recursive: true });
    mkdirSync(localOnlyTheme, { recursive: true });
    mkdirSync(path.dirname(localOnlyUpload), { recursive: true });
    mkdirSync(path.join(root, '.ddev'), { recursive: true });
    mkdirSync(path.join(root, 'wp-content/cache'), { recursive: true });
    mkdirSync(path.dirname(productionUpload), { recursive: true });
    mkdirSync(path.join(production, 'wp-content/themes'), { recursive: true });
    mkdirSync(path.join(production, 'wp-content/plugins'), { recursive: true });

    writeFileSync(path.join(trackedTheme, 'functions.php'), '<?php // Tracked.');
    writeFileSync(path.join(trackedTheme, 'local-tool.php'), '<?php // Protected package.');
    writeFileSync(path.join(localOnlyTheme, 'style.css'), 'Local-only theme.');
    writeFileSync(localOnlyUpload, 'Local-only upload.');
    writeFileSync(path.join(root, 'local-notes.txt'), 'Untracked local file.');
    writeFileSync(path.join(root, 'README.md'), 'Tracked project file.');
    writeFileSync(path.join(root, '.ddev/config.yaml'), 'name: example-project\n');
    writeFileSync(path.join(root, 'wp-content/cache/local.cache'), 'Local cache.');
    writeFileSync(productionUpload, 'Production upload.');

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(
      spawnSync(
        'git',
        ['add', 'README.md', 'wp-content/themes/customer-theme/functions.php'],
        { cwd: root },
      ).status,
      0,
    );
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', production, '.']).status, 0);

    const result = await mirrorProductionFiles(root, archive, true);

    assert.equal(result.removedFiles, 3);
    assert.equal(existsSync(localOnlyTheme), false);
    assert.equal(existsSync(localOnlyUpload), false);
    assert.equal(existsSync(path.join(root, 'local-notes.txt')), false);
    assert.equal(existsSync(path.join(root, 'README.md')), true);
    assert.equal(existsSync(path.join(trackedTheme, 'functions.php')), true);
    assert.equal(existsSync(path.join(trackedTheme, 'local-tool.php')), true);
    assert.equal(existsSync(path.join(root, '.ddev/config.yaml')), true);
    assert.equal(existsSync(path.join(root, 'wp-content/cache/local.cache')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(production, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
});

test('wp-config patch is safe and idempotent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const configPath = path.join(root, 'wp-config.php');
  try {
    writeFileSync(configPath, `<?php
define( 'DB_NAME', 'prod' );
define( 'DB_USER', 'prod' );
define( 'DB_PASSWORD', 'secret' );
define( 'DB_HOST', 'db.example.com' );
`);
    patchWpConfig(configPath);
    const first = readFileSync(configPath, 'utf8');
    patchWpConfig(configPath);
    assert.equal(readFileSync(configPath, 'utf8'), first);
    assert.match(first, /wp-config-ddev\.php/);
    assert.match(first, /defined\( 'DB_PASSWORD' \) \|\| define/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('URL variants cover www and HTTP versions', () => {
  assert.deepEqual(urlVariants('https://www.example.com'), [
    'https://www.example.com',
    'https://example.com',
    'http://example.com',
    'http://www.example.com',
  ]);
});

test('DDEV URL uses project_tld from config.yaml', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  try {
    mkdirSync(path.join(root, '.ddev'), { recursive: true });
    writeFileSync(path.join(root, '.ddev', 'config.yaml'), `name: example-project
project_tld: local
`);

    assert.equal(ddevUrl(root, 'https://example-project.example.com'), 'https://example-project.local');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DDEV URL falls back to ddev.site when project_tld is absent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  try {
    mkdirSync(path.join(root, '.ddev'), { recursive: true });
    writeFileSync(path.join(root, '.ddev', 'config.yaml'), 'name: example-project\n');

    assert.equal(ddevUrl(root, 'https://example-project.example.com'), 'https://example-project.ddev.site');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
