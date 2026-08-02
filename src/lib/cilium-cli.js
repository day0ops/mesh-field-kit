import { join, dirname } from 'path';
import { CommandRunner, Logger } from './common.js';

const CILIUM_CLI_LOCAL_DIR = join(process.cwd(), '._cilium_cli_dir');
const CILIUM_CLI_STABLE_URL = 'https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt';
const CILIUM_CLI_RELEASE_BASE = 'https://github.com/cilium/cilium-cli/releases/download';

/**
 * Resolve and download the Cilium CLI.
 *
 * Used for `cilium uninstall`, which properly reverses Cilium's node-level
 * footprint (cilium_host/cilium_net veth pair, attached BPF programs/maps) —
 * a plain `helm uninstall`, even with `cni.uninstall=true` set first, can
 * leave these behind if the agent's pre-stop cleanup hook doesn't get a
 * chance to run cleanly, silently breaking whatever CNI replaces Cilium
 * later. Mirrors IstioctlHelper/GlooHelper's resolve-or-download pattern.
 */
export class CiliumCliHelper {
  static #ciliumStandardPath() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return join(home, '.cilium-cli', 'bin', 'cilium');
  }

  /**
   * Resolve the cilium binary: PATH, cached ~/.cilium-cli/bin/cilium, or download.
   * @param {{ spinner?: import('./common.js').SpinnerLogger }} [options]
   * @returns {Promise<string|null>}
   */
  static async resolve({ spinner } = {}) {
    const log = (msg, level = 'info') => (spinner ? spinner.log(msg, level) : Logger[level](msg));

    const r = await CommandRunner.exec('which cilium', { ignoreError: true });
    if (!r.exitCode && r.stdout?.trim()) return 'cilium';

    const standardPath = this.#ciliumStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) return standardPath;

    log('cilium CLI not found — downloading...');
    return await this.#downloadCilium(spinner);
  }

  static async #downloadCilium(spinner) {
    const log = (msg, level = 'info') => (spinner ? spinner.log(msg, level) : Logger[level](msg));

    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const archResult = await CommandRunner.exec('uname -m', { ignoreError: true });
    const rawArch = archResult.stdout?.trim() || '';
    const arch = rawArch === 'arm64' || rawArch === 'aarch64' ? 'arm64' : 'amd64';

    await CommandRunner.exec(`mkdir -p "${CILIUM_CLI_LOCAL_DIR}"`, { ignoreError: true });

    const versionResult = await CommandRunner.exec(`curl -fsSL "${CILIUM_CLI_STABLE_URL}"`, {
      ignoreError: true,
    });
    const version = versionResult.stdout?.trim();
    if (versionResult.exitCode || !version) {
      log('Failed to resolve latest cilium-cli version', 'warn');
      return null;
    }

    const tarballName = `cilium-${platform}-${arch}.tar.gz`;
    const tarballPath = join(CILIUM_CLI_LOCAL_DIR, tarballName);
    const dlResult = await CommandRunner.exec(
      `curl -fsSL "${CILIUM_CLI_RELEASE_BASE}/${version}/${tarballName}" -o "${tarballPath}"`,
      { ignoreError: true }
    );
    if (dlResult.exitCode) {
      log('Failed to download cilium-cli release tarball', 'warn');
      return null;
    }

    const standardPath = this.#ciliumStandardPath();
    const standardDir = dirname(standardPath);
    await CommandRunner.exec(`mkdir -p "${standardDir}"`, { ignoreError: true });

    const extractResult = await CommandRunner.exec(`tar xzf "${tarballPath}" -C "${standardDir}"`, {
      ignoreError: true,
    });
    if (extractResult.exitCode) {
      log('Failed to extract cilium-cli release tarball', 'warn');
      return null;
    }
    await CommandRunner.exec(`chmod +x "${standardPath}"`, { ignoreError: true });

    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) {
      log(`Downloaded cilium CLI to ${standardPath}`);
      return standardPath;
    }

    log('cilium CLI not found after download', 'warn');
    return null;
  }
}
