import { Feature } from '../../../src/lib/feature.js';

/**
 * Network Policy Feature
 *
 * Deploys a plain Kubernetes NetworkPolicy (networking.k8s.io/v1) - CNI-level
 * L3/L4 enforcement, independent of Istio's own AuthorizationPolicy. Useful for
 * testing that a NetworkPolicy-enforcing CNI (e.g. Cilium in chaining mode)
 * still works correctly alongside ambient/sidecar dataplanes.
 *
 * Configuration:
 * {
 *   policyName: string,          // Required: NetworkPolicy name
 *   namespace: string,           // Required: Namespace
 *   policyTypes: string[],       // Required: ['Ingress'] | ['Egress'] | ['Ingress', 'Egress']
 *   podSelector: object,         // Optional: pod selector (default: {} - all pods in namespace)
 *   ingress: array,              // Optional: ingress rules
 *   egress: array,               // Optional: egress rules
 * }
 */
export class NetworkPolicyFeature extends Feature {
  validate() {
    if (!this.config.policyName) {
      throw new Error('policyName is required for NetworkPolicy feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for NetworkPolicy feature');
    }
    if (!this.config.policyTypes) {
      throw new Error('policyTypes is required for NetworkPolicy feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const policyName = this.config.policyName;
    const policyTypes = this.config.policyTypes;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying NetworkPolicy feature: ${policyName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Policy types: ${policyTypes.join(', ')}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const spec = {
      podSelector: this.config.podSelector || {},
      policyTypes,
    };

    if (this.config.ingress) {
      spec.ingress = this.config.ingress;
    }
    if (this.config.egress) {
      spec.egress = this.config.egress;
    }

    const policy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: namespace,
      },
      spec: spec,
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying NetworkPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.applyResource(policy, context);
    }
  }

  async cleanup() {
    const policyName = this.config.policyName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up NetworkPolicy feature: ${policyName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting NetworkPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.deleteResource('networkpolicy', policyName, namespace, context);
    }
  }
}

export function createNetworkPolicyFeature(config) {
  return new NetworkPolicyFeature('network-policy', config);
}
