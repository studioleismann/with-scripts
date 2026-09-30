import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { note, outro } from '@clack/prompts';
import { run, runCapture } from './cli.mjs';

export function parseSyncToolsArgs(args) {
  const options = {
    slug: '',
    toolSources: {},
    dryRun: false,
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
    if (argument.startsWith('--slug=')) {
      options.slug = argument.slice('--slug='.length).trim();
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (
    options.slug &&
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(options.slug)
  ) {
    throw new Error('Theme slug must use lowercase letters, numbers, and single hyphens.');
  }

  return options;
}

export function resolveToolTargets(startDirectory, slug = '') {
  const current = path.resolve(startDirectory);

  if (
    path.basename(path.dirname(current)) === 'themes' &&
    path.basename(path.dirname(path.dirname(current))) === 'wp-content'
  ) {
    return {
      projectRoot: path.dirname(path.dirname(path.dirname(current))),
      themeRoot: current,
      slug: path.basename(current),
    };
  }

  if (
    existsSync(path.join(current, '.ddev', 'config.yaml')) &&
    existsSync(path.join(current, 'wp-content', 'themes'))
  ) {
    const activeSlug = slug || runCapture(
      'Detecting active WordPress theme',
      'ddev',
      ['wp', 'option', 'get', 'stylesheet'],
      undefined,
      false,
      {
        errorMessage: 'The active WordPress theme could not be detected.\n'
          + 'Run ddev start. For a new site, complete the WordPress installer at /wp-admin/install.php.\n'
          + 'If already installed, check the WordPress error above and wp-config.php.\n'
          + 'Then rerun with-scripts sync-tools. No theme or plugin files were changed.',
      },
    ).trim();
    if (!activeSlug) {
      throw new Error('Could not detect the active WordPress theme.');
    }
    return {
      projectRoot: current,
      themeRoot: path.join(current, 'wp-content', 'themes', activeSlug),
      slug: activeSlug,
    };
  }

  throw new Error(
    'Run sync-tools from a DDEV WordPress project root or one of its theme roots.',
  );
}

export function syncTools(args = [], context = {}) {
  const options = parseSyncToolsArgs(args);
  const targets = context.projectRoot && context.themeRoot
    ? {
        projectRoot: context.projectRoot,
        themeRoot: context.themeRoot,
        slug: path.basename(context.themeRoot),
      }
    : resolveToolTargets(process.cwd(), options.slug);
  const toolSources = context.toolSources || defaultToolSources(options.toolSources);
  const pluginsDirectory = path.join(targets.projectRoot, 'wp-content', 'plugins');
  const themeToolsTarget = path.join(pluginsDirectory, 'with-theme-tools');
  const siteToolsTarget = path.join(
    targets.projectRoot,
    'wp-content',
    'plugins',
    'with-site-tools',
  );

  if (options.dryRun || context.activatePlugin !== false) {
    run('Checking local WordPress installation', 'ddev', [
      'wp', 'core', 'is-installed', '--skip-plugins', '--skip-themes',
    ], {
      errorMessage: 'Local WordPress is not installed or could not be loaded.\n'
        + 'Run ddev start. For a new site, complete the WordPress installer at /wp-admin/install.php.\n'
        + 'If already installed, check wp-config.php and the database connection.\n'
        + 'Then rerun with-scripts sync-tools. No theme or plugin files were changed by this sync.',
    });
  }

  if (!existsSync(path.join(targets.themeRoot, 'package.json'))) {
    throw new Error(`Theme package.json is missing: ${targets.themeRoot}`);
  }
  for (const [label, directory] of Object.entries(toolSources)) {
    if (!existsSync(directory)) {
      throw new Error(`Missing local ${label} source repository: ${directory}`);
    }
  }

  note(`Theme: ${targets.themeRoot}\nPatterns source: ${toolSources.patterns}\nTheme Tools source: ${toolSources.themeTools}\nSite Tools source: ${toolSources.siteTools}\nTheme Tools target: ${themeToolsTarget}\nSite Tools target: ${siteToolsTarget}`, 'Shared tools sync');

  if (options.dryRun) {
    run('Checking With Patterns runtime', 'npm', [
      '--prefix',
      targets.themeRoot,
      'run',
      'patterns:check',
    ]);
    run('Checking With Theme Tools source version', 'npm', [
      '--prefix',
      toolSources.themeTools,
      'run',
      'check:version',
    ]);
    run('Checking With Theme Tools plugin', 'ddev', [
      'wp',
      'plugin',
      'status',
      'with-theme-tools',
    ]);
    run('Checking With Site Tools runtime', 'npm', [
      '--prefix',
      toolSources.siteTools,
      'run',
      'sync:check',
      '--',
      '--target',
      siteToolsTarget,
    ]);
    outro('Shared tools dry run complete. No runtime files were changed.');
    return;
  }

  run('Building With Patterns source', 'npm', [
    '--prefix',
    toolSources.patterns,
    'run',
    'build',
  ]);
  run('Checking With Patterns source', 'npm', [
    '--prefix',
    toolSources.patterns,
    'run',
    'check',
  ]);
  run('Checking With Patterns runtime before sync', 'npm', [
    '--prefix',
    targets.themeRoot,
    'run',
    'patterns:check',
  ]);
  run('Syncing With Patterns runtime', 'npm', [
    '--prefix',
    targets.themeRoot,
    'run',
    'patterns:sync',
  ]);
  run('Verifying With Patterns runtime', 'npm', [
    '--prefix',
    targets.themeRoot,
    'run',
    'patterns:check',
  ]);

  run('Building With Theme Tools plugin ZIP', 'npm', [
    '--prefix',
    toolSources.themeTools,
    'run',
    'zip',
  ]);
  run('Installing With Theme Tools plugin', 'unzip', [
    '-q',
    '-o',
    path.join(toolSources.themeTools, 'dist', 'with-theme-tools.zip'),
    '-d',
    pluginsDirectory,
  ]);

  run('Building With Site Tools source', 'npm', [
    '--prefix',
    toolSources.siteTools,
    'run',
    'build',
  ]);
  run('Checking With Site Tools runtime before sync', 'npm', [
    '--prefix',
    toolSources.siteTools,
    'run',
    'sync:check',
    '--',
    '--target',
    siteToolsTarget,
  ]);
  run('Syncing With Site Tools runtime', 'npm', [
    '--prefix',
    toolSources.siteTools,
    'run',
    'sync',
    '--',
    '--target',
    siteToolsTarget,
  ]);
  run('Verifying With Site Tools runtime', 'npm', [
    '--prefix',
    toolSources.siteTools,
    'run',
    'sync:check',
    '--',
    '--target',
    siteToolsTarget,
  ]);

  if (context.activatePlugin !== false) {
    run('Activating With Theme Tools', 'ddev', [
      'wp',
      'plugin',
      'activate',
      'with-theme-tools',
    ], {
      errorMessage: 'With Theme Tools could not be activated. Check the WordPress error above.\nRuntime files were already synchronized; activation may be incomplete.',
    });
    run('Activating With Site Tools', 'ddev', [
      'wp',
      'plugin',
      'activate',
      'with-site-tools',
    ], {
      errorMessage: 'With Site Tools could not be activated. Check the WordPress error above.\nRuntime files were already synchronized and With Theme Tools was activated.',
    });
  }

  outro('Shared tools are synchronized and verified.');
}

export function defaultToolSources(overrides = {}) {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );

  return {
    patterns: path.resolve(overrides.patterns || path.join(packageRoot, '..', 'with-patterns')),
    themeTools: path.resolve(overrides.themeTools || path.join(packageRoot, '..', '..', 'plugins', 'with-theme-tools')),
    siteTools: path.resolve(overrides.siteTools || path.join(packageRoot, '..', '..', 'plugins', 'with-site-tools')),
  };
}
