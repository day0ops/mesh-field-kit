import { AddonFeature } from '../../src/lib/feature.js';
import { CommandRunner } from '../../src/lib/common.js';

const DEFAULT_NAMESPACE = 'kube-system';
const DEFAULT_SCC = 'privileged';

/**
 * Grants an OpenShift SecurityContextConstraint to every ServiceAccount in a
 * namespace (default kube-system) - required for Istio ambient's istio-cni/
 * ztunnel node agents on ROSA/OpenShift, which need NET_ADMIN and run as
 * super-privileged containers. Binds by namespace group
 * (system:serviceaccounts:<namespace>) rather than named ServiceAccounts,
 * since this runs as a 'pre' phase addon before Helm creates those
 * ServiceAccounts - binding a named SA that doesn't exist yet fails, and
 * pre-creating it by hand risks Helm's own install refusing to adopt a
 * pre-existing, unmanaged object of the same name.
 */
export class OpenshiftSccFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.sccNamespace = config.namespace || DEFAULT_NAMESPACE;
    this.scc = config.scc || DEFAULT_SCC;
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log(`Granting ${this.scc} SCC to service accounts in ${this.sccNamespace}...`, 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await CommandRunner.run('oc', [
      ...ctxArgs,
      'adm',
      'policy',
      'add-scc-to-group',
      this.scc,
      `system:serviceaccounts:${this.sccNamespace}`,
    ]);
    this.log(`${this.scc} SCC granted to system:serviceaccounts:${this.sccNamespace}`, 'success');
  }

  async cleanup() {
    this.log(`Removing ${this.scc} SCC from service accounts in ${this.sccNamespace}...`, 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    try {
      await CommandRunner.run('oc', [
        ...ctxArgs,
        'adm',
        'policy',
        'remove-scc-from-group',
        this.scc,
        `system:serviceaccounts:${this.sccNamespace}`,
      ]);
      this.log(
        `${this.scc} SCC removed from system:serviceaccounts:${this.sccNamespace}`,
        'success'
      );
    } catch (error) {
      if (!/not found/i.test(error.message)) throw error;
    }
  }
}
