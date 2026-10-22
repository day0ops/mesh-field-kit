import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHART_DIR = join(__dirname, 'config', 'chart');

/**
 * Redpanda Feature
 *
 * Installs a single-node, dev-mode Redpanda broker (Kafka-API compatible)
 * from a bundled local Helm chart - no remote chart repository, since this
 * is intentionally a lightweight dev/demo broker, not a production cluster.
 *
 * Reference: Acme Bank's own deploy/helm/redpanda, which this chart was
 * copied and adapted from (parameterized the advertised address by release
 * namespace instead of hardcoding one).
 *
 * Configuration:
 * {
 *   redpandaNamespace: string,  // Default: 'redpanda'
 *   kubeContext: string         // Optional: target cluster context
 * }
 */
export class RedpandaFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.redpandaNamespace = config.redpandaNamespace || config.namespace || 'redpanda';
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Installing Redpanda...', 'info');

    await KubernetesHelper.ensureNamespace(this.redpandaNamespace, this.spinner, this.kubeContext);
    this.log(`Namespace '${this.redpandaNamespace}' ready`, 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      'redpanda',
      CHART_DIR,
      '-n',
      this.redpandaNamespace,
      '--wait',
      '--timeout',
      '5m',
    ];
    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });

    this.log('Redpanda installed successfully', 'success');
  }

  async cleanup() {
    this.log('Cleaning up Redpanda...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    try {
      await CommandRunner.run('helm', ['uninstall', 'redpanda', '-n', this.redpandaNamespace, ...helmCtxArgs]);
      this.log('Redpanda Helm chart uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }
  }
}
