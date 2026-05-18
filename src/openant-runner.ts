/**
 * OpenAnt runner.
 * Executes `openant parse` against a repository and returns the path to the generated dataset.json.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, access, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logProgress, logDebug } from './logging.js';
import { ERROR_CODES, formatError } from './error-codes.js';

const TAG = 'openant';

/**
 * Get the openant binary name for the current platform.
 */
function getOpenAntBinary(): string {
  return process.platform === 'win32' ? 'openant.exe' : 'openant';
}

/**
 * Verify that OpenAnt is installed and available on PATH.
 * Resolves if found, rejects with a user-friendly error if not.
 * Skips the check when AGHAST_OPENANT_DATASET is set (the dataset is
 * supplied directly, so there is no need to invoke OpenAnt).
 *
 * Internal testing affordance: AGHAST_TESTING_OPENANT_UNAVAILABLE=true
 * forces this check to fail, letting tests exercise the depth-0 fallback
 * path deterministically on machines where OpenAnt happens to be installed.
 * Not part of the public API.
 */
export async function verifyOpenAntInstalled(): Promise<void> {
  if (process.env.AGHAST_OPENANT_DATASET) return;
  if (process.env.AGHAST_TESTING_OPENANT_UNAVAILABLE === 'true') {
    throw new Error(
      formatError(ERROR_CODES.E6001, 'OpenAnt is unavailable (forced by AGHAST_TESTING_OPENANT_UNAVAILABLE).'),
    );
  }
  const binary = getOpenAntBinary();
  return new Promise((resolve, reject) => {
    execFile(binary, ['--help'], (error) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          formatError(ERROR_CODES.E6001, 'OpenAnt is required for the configured checks but was not found. Install it from https://github.com/knostic/OpenAnt/'),
        ));
        return;
      }
      resolve();
    });
  });
}

/**
 * Execute `openant parse` and return the path to the generated dataset.json.
 * If AGHAST_OPENANT_DATASET env var is set, uses that file instead of invoking
 * OpenAnt. Useful in CI pipelines that cache the dataset across runs, in
 * environments without Python 3.11+, or for tests that stub the OpenAnt output.
 *
 * The caller is responsible for cleaning up the returned temp directory via
 * the cleanup function returned alongside the dataset path.
 */
export async function runOpenAnt(
  repositoryPath: string,
): Promise<{ datasetPath: string; cleanup: () => Promise<void> }> {
  const preloadedDataset = process.env.AGHAST_OPENANT_DATASET;
  if (preloadedDataset) {
    logDebug(TAG, `Using preloaded dataset from ${preloadedDataset}`);
    // Copy to temp dir so cleanup logic is consistent
    const tmpDir = await mkdtemp(join(tmpdir(), 'aghast-openant-preloaded-'));
    const datasetPath = join(tmpDir, 'dataset.json');
    await copyFile(preloadedDataset, datasetPath);
    return {
      datasetPath,
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
          logDebug(TAG, `Failed to clean up temp directory ${tmpDir}: ${err}`);
        });
      },
    };
  }

  logProgress(TAG, 'Running OpenAnt parse...');

  const tmpDir = await mkdtemp(join(tmpdir(), 'aghast-openant-'));
  const binary = getOpenAntBinary();
  const args = ['parse', repositoryPath, '--output', tmpDir, '--language', 'auto', '--quiet'];

  logDebug(TAG, `Command: ${binary} ${args.join(' ')}`);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        binary,
        args,
        { timeout: 600_000 }, // 10 minute timeout
        (error, _stdout, stderr) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(new Error(
                formatError(ERROR_CODES.E6001, 'OpenAnt not found. Install it from https://github.com/knostic/OpenAnt/'),
              ));
              return;
            }
            reject(new Error(
              formatError(ERROR_CODES.E6002, `OpenAnt execution failed${stderr?.trim() ? `: ${stderr.trim()}` : ''}`),
            ));
            return;
          }
          resolve();
        },
      );
    });

    const datasetPath = join(tmpDir, 'dataset.json');
    const exists = await access(datasetPath).then(() => true, () => false);
    if (!exists) {
      throw new Error(formatError(ERROR_CODES.E6002, `OpenAnt did not produce dataset.json in ${tmpDir}`));
    }

    logDebug(TAG, `Dataset generated: ${datasetPath}`);

    return {
      datasetPath,
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
          logDebug(TAG, `Failed to clean up temp directory ${tmpDir}: ${err}`);
        });
      },
    };
  } catch (err) {
    // Clean up on error
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
