import process from 'node:process';
import { note, outro } from '@clack/prompts';
import {
  askRequired,
  askYesNo,
  createPrompts,
  readConfig,
  runCapture,
  writeConfig,
} from './cli.mjs';
import {
  buildInspectionScript,
  sshArgs,
  validateRemoteInput,
} from './remote-wordpress.mjs';

export async function inspectWordPress() {
  const projectRoot = process.cwd();
  const config = readConfig(projectRoot);
  const defaults = config.wordpressPull || {};
  const rl = createPrompts();

  try {
    note(`Project: ${projectRoot}\nRead-only inspection of the remote WordPress site.`, 'Inspect WordPress');

    const sshTarget = await askRequired(rl, 'SSH target', defaults.sshTarget);
    const remoteRoot = await askRequired(rl, 'Remote WordPress root', defaults.remoteRoot);
    validateRemoteInput(sshTarget, remoteRoot);
    const save = await askYesNo(rl, 'Save these settings?', true);
    rl?.close();

    runCapture(
      'Inspecting production',
      'ssh',
      sshArgs(sshTarget, remoteRoot),
      buildInspectionScript(),
      true,
    );

    if (save) {
      writeConfig(projectRoot, {
        ...config,
        wordpressPull: { ...defaults, sshTarget, remoteRoot },
      });
    }

    outro('Inspection complete. Production was not changed.');
  } finally {
    rl?.close();
  }
}
