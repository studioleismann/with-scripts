import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const packageRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(packageRoot, 'bin', 'with-scripts.mjs');
const wizard = readFileSync(path.join(packageRoot, 'src', 'setup-deployment.sh'), 'utf8');
const library = wizard.split('# STAGES:')[0];

for (const command of ['inspect-wordpress', 'setup-wordpress', 'pull-wordpress', 'configure-wordpress', 'setup-theme', 'sync-tools', 'push-wordpress', 'setup-deployment']) {
  test(`${command} help and unknown options stop before project access`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-options-'));
    try {
      writeFileSync(path.join(root, '.with-scripts.json'), 'invalid JSON');
      for (const flag of ['--help', '-h', '--invalid-option']) {
        const result = spawnSync(process.execPath, [cli, command, flag], { cwd: root, input: '', encoding: 'utf8', timeout: 3000 });
        assert.equal(result.status, flag === '--invalid-option' ? 1 : 0, result.stderr);
        assert.match(result.stdout + result.stderr, flag === '--invalid-option' ? /Unknown (?:push )?option/i : /Usage: with-scripts/);
        assert.doesNotMatch(result.stdout + result.stderr, /Invalid .with-scripts.json|SSH target:|unsettled top-level await/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('pull rejects unsupported dry-run and an EOF produces an actionable error', () => {
  for (const [command, args, message] of [
    ['pull-wordpress', ['--dry-run'], /Unknown option for pull-wordpress/],
    ['inspect-wordpress', [], /Input closed.*interactive terminal/],
  ]) {
    const result = spawnSync(process.execPath, [cli, command, ...args], { cwd: packageRoot, input: '', encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  }
});

test('deployment demo works in an empty folder without project or service access', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-demo-')));
  const project = path.join(root, 'empty-project');
  const bin = path.join(root, 'bin');
  const commandLog = path.join(root, 'external-commands');
  try {
    mkdirSync(project);
    mkdirSync(bin);
    for (const command of ['git', 'gh', 'ssh', 'ssh-keygen', 'ssh-keyscan', 'ddev', 'open', 'xdg-open', 'wslview', 'explorer.exe']) {
      writeFileSync(path.join(bin, command), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.TEST_COMMAND_LOG, ${JSON.stringify(command)} + '\\n'); process.exit(1);\n`, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [cli, 'setup-deployment', '--demo'], {
      cwd: project, input: '\ndemo-theme\n\n\n\n\n\n', encoding: 'utf8', timeout: 3000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: commandLog },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Stage 1\/5.*Demo/);
    assert.match(result.stdout, /Stage 5\/5.*Demo/);
    assert.match(result.stdout, /wp-content\/themes\/demo-theme/);
    assert.match(result.stdout, /Demo complete.*All steps were simulated/);
    assert.doesNotMatch(result.stdout, /Deployment setup complete|Setup complete|✓ set/);
    assert.equal(existsSync(commandLog), false, 'Demo must not call Git, SSH, GitHub CLI, or a browser.');
    assert.deepEqual(readdirSync(project), []);

    writeFileSync(path.join(project, '.with-scripts.json'), 'invalid JSON');
    const retry = spawnSync(process.execPath, [cli, 'setup-deployment', '--demo'], {
      cwd: project, input: '', encoding: 'utf8', timeout: 3000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: commandLog },
    });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readFileSync(path.join(project, '.with-scripts.json'), 'utf8'), 'invalid JSON');
    assert.equal(existsSync(commandLog), false);
    for (const option of ['--dry-run', '--host=real.example.org']) {
      const invalid = spawnSync(process.execPath, [cli, 'setup-deployment', '--demo', option], { cwd: project, input: '', encoding: 'utf8', timeout: 3000 });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Use --demo on its own/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const empty of [true, false]) {
  test(`deployment explains ${empty ? 'an empty folder' : 'a folder without Git'}`, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-no-project-')));
    try {
      if (!empty) writeFileSync(path.join(root, 'README.md'), 'Existing local files.\n');
      const before = readdirSync(root);
      const result = spawnSync(process.execPath, [cli, 'setup-deployment', '--dry-run'], { cwd: root, input: '', encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, empty ? /This folder is empty/ : /No Git repository could be read/);
      if (empty) assert.match(result.stderr, /with-scripts setup-deployment --demo/);
      assert.ok(result.stderr.includes(root));
      assert.deepEqual(readdirSync(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const scenario of [
  { name: 'theme preview', success: true },
  { name: 'plugin preview', plugin: true, success: true },
  { name: 'saved public deployment values', saved: true, success: true },
  { name: 'preview from a theme subdirectory', nested: true, omitTheme: true, multipleThemes: true, success: true },
  { name: 'saved defaults from a theme subdirectory', nested: true, saved: true, success: true },
  { name: 'plugin preview from a subdirectory', nested: true, plugin: true, success: true },
  { name: 'SSH origin with an explicit port', remote: 'ssh://git@github.com:22/example-owner/example-site.git/', success: true },
  { name: 'missing origin has a specific error', remote: null, error: /has no readable origin remote/ },
  { name: 'unsupported origin has a specific error', remote: 'git@gitlab.com:example-owner/example-site.git', error: /origin remote is not a supported github.com URL/ },
  { name: 'interactive setup requires a terminal', apply: true, error: /interactive terminal/ },
  { name: 'remote root traversal', change: { root: '/srv/../site' }, error: /absolute path/ },
  { name: 'temp path inside web root', change: { temp: '/srv/site/httpdocs/tmp' }, error: /outside the WordPress/ },
  { name: 'shell syntax in remote root', change: { root: '/srv/site/$(whoami)' }, error: /absolute path/ },
  { name: 'URL shell syntax', change: { url: 'https://example.org/$(whoami)' }, error: /HTTPS URL/ },
  { name: 'invalid SSH port', change: { port: '70000' }, error: /between 1 and 65535/ },
  { name: 'SSH username injection', change: { user: 'account;false' }, error: /Invalid SSH username/ },
  { name: 'existing workflow preserved', existing: true, error: /existing deploy-production.yml differs/ },
  { name: 'another deployment workflow preserved', otherWorkflow: true, error: /Existing workflow custom-deploy.yml/ },
  { name: 'workflow directory symlink', symlink: true, error: /regular project path/ },
  { name: 'dangling workflow directory symlink', symlink: true, dangling: true, error: /regular project path/ },
  { name: 'private key inside repository', keyInRepo: true, error: /outside the website repository/ },
  { name: 'pull target is never inherited', omitRoot: true, error: /Missing --root/ },
]) {
  test(`deployment ${scenario.name}`, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-deployment-')));
    const project = path.join(root, 'website with spaces');
    const theme = path.join(project, 'wp-content', 'themes', 'example-theme');
    const plugin = path.join(project, 'wp-content', 'plugins', 'example-plugin');
    const bin = path.join(root, 'bin');
    const commandLog = path.join(root, 'external-commands');
    try {
      mkdirSync(theme, { recursive: true });
      mkdirSync(bin);
      for (const component of [theme, ...(scenario.plugin ? [plugin] : [])]) {
        mkdirSync(component, { recursive: true });
        writeFileSync(path.join(component, 'package.json'), '{"scripts":{"build":"build-command"}}\n');
        writeFileSync(path.join(component, 'package-lock.json'), '{}\n');
      }
      for (const name of ['style.css', 'functions.php', 'theme.json', 'screenshot.png']) writeFileSync(path.join(theme, name), 'fixture\n');
      if (scenario.nested) mkdirSync(path.join(theme, 'src'));
      if (scenario.multipleThemes) {
        const otherTheme = path.join(project, 'wp-content', 'themes', 'other-theme');
        mkdirSync(otherTheme);
        writeFileSync(path.join(otherTheme, 'style.css'), 'fixture\n');
      }
      if (scenario.plugin) writeFileSync(path.join(plugin, 'custom-loader.php'), '<?php\n');
      const settings = {
        theme: 'example-theme', plugin: scenario.plugin ? 'example-plugin' : 'none',
        root: '/srv/site/httpdocs', temp: '/srv/deployment-temp/', url: 'https://example.org',
        host: 'server.example.org', user: 'site-account', port: '22',
        'key-file': path.join(scenario.keyInRepo ? project : root, 'deployment-key'),
        'hosting-url': 'https://hosting.example.org/',
        ...(scenario.plugin ? { 'plugin-main': 'custom-loader.php', 'plugin-health': 'build/index.js' } : {}),
        ...scenario.change,
      };
      if (scenario.omitRoot) delete settings.root;
      if (scenario.omitTheme) delete settings.theme;
      writeFileSync(path.join(project, '.with-scripts.json'), JSON.stringify({
        wordpressPull: { remoteRoot: '/different/site', sshTarget: 'different-host' },
        ...(scenario.saved ? { wordpressDeployment: settings } : {}),
      }));
      for (const command of ['ssh', 'ssh-keygen', 'ssh-keyscan', 'gh', 'ddev', 'bash']) {
        writeFileSync(path.join(bin, command), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.TEST_COMMAND_LOG, ${JSON.stringify(command)} + '\\n'); process.exit(1);\n`, { mode: 0o755 });
      }
      execFileSync('git', ['init', '-q', project]);
      if (scenario.remote !== null) execFileSync('git', ['-C', project, 'remote', 'add', 'origin', scenario.remote || 'git@github.com:example-owner/example-site.git']);
      execFileSync('git', ['-C', project, 'add', 'wp-content']);
      if (scenario.existing) {
        mkdirSync(path.join(project, '.github', 'workflows'), { recursive: true });
        writeFileSync(path.join(project, '.github', 'workflows', 'deploy-production.yml'), 'Customer workflow.\n');
      }
      if (scenario.otherWorkflow) {
        mkdirSync(path.join(project, '.github', 'workflows'), { recursive: true });
        writeFileSync(path.join(project, '.github', 'workflows', 'custom-deploy.yml'), 'host: ${{ secrets.HOST }}\n');
      }
      if (scenario.symlink) {
        if (!scenario.dangling) mkdirSync(path.join(root, 'outside'));
        symlinkSync(path.join(root, 'outside'), path.join(project, '.github'));
      }
      const beforeConfig = readFileSync(path.join(project, '.with-scripts.json'), 'utf8');
      const args = [cli, 'setup-deployment', ...(scenario.apply ? [] : ['--dry-run']), ...(scenario.saved ? [] : Object.entries(settings).map(([key, value]) => `--${key}=${value}`))];
      const result = spawnSync(process.execPath, args, {
        cwd: scenario.nested ? path.join(theme, 'src') : project, input: '', encoding: 'utf8', timeout: 3000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: commandLog },
      });
      assert.equal(result.status, scenario.success ? 0 : 1, result.stderr + result.stdout);
      assert.equal(existsSync(commandLog), false, 'Local preview and invalid input must not contact external services.');
      assert.equal(readFileSync(path.join(project, '.with-scripts.json'), 'utf8'), beforeConfig);
      if (scenario.success) {
        assert.match(result.stdout, /GitHub repository: example-owner\/example-site\b/);
        assert.match(result.stdout, /THEME_SLUG: "example-theme"/);
        assert.match(result.stdout, /ref: \$\{\{ github.event.release.tag_name \}\}/);
        assert.match(result.stdout, /types: \[published\]/);
        assert.match(result.stdout, /WORDPRESS_ROOT: "\/srv\/site\/httpdocs"/);
        assert.match(result.stdout, /DEPLOY_TMP_PATH: "\/srv\/deployment-temp\/"/);
        assert.doesNotMatch(result.stdout, /\{\{(?:WORDPRESS_ROOT|THEME_SLUG|PLUGIN_SLUG)\}\}/);
        if (scenario.plugin) assert.match(result.stdout, /PLUGIN_MAIN_FILE: "custom-loader.php"/);
        else assert.doesNotMatch(result.stdout, /PLUGIN_SLUG:/);
        assert.match(result.stdout, /Preview complete/);
        const source = result.stdout.split('\n').find((line) => line.startsWith('          source: wp-content/themes/'));
        assert.ok(source.includes('/build,'));
        assert.ok(source.includes('/style.css,'));
        assert.equal(source.includes('/inc,'), false);
        assert.equal(source.includes('/LICENSE,'), false);
      } else assert.match(result.stderr, scenario.error);
      if (scenario.existing) assert.equal(readFileSync(path.join(project, '.github', 'workflows', 'deploy-production.yml'), 'utf8'), 'Customer workflow.\n');
      else if (!scenario.symlink && !scenario.otherWorkflow) assert.equal(existsSync(path.join(project, '.github')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('deployment wizard passes Bash syntax validation', () => {
  const result = spawnSync('bash', ['-n'], { input: wizard, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const failure of ['', 'HOST', 'KEY', 'list']) {
  test(`isolated secret stage: ${failure || 'multiline key success'}`, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-secrets-')));
    try {
      const fakeKey = '-----BEGIN SYNTHETIC KEY-----\nfirst-line\nsecond-line\n-----END SYNTHETIC KEY-----\n';
      writeFileSync(path.join(root, 'private-key'), fakeKey);
      writeFileSync(path.join(root, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'auth') process.exit(0);
if (args[1] === 'set') {
  if (args[2] === process.env.TEST_FAILURE) process.exit(1);
  fs.writeFileSync(process.env.TEST_ROOT + '/' + args[2], fs.readFileSync(0));
} else if (args[1] === 'list') {
  console.log(process.env.TEST_FAILURE === 'list' ? 'HOST' : 'HOST\\nUSERNAME\\nKEY\\nPORT\\nFINGERPRINT');
}
`, { mode: 0o755 });
      // Exercise only secret writes with a fake gh executable: no UI or SSH steps.
      const stage = wizard.slice(wizard.indexOf('secret_names=(HOST'));
      const result = spawnSync('bash', ['-c', `${library}\n${stage}`], {
        cwd: root, encoding: 'utf8', timeout: 3000,
        env: {
          ...process.env, PATH: `${root}:${process.env.PATH}`, GH_REPO: 'example-owner/example-site',
          WITH_DEPLOY_HOST: 'example.org', WITH_DEPLOY_USER: 'example', WITH_DEPLOY_PORT: '22',
          DEPLOY_FINGERPRINT: 'SHA256:synthetic', WITH_DEPLOY_KEY: path.join(root, 'private-key'),
          wizard_temp: root, TEST_ROOT: root, TEST_FAILURE: failure,
        },
      });
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /BEGIN SYNTHETIC|first-line|Setup complete/);
      assert.equal(existsSync(path.join(root, '.env')), false);
      if (!failure) assert.equal(readFileSync(path.join(root, 'KEY'), 'utf8'), fakeKey);
      else assert.match(result.stdout, /incomplete/i);
      if (failure === 'HOST') assert.equal(existsSync(path.join(root, 'KEY')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('isolated remote preflight rejects a temp symlink into the web root', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-deploy-preflight-')));
  try {
    const site = path.join(root, 'site');
    mkdirSync(path.join(site, 'wp-content', 'themes'), { recursive: true });
    mkdirSync(path.join(site, 'tmp'));
    mkdirSync(path.join(root, 'temp'));
    writeFileSync(path.join(site, 'wp-config.php'), '<?php\n');
    writeFileSync(path.join(site, 'wp-load.php'), '<?php\n');
    symlinkSync(path.join(site, 'tmp'), path.join(root, 'linked-temp'));
    const script = wizard.split("<<'REMOTE'\n")[1].split('\nREMOTE')[0];
    for (const directory of ['temp', 'linked-temp']) {
      const result = spawnSync('sh', ['-s', '--', site, path.join(root, directory), 'example-theme', 'none'], { input: script, encoding: 'utf8' });
      assert.equal(result.status, directory === 'temp' ? 0 : 1, result.stderr);
      if (directory === 'linked-temp') assert.match(result.stderr, /resolves inside the web root/);
      assert.deepEqual(readdirSync(path.join(site, 'tmp')), []);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
