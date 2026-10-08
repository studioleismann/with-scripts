/**
 * Deployment artifact and transaction integration tests.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const prepareScript = join(scriptsRoot, 'prepare-deployment.mjs');
const remoteScript = join(scriptsRoot, 'remote-deployment.sh');
const workflowFile = join(
	scriptsRoot,
	'..',
	'workflows',
	'deploy-production.yml'
);
const manifestName = '.with-deploy-manifest';
const manifestVersion = 'with-deploy-manifest-v1';
const fullTest = process.env.WITH_DEPLOY_FULL_TESTS === '1' ? test : test.skip;

/**
 * Run a command and return the completed process.
 *
 * @param {string} command Command name.
 * @param {string[]} args Command arguments.
 * @param {object} options Process options.
 * @return {import('node:child_process').SpawnSyncReturns<string>} Process result.
 */
function run(command, args, options = {}) {
	return spawnSync(command, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: options.env || process.env,
		input: options.input,
	});
}

/**
 * Assert that a command completed successfully.
 *
 * @param {string} command Command name.
 * @param {string[]} args Command arguments.
 * @param {object} options Process options.
 * @return {import('node:child_process').SpawnSyncReturns<string>} Process result.
 */
function runSuccessfully(command, args, options = {}) {
	const result = run(command, args, options);

	assert.equal(
		result.status,
		0,
		`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`
	);

	return result;
}

/**
 * Create an isolated WordPress filesystem fixture.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @param {boolean} withSpaces Whether the returned path should contain spaces.
 * @return {string} WordPress root.
 */
function createWordPressRoot(t, withSpaces = false) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), 'with-deploy-wordpress-'));
	const root = withSpaces ? join(fixtureRoot, 'WordPress Root') : fixtureRoot;
	t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

	mkdirSync(root, { recursive: true });
	mkdirSync(join(root, 'wp-admin'));
	mkdirSync(join(root, 'wp-includes'));
	mkdirSync(join(root, 'wp-content', 'themes'), { recursive: true });
	mkdirSync(join(root, 'wp-content', 'plugins'), { recursive: true });
	writeFileSync(join(root, 'wp-load.php'), '<?php\n');

	return root;
}

/**
 * Create a site deployment artifact from component fixtures.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @param {Array<object>} components Components.
 * @return {string} Artifact path.
 */
function createArtifact(t, components) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), 'with-deploy-artifact-'));
	t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

	const siteRoot = join(fixtureRoot, 'site');
	const payloadRoot = join(siteRoot, 'payload');
	mkdirSync(payloadRoot, { recursive: true });

	for (const component of components) {
		const componentPath = join(payloadRoot, component.path);

		if (component.type === 'file') {
			mkdirSync(dirname(componentPath), { recursive: true });
			writeFileSync(componentPath, component.content || '<?php\n');
			continue;
		}

		mkdirSync(componentPath, { recursive: true });

		for (const [filePath, content] of Object.entries(
			component.files || {}
		)) {
			const target = join(componentPath, filePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}

	const manifest = [
		manifestVersion,
		...components
			.toSorted((first, second) => first.path.localeCompare(second.path))
			.map((component) => `${component.type}\t${component.path}`),
		'',
	].join('\n');
	writeFileSync(join(siteRoot, manifestName), manifest);

	const artifact = join(fixtureRoot, 'deployment.tar.gz');
	runSuccessfully('tar', [
		'-czf',
		artifact,
		'-C',
		siteRoot,
		manifestName,
		'payload',
	]);

	return artifact;
}

/**
 * Run one remote deployment-script mode locally.
 *
 * @param {string} mode Deployment mode.
 * @param {string} root WordPress root.
 * @param {string} runKey Numeric run key.
 * @return {import('node:child_process').SpawnSyncReturns<string>} Process result.
 */
function runRemote(mode, root, runKey) {
	return run('sh', [remoteScript, mode, root, runKey]);
}

/**
 * Prepare and switch an artifact without committing it.
 *
 * @param {string} root WordPress root.
 * @param {string} runKey Numeric run key.
 * @param {string} artifact Artifact path.
 */
function switchArtifact(root, runKey, artifact) {
	for (const mode of ['preflight', 'create']) {
		const result = runRemote(mode, root, runKey);
		assert.equal(
			result.status,
			0,
			`${mode} failed:\n${result.stdout}${result.stderr}`
		);
	}

	copyFileSync(
		artifact,
		join(root, 'wp-content', `.with-deploy-${runKey}`, 'artifact.tar.gz')
	);

	for (const mode of ['prepare', 'switch']) {
		const result = runRemote(mode, root, runKey);
		assert.equal(
			result.status,
			0,
			`${mode} failed:\n${result.stdout}${result.stderr}`
		);
	}
}

test('workflow is release-driven and contains no configured component slug', () => {
	const workflow = readFileSync(workflowFile, 'utf8');

	assert.match(workflow, /release:\n\s+types: \[published\]/);
	assert.doesNotMatch(workflow, /THEME_SLUG|PLUGIN_SLUG/);
	assert.doesNotMatch(workflow, /\brsync\b|\bsftp\b/i);
});

test('workflow uses pinned appleboy transport for deployment', () => {
	const workflow = readFileSync(workflowFile, 'utf8');

	assert.match(workflow, /uses: appleboy\/scp-action@ff85246acaad7bdce478db94a363cd2bf7c90345/);
	assert.match(workflow, /uses: appleboy\/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2/);
	assert.match(workflow, /fingerprint: \$\{\{ secrets\.FINGERPRINT \}\}/);
	assert.match(
		workflow,
		/target: \$\{\{ env\.WORDPRESS_ROOT \}\}\/wp-content\/\.with-deploy-\$\{\{ env\.DEPLOY_RUN_KEY \}\}\//
	);
});

test('workflow checks IPv4 SSH reachability before upload and reports failures', () => {
	const workflow = readFileSync(workflowFile, 'utf8');
	const step = workflow.indexOf('      - name: Verify SSH connectivity');
	const upload = workflow.indexOf('      - name: Upload remote deployment script');
	assert.ok(step >= 0 && step < upload);
	const match = workflow.slice(step, upload).match(/<<'PY'\n([\s\S]*?)\n          PY/);
	assert.ok(match, 'SSH check must contain executable Python');
	const script = match[1].replace(/^          /gm, '');

	for (const [scenario, status, message] of [
		['success', 0, 'SSH connectivity OK: example.test:22'],
		['fallback', 0, 'SSH connectivity OK: example.test:22'],
		['dns', 1, 'SSH host does not resolve: example.test'],
		['empty', 1, 'SSH host could not be resolved: example.test'],
		['refused', 1, 'SSH connection timed out or was refused: example.test:22'],
	]) {
		const result = run('python3', ['-', 'example.test', '22', scenario], {
			input: `import socket
import sys
from unittest.mock import MagicMock, patch

scenario = sys.argv[3]
addresses = [
    (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.1', 22)),
    (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.2', 22)),
]
resolver = patch('socket.getaddrinfo').start()
resolver.return_value = [] if scenario == 'empty' else addresses
if scenario == 'dns':
    resolver.side_effect = socket.gaierror('fixture DNS failure')
connector = patch('socket.create_connection').start()
connector.side_effect = (
    [ConnectionRefusedError('fixture refusal'), MagicMock()]
    if scenario == 'fallback' else
    ConnectionRefusedError('fixture refusal') if scenario == 'refused' else None
)
try:
${script.replace(/^/gm, '    ')}
finally:
    resolver.assert_called_once_with('example.test', 22, family=socket.AF_INET, type=socket.SOCK_STREAM)
    expected = 0 if scenario in ('dns', 'empty') else 2 if scenario in ('fallback', 'refused') else 1
    assert connector.call_count == expected
    for index, call in enumerate(connector.call_args_list):
        assert call.args == (addresses[index][4],)
        assert call.kwargs == {'timeout': 15}
`,
		});
		assert.equal(result.status, status, `${scenario}: ${result.stdout}${result.stderr}`);
		assert.ok(`${result.stdout}${result.stderr}`.includes(message), scenario);
	}
});

test('cleanup only runs for failures after the transaction workspace exists', () => {
	const workflow = readFileSync(workflowFile, 'utf8');

	assert.match(workflow, /id: create/);
	assert.match(
		workflow,
		/if: \$\{\{ failure\(\) && steps\.create\.outcome == 'success' && steps\.switch\.outcome != 'success' \}\}/
	);
});

test('workflow-style shell arguments preserve a WordPress root with spaces', (t) => {
	const root = createWordPressRoot(t, true);
	const result = run('sh', [
		'-s',
		'--',
		'preflight',
		root,
		'109-1',
	], { input: readFileSync(remoteScript) });

	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('prepare script discovers themes, directory plugins, and single-file plugins', (t) => {
	const repository = mkdtempSync(join(tmpdir(), 'with-deploy-repository-'));
	t.after(() => rmSync(repository, { recursive: true, force: true }));

	const theme = join(repository, 'wp-content', 'themes', 'customer-theme');
	const plugin = join(repository, 'wp-content', 'plugins', 'customer-plugin');
	const sourcePlugin = join(
		repository,
		'wp-content',
		'plugins',
		'source-plugin'
	);
	mkdirSync(theme, { recursive: true });
	mkdirSync(plugin, { recursive: true });
	mkdirSync(sourcePlugin, { recursive: true });
	writeFileSync(join(theme, 'style.css'), 'Theme Name: Test\n');
	writeFileSync(
		join(repository, 'wp-content', 'plugins', 'single-plugin.php'),
		'<?php\n'
	);
	writeFileSync(join(plugin, 'customer-plugin.php'), '<?php\n');
	writeFileSync(
		join(plugin, 'build.mjs'),
		"import { mkdirSync, writeFileSync } from 'node:fs';\n" +
			"mkdirSync( 'build', { recursive: true } );\n" +
			"writeFileSync( 'build/runtime.js', 'built\\n' );\n"
	);
	writeFileSync(
		join(plugin, 'package.json'),
		`${JSON.stringify(
			{
				name: 'customer-plugin',
				version: '1.0.0',
				scripts: { build: 'node build.mjs' },
				files: ['build', 'customer-plugin.php'],
			},
			null,
			2
		)}\n`
	);
	writeFileSync(
		join(plugin, 'package-lock.json'),
		`${JSON.stringify(
			{
				name: 'customer-plugin',
				version: '1.0.0',
				lockfileVersion: 3,
				requires: true,
				packages: { '': { name: 'customer-plugin', version: '1.0.0' } },
			},
			null,
			2
		)}\n`
	);
	writeFileSync(join(sourcePlugin, 'source-plugin.php'), '<?php\n');
	writeFileSync(join(sourcePlugin, 'development.md'), 'Do not deploy.\n');
	writeFileSync(
		join(sourcePlugin, '.gitattributes'),
		'development.md export-ignore\n.gitattributes export-ignore\n'
	);

	for (const args of [
		['init', '--quiet'],
		['config', 'user.name', 'Deployment Test'],
		['config', 'user.email', 'deployment@example.test'],
		['add', '.'],
		['commit', '--quiet', '-m', 'Fixture'],
	]) {
		runSuccessfully('git', args, { cwd: repository });
	}

	const artifact = join(repository, 'deployment.tar.gz');
	const npmCache = join(repository, '.npm-cache');
	const result = run(process.execPath, [prepareScript, artifact], {
		cwd: repository,
		env: { ...process.env, npm_config_cache: npmCache },
	});

	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	assert.match(result.stdout, /wp-content\/themes\/customer-theme/);
	assert.match(result.stdout, /wp-content\/plugins\/customer-plugin/);
	assert.match(result.stdout, /wp-content\/plugins\/source-plugin/);
	assert.match(result.stdout, /wp-content\/plugins\/single-plugin\.php/);

	const extracted = join(repository, 'extracted');
	mkdirSync(extracted);
	runSuccessfully('tar', ['-xzf', artifact, '-C', extracted]);

	const manifest = readFileSync(join(extracted, manifestName), 'utf8');
	assert.match(manifest, /directory\twp-content\/themes\/customer-theme/);
	assert.match(manifest, /directory\twp-content\/plugins\/customer-plugin/);
	assert.match(manifest, /directory\twp-content\/plugins\/source-plugin/);
	assert.match(manifest, /file\twp-content\/plugins\/single-plugin\.php/);
	assert.equal(
		readFileSync(
			join(
				extracted,
				'payload',
				'wp-content',
				'plugins',
				'customer-plugin',
				'customer-plugin.php'
			),
			'utf8'
		),
		'<?php\n'
	);
	assert.equal(
		existsSync(
			join(
				extracted,
				'payload',
				'wp-content',
				'plugins',
				'customer-plugin',
				'build.mjs'
			)
		),
		false
	);
	assert.equal(
		readFileSync(
			join(
				extracted,
				'payload',
				'wp-content',
				'plugins',
				'customer-plugin',
				'build',
				'runtime.js'
			),
			'utf8'
		),
		'built\n'
	);
	assert.equal(
		existsSync(
			join(
				extracted,
				'payload',
				'wp-content',
				'plugins',
				'source-plugin',
				'development.md'
			)
		),
		false
	);
});

fullTest('prepare script rejects tracked WordPress paths outside supported component roots', (t) => {
	const repository = mkdtempSync(join(tmpdir(), 'with-deploy-unsupported-'));
	t.after(() => rmSync(repository, { recursive: true, force: true }));

	mkdirSync(join(repository, 'wp-content', 'uploads'), { recursive: true });
	writeFileSync(
		join(repository, 'wp-content', 'uploads', 'tracked.txt'),
		'unsafe\n'
	);
	runSuccessfully('git', ['init', '--quiet'], { cwd: repository });
	runSuccessfully('git', ['add', '.'], { cwd: repository });

	const result = run(
		process.execPath,
		[prepareScript, join(repository, 'deployment.tar.gz')],
		{
			cwd: repository,
		}
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unsupported tracked WordPress path/);
});

fullTest('prepare script rejects npm components without an explicit files contract', (t) => {
	const repository = mkdtempSync(
		join(tmpdir(), 'with-deploy-missing-files-')
	);
	t.after(() => rmSync(repository, { recursive: true, force: true }));

	const plugin = join(repository, 'wp-content', 'plugins', 'customer-plugin');
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(plugin, 'customer-plugin.php'), '<?php\n');
	writeFileSync(
		join(plugin, 'package.json'),
		`${JSON.stringify({ name: 'customer-plugin', version: '1.0.0' }, null, 2)}\n`
	);
	runSuccessfully('git', ['init', '--quiet'], { cwd: repository });
	runSuccessfully('git', ['add', '.'], { cwd: repository });

	const result = run(
		process.execPath,
		[prepareScript, join(repository, 'deployment.tar.gz')],
		{
			cwd: repository,
		}
	);

	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/Missing package\.json#files deployment contract/
	);
});

fullTest('prepare script rejects unsafe first-level component names', (t) => {
	const repository = mkdtempSync(join(tmpdir(), 'with-deploy-unsafe-name-'));
	t.after(() => rmSync(repository, { recursive: true, force: true }));

	const plugin = join(repository, 'wp-content', 'plugins', 'unsafe plugin');
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(plugin, 'plugin.php'), '<?php\n');
	runSuccessfully('git', ['init', '--quiet'], { cwd: repository });
	runSuccessfully('git', ['add', '.'], { cwd: repository });

	const result = run(
		process.execPath,
		[prepareScript, join(repository, 'deployment.tar.gz')],
		{
			cwd: repository,
		}
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unsafe component name/);
});

fullTest('prepare script rejects single-file components in themes', (t) => {
	const repository = mkdtempSync(join(tmpdir(), 'with-deploy-theme-file-'));
	t.after(() => rmSync(repository, { recursive: true, force: true }));

	mkdirSync(join(repository, 'wp-content', 'themes'), { recursive: true });
	writeFileSync(
		join(repository, 'wp-content', 'themes', 'single-theme-file.php'),
		'<?php\n'
	);
	runSuccessfully('git', ['init', '--quiet'], { cwd: repository });
	runSuccessfully('git', ['add', '.'], { cwd: repository });

	const result = run(
		process.execPath,
		[prepareScript, join(repository, 'deployment.tar.gz')],
		{
			cwd: repository,
		}
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Single-file components are not supported in themes/);
});

test('bootstrap replacement removes stale component files and preserves live-only plugins', (t) => {
	const root = createWordPressRoot(t, true);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	const managedPlugin = join(
		root,
		'wp-content',
		'plugins',
		'customer-plugin'
	);
	const liveOnlyPlugin = join(root, 'wp-content', 'plugins', 'third-party');
	mkdirSync(theme);
	mkdirSync(managedPlugin);
	mkdirSync(liveOnlyPlugin);
	mkdirSync(join(root, 'wp-content', 'uploads'));
	writeFileSync(join(theme, 'style.css'), 'old\n');
	writeFileSync(join(theme, 'stale.css'), 'stale\n');
	writeFileSync(join(managedPlugin, 'plugin.php'), 'old\n');
	writeFileSync(join(managedPlugin, 'stale.php'), 'stale\n');
	writeFileSync(join(liveOnlyPlugin, 'plugin.php'), 'untouched\n');
	writeFileSync(
		join(root, 'wp-content', 'uploads', 'image.txt'),
		'untouched upload\n'
	);
	writeFileSync(join(root, 'wp-config.php'), 'untouched config\n');
	writeFileSync(join(root, 'database-sentinel.sql'), 'untouched database\n');

	const artifact = createArtifact(t, [
		{
			type: 'directory',
			path: 'wp-content/plugins/customer-plugin',
			files: { 'plugin.php': 'new\n' },
		},
		{
			type: 'directory',
			path: 'wp-content/themes/customer-theme',
			files: { 'style.css': 'new\n' },
		},
	]);
	const runKey = '100-1';
	switchArtifact(root, runKey, artifact);

	assert.equal(readFileSync(join(theme, 'style.css'), 'utf8'), 'new\n');
	assert.equal(existsSync(join(theme, 'stale.css')), false);
	assert.equal(
		readFileSync(join(managedPlugin, 'plugin.php'), 'utf8'),
		'new\n'
	);
	assert.equal(existsSync(join(managedPlugin, 'stale.php')), false);
	assert.equal(
		readFileSync(join(liveOnlyPlugin, 'plugin.php'), 'utf8'),
		'untouched\n'
	);
	assert.equal(
		readFileSync(join(root, 'wp-content', 'uploads', 'image.txt'), 'utf8'),
		'untouched upload\n'
	);
	assert.equal(
		readFileSync(join(root, 'wp-config.php'), 'utf8'),
		'untouched config\n'
	);
	assert.equal(
		readFileSync(join(root, 'database-sentinel.sql'), 'utf8'),
		'untouched database\n'
	);

	const cleanup = runRemote('cleanup', root, runKey);
	assert.notEqual(cleanup.status, 0);
	assert.match(cleanup.stderr, /Refusing pre-switch cleanup/);
	assert.equal(readFileSync(join(theme, 'style.css'), 'utf8'), 'new\n');

	const commit = runRemote('commit', root, runKey);
	assert.equal(commit.status, 0, `${commit.stdout}${commit.stderr}`);
	assert.equal(
		existsSync(join(root, 'wp-content', `.with-deploy-${runKey}`)),
		false
	);
});

test('later deployment removes a formerly managed plugin but preserves unrelated plugins', (t) => {
	const root = createWordPressRoot(t);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	const managedPlugin = join(root, 'wp-content', 'plugins', 'managed-plugin');
	const liveOnlyPlugin = join(root, 'wp-content', 'plugins', 'third-party');
	mkdirSync(theme);
	mkdirSync(managedPlugin);
	mkdirSync(liveOnlyPlugin);
	writeFileSync(join(theme, 'style.css'), 'old\n');
	writeFileSync(join(managedPlugin, 'plugin.php'), 'managed\n');
	writeFileSync(join(liveOnlyPlugin, 'plugin.php'), 'untouched\n');
	writeFileSync(
		join(root, 'wp-content', manifestName),
		`${manifestVersion}\ndirectory\twp-content/plugins/managed-plugin\ndirectory\twp-content/themes/customer-theme\n`
	);

	const artifact = createArtifact(t, [
		{
			type: 'directory',
			path: 'wp-content/themes/customer-theme',
			files: { 'style.css': 'new\n' },
		},
	]);
	const runKey = '101-1';
	switchArtifact(root, runKey, artifact);
	assert.equal(existsSync(managedPlugin), false);
	assert.equal(
		readFileSync(join(liveOnlyPlugin, 'plugin.php'), 'utf8'),
		'untouched\n'
	);

	const commit = runRemote('commit', root, runKey);
	assert.equal(commit.status, 0, `${commit.stdout}${commit.stderr}`);
});

test('failed smoke-test rollback restores all previous components and the previous manifest', (t) => {
	const root = createWordPressRoot(t);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	mkdirSync(theme);
	writeFileSync(join(theme, 'style.css'), 'old\n');
	const previousManifest = `${manifestVersion}\ndirectory\twp-content/themes/customer-theme\n`;
	writeFileSync(join(root, 'wp-content', manifestName), previousManifest);

	const artifact = createArtifact(t, [
		{
			type: 'directory',
			path: 'wp-content/plugins/new-plugin',
			files: { 'plugin.php': 'new plugin\n' },
		},
		{
			type: 'directory',
			path: 'wp-content/themes/customer-theme',
			files: { 'style.css': 'new\n' },
		},
	]);
	const runKey = '102-1';
	switchArtifact(root, runKey, artifact);

	const rollback = runRemote('rollback', root, runKey);
	assert.equal(rollback.status, 0, `${rollback.stdout}${rollback.stderr}`);
	assert.equal(readFileSync(join(theme, 'style.css'), 'utf8'), 'old\n');
	assert.equal(
		existsSync(join(root, 'wp-content', 'plugins', 'new-plugin')),
		false
	);
	assert.equal(
		readFileSync(join(root, 'wp-content', manifestName), 'utf8'),
		previousManifest
	);
});

test('switch failure in a later component restores components already moved', (t) => {
	const root = createWordPressRoot(t);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	const plugin = join(root, 'wp-content', 'plugins', 'managed-plugin');
	mkdirSync(theme);
	mkdirSync(plugin);
	writeFileSync(join(theme, 'style.css'), 'old theme\n');
	writeFileSync(join(plugin, 'plugin.php'), 'old plugin\n');
	const previousManifest =
		`${manifestVersion}\n` +
		'directory\twp-content/plugins/managed-plugin\n' +
		'directory\twp-content/themes/customer-theme\n';
	writeFileSync(join(root, 'wp-content', manifestName), previousManifest);

	const artifact = createArtifact(t, [
		{
			type: 'directory',
			path: 'wp-content/plugins/managed-plugin',
			files: { 'plugin.php': 'new plugin\n' },
		},
		{
			type: 'directory',
			path: 'wp-content/themes/customer-theme',
			files: { 'style.css': 'new theme\n' },
		},
	]);
	const runKey = '103-1';

	for (const mode of ['preflight', 'create']) {
		const result = runRemote(mode, root, runKey);
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	}

	const workspace = join(root, 'wp-content', `.with-deploy-${runKey}`);
	copyFileSync(artifact, join(workspace, 'artifact.tar.gz'));
	const prepare = runRemote('prepare', root, runKey);
	assert.equal(prepare.status, 0, `${prepare.stdout}${prepare.stderr}`);
	rmSync(
		join(
			workspace,
			'candidate',
			'payload',
			'wp-content',
			'themes',
			'customer-theme'
		),
		{
			recursive: true,
		}
	);

	const componentSwitch = runRemote('switch', root, runKey);
	assert.notEqual(componentSwitch.status, 0);
	assert.match(componentSwitch.stderr, /failed switch was rolled back/i);
	assert.equal(readFileSync(join(theme, 'style.css'), 'utf8'), 'old theme\n');
	assert.equal(
		readFileSync(join(plugin, 'plugin.php'), 'utf8'),
		'old plugin\n'
	);
	assert.equal(
		readFileSync(join(root, 'wp-content', manifestName), 'utf8'),
		previousManifest
	);
	assert.equal(existsSync(workspace), false);
});

fullTest('remote preparation rejects a traversal component before production changes', (t) => {
	const root = createWordPressRoot(t);
	const fixtureRoot = mkdtempSync(join(tmpdir(), 'with-deploy-traversal-'));
	t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
	const siteRoot = join(fixtureRoot, 'site');
	mkdirSync(join(siteRoot, 'payload'), { recursive: true });
	writeFileSync(
		join(siteRoot, manifestName),
		`${manifestVersion}\ndirectory\twp-content/plugins/../unsafe\n`
	);
	const artifact = join(fixtureRoot, 'deployment.tar.gz');
	runSuccessfully('tar', [
		'-czf',
		artifact,
		'-C',
		siteRoot,
		manifestName,
		'payload',
	]);
	const runKey = '104-1';
	const otherWorkspace = join(root, 'wp-content', '.with-deploy-999-1');
	mkdirSync(otherWorkspace);
	writeFileSync(join(otherWorkspace, 'evidence'), 'keep\n');

	assert.equal(runRemote('preflight', root, runKey).status, 0);
	assert.equal(runRemote('create', root, runKey).status, 0);
	const workspace = join(root, 'wp-content', `.with-deploy-${runKey}`);
	copyFileSync(artifact, join(workspace, 'artifact.tar.gz'));

	const prepare = runRemote('prepare', root, runKey);
	assert.notEqual(prepare.status, 0);
	assert.match(
		prepare.stderr,
		/Unsafe component name|not a first-level WordPress entry/
	);
	assert.equal(existsSync(join(root, 'wp-content', 'unsafe')), false);

	const cleanup = runRemote('cleanup', root, runKey);
	assert.equal(cleanup.status, 0, `${cleanup.stdout}${cleanup.stderr}`);
	assert.equal(
		readFileSync(join(otherWorkspace, 'evidence'), 'utf8'),
		'keep\n'
	);
});

fullTest('remote preparation rejects non-PHP single-file plugin components', (t) => {
	const root = createWordPressRoot(t);
	const fixtureRoot = mkdtempSync(join(tmpdir(), 'with-deploy-non-php-file-'));
	t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
	const siteRoot = join(fixtureRoot, 'site');
	mkdirSync(join(siteRoot, 'payload', 'wp-content', 'plugins'), {
		recursive: true,
	});
	writeFileSync(
		join(siteRoot, 'payload', 'wp-content', 'plugins', 'notes.txt'),
		'not php\n'
	);
	writeFileSync(
		join(siteRoot, manifestName),
		`${manifestVersion}\nfile\twp-content/plugins/notes.txt\n`
	);
	const artifact = join(fixtureRoot, 'deployment.tar.gz');
	runSuccessfully('tar', [
		'-czf',
		artifact,
		'-C',
		siteRoot,
		manifestName,
		'payload',
	]);
	const runKey = '104-2';

	assert.equal(runRemote('preflight', root, runKey).status, 0);
	assert.equal(runRemote('create', root, runKey).status, 0);
	const workspace = join(root, 'wp-content', `.with-deploy-${runKey}`);
	copyFileSync(artifact, join(workspace, 'artifact.tar.gz'));

	const prepare = runRemote('prepare', root, runKey);
	assert.notEqual(prepare.status, 0);
	assert.match(
		prepare.stderr,
		/Single-file plugin components must be PHP files/
	);

	const cleanup = runRemote('cleanup', root, runKey);
	assert.equal(cleanup.status, 0, `${cleanup.stdout}${cleanup.stderr}`);
});

fullTest('preflight preserves an existing maintenance file and rejects a missing managed target', (t) => {
	const root = createWordPressRoot(t);
	const maintenance = join(root, '.maintenance');
	writeFileSync(maintenance, '<?php $upgrading = time(); /* external */\n');

	const maintenanceResult = runRemote('preflight', root, '105-1');
	assert.notEqual(maintenanceResult.status, 0);
	assert.match(
		maintenanceResult.stderr,
		/already in filesystem maintenance mode/
	);
	assert.equal(
		readFileSync(maintenance, 'utf8'),
		'<?php $upgrading = time(); /* external */\n'
	);
	rmSync(maintenance);

	writeFileSync(
		join(root, 'wp-content', manifestName),
		`${manifestVersion}\ndirectory\twp-content/plugins/missing-plugin\n`
	);
	const missingTargetResult = runRemote('preflight', root, '105-2');
	assert.notEqual(missingTargetResult.status, 0);
	assert.match(missingTargetResult.stderr, /Component directory is missing/);
	assert.equal(
		existsSync(join(root, 'wp-content', '.with-deploy-105-2')),
		false
	);
});

fullTest('remote preparation rejects a corrupt archive without changing production', (t) => {
	const root = createWordPressRoot(t);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	mkdirSync(theme);
	writeFileSync(join(theme, 'style.css'), 'old\n');
	const runKey = '106-1';

	assert.equal(runRemote('preflight', root, runKey).status, 0);
	assert.equal(runRemote('create', root, runKey).status, 0);
	const workspace = join(root, 'wp-content', `.with-deploy-${runKey}`);
	writeFileSync(join(workspace, 'artifact.tar.gz'), 'not an archive\n');

	const prepare = runRemote('prepare', root, runKey);
	assert.notEqual(prepare.status, 0);
	assert.equal(readFileSync(join(theme, 'style.css'), 'utf8'), 'old\n');
	assert.equal(existsSync(join(root, '.maintenance')), false);

	const cleanup = runRemote('cleanup', root, runKey);
	assert.equal(cleanup.status, 0, `${cleanup.stdout}${cleanup.stderr}`);
});

fullTest('remote preparation rejects symbolic links without changing production', (t) => {
	const root = createWordPressRoot(t);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	mkdirSync(theme);
	writeFileSync(join(theme, 'style.css'), 'old\n');

	const fixtureRoot = mkdtempSync(join(tmpdir(), 'with-deploy-symlink-'));
	t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
	const siteRoot = join(fixtureRoot, 'site');
	const plugin = join(
		siteRoot,
		'payload',
		'wp-content',
		'plugins',
		'linked-plugin'
	);
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(plugin, 'target.php'), '<?php\n');
	symlinkSync('target.php', join(plugin, 'link.php'));
	writeFileSync(
		join(siteRoot, manifestName),
		`${manifestVersion}\ndirectory\twp-content/plugins/linked-plugin\n`
	);
	const artifact = join(fixtureRoot, 'deployment.tar.gz');
	runSuccessfully('tar', [
		'-czf',
		artifact,
		'-C',
		siteRoot,
		manifestName,
		'payload',
	]);
	const runKey = '107-1';

	assert.equal(runRemote('preflight', root, runKey).status, 0);
	assert.equal(runRemote('create', root, runKey).status, 0);
	const workspace = join(root, 'wp-content', `.with-deploy-${runKey}`);
	copyFileSync(artifact, join(workspace, 'artifact.tar.gz'));

	const prepare = runRemote('prepare', root, runKey);
	assert.notEqual(prepare.status, 0);
	assert.match(prepare.stderr, /cannot contain symbolic links/);
	assert.equal(readFileSync(join(theme, 'style.css'), 'utf8'), 'old\n');
	assert.equal(
		existsSync(join(root, 'wp-content', 'plugins', 'linked-plugin')),
		false
	);

	const cleanup = runRemote('cleanup', root, runKey);
	assert.equal(cleanup.status, 0, `${cleanup.stdout}${cleanup.stderr}`);
});

fullTest('an incomplete rollback retains maintenance mode and transaction evidence', (t) => {
	const root = createWordPressRoot(t);
	const theme = join(root, 'wp-content', 'themes', 'customer-theme');
	mkdirSync(theme);
	writeFileSync(join(theme, 'style.css'), 'old\n');
	writeFileSync(
		join(root, 'wp-content', manifestName),
		`${manifestVersion}\ndirectory\twp-content/themes/customer-theme\n`
	);

	const artifact = createArtifact(t, [
		{
			type: 'directory',
			path: 'wp-content/themes/customer-theme',
			files: { 'style.css': 'new\n' },
		},
	]);
	const runKey = '108-1';
	switchArtifact(root, runKey, artifact);
	const workspace = join(root, 'wp-content', `.with-deploy-${runKey}`);
	rmSync(
		join(workspace, 'rollback', 'wp-content', 'themes', 'customer-theme'),
		{ recursive: true }
	);

	const rollback = runRemote('rollback', root, runKey);
	assert.notEqual(rollback.status, 0);
	assert.match(
		rollback.stderr,
		/Automatic rollback failed|Component directory is missing/
	);
	assert.match(
		readFileSync(join(root, '.maintenance'), 'utf8'),
		/with-deploy-108-1/
	);
	assert.equal(existsSync(workspace), true);
});
