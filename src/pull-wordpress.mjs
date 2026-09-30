import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { log, note, outro } from '@clack/prompts';
import {
  ask,
  askRequired,
  askYesNo,
  createPrompts,
  readConfig,
  run,
  runCapture,
  runToFile,
  writeConfig,
} from './cli.mjs';
import {
  buildDatabaseStreamScript,
  buildFileStreamScript,
  buildPreflightScript,
  deriveDdevUrl,
  FILE_EXCLUDES,
  normalizeUrl,
  sshArgs,
  validateRemoteInput,
} from './remote-wordpress.mjs';

export async function pullWordPress() {
  const projectRoot = process.cwd();
  ensureDdevProject(projectRoot);

  const config = readConfig(projectRoot);
  const defaults = config.wordpressPull || {};
  const localProtection = inspectLocalProtection(projectRoot);
  const rl = createPrompts();
  let temporaryRoot = '';
  let snapshotName = '';
  let localFilesChanged = false;
  let localFilesCompleted = false;
  let localDatabaseChanged = false;

  try {
    note(`Project: ${projectRoot}\nPull the production site into DDEV. Production remains read only.`, 'Pull WordPress');

    const sshTarget = await askRequired(rl, 'SSH target', defaults.sshTarget);
    const remoteRoot = await askRequired(rl, 'Remote WordPress root', defaults.remoteRoot);
    const liveUrl = normalizeUrl(await askRequired(rl, 'Live URL', defaults.liveUrl));
    const generatedLocalUrl = ddevUrl(projectRoot, liveUrl);
    const savedLocalUrl = defaults.localUrl ? normalizeUrl(defaults.localUrl) : '';
    const generatedProjectName = new URL(generatedLocalUrl).hostname.split('.')[0];
    const savedProjectName = savedLocalUrl
      ? new URL(savedLocalUrl).hostname.replace(/\.ddev\.site$/, '')
      : '';
    const localUrlDefault = savedLocalUrl && savedProjectName !== generatedProjectName
      ? savedLocalUrl
      : generatedLocalUrl;
    const localUrl = normalizeUrl(await ask(rl, 'Local DDEV URL', localUrlDefault));
    const save = await askYesNo(rl, 'Save these settings?', true);
    const deleteMissingLabel = 'Delete local files that no longer exist on production?';
    const deleteMissingLocalFiles = await askYesNo(
      rl,
      deleteMissingLabel,
      false,
    );
    validateRemoteInput(sshTarget, remoteRoot);

    const localCleanupPlan = deleteMissingLocalFiles
      ? '- Local files missing from production will be deleted.'
      : '- Files and packages that exist only locally will be preserved.';
    note([
      '- Replace the local WordPress database after creating a DDEV snapshot.',
      '- Replace local untracked files with their production copies.',
      '- Replace matching untracked plugins and themes as complete packages.',
      localCleanupPlan,
      '- Preserve Git-managed packages, tracked files, DDEV configuration, and temporary settings.',
    ].join('\n'), 'Planned local changes');

    let confirmed;
    if (localProtection.warning) {
      log.warn(`${localProtection.warning}\nReplaced local files cannot be restored automatically.`);
      const confirmation = await ask(rl, 'Type PULL WITHOUT BACKUP to continue');
      confirmed = confirmation === 'PULL WITHOUT BACKUP';
    } else {
      confirmed = await askYesNo(rl, 'Continue?', false);
    }

    if (!confirmed) {
      outro('Stopped before making changes.');
      return;
    }

    rl?.close();
    runCapture(
      'Checking production',
      'ssh',
      sshArgs(sshTarget, remoteRoot),
      buildPreflightScript(),
      true,
      {
        errorMessage: 'Production preflight failed. Check SSH access and the remote WordPress root.\nLocal files and database were not replaced.',
      },
    );

    if (save) {
      try {
        writeConfig(projectRoot, {
          ...config,
          wordpressPull: {
            ...defaults,
            sshTarget,
            remoteRoot,
            liveUrl,
            localUrl,
          },
        });
      } catch {
        throw new Error('Pull settings could not be saved. Check project write permissions.\nLocal files and database were not replaced.');
      }
    }

    run('Starting DDEV', 'ddev', ['start'], {
      errorMessage: 'DDEV could not be started. Local files and database were not replaced.',
    });
    snapshotName = `before-pull-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    run('Creating local database snapshot', 'ddev', ['snapshot', `--name=${snapshotName}`], {
      errorMessage: 'The local database snapshot could not be created. Local files and database were not replaced.',
    });

    try {
      temporaryRoot = mkdtempSync(path.join(tmpdir(), 'with-scripts-'));
      chmodSync(temporaryRoot, 0o700);
    } catch {
      throw new Error('Secure temporary storage could not be created. Check local disk space and permissions.\nLocal files and database were not replaced.');
    }
    const databaseFile = path.join(temporaryRoot, 'database.sql.gz');
    const filesArchive = path.join(temporaryRoot, 'files.tar.gz');
    const trackedFilesArchive = path.join(temporaryRoot, 'git-tracked-files.tar.gz');
    const wpConfigBackup = path.join(temporaryRoot, 'wp-config.php');

    await runToFile(
      'Downloading production database',
      'ssh',
      sshArgs(sshTarget, remoteRoot),
      buildDatabaseStreamScript(),
      databaseFile,
      {
        errorMessage: 'Production database download failed. Check SSH and database access.\nLocal files and database were not replaced.',
        idleError: 'Production database download stalled. Check the SSH connection and try again.\nLocal files and database were not replaced.',
      },
    );
    await runToFile(
      'Downloading production files',
      'ssh',
      sshArgs(sshTarget, remoteRoot),
      buildFileStreamScript(),
      filesArchive,
      {
        changedFileError: 'Production files changed during download. Please run the pull again.\nLocal files and database were not replaced.',
        errorMessage: 'Production file download failed. Check SSH and remote file access.\nLocal files and database were not replaced.',
        idleError: 'Production file download stalled. Check the SSH connection and try again.\nLocal files and database were not replaced.',
      },
    );
    run('Validating database download', 'gzip', ['-t', databaseFile], {
      errorMessage: 'Production database download is incomplete or invalid. Please run the pull again.\nLocal files and database were not replaced.',
    });
    run('Validating file download', 'tar', ['-tzf', filesArchive], {
      stdout: 'ignore',
      errorMessage: 'Production file download is incomplete or invalid. Please run the pull again.\nLocal files and database were not replaced.',
    });

    let trackedFilesSaved = false;
    if (localProtection.gitProtected) {
      try {
        trackedFilesSaved = backupTrackedFiles(projectRoot, trackedFilesArchive);
      } catch {
        throw new Error('Git-tracked files could not be backed up. Check local disk space and permissions.\nLocal files and database were not replaced.');
      }
    }
    localFilesChanged = true;
    try {
      if (deleteMissingLocalFiles) {
        try {
          await mirrorProductionFiles(
            projectRoot,
            filesArchive,
            localProtection.gitProtected,
          );
        } catch (error) {
          throw new Error(`Local file cleanup failed: ${error.message}`);
        }
      }
      let protectedPackageExcludes;
      try {
        protectedPackageExcludes = prepareProductionPackages(
          projectRoot,
          filesArchive,
          localProtection.gitProtected,
        );
      } catch (error) {
        throw new Error(`Production packages could not be prepared: ${error.message}`);
      }
      run('Extracting production files', 'tar', [
        '-xzf',
        filesArchive,
        '-C',
        projectRoot,
        ...protectedPackageExcludes,
      ], {
        errorMessage: 'Production files could not be extracted.',
      });
    } finally {
      if (trackedFilesSaved) {
        run('Restoring Git-tracked files', 'tar', ['-xzf', trackedFilesArchive, '-C', projectRoot], {
          errorMessage: 'Git-tracked files could not be restored. Restore them with Git before continuing.',
        });
      }
    }
    localFilesCompleted = true;

    const wpConfigPath = path.join(projectRoot, 'wp-config.php');
    try {
      copyFileSync(wpConfigPath, wpConfigBackup);
    } catch {
      throw new Error('wp-config.php could not be backed up. Check local disk space and permissions.');
    }
    patchWpConfig(wpConfigPath);
    try {
      run('Checking wp-config.php', 'ddev', ['exec', 'php', '-l', 'wp-config.php'], {
        errorMessage: 'wp-config.php failed validation.',
      });
    } catch {
      try {
        copyFileSync(wpConfigBackup, wpConfigPath);
      } catch {
        throw new Error('wp-config.php failed validation and the previous local file could not be restored. Restore it with Git before continuing.');
      }
      throw new Error('wp-config.php failed validation. The previous local file was restored.');
    }

    try {
      updateGitignore(projectRoot);
      moveMaintenanceFile(projectRoot);
    } catch (error) {
      throw new Error(`Local project preparation failed: ${error.message}`);
    }
    localDatabaseChanged = true;
    run('Importing production database', 'ddev', ['import-db', `--file=${databaseFile}`], {
      errorMessage: 'Production database import failed.',
    });
    replaceUrls(liveUrl, localUrl);
    run('Checking local WordPress', 'ddev', ['wp', 'core', 'is-installed', '--skip-plugins', '--skip-themes'], {
      errorMessage: 'Local WordPress verification failed.',
    });

    outro(`Pull complete.\nOpen locally: ${localUrl}`);
  } catch (error) {
    if (localFilesCompleted) {
      console.error('\nProduction files were copied locally before the error.');
    } else if (localFilesChanged) {
      console.error('\nLocal files may have been partially replaced. Review the project before continuing.');
    }
    if (snapshotName && localDatabaseChanged) {
      console.error(`Restore the previous database with: ddev snapshot restore ${snapshotName}`);
    }
    throw error;
  } finally {
    rl?.close();
    if (temporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export async function mirrorProductionFiles(
  projectRoot,
  archivePath,
  protectTrackedFiles,
) {
  const productionFiles = new Set();
  const productionDirectories = new Set();
  const listing = spawn('tar', ['-tzf', archivePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let listingError = '';
  listing.stderr.setEncoding('utf8');
  listing.stderr.on('data', (chunk) => {
    listingError += chunk;
  });
  const listingResult = new Promise((resolve) => {
    listing.once('error', (error) => resolve({ error }));
    listing.once('close', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: listing.stdout, crlfDelay: Infinity });

  for await (const entry of lines) {
    const isDirectory = entry.endsWith('/');
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) continue;
    if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      listing.kill();
      throw new Error(`Unsafe path in production archive: ${entry}`);
    }

    if (isDirectory) {
      productionDirectories.add(normalized);
    } else {
      productionFiles.add(normalized);
    }

    const parts = normalized.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      productionDirectories.add(parts.slice(0, index).join('/'));
    }
  }

  const result = await listingResult;
  if (result.error) {
    throw new Error(`Could not inspect production files: ${result.error.message}`);
  }
  if (result.code !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    throw new Error(
      `Could not inspect production files: tar failed with ${reason}${listingError ? `: ${listingError.trim()}` : '.'}`,
    );
  }

  const trackedFiles = protectTrackedFiles
    ? new Set(
        execFileSync('git', ['ls-files', '-z'], {
          cwd: projectRoot,
          encoding: 'utf8',
        }).split('\0').filter(Boolean),
      )
    : new Set();
  const protectedRoots = new Set(
    FILE_EXCLUDES.map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, '')),
  );

  for (const trackedFile of trackedFiles) {
    const match = trackedFile.match(/^wp-content\/(plugins|themes)\/([^/]+)(?:\/|$)/);
    if (match) {
      protectedRoots.add(`wp-content/${match[1]}/${match[2]}`);
    }
  }
  const protectedRootList = [...protectedRoots];

  const pendingDirectories = [''];
  const visitedDirectories = [];
  let removedFiles = 0;
  let removedDirectories = 0;

  while (pendingDirectories.length) {
    const relativeDirectory = pendingDirectories.pop();
    const absoluteDirectory = relativeDirectory
      ? path.join(projectRoot, relativeDirectory)
      : projectRoot;

    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const protectedByRoot = protectedRootList.some(
        (root) => relativePath === root || relativePath.startsWith(`${root}/`),
      );

      if (protectedByRoot || trackedFiles.has(relativePath)) continue;

      const absolutePath = path.join(projectRoot, relativePath);
      if (entry.isDirectory()) {
        pendingDirectories.push(relativePath);
        visitedDirectories.push(relativePath);
        continue;
      }

      if (!productionFiles.has(relativePath)) {
        rmSync(absolutePath, { force: true });
        removedFiles += 1;
      }
    }
  }

  visitedDirectories.sort(
    (left, right) => right.split('/').length - left.split('/').length,
  );
  for (const relativePath of visitedDirectories) {
    if (productionDirectories.has(relativePath)) continue;
    const absolutePath = path.join(projectRoot, relativePath);
    if (existsSync(absolutePath) && readdirSync(absolutePath).length === 0) {
      rmdirSync(absolutePath);
      removedDirectories += 1;
    }
  }

  console.log(
    `\nLocal cleanup: ${removedFiles} files and ${removedDirectories} directories removed.`,
  );

  return { removedFiles, removedDirectories };
}

export function ddevUrl(projectRoot, liveUrl) {
  const yaml = readFileSync(path.join(projectRoot, '.ddev', 'config.yaml'), 'utf8');
  const name = yaml.match(/^\s*name:\s*["']?([^"'#\s]+)["']?\s*$/m)?.[1]?.trim();
  const projectTld = yaml.match(/^\s*project_tld:\s*["']?([^"'#\s]+)["']?\s*$/m)?.[1]?.trim() || 'ddev.site';
  return name ? `https://${name}.${projectTld}` : deriveDdevUrl(liveUrl, projectTld);
}

function ensureDdevProject(projectRoot) {
  if (!existsSync(path.join(projectRoot, '.ddev', 'config.yaml'))) {
    throw new Error('DDEV is not configured. Run with-scripts setup-wordpress first.');
  }
}

export function inspectLocalProtection(projectRoot) {
  const hasWordPress = ['index.php', 'wp-admin', 'wp-includes']
    .some((entry) => existsSync(path.join(projectRoot, entry)));

  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (path.resolve(gitRoot) !== path.resolve(projectRoot)) {
      return {
        warning: hasWordPress ? 'This WordPress folder is not the root of its own Git repository.' : '',
        gitProtected: false,
      };
    }
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    if (status) {
      throw new Error('Local Git changes are present. Commit or stash them before pulling.');
    }
    return { warning: '', gitProtected: true };
  } catch (error) {
    if (error.message.startsWith('Local Git changes')) throw error;
    return {
      warning: hasWordPress ? 'Existing local WordPress files are not protected by Git.' : '',
      gitProtected: false,
    };
  }
}

export function backupTrackedFiles(projectRoot, destination) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot });
  if (!files.length) return false;

  execFileSync('tar', ['-czf', destination, '--null', '-T', '-'], {
    cwd: projectRoot,
    input: files,
  });
  return true;
}

/**
 * Prepare production plugin and theme packages for extraction.
 *
 * A production package replaces a matching package that is not managed by the
 * project repository. Packages containing Git-tracked files are excluded from
 * extraction as a complete unit so production and local versions cannot mix.
 *
 * @param {string} projectRoot Project root.
 * @param {string} archivePath Production file archive.
 * @param {boolean} protectTrackedPackages Whether Git-tracked packages exist.
 * @returns {string[]} Tar exclusion arguments for Git-tracked packages.
 */
export function prepareProductionPackages(
  projectRoot,
  archivePath,
  protectTrackedPackages,
) {
  const packagePattern = /^wp-content\/(plugins|themes)\/([^/]+)(?:\/|$)/;
  const collectPackageRoots = (entries) => {
    const packages = new Set();

    for (const entry of entries) {
      const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
      const match = normalized.match(packagePattern);

      if (match && !['.', '..'].includes(match[2])) {
        packages.add(`wp-content/${match[1]}/${match[2]}`);
      }
    }

    return packages;
  };

  const archiveFiles = execFileSync(
    'tar',
    [
      '-tzf',
      archivePath,
      './wp-content/plugins',
      './wp-content/themes',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const productionPackages = collectPackageRoots(archiveFiles.split('\n'));
  const trackedPackages = protectTrackedPackages
    ? collectPackageRoots(
        execFileSync(
          'git',
          ['ls-files', '-z', '--', 'wp-content/plugins', 'wp-content/themes'],
          { cwd: projectRoot, encoding: 'utf8' },
        ).split('\0'),
      )
    : new Set();
  const protectedPackages = [...trackedPackages]
    .filter((packageRoot) => productionPackages.has(packageRoot))
    .sort();
  let replacedPackages = 0;

  for (const packageRoot of [...productionPackages].sort()) {
    if (trackedPackages.has(packageRoot)) continue;

    const target = path.resolve(projectRoot, packageRoot);
    const resolvedProjectRoot = path.resolve(projectRoot);

    if (!target.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
      throw new Error(`Unsafe WordPress package path: ${packageRoot}`);
    }

    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      replacedPackages += 1;
    }
  }

  console.log(
    `\nProduction packages replaced: ${replacedPackages}; Git-managed packages preserved: ${protectedPackages.length}.`,
  );

  return protectedPackages.flatMap((packageRoot) => [
    `--exclude=./${packageRoot}`,
    `--exclude=${packageRoot}`,
  ]);
}

export function patchWpConfig(wpConfigPath) {
  let contents = readFileSync(wpConfigPath, 'utf8');
  if (!contents.includes('wp-config-ddev.php')) {
    if (!contents.startsWith('<?php')) {
      throw new Error('wp-config.php does not start with <?php.');
    }
    contents = contents.replace('<?php', `<?php

if ( getenv( 'IS_DDEV_PROJECT' ) === 'true' && is_readable( __DIR__ . '/wp-config-ddev.php' ) ) {
	require_once __DIR__ . '/wp-config-ddev.php';
}
`);
  }

  for (const name of ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST']) {
    if (new RegExp(`defined\\s*\\(\\s*['"]${name}['"]`).test(contents)) continue;
    const definition = new RegExp(`^(\\s*)define\\s*\\(\\s*(['"])${name}\\2\\s*,`, 'm');
    if (!definition.test(contents)) {
      throw new Error(`Could not safely patch ${name} in wp-config.php.`);
    }
    contents = contents.replace(definition, `$1defined( '${name}' ) || define( '${name}',`);
  }
  writeFileSync(wpConfigPath, contents);
}

function updateGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const wanted = [
    '.with-scripts.json',
    'wp-config.php',
    '.maintenance*',
    '*.sql',
    '*.sql.gz',
    '*.tar.gz',
    'wp-content/uploads/',
    'wp-content/cache/',
    'wp-content/upgrade/',
    'wp-content/wpvividbackups/',
  ];
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/));
  const additions = wanted.filter((line) => !lines.has(line));
  if (!additions.length) return;
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${existing}${separator}\n# Local WordPress pull files\n${additions.join('\n')}\n`);
}

function moveMaintenanceFile(projectRoot) {
  const source = path.join(projectRoot, '.maintenance');
  if (!existsSync(source)) return;
  const target = path.join(projectRoot, '.maintenance.production-copy');
  rmSync(target, { force: true });
  renameSync(source, target);
}

function replaceUrls(liveUrl, localUrl) {
  for (const from of urlVariants(liveUrl)) {
    if (from === localUrl) continue;
    const args = [
      'wp',
      'search-replace',
      from,
      localUrl,
      '--all-tables-with-prefix',
      '--skip-columns=guid',
      '--skip-plugins',
      '--skip-themes',
    ];
    run(`Previewing URL replacement: ${from}`, 'ddev', [...args, '--dry-run'], {
      errorMessage: `URL replacement preview failed for ${from}.`,
    });
    run(`Applying URL replacement: ${from}`, 'ddev', args, {
      errorMessage: `URL replacement failed for ${from}.`,
    });
  }
}

export function urlVariants(liveUrl) {
  const url = new URL(liveUrl);
  const bareHost = url.hostname.replace(/^www\./, '');
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return [...new Set([
    liveUrl,
    `https://${bareHost}${suffix}`,
    `https://www.${bareHost}${suffix}`,
    `http://${bareHost}${suffix}`,
    `http://www.${bareHost}${suffix}`,
  ])];
}
