import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const packageRoot = path.resolve(import.meta.dirname, '..');

for (const scenario of [
  { name: 'new theme without an installed database', command: 'setup-theme', preflight: 'missing' },
  { name: 'theme replacement from its theme directory', command: 'setup-theme', preflight: 'missing', existing: true, themeCwd: true },
  { name: 'stopped DDEV project', command: 'setup-theme', preflight: 'stopped', detail: 'DDEV project is stopped' },
  { name: 'unreachable WordPress database', command: 'setup-theme', preflight: 'database', detail: 'Error establishing a database connection' },
  { name: 'missing local theme source', command: 'setup-theme', source: true, fail: 'source', error: /Not a valid With Base theme source/ },
  { name: 'theme setup requires an explicit source in noninteractive mode', command: 'setup-theme', error: /Local starter theme directory \(--source\)/ },
  { name: 'failed dependency installation', command: 'setup-theme', fail: 'install', source: true, error: /Theme dependencies could not be installed/ },
  { name: 'failed theme build after sync', command: 'setup-theme', fail: 'build', source: true, error: /customer theme build failed/, pluginsMayHaveChanged: true },
  { name: 'failed plugin activation during setup', command: 'setup-theme', fail: 'with-theme-tools', source: true, error: /With Theme Tools could not be activated/, pluginsMayHaveChanged: true },
  { name: 'successful theme setup', command: 'setup-theme', source: true, success: true },
  { name: 'theme setup uses explicitly selected local tool sources', command: 'setup-theme', source: true, explicitSources: true, success: true },
  { name: 'theme preview without WordPress', command: 'setup-theme', source: true, dryRun: true, preflight: 'missing', success: true },
  { name: 'sync from project with an explicit slug', command: 'sync-tools', preflight: 'missing', existing: true, slug: true },
  { name: 'sync from theme directory', command: 'sync-tools', preflight: 'missing', existing: true, themeCwd: true },
  { name: 'sync with active theme detection', command: 'sync-tools', preflight: 'missing', existing: true },
  { name: 'sync preview without WordPress', command: 'sync-tools', preflight: 'missing', existing: true, themeCwd: true, dryRun: true },
  { name: 'failed Site Tools activation during sync', command: 'sync-tools', fail: 'with-site-tools', existing: true, themeCwd: true, error: /With Site Tools could not be activated/ },
  { name: 'successful tools sync', command: 'sync-tools', existing: true, themeCwd: true, success: true },
  { name: 'tools sync uses explicitly selected local sources', command: 'sync-tools', existing: true, themeCwd: true, explicitSources: true, success: true },
]) {
  test(scenario.name, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-preflight-'));
    const fixturePackage = path.join(root, 'packages', 'with-scripts');
    const project = path.join(root, 'projects', 'example-project');
    const theme = path.join(project, 'wp-content', 'themes', 'example-theme');
    const source = path.join(root, 'with-base');
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'commands.jsonl');
    const patternsSource = path.join(root, scenario.explicitSources ? 'custom-packages' : 'packages', 'with-patterns');
    const themeToolsSource = path.join(root, scenario.explicitSources ? 'custom-plugins' : 'plugins', 'with-theme-tools');
    const siteToolsSource = path.join(root, scenario.explicitSources ? 'custom-plugins' : 'plugins', 'with-site-tools');
    try {
      // Isolate package-relative tool sources as well as all external commands.
      cpSync(path.join(packageRoot, 'src'), path.join(fixturePackage, 'src'), { recursive: true });
      cpSync(path.join(packageRoot, 'bin'), path.join(fixturePackage, 'bin'), { recursive: true });
      symlinkSync(path.join(packageRoot, 'node_modules'), path.join(fixturePackage, 'node_modules'), 'dir');
      for (const directory of [
        bin, source,
        path.join(project, '.ddev'),
        path.join(project, 'wp-content', 'themes'),
        path.join(project, 'wp-content', 'plugins'),
        patternsSource,
        themeToolsSource,
        siteToolsSource,
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(path.join(project, '.ddev', 'config.yaml'), 'name: example-project\nproject_tld: local\n');
      writeFileSync(path.join(project, 'wp-content', 'plugins', 'preserved.txt'), 'Existing plugin data.\n');
      writeFileSync(path.join(source, 'style.css'), 'Theme Name: With Base\nText Domain: with-base\n');
      writeFileSync(path.join(source, 'theme.json'), '{}\n');
      writeFileSync(path.join(source, 'package.json'), '{"name":"with-base","scripts":{}}\n');
      if (scenario.existing) {
        mkdirSync(path.join(theme, '.git'), { recursive: true });
        writeFileSync(path.join(theme, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        writeFileSync(path.join(theme, 'package.json'), '{"name":"example-theme"}\n');
        writeFileSync(path.join(theme, 'style.css'), 'Existing theme data.\n');
      }
      const before = readdirSync(project, { recursive: true }).sort().map((name) => [
        name,
        statSync(path.join(project, name)).isFile() ? readFileSync(path.join(project, name), 'hex') : null,
      ]);

      const mock = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify({ command, args }) + '\\n');
const preflight = process.env.TEST_PREFLIGHT;
if (command === 'ddev' && (args.includes('is-installed') || args.includes('stylesheet')) && preflight) {
  if (preflight === 'stopped') console.error('DDEV project is stopped');
  if (preflight === 'database') console.error('Error establishing a database connection');
  process.exit(1);
}
if (command === 'ddev' && args.includes('stylesheet')) console.log('example-theme');
if (command === 'git' && args.includes('rev-parse')) console.log('1234567');
const failure = process.env.TEST_FAILURE;
if ((command === 'npm' && args.includes('install') && failure === 'install')
  || (command === 'npm' && args.includes('build') && args[1].endsWith('example-theme') && failure === 'build')
  || (command === 'ddev' && args.includes('activate') && args.includes(failure))) {
  console.error('Underlying command diagnostic.');
  process.exit(1);
}
`;
      for (const command of ['ddev', 'git', 'npm', 'unzip']) {
        const file = path.join(bin, command);
        writeFileSync(file, mock);
        chmodSync(file, 0o755);
      }

      const args = [path.join(fixturePackage, 'bin', 'with-scripts.mjs'), scenario.command];
      if (scenario.command === 'setup-theme') {
        args.push('--name=Example Theme', '--slug=example-theme', '--yes');
        if (scenario.existing) args.push('--replace-existing');
        if (scenario.source) args.push(`--source=${scenario.fail === 'source' ? path.join(root, 'missing-theme') : source}`);
      } else if (scenario.slug) {
        args.push('--slug=example-theme');
      }
      if (scenario.dryRun) args.push('--dry-run');
      if (scenario.explicitSources) {
        args.push(`--patterns-source=${patternsSource}`, `--theme-tools-source=${themeToolsSource}`, `--site-tools-source=${siteToolsSource}`);
      }
      const result = spawnSync(process.execPath, args, {
        cwd: scenario.themeCwd ? theme : project,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_LOG: log,
          TEST_PREFLIGHT: scenario.preflight || '',
          TEST_FAILURE: scenario.fail || '',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, scenario.success ? 0 : 1, output);
      const commands = existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        : [];

      if (scenario.preflight && !scenario.success) {
        assert.equal(commands.length, 1, output);
        assert.equal(commands[0].command, 'ddev');
        assert.match(output, /ddev start/);
        assert.match(output, /\/wp-admin\/install\.php/);
        assert.match(output, /wp-config\.php/);
        assert.match(output, /No theme or plugin files were changed/);
        if (scenario.command === 'setup-theme') {
          assert.match(output, /https:\/\/example-project\.local\/wp-admin\/install\.php/);
        }
        if (scenario.detail) assert.ok(output.includes(scenario.detail), output);
      }
      for (const command of commands.filter(({ args }) => args.includes('is-installed'))) {
        assert.ok(command.args.includes('--skip-plugins'));
        assert.ok(command.args.includes('--skip-themes'));
      }
      if (scenario.dryRun && scenario.command === 'setup-theme') {
        assert.equal(commands.some(({ command }) => command === 'ddev'), false, output);
        assert.match(output, /Applying this plan requires/);
      }
      if (scenario.error) {
        assert.match(output, scenario.error);
        if (scenario.fail && scenario.fail !== 'source') {
          assert.match(output, /Underlying command diagnostic/);
        }
        assert.doesNotMatch(output, /failed with exit code/);
      }
      if (scenario.command === 'setup-theme') {
        assert.equal(commands.some(({ command, args }) => command === 'git' && args[0] === 'clone'), false, output);
        assert.equal(output.includes('Shared plugin files and activation state may have changed'), Boolean(scenario.pluginsMayHaveChanged), output);
      }
      if (scenario.fail === 'with-site-tools') {
        assert.match(output, /Runtime files were already synchronized and With Theme Tools was activated/);
      }
      if (scenario.success && !scenario.dryRun) {
        assert.match(output, scenario.command === 'setup-theme' ? /Theme setup complete/ : /Shared tools are synchronized and verified/);
        assert.equal(commands[0].command, 'ddev');
        assert.ok(commands[0].args.includes('is-installed'));
        if (scenario.explicitSources) {
          for (const directory of [patternsSource, themeToolsSource, siteToolsSource]) {
            assert.ok(commands.some(({ command, args }) => command === 'npm' && args[0] === '--prefix' && args[1] === directory), directory);
          }
        }
      } else {
        const after = readdirSync(project, { recursive: true }).sort().map((name) => [
          name,
          statSync(path.join(project, name)).isFile() ? readFileSync(path.join(project, name), 'hex') : null,
        ]);
        assert.deepEqual(after, before, 'Project files must be preserved after preflight failure or theme cleanup.');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
