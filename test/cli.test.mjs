import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readConfig,
  run,
  runCapture,
  runToFile,
} from '../src/cli.mjs';

test('commands can report a concise stage-specific error', () => {
  assert.throws(
    () => run(
      'Starting DDEV',
      process.execPath,
      ['-e', 'process.exit(1)'],
      {
        stdout: 'ignore',
        errorMessage: 'DDEV could not be started. Local files and database were not replaced.',
      },
    ),
    { message: 'DDEV could not be started. Local files and database were not replaced.' },
  );
});

test('captured commands can report a concise stage-specific error', () => {
  assert.throws(
    () => runCapture(
      'Checking production',
      process.execPath,
      ['-e', 'process.exit(1)'],
      '',
      false,
      { errorMessage: 'Production preflight failed.' },
    ),
    { message: 'Production preflight failed.' },
  );
});

test('download progress follows real bytes and removes stalled files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const completed = path.join(root, 'completed.bin');
  const stalled = path.join(root, 'stalled.bin');
  try {
    await runToFile(
      'Test download',
      process.execPath,
      ['-e', 'process.stdout.write("real bytes")'],
      '',
      completed,
      { intervalMs: 10, idleTimeoutMs: 500 },
    );
    assert.equal(readFileSync(completed, 'utf8'), 'real bytes');

    await assert.rejects(
      runToFile(
        'Test stalled download',
        process.execPath,
        ['-e', 'setTimeout(() => {}, 1000)'],
        '',
        stalled,
        {
          intervalMs: 10,
          idleTimeoutMs: 50,
          idleError: 'Production file download stalled. Check the SSH connection and try again.',
        },
      ),
      { message: 'Production file download stalled. Check the SSH connection and try again.' },
    );
    assert.equal(existsSync(stalled), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed downloads can report a concise stage-specific error', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const destination = path.join(root, 'database.sql.gz');
  const message = 'Production database download failed. Check SSH and database access.';
  try {
    await assert.rejects(
      runToFile(
        'Downloading production database',
        process.execPath,
        ['-e', 'process.exit(1)'],
        '',
        destination,
        { errorMessage: message },
      ),
      { message },
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changed files during a download get a clear retryable error', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  const destination = path.join(root, 'files.tar.gz');
  const message = 'Production files changed during download. Please run the pull again.\nLocal files and database were not replaced.';
  try {
    await assert.rejects(
      runToFile(
        'Downloading production files',
        process.execPath,
        [
          '-e',
          'process.stderr.write("tar: ./wp-content: file changed as we read it\\n"); process.exit(1)',
        ],
        '',
        destination,
        { changedFileError: message },
      ),
      { message },
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid saved settings get an actionable error', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-test-'));
  try {
    writeFileSync(path.join(root, '.with-scripts.json'), '{');
    assert.throws(
      () => readConfig(root),
      { message: 'Invalid .with-scripts.json. Fix or remove the file before continuing.' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
