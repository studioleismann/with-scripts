#!/usr/bin/env node

/**
 * Build the repository-managed WordPress components into one deployment artifact.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const MANIFEST_NAME = '.with-deploy-manifest';
const MANIFEST_VERSION = 'with-deploy-manifest-v1';
const SUPPORTED_ROOTS = new Set(['themes', 'plugins', 'mu-plugins']);
const COMPONENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const projectRoot = process.cwd();
const artifactArgument = process.argv[2];

if (!artifactArgument || process.argv.length !== 3) {
	throw new Error(
		'Usage: node .github/scripts/prepare-deployment.mjs /absolute/path/deployment.tar.gz'
	);
}

const artifactPath = resolve(artifactArgument);

if (!isAbsolute(artifactArgument) || !artifactPath.endsWith('.tar.gz')) {
	throw new Error(
		'The deployment artifact must be an absolute .tar.gz path.'
	);
}

if (existsSync(artifactPath)) {
	throw new Error(
		`Refusing to overwrite an existing artifact: ${artifactPath}`
	);
}

if (!existsSync(join(projectRoot, '.git'))) {
	throw new Error(
		`The current directory is not a Git repository: ${projectRoot}`
	);
}

/**
 * Run a command and return its standard output.
 *
 * @param {string} command Command name.
 * @param {string[]} args Command arguments.
 * @param {string} cwd Working directory.
 * @return {Buffer} Standard output.
 */
function run(command, args, cwd = projectRoot) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: null,
		stdio: ['ignore', 'pipe', 'pipe'],
		// Large SVG collections exceed Node's default 1 MiB output buffer.
		maxBuffer: 64 * 1024 * 1024,
	});

	if (result.error) {
		throw new Error(
			`Command failed to start: ${command} ${args.join(' ')}\n${result.error.message}`
		);
	}

	if (result.status !== 0) {
		const output = Buffer.concat([
			result.stdout || Buffer.alloc(0),
			result.stderr || Buffer.alloc(0),
		])
			.toString('utf8')
			.trim();

		throw new Error(
			`Command failed: ${command} ${args.join(' ')}${output ? `\n${output}` : ''}`
		);
	}

	return result.stdout || Buffer.alloc(0);
}

/**
 * Return the safe component root for a tracked WordPress path.
 *
 * @param {string} trackedPath Repository-relative tracked path.
 * @return {string} Repository-relative component path.
 */
function getComponentPath(trackedPath) {
	if (
		trackedPath.startsWith('/') ||
		trackedPath.includes('\\') ||
		/[\n\r\t]/.test(trackedPath) ||
		trackedPath.split('/').includes('..')
	) {
		throw new Error(`Unsafe tracked path: ${trackedPath}`);
	}

	const parts = trackedPath.split('/');

	if (
		parts.length < 3 ||
		parts[0] !== 'wp-content' ||
		!SUPPORTED_ROOTS.has(parts[1])
	) {
		throw new Error(
			`Unsupported tracked WordPress path: ${trackedPath}. ` +
				'Only first-level components below themes, plugins, and mu-plugins are deployable.'
		);
	}

	const componentName = parts[2];

	if (!COMPONENT_NAME_PATTERN.test(componentName)) {
		throw new Error(
			`Unsafe component name in tracked path: ${trackedPath}`
		);
	}

	return `wp-content/${parts[1]}/${componentName}`;
}

/**
 * Enforce supported component type/path combinations.
 *
 * @param {'directory'|'file'} type Component type.
 * @param {string} componentPath Repository-relative component path.
 */
function validateComponentTypePath(type, componentPath) {
	const [, componentRoot, componentName] = componentPath.split('/');

	if (type === 'directory') {
		return;
	}

	if (componentRoot === 'themes') {
		throw new Error(
			`Single-file components are not supported in themes: ${componentPath}`
		);
	}

	if (!componentName.endsWith('.php')) {
		throw new Error(
			`Single-file plugin components must be PHP files: ${componentPath}`
		);
	}
}

/**
 * Validate archive entry names before extraction.
 *
 * @param {string[]} entries Archive entry names.
 * @param {string} requiredPrefix Required first path segment.
 */
function validateArchiveEntries(entries, requiredPrefix) {
	if (entries.length === 0) {
		throw new Error('The generated archive is empty.');
	}

	for (const rawEntry of entries) {
		const entry = rawEntry.replace(/\/$/, '');

		if (!entry) {
			continue;
		}

		if (
			entry.startsWith('/') ||
			entry.includes('\\') ||
			/[\n\r\t]/.test(entry) ||
			entry.split('/').includes('..') ||
			(entry !== requiredPrefix &&
				!entry.startsWith(`${requiredPrefix}/`))
		) {
			throw new Error(`Unsafe archive entry: ${rawEntry}`);
		}
	}
}

/**
 * Collect and validate all staged entries below a component.
 *
 * @param {string} componentRoot Absolute staged component path.
 * @return {string[]} Absolute file paths.
 */
function collectComponentEntries(componentRoot) {
	const rootStatus = lstatSync(componentRoot);

	if (rootStatus.isSymbolicLink()) {
		throw new Error(
			`A component root cannot be a symbolic link: ${componentRoot}`
		);
	}

	if (rootStatus.isFile()) {
		return [componentRoot];
	}

	if (!rootStatus.isDirectory()) {
		throw new Error(`Unsupported component type: ${componentRoot}`);
	}

	const entries = [];
	const pendingDirectories = [componentRoot];

	while (pendingDirectories.length > 0) {
		const currentDirectory = pendingDirectories.pop();

		for (const name of readdirSync(currentDirectory)) {
			const entryPath = join(currentDirectory, name);
			const entryRelativePath = relative(componentRoot, entryPath);
			const pathParts = entryRelativePath.split(sep);

			if (/[\n\r\t\\]/.test(entryRelativePath)) {
				throw new Error(`Unsafe packaged path: ${entryPath}`);
			}

			if (
				pathParts.includes('node_modules') ||
				pathParts.includes('.git')
			) {
				throw new Error(
					`Development dependency found in component package: ${entryPath}`
				);
			}

			const status = lstatSync(entryPath);

			if (status.isSymbolicLink()) {
				throw new Error(
					`Symbolic links are not allowed in component packages: ${entryPath}`
				);
			}

			if (status.isDirectory()) {
				pendingDirectories.push(entryPath);
				continue;
			}

			if (status.isFile()) {
				entries.push(entryPath);
				continue;
			}

			throw new Error(
				`Unsupported packaged filesystem entry: ${entryPath}`
			);
		}
	}

	if (entries.length === 0) {
		throw new Error(`The staged component is empty: ${componentRoot}`);
	}

	return entries;
}

/**
 * Package a component that owns npm package metadata.
 *
 * @param {string} componentPath Repository-relative component path.
 * @param {string} stagedComponentPath Absolute staging path.
 * @param {string} temporaryRoot Absolute temporary workspace.
 */
function packageNpmComponent(
	componentPath,
	stagedComponentPath,
	temporaryRoot
) {
	const sourcePath = join(projectRoot, componentPath);
	const packageJsonPath = join(sourcePath, 'package.json');
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

	if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
		throw new Error(
			`Missing package.json#files deployment contract: ${componentPath}`
		);
	}

	const hasLockfile = existsSync(join(sourcePath, 'package-lock.json'));
	const hasBuild = typeof packageJson.scripts?.build === 'string';

	if (hasBuild && !hasLockfile) {
		throw new Error(
			`A build script requires package-lock.json: ${componentPath}`
		);
	}

	if (hasLockfile) {
		process.stdout.write(
			`Installing locked dependencies: ${componentPath}\n`
		);
		run('npm', ['ci', '--no-audit', '--no-fund'], sourcePath);
	}

	if (hasBuild) {
		process.stdout.write(`Building component: ${componentPath}\n`);
		run('npm', ['run', 'build'], sourcePath);
	}

	const packageDirectory = join(
		temporaryRoot,
		'packages',
		componentPath.replaceAll('/', '--')
	);
	mkdirSync(packageDirectory, { recursive: true });

	const npmOutput = run(
		'npm',
		['pack', '--json', '--pack-destination', packageDirectory],
		sourcePath
	).toString('utf8');

	let packageResult;

	try {
		packageResult = JSON.parse(npmOutput);
	} catch {
		throw new Error(`npm pack returned invalid JSON for ${componentPath}.`);
	}

	if (
		!Array.isArray(packageResult) ||
		packageResult.length !== 1 ||
		!packageResult[0].filename
	) {
		throw new Error(
			`npm pack did not create exactly one package for ${componentPath}.`
		);
	}

	const packageArchive = join(packageDirectory, packageResult[0].filename);

	if (!existsSync(packageArchive)) {
		throw new Error(
			`npm package is missing after creation: ${packageArchive}`
		);
	}

	const packageEntries = run('tar', ['-tzf', packageArchive])
		.toString('utf8')
		.split('\n')
		.filter(Boolean);

	validateArchiveEntries(packageEntries, 'package');
	mkdirSync(stagedComponentPath, { recursive: true });
	run('tar', [
		'-xzf',
		packageArchive,
		'--strip-components=1',
		'-C',
		stagedComponentPath,
	]);
}

/**
 * Package a source-only component from the release Git tree.
 *
 * @param {string} componentPath Repository-relative component path.
 * @param {string} stagingRoot Absolute payload staging root.
 * @param {string} temporaryRoot Absolute temporary workspace.
 */
function packageSourceComponent(componentPath, stagingRoot, temporaryRoot) {
	const sourceArchive = join(
		temporaryRoot,
		'source-packages',
		`${componentPath.replaceAll('/', '--')}.tar`
	);

	mkdirSync(dirname(sourceArchive), { recursive: true });
	run('git', [
		'archive',
		'--format=tar',
		`--output=${sourceArchive}`,
		'HEAD',
		'--',
		componentPath,
	]);
	run('tar', ['-xf', sourceArchive, '-C', stagingRoot]);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'with-deploy-'));
let artifactComplete = false;

try {
	const trackedPaths = run('git', ['ls-files', '-z', '--', 'wp-content'])
		.toString('utf8')
		.split('\0')
		.filter(Boolean);
	const componentPaths = [
		...new Set(trackedPaths.map(getComponentPath)),
	].sort();

	if (componentPaths.length === 0) {
		throw new Error(
			'No repository-managed WordPress components were found.'
		);
	}

	const stagingRoot = join(temporaryRoot, 'site');
	const payloadRoot = join(stagingRoot, 'payload');
	mkdirSync(payloadRoot, { recursive: true });

	const components = [];

	for (const componentPath of componentPaths) {
		const sourcePath = join(projectRoot, componentPath);
		const sourceStatus = lstatSync(sourcePath);

		if (sourceStatus.isSymbolicLink()) {
			throw new Error(
				`A component root cannot be a symbolic link: ${componentPath}`
			);
		}

		const type = sourceStatus.isDirectory()
			? 'directory'
			: sourceStatus.isFile()
				? 'file'
				: null;

		if (!type) {
			throw new Error(`Unsupported component type: ${componentPath}`);
		}

		validateComponentTypePath(type, componentPath);

		const stagedComponentPath = join(payloadRoot, componentPath);

		if (
			type === 'directory' &&
			existsSync(join(sourcePath, 'package.json'))
		) {
			packageNpmComponent(
				componentPath,
				stagedComponentPath,
				temporaryRoot
			);
		} else {
			packageSourceComponent(componentPath, payloadRoot, temporaryRoot);
		}

		collectComponentEntries(stagedComponentPath);
		components.push({ type, path: componentPath });
	}

	const manifest = [
		MANIFEST_VERSION,
		...components.map(
			(component) => `${component.type}\t${component.path}`
		),
		'',
	].join('\n');

	writeFileSync(join(stagingRoot, MANIFEST_NAME), manifest, { mode: 0o600 });
	mkdirSync(dirname(artifactPath), { recursive: true });
	run('tar', [
		'-czf',
		artifactPath,
		'-C',
		stagingRoot,
		MANIFEST_NAME,
		'payload',
	]);

	const siteEntries = run('tar', ['-tzf', artifactPath])
		.toString('utf8')
		.split('\n')
		.filter(Boolean);

	for (const entry of siteEntries) {
		const normalizedEntry = entry.replace(/\/$/, '');

		if (
			normalizedEntry.startsWith('/') ||
			normalizedEntry.includes('\\') ||
			normalizedEntry.split('/').includes('..') ||
			(normalizedEntry !== MANIFEST_NAME &&
				normalizedEntry !== 'payload' &&
				!normalizedEntry.startsWith('payload/'))
		) {
			throw new Error(`Unsafe site artifact entry: ${entry}`);
		}
	}

	artifactComplete = true;

	process.stdout.write(`Prepared deployment artifact: ${artifactPath}\n`);
	process.stdout.write('Managed components:\n');

	for (const component of components) {
		process.stdout.write(`  ${component.type} ${component.path}\n`);
	}
} finally {
	if (!artifactComplete) {
		rmSync(artifactPath, { force: true });
	}

	rmSync(temporaryRoot, { recursive: true, force: true });
}
