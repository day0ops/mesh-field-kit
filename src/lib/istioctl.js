import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { CommandRunner, Logger } from './common.js';

const ISTIOCTL_LOCAL_DIR = join(process.cwd(), '._istioctl_dir');
const ISTIOCTL_INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/solo-io/doc-examples/main/istio/install-istioctl.sh';

/**
 * Resolve, download, and run istioctl / solo-istioctl commands.
 */
export class IstioctlHelper {
  static #istioctlStandardPath() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return join(home, '.istioctl', 'bin', 'istioctl');
  }

  /**
   * Resolve istioctl binary: solo-istioctl in PATH, cached ~/.istioctl/bin/istioctl, or download.
   * @param {{ istioImage?: string }} [options]
   * @returns {Promise<string|null>}
   */
  static async resolve({ istioImage } = {}) {
    const r = await CommandRunner.exec('which solo-istioctl', { ignoreError: true });
    if (!r.exitCode && r.stdout?.trim()) return 'solo-istioctl';

    const standardPath = this.#istioctlStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) return standardPath;

    Logger.info('istioctl not found — downloading via Solo install script...');
    return await this.#downloadIstioctl(istioImage);
  }

  static async #downloadIstioctl(istioImage = '') {
    const scriptPath = join(ISTIOCTL_LOCAL_DIR, 'install-istioctl.sh');

    await CommandRunner.exec(`mkdir -p "${ISTIOCTL_LOCAL_DIR}"`, { ignoreError: true });

    const dlResult = await CommandRunner.exec(
      `curl -fsSL "${ISTIOCTL_INSTALL_SCRIPT_URL}" -o "${scriptPath}"`,
      { ignoreError: true }
    );
    if (dlResult.exitCode) {
      Logger.warn('Failed to download istioctl install script');
      return null;
    }

    await CommandRunner.exec(`chmod +x "${scriptPath}"`, { ignoreError: true });

    const runResult = await CommandRunner.exec(`ISTIO_IMAGE=${istioImage} sh "${scriptPath}"`, {
      ignoreError: true,
    });
    if (runResult.stderr?.trim()) {
      Logger.warn(`Install script: ${runResult.stderr.trim()}`);
    }

    const standardPath = this.#istioctlStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) {
      Logger.info(`Downloaded istioctl to ${standardPath}`);
      return standardPath;
    }

    Logger.warn('istioctl not found after download');
    return null;
  }

  /**
   * Generate and apply an east-west gateway via istioctl multicluster expose.
   */
  static async deployViaIstioctl(cluster, namespace, contextFlag) {
    Logger.info(`Running istioctl multicluster expose on ${cluster.name}...`);

    const generateResult = await CommandRunner.exec(
      `solo-istioctl multicluster expose --namespace ${namespace} ${contextFlag} --generate`,
      { ignoreError: true }
    );

    if (generateResult.exitCode || !generateResult.stdout) {
      Logger.warn('solo-istioctl not available, falling back to istioctl...');
      const istioctl = await this.resolve();
      if (!istioctl) {
        throw new Error(`Failed to resolve istioctl for east-west gateway on ${cluster.name}`);
      }
      const bin = istioctl.includes('/') ? `"${istioctl}"` : istioctl;
      const fallbackResult = await CommandRunner.exec(
        `${bin} multicluster expose --namespace ${namespace} ${contextFlag} --generate`,
        { ignoreError: true }
      );

      if (fallbackResult.exitCode || !fallbackResult.stdout) {
        throw new Error(`Failed to generate east-west gateway manifest for ${cluster.name}`);
      }

      generateResult.stdout = fallbackResult.stdout;
    }

    const tempFile = `/tmp/.mesh-ew-gateway-${cluster.name}-${process.pid}.yaml`;
    writeFileSync(tempFile, generateResult.stdout);

    try {
      const kubectlCtx = cluster.context ? `--context=${cluster.context}` : '';
      await CommandRunner.exec(`kubectl ${kubectlCtx} apply -f ${tempFile}`);
      Logger.info(`East-west gateway applied on ${cluster.name}`);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Run istioctl vm add-workload to add a single workload identity to a VM.
   *
   * The first call for a given VM's gateway (external + hostname) prints a
   * BOOTSTRAP_TOKEN needed to start ztunnel; later calls for additional
   * workloads on the same VM reuse the existing gateway and don't reprint it.
   *
   * @param {object} options
   * @param {string} options.name - Workload name
   * @param {string} options.address - VM IP address
   * @param {string} options.namespace - Kubernetes namespace for the workload
   * @param {string} options.ports - Port spec, e.g. 'http:80:8080' or 'http:80:8080/grpc:9090'
   * @param {boolean} [options.external] - Mark the workload external (creates the gateway)
   * @param {string} [options.hostname] - VM hostname (required with `external`)
   * @param {string} options.outputDir - Directory to write the workload token file to
   * @param {string} [options.context] - Kubernetes context
   * @param {string} [options.istioImage]
   * @returns {Promise<{bootstrapToken: string|null, tokenFile: string}>}
   */
  static async vmAddWorkload({
    name,
    address,
    namespace,
    ports,
    external = false,
    hostname = null,
    outputDir,
    context = null,
    istioImage,
  } = {}) {
    const istioctl = await this.resolve({ istioImage });
    if (!istioctl) {
      throw new Error(`Failed to resolve istioctl for vm add-workload '${name}'`);
    }

    const bin = istioctl.includes('/') ? `"${istioctl}"` : istioctl;
    const flags = [
      `--address ${address}`,
      `--namespace ${namespace}`,
      `--ports ${ports}`,
      `--output-dir ${outputDir}`,
    ];
    if (external) flags.push('--external');
    if (hostname) flags.push(`--hostname ${hostname}`);
    if (context) flags.push(`--context=${context}`);

    const result = await CommandRunner.exec(`${bin} vm add-workload ${name} ${flags.join(' ')}`, {
      ignoreError: true,
    });

    if (result.exitCode) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      throw new Error(
        `istioctl vm add-workload failed for '${name}' (exit ${result.exitCode}): ${output || '(no output)'}`
      );
    }

    const tokenMatch = result.stdout?.match(/BOOTSTRAP_TOKEN=(\S+)/);

    return {
      bootstrapToken: tokenMatch ? tokenMatch[1] : null,
      tokenFile: join(outputDir, `${name}.token`),
    };
  }

  /**
   * Run istioctl zc endpoints for a service in a cluster context.
   * @returns {Promise<string>} combined stdout/stderr output
   */
  static async zcEndpoints({
    service,
    serviceNamespace,
    hostname,
    context,
    istioImage,
    timeoutMs = 30000,
  }) {
    const istioctl = await this.resolve({ istioImage });
    if (!istioctl) {
      throw new Error('istioctl could not be resolved or downloaded');
    }

    const bin = istioctl.includes('/') ? `"${istioctl}"` : istioctl;
    const contextFlag = context ? ` --context=${context}` : '';
    // --service/--service-namespace only match the cluster-local Service; cross-cluster
    // "autogen" WorkloadEntries aggregated under a global mesh.internal ServiceEntry are
    // only matched by --hostname.
    const targetFlag = hostname
      ? `--hostname ${hostname}`
      : `--service ${service} --service-namespace ${serviceNamespace}`;
    const cmd = `${bin} zc endpoints ${targetFlag}${contextFlag}`;

    const result = await CommandRunner.exec(cmd, {
      ignoreError: true,
      timeout: timeoutMs,
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.exitCode) {
      throw new Error(
        `istioctl zc endpoints failed (exit ${result.exitCode}): ${output || '(no output)'}`
      );
    }
    return output;
  }
}
