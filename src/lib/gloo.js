import { join } from 'path';
import { CommandRunner, Logger } from './common.js';

const GLOO_LOCAL_DIR = join(process.cwd(), '._gloo_dir');
const GLOO_INSTALL_SCRIPT_URL = 'https://storage.googleapis.com/gloo-cli/install.sh';

/**
 * Resolve and download the Solo `gloo` CLI (used for `gloo ambient migrate`).
 * Mirrors IstioctlHelper's resolve-or-download pattern in istioctl.js.
 */
export class GlooHelper {
  static #glooStandardPath() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return join(home, '.gloo', 'bin', 'gloo');
  }

  /**
   * Resolve the gloo binary: PATH, cached ~/.gloo/bin/gloo, or download.
   * @param {{ spinner?: import('./common.js').SpinnerLogger }} [options] - pass the
   *   caller's spinner so status messages don't collide with its progress line.
   * @returns {Promise<string|null>}
   */
  static async resolve({ spinner } = {}) {
    const log = (msg, level = 'info') => (spinner ? spinner.log(msg, level) : Logger[level](msg));

    const r = await CommandRunner.exec('which gloo', { ignoreError: true });
    if (!r.exitCode && r.stdout?.trim()) return 'gloo';

    const standardPath = this.#glooStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) return standardPath;

    log('gloo CLI not found — downloading via Solo install script...');
    return await this.#downloadGloo(spinner);
  }

  static async #downloadGloo(spinner) {
    const log = (msg, level = 'info') => (spinner ? spinner.log(msg, level) : Logger[level](msg));
    const scriptPath = join(GLOO_LOCAL_DIR, 'install-gloo.sh');

    await CommandRunner.exec(`mkdir -p "${GLOO_LOCAL_DIR}"`, { ignoreError: true });

    const dlResult = await CommandRunner.exec(
      `curl -fsSL "${GLOO_INSTALL_SCRIPT_URL}" -o "${scriptPath}"`,
      { ignoreError: true }
    );
    if (dlResult.exitCode) {
      log('Failed to download gloo install script', 'warn');
      return null;
    }

    await CommandRunner.exec(`chmod +x "${scriptPath}"`, { ignoreError: true });

    const runResult = await CommandRunner.exec(`sh "${scriptPath}"`, { ignoreError: true });
    if (runResult.stderr?.trim()) {
      log(`Install script: ${runResult.stderr.trim()}`, 'warn');
    }

    const standardPath = this.#glooStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) {
      log(`Downloaded gloo to ${standardPath}`);
      return standardPath;
    }

    log('gloo CLI not found after download', 'warn');
    return null;
  }
}
