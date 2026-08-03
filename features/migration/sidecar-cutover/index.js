import { Feature } from '../../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../../src/lib/common.js';

/**
 * Performs the Phase 5 (enable waypoint) and Phase 7 (sidecar removal) actions
 * from Solo's sidecar-to-ambient migration guide for a single namespace:
 * enables the namespace's waypoint, flips it from classic sidecar injection
 * to ambient dataplane mode, and restarts its Deployments so running pods
 * actually drop their sidecar container (labeling alone only affects pods
 * created after the label change).
 *
 * Reference: https://docs.solo.io/istio/1.30.x/ambient/setup/install/migrate/#waypoint-enable
 *
 * Configuration:
 * {
 *   namespace: string,      // required — the namespace being cut over
 *   waypointName: string,   // optional — enables istio.io/use-waypoint if set
 *   kubeContext: string,    // optional
 * }
 */
export class SidecarCutoverFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.waypointName = config.waypointName || null;
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (!this.namespace) {
      throw new Error('sidecar-cutover requires a namespace');
    }
    return true;
  }

  #ctxArgs() {
    return this.kubeContext ? ['--context', this.kubeContext] : [];
  }

  async #restartWorkloads() {
    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const result = await CommandRunner.exec(
      `kubectl ${ctxFlag} get deployments -n ${this.namespace} -o name`,
      { ignoreError: true }
    );
    const deployments = (result.stdout || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    for (const dep of deployments) {
      this.log(`Restarting ${dep} to pick up the new dataplane mode...`, 'info');
      await CommandRunner.exec(`kubectl ${ctxFlag} -n ${this.namespace} rollout restart ${dep}`);
      await CommandRunner.exec(
        `kubectl ${ctxFlag} -n ${this.namespace} rollout status ${dep} --timeout=120s`
      );
    }
  }

  async deploy() {
    if (this.waypointName) {
      this.log(
        `Enabling waypoint '${this.waypointName}' for namespace '${this.namespace}'...`,
        'info'
      );
      await KubernetesHelper.kubectl(
        [
          ...this.#ctxArgs(),
          'label',
          'namespace',
          this.namespace,
          `istio.io/use-waypoint=${this.waypointName}`,
          '--overwrite',
        ],
        { spinner: this.spinner }
      );
    }

    this.log(`Cutting over namespace '${this.namespace}' from sidecar to ambient...`, 'info');
    await KubernetesHelper.labelNamespaceForDataplaneMode(
      this.namespace,
      'ambient',
      this.kubeContext,
      { spinner: this.spinner }
    );

    await this.#restartWorkloads();
    this.log(`Namespace '${this.namespace}' is now running ambient-only`, 'success');
  }

  async cleanup() {
    this.log(`Reverting namespace '${this.namespace}' to sidecar mode...`, 'info');
    await KubernetesHelper.labelNamespaceForDataplaneMode(
      this.namespace,
      'sidecar',
      this.kubeContext,
      { spinner: this.spinner }
    );

    if (this.waypointName) {
      await KubernetesHelper.kubectl(
        [
          ...this.#ctxArgs(),
          'label',
          'namespace',
          this.namespace,
          'istio.io/use-waypoint-',
          '--overwrite',
        ],
        { spinner: this.spinner, ignoreError: true }
      );
    }

    await this.#restartWorkloads();
  }
}
