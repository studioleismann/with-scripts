import process from 'node:process';
import { log, note, outro } from '@clack/prompts';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import {
  ask,
  askRequired,
  askYesNo,
  createPrompts,
  readConfig,
  run,
  writeConfig,
} from './cli.mjs';
import {
  deriveDdevUrl,
  inspectEnvironment,
  normalizeUrl,
  validateRemoteInput,
} from './remote-wordpress.mjs';

export async function setupWordPress() {
  const projectRoot = process.cwd();
  const config = readConfig(projectRoot);
  const defaults = config.wordpressPull || {};
  const rl = createPrompts();

  try {
    note(`Project: ${projectRoot}\nRead the production environment and configure DDEV locally.`, 'Set up local WordPress');

    const sshTarget = await askRequired(rl, 'SSH target', defaults.sshTarget);
    const remoteRoot = await askRequired(rl, 'Remote WordPress root', defaults.remoteRoot);
    validateRemoteInput(sshTarget, remoteRoot);
    const environment = inspectEnvironment(sshTarget, remoteRoot);
    const liveUrl = normalizeUrl(environment.liveUrl);
    const localUrl = normalizeUrl(await ask(rl, 'Local DDEV URL', deriveDdevUrl(liveUrl)));
    const projectName = await ask(rl, 'DDEV project name', defaults.projectName || projectNameFromUrl(localUrl));
    const save = await askYesNo(rl, 'Save these settings for future pulls?', true);

    note(`PHP: ${environment.phpVersion}\nDatabase: ${environment.databaseEngine}:${environment.databaseVersion}\nLive URL: ${liveUrl}\nLocal URL: ${localUrl}`, 'Detected production environment');

    if (!await askYesNo(rl, 'Configure and start DDEV now?', true)) {
      outro('Stopped before making local changes.');
      return;
    }

    if (save) {
      writeConfig(projectRoot, {
        ...config,
        wordpressPull: {
          ...defaults,
          sshTarget,
          remoteRoot,
          liveUrl,
          localUrl,
          projectName,
        },
      });
    }

    rl?.close();
    run('Configuring DDEV', 'ddev', [
      'config',
      '--auto',
      '--project-type=wordpress',
      `--project-name=${projectName}`,
      '--docroot=.',
      `--php-version=${environment.phpVersion}`,
      `--database=${environment.databaseEngine}:${environment.databaseVersion}`,
    ]);

    const wpCommandTarget = path.join(projectRoot, '.ddev', 'commands', 'web', 'wp');
    mkdirSync(path.dirname(wpCommandTarget), { recursive: true });
    copyFileSync(
      path.join(import.meta.dirname, '..', 'templates', 'wordpress-project', 'ddev', 'commands', 'web', 'wp'),
      wpCommandTarget,
    );
    chmodSync(wpCommandTarget, 0o755);

    log.info('DDEV may ask for your local macOS administrator password.\nPassword characters remain invisible while you type.');
    run('Starting DDEV', 'ddev', ['start']);

    outro('DDEV setup complete.\nNext: with-scripts pull-wordpress');
  } finally {
    rl?.close();
  }
}

function projectNameFromUrl(localUrl) {
  return new URL(localUrl).hostname.split('.')[0];
}
