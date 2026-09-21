import { AddonFeature } from '../../src/lib/feature.js';
import { CommandRunner } from '../../src/lib/common.js';

const DEFAULT_NAMESPACE = 'kube-system';
const DEFAULT_SCC = 'privileged';
// The Cluster Network Operator can take several minutes to roll ovnkube-node
// out across every node after a gatewayConfig change - generous timeout for
// real clusters, not just a fast local test.
const NETWORK_ROLLOUT_TIMEOUT_SEC = 600;
// Give the operator a moment to notice the patch and flip Progressing=true
// before we start waiting for Progressing=false - otherwise `oc wait` can
// return immediately on the pre-patch state before reconciliation even starts.
const NETWORK_ROLLOUT_SETTLE_MS = 15000;

/**
 * OpenShift/ROSA ambient prerequisites that need cluster-admin, run as a
 * 'pre' phase addon before Helm installs any mesh component:
 *
 * 1. Grants a SecurityContextConstraint to every ServiceAccount in a
 *    namespace (default kube-system) - required for istio-cni/ztunnel's
 *    node agents, which need NET_ADMIN and run as super-privileged
 *    containers. Binds by namespace group (system:serviceaccounts:<namespace>)
 *    rather than named ServiceAccounts, since this runs before Helm creates
 *    those ServiceAccounts - binding a named SA that doesn't exist yet fails,
 *    and pre-creating it by hand risks Helm's own install refusing to adopt
 *    a pre-existing, unmanaged object of the same name.
 * 2. Enables OVN-Kubernetes local gateway mode (routingViaHost: true) on the
 *    cluster-wide Network.operator.openshift.io CR - required so kubelet
 *    liveness/readiness probe traffic reaches pods directly via the host
 *    instead of being pulled into ztunnel's ambient datapath, where it's
 *    dropped (ztunnel is designed to never see probe traffic). Without this,
 *    ambient workloads can fail health checks despite actually being healthy.
 *    Documented as a required OpenShift ambient prerequisite by both
 *    upstream Istio and Red Hat's own OSSM3 release notes.
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

    await this.#enableRoutingViaHost(ctxArgs);
  }

  async #enableRoutingViaHost(ctxArgs) {
    this.log('Enabling OVN-Kubernetes local gateway mode (routingViaHost)...', 'info');
    await CommandRunner.run('oc', [
      ...ctxArgs,
      'patch',
      'networks.operator.openshift.io',
      'cluster',
      '--type=merge',
      '-p',
      '{"spec":{"defaultNetwork":{"ovnKubernetesConfig":{"gatewayConfig":{"routingViaHost":true}}}}}',
    ]);

    this.log('Waiting for the network ClusterOperator to finish rolling out...', 'info');
    await new Promise(resolve => setTimeout(resolve, NETWORK_ROLLOUT_SETTLE_MS));
    await CommandRunner.run('oc', [
      ...ctxArgs,
      'wait',
      'clusteroperator/network',
      '--for=condition=Progressing=false',
      `--timeout=${NETWORK_ROLLOUT_TIMEOUT_SEC}s`,
    ]);
    this.log('routingViaHost enabled and network ClusterOperator stable', 'success');
  }

  async cleanup() {
    // Deliberately does not revert routingViaHost: it's a cluster-wide OVN-Kubernetes
    // setting with no reason to toggle back on mesh uninstall - doing so would trigger
    // another disruptive ovnkube-node rollout for no benefit, and the fix it provides
    // (correct probe routing) has no downside to leaving in place permanently.
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
