import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { log, note, outro } from '@clack/prompts';
import {
  askRequired,
  askYesNo,
  createPrompts,
  run,
  runCapture,
} from './cli.mjs';
import { ddevUrl } from './pull-wordpress.mjs';
import { defaultToolSources, syncTools } from './sync-tools.mjs';

const TEXT_EXTENSIONS = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.php',
  '.scss',
  '.svg',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function parseSetupThemeArgs(args) {
  const options = {
    name: '',
    slug: '',
    source: '',
    toolSources: {},
    replaceExisting: false,
    dryRun: false,
    yes: false,
  };

  for (const argument of args) {
    const sourceOption = argument.match(/^--(patterns|theme-tools|site-tools)-source=(.*)$/);
    if (sourceOption) {
      const directory = sourceOption[2].trim();
      if (!directory) {
        throw new Error(`Provide a local directory for --${sourceOption[1]}-source.`);
      }
      const key = { patterns: 'patterns', 'theme-tools': 'themeTools', 'site-tools': 'siteTools' }[sourceOption[1]];
      options.toolSources[key] = path.resolve(directory);
      continue;
    }
    if (argument.startsWith('--name=')) {
      options.name = argument.slice('--name='.length).trim();
      continue;
    }
    if (argument.startsWith('--slug=')) {
      options.slug = argument.slice('--slug='.length).trim();
      continue;
    }
    if (argument.startsWith('--source=')) {
      options.source = argument.slice('--source='.length).trim();
      continue;
    }
    if (argument === '--replace-existing') {
      options.replaceExisting = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--yes') {
      options.yes = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

export function validateThemeIdentity(name, slug) {
  if (!name || /[\r\n]/.test(name)) {
    throw new Error('Theme name must be a non-empty single line.');
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('Theme slug must use lowercase letters, numbers, and single hyphens.');
  }
  if (slug === 'with-base') {
    throw new Error('Choose a customer theme slug instead of with-base.');
  }
}

export function detectWordPressProjectRoot(startDirectory) {
  const current = path.resolve(startDirectory);

  if (
    existsSync(path.join(current, 'wp-content', 'themes')) &&
    existsSync(path.join(current, '.ddev', 'config.yaml'))
  ) {
    return current;
  }

  if (
    path.basename(path.dirname(current)) === 'themes' &&
    path.basename(path.dirname(path.dirname(current))) === 'wp-content'
  ) {
    const projectRoot = path.dirname(path.dirname(path.dirname(current)));
    if (existsSync(path.join(projectRoot, '.ddev', 'config.yaml'))) {
      return projectRoot;
    }
  }

  throw new Error(
    'Run setup-theme from a DDEV WordPress project root or one of its theme roots.',
  );
}

export function personalizeTheme(themeRoot, { name, slug, localUrl }) {
  const phpPrefix = slug.replaceAll('-', '_');
  const constantPrefix = phpPrefix.toUpperCase();

  renameIdentityPaths(themeRoot, slug);

  for (const file of listFiles(themeRoot)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      continue;
    }
    const content = readFileSync(file);
    if (content.includes(0)) {
      continue;
    }
    const original = content.toString('utf8');
    const updated = original
      .replaceAll('WITH_BASE', constantPrefix)
      .replaceAll('with_base', phpPrefix)
      .replaceAll('with-base', slug)
      .replaceAll('With Base', name);

    if (updated !== original) {
      writeFileSync(file, updated);
    }
  }

  const stylePath = path.join(themeRoot, 'style.css');
  const style = readFileSync(stylePath, 'utf8')
    .replace(/^Theme Name:.*$/m, `Theme Name: ${name}`)
    .replace(/^Theme URI:.*\n/m, '')
    .replace(/^Description:.*$/m, `Description: Custom WordPress block theme for ${name}.`)
    .replace(/^Text Domain:.*$/m, `Text Domain: ${slug}`);
  writeFileSync(stylePath, style);

  const packagePath = path.join(themeRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.name = slug;
  packageJson.description = `Custom WordPress block theme for ${name}.`;
  packageJson.scripts.start =
    `${constantPrefix}_BS_PROXY=${localUrl}/ wp-scripts start --config webpack.dev.js`;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`);

  const readmePath = path.join(themeRoot, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8')
      .replace(/^# .* WordPress Block Theme$/m, `# ${name} WordPress Block Theme`)
      .replace(
        /^.* is released under the \[GPLv2\]\(LICENSE\)\.$/m,
        `${name} is released under the [GPLv2](LICENSE).`,
      );
    writeFileSync(readmePath, readme);
  }
}

export async function setupTheme(args = []) {
  const options = parseSetupThemeArgs(args);
  const projectRoot = detectWordPressProjectRoot(process.cwd());
  const rl = createPrompts();

  try {
    const name = options.name || await askRequired(rl, 'Theme name');
    const slug = options.slug || await askRequired(rl, 'Theme slug');
    validateThemeIdentity(name, slug);

    const target = path.join(projectRoot, 'wp-content', 'themes', slug);
    const targetExists = existsSync(target);

    if (targetExists && !options.replaceExisting) {
      throw new Error(
        `Theme target already exists: ${target}\nUse --replace-existing only after reviewing and committing the current theme.`,
      );
    }

    const localUrl = ddevUrl(projectRoot, `https://${slug}.example`);

    if (!options.dryRun) {
      run('Checking local WordPress installation', 'ddev', [
        'wp', 'core', 'is-installed', '--skip-plugins', '--skip-themes',
      ], {
        errorMessage: 'Local WordPress is not installed or could not be loaded.\n'
          + `Run ddev start. For a new site, complete the installer at ${localUrl}/wp-admin/install.php.\n`
          + 'If already installed, check wp-config.php and the database connection.\n'
          + 'Then rerun with-scripts setup-theme. No theme or plugin files were changed.',
      });
    }

    const source = path.resolve(options.source || await askRequired(rl, 'Local starter theme directory (--source)'));
    assertThemeSource(source);
    let sourceCommit = 'local source';
    const result = spawnSync(
      'git',
      ['-C', source, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8' },
    );
    if (result.status === 0) {
      sourceCommit = result.stdout.trim();
    }

    const toolSources = defaultToolSources(options.toolSources);
    note(`Source: ${source}\nSource commit: ${sourceCommit}\nPatterns source: ${toolSources.patterns}\nTheme Tools source: ${toolSources.themeTools}\nSite Tools source: ${toolSources.siteTools}\nTarget: ${target}\nTheme name: ${name}\nTheme slug: ${slug}\nLocal URL: ${localUrl}\nExisting target: ${targetExists ? 'replace with backup' : 'no'}`, 'Theme setup plan');

    if (options.dryRun) {
      log.info('Applying this plan requires a running DDEV project and an installed WordPress database.');
      outro('Dry run complete. No project files were changed.');
      return;
    }

    if (!options.yes && !await askYesNo(rl, 'Apply this theme setup now?', false)) {
      outro('Stopped before changing the project.');
      return;
    }

    let backup = '';
    if (targetExists) {
      assertReplaceableTheme(target);
      const timestamp = timestampSlug();
      const backupBranch = `backup/pre-with-base-${timestamp}`;
      backup = path.join(
        projectRoot,
        '.with-scripts-backups',
        'themes',
        `${slug}-${timestamp}`,
      );

      run('Creating theme backup branch', 'git', [
        '-C',
        target,
        'branch',
        backupBranch,
        'HEAD',
      ], {
        errorMessage: 'The theme backup branch could not be created. Check the theme Git repository.\nThe existing theme files were not replaced.',
      });
      run('Creating DDEV database snapshot', 'ddev', [
        'snapshot',
        `--name=pre-with-base-${timestamp}`,
      ], {
        errorMessage: 'The DDEV database snapshot could not be created. Check DDEV and available disk space.\nThe existing theme files were not replaced.',
      });

      mkdirSync(path.dirname(backup), { recursive: true });
      renameSync(target, backup);
      mkdirSync(target, { recursive: true });
      renameSync(path.join(backup, '.git'), path.join(target, '.git'));
      console.log(`Moved the previous theme files to ${backup}`);
    } else {
      mkdirSync(target, { recursive: true });
    }

    let toolsSyncStarted = false;
    try {
      copyTheme(source, target);
      personalizeTheme(target, { name, slug, localUrl });

      for (const [label, directory] of Object.entries(toolSources)) {
        if (!existsSync(directory)) {
          throw new Error(`Missing local ${label} source repository: ${directory}`);
        }
      }

      run('Installing theme and With Patterns dependencies', 'npm', [
        '--prefix',
        target,
        'install',
        '--save-dev',
        toolSources.patterns,
      ], {
        errorMessage: 'Theme dependencies could not be installed. Check the npm output above, network access, and local package paths.',
      });

      run('Setting up With Patterns runtime', 'npm', [
        '--prefix',
        target,
        'run',
        'patterns:setup',
      ], {
        errorMessage: 'With Patterns setup failed. Check the output above and the local With Patterns source.',
      });
      toolsSyncStarted = true;
      syncTools([], {
        projectRoot,
        themeRoot: target,
        toolSources,
        activatePlugin: true,
      });

      run('Building customer theme', 'npm', ['--prefix', target, 'run', 'build'], {
        errorMessage: 'The customer theme build failed. Fix the build errors shown above before retrying setup-theme.',
      });
      run('Linting customer theme CSS', 'npm', ['--prefix', target, 'run', 'lint:css'], {
        errorMessage: 'Customer theme CSS validation failed. Fix the lint errors shown above before retrying setup-theme.',
      });
      run('Linting customer theme JavaScript', 'npm', [
        '--prefix',
        target,
        'run',
        'lint:js',
      ], {
        errorMessage: 'Customer theme JavaScript validation failed. Fix the lint errors shown above before retrying setup-theme.',
      });
      run('Activating customer theme', 'ddev', ['wp', 'theme', 'activate', slug], {
        errorMessage: 'The customer theme could not be activated. Check the WordPress error above and the local DDEV installation.',
      });
    } catch (error) {
      if (backup && existsSync(backup)) {
        if (existsSync(path.join(target, '.git'))) {
          renameSync(path.join(target, '.git'), path.join(backup, '.git'));
        }
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
        console.error('\nRestored the previous theme files after setup failed.');
      } else if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        console.error('\nRemoved the incomplete new theme after setup failed.');
      }
      if (toolsSyncStarted) {
        console.error('Shared plugin files and activation state may have changed; they were not rolled back.');
      }
      throw error;
    }

    log.success('Theme setup complete.');
    console.log(`With Base source commit: ${sourceCommit}`);
    if (backup) {
      console.log(`Recoverable previous theme files: ${backup}`);
    }
    console.log('Customer-specific features must now be migrated manually.');
    outro('Review the frontend, Site Editor, templates, and persisted Global Styles.');
  } finally {
    rl?.close();
  }
}

function assertThemeSource(source) {
  if (
    !existsSync(source) ||
    !statSync(source).isDirectory() ||
    !existsSync(path.join(source, 'style.css')) ||
    !existsSync(path.join(source, 'theme.json')) ||
    !existsSync(path.join(source, 'package.json'))
  ) {
    throw new Error(`Not a valid With Base theme source: ${source}`);
  }
}

function assertReplaceableTheme(target) {
  const topLevel = runCapture(
    'Checking existing theme repository',
    'git',
    ['-C', target, 'rev-parse', '--show-toplevel'],
  ).trim();
  if (path.resolve(topLevel) !== path.resolve(target)) {
    throw new Error('The existing theme must be its own Git repository.');
  }

  const status = runCapture(
    'Checking existing theme worktree',
    'git',
    ['-C', target, 'status', '--porcelain', '--untracked-files=all'],
  ).trim();
  if (status) {
    throw new Error(
      'The existing theme worktree is not clean. Commit or remove all changes before replacement.',
    );
  }
}

function copyTheme(source, target) {
  for (const entry of readdirSync(source)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '.webpack-cache') {
      continue;
    }
    cpSync(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function renameIdentityPaths(directory, slug) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const original = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      renameIdentityPaths(original, slug);
    }
    const renamed = entry.name.replaceAll('with-base', slug);
    if (renamed !== entry.name) {
      renameSync(original, path.join(directory, renamed));
    }
  }
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function timestampSlug() {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replaceAll(':', '')
    .replace('T', '-');
}
