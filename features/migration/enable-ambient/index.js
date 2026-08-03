import { AddonFeature } from '../../../src/lib/feature.js';
import { KubernetesHelper } from '../../../src/lib/common.js';
import { ConfigResolver } from '../../../src/lib/config-resolver.js';

/**
 * Upgrades an already-installed sidecar-only Istio control plane to
 * ambient-capable, without touching existing sidecar-injected workloads
 * (relies on the Solo distribution's sidecar/ambient interop support).
 *
 * Mirrors Solo's documented "Enabling ambient mode" steps exactly:
 * https://docs.solo.io/istio/1.30.x/ambient/setup/install/migrate/#enabling-ambient-mode
 *
 * istio-base and istiod are pre-existing releases (installed by a sidecar
 * profile), so they're upgraded with --reuse-values — this carries forward
 * hub/tag/license automatically and only layers `profile=ambient` on top.
 * istio-cni and ztunnel are new installs and need the version/repo explicitly.
 *
 * Configuration:
 * {
 *   namespace: string,      // default: 'istio-system'
 *   istioVersion: string,   // required — must match the running sidecar install
 *   istioRevision: string,  // default: 'default' — must match the sidecar profile's
 *                           // mesh.istioRevision, or ztunnel/cni end up pointed at
 *                           // the wrong istiod service name (e.g. istiod-stable)
 *   istioRepo: string,      // default: 'us-docker.pkg.dev/soloio-img/istio'
 *   helmIstioRepo: string,  // default: 'us-docker.pkg.dev/soloio-img/istio-helm'
 *   kubeContext: string,
 * }
 */
export class EnableAmbientFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.namespace = config.namespace || 'istio-system';
    this.istioVersion = config.istioVersion || null;
    this.istioRevision = config.istioRevision || 'default';
    this.istioRepo = config.istioRepo || 'us-docker.pkg.dev/soloio-img/istio';
    this.helmIstioRepo = config.helmIstioRepo || 'us-docker.pkg.dev/soloio-img/istio-helm';
    this.istioImage = this.istioVersion
      ? this.istioVersion.endsWith('-solo')
        ? this.istioVersion
        : `${this.istioVersion}-solo`
      : null;
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (!this.istioVersion) {
      throw new Error(
        'enable-ambient requires istioVersion (must match the running sidecar install)'
      );
    }
    return true;
  }

  #ctxArgs() {
    return this.kubeContext ? ['--kube-context', this.kubeContext] : [];
  }

  async deploy() {
    const ctxArgs = this.#ctxArgs();

    this.log('Upgrading istio-base to the ambient profile...', 'info');
    await KubernetesHelper.helm(
      [
        ...ctxArgs,
        'upgrade',
        'istio-base',
        `oci://${this.helmIstioRepo}/base`,
        '-n',
        this.namespace,
        '--version',
        this.istioImage,
        '--reuse-values',
        '--set',
        'profile=ambient',
        '--wait',
      ],
      { spinner: this.spinner }
    );

    this.log('Upgrading istiod to the ambient profile...', 'info');
    await KubernetesHelper.helm(
      [
        ...ctxArgs,
        'upgrade',
        'istiod',
        `oci://${this.helmIstioRepo}/istiod`,
        '-n',
        this.namespace,
        '--version',
        this.istioImage,
        '--reuse-values',
        '--set',
        'profile=ambient',
        '--wait',
      ],
      { spinner: this.spinner }
    );

    const revision = ConfigResolver.chartRevision(this.istioRevision);

    this.log('Installing istio-cni (ambient)...', 'info');
    await KubernetesHelper.helm(
      [
        ...ctxArgs,
        'upgrade',
        '--install',
        'istio-cni',
        `oci://${this.helmIstioRepo}/cni`,
        '-n',
        this.namespace,
        '--version',
        this.istioImage,
        '--set',
        `revision=${revision}`,
        '--set',
        'profile=ambient',
        '--set',
        'ambient.dnsCapture=true',
        '--set',
        `global.hub=${this.istioRepo}`,
        '--set',
        `global.tag=${this.istioImage}`,
        '--set',
        `excludeNamespaces[0]=${this.namespace}`,
        '--set',
        'excludeNamespaces[1]=kube-system',
        '--wait',
      ],
      { spinner: this.spinner }
    );

    this.log('Installing ztunnel...', 'info');
    await KubernetesHelper.helm(
      [
        ...ctxArgs,
        'install',
        'ztunnel',
        `oci://${this.helmIstioRepo}/ztunnel`,
        '-n',
        this.namespace,
        '--version',
        this.istioImage,
        '--set',
        `revision=${revision}`,
        '--set',
        `hub=${this.istioRepo}`,
        '--set',
        `tag=${this.istioImage}`,
        '--set',
        'profile=ambient',
        '--set',
        `istioNamespace=${this.namespace}`,
        '--set',
        `namespace=${this.namespace}`,
        '--set',
        'enabled=true',
        '--set',
        'configValidation=true',
        '--set',
        'env.L7_ENABLED=true',
        '--set',
        'proxy.clusterDomain=cluster.local',
        '--set',
        'terminationGracePeriodSeconds=29',
        '--set',
        'variant=distroless',
        '--wait',
      ],
      { spinner: this.spinner }
    );

    this.log(
      'Cluster is now ambient-capable — existing sidecar workloads keep running via interop',
      'success'
    );
  }

  async cleanup() {
    const ctxArgs = this.#ctxArgs();

    this.log('Removing ztunnel...', 'info');
    try {
      await KubernetesHelper.helm([...ctxArgs, 'uninstall', 'ztunnel', '-n', this.namespace], {
        spinner: this.spinner,
      });
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    this.log('Removing istio-cni...', 'info');
    try {
      await KubernetesHelper.helm([...ctxArgs, 'uninstall', 'istio-cni', '-n', this.namespace], {
        spinner: this.spinner,
      });
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    this.log(
      'ztunnel and istio-cni removed — istiod/base left ambient-capable (sidecar workloads unaffected)',
      'success'
    );
  }
}
