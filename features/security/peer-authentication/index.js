import { Feature } from '../../../src/lib/feature.js';

/**
 * Peer Authentication Feature
 *
 * Deploys a PeerAuthentication (security.istio.io/v1) resource - controls the
 * mTLS mode ztunnel enforces for inbound connections (PERMISSIVE accepts both
 * plaintext and mTLS, STRICT rejects plaintext). DISABLE is not supported in
 * ambient mesh.
 *
 * Configuration:
 * {
 *   policyName: string,          // Required: PeerAuthentication name
 *   namespace: string,           // Required: Namespace
 *   mtls: {                      // Required: mesh-wide/namespace mTLS mode
 *     mode: string,              // PERMISSIVE|STRICT
 *   },
 *   selector: object,            // Optional: workload selector (default: applies to whole namespace)
 *   portLevelMtls: object,       // Optional: per-port mTLS mode overrides
 * }
 */
export class PeerAuthenticationFeature extends Feature {
  validate() {
    if (!this.config.policyName) {
      throw new Error('policyName is required for PeerAuthentication feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for PeerAuthentication feature');
    }
    if (!this.config.mtls?.mode) {
      throw new Error('mtls.mode is required for PeerAuthentication feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const policyName = this.config.policyName;
    const mode = this.config.mtls.mode;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying PeerAuthentication feature: ${policyName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  mTLS mode: ${mode}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const spec = {
      mtls: { mode },
    };

    if (this.config.selector) {
      spec.selector = this.config.selector;
    }
    if (this.config.portLevelMtls) {
      spec.portLevelMtls = this.config.portLevelMtls;
    }

    const policy = {
      apiVersion: 'security.istio.io/v1',
      kind: 'PeerAuthentication',
      metadata: {
        name: policyName,
        namespace: namespace,
      },
      spec: spec,
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying PeerAuthentication: ${policyName}${contextInfo}...`, 'info');
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

    this.log(`Cleaning up PeerAuthentication feature: ${policyName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting PeerAuthentication: ${policyName}${contextInfo}...`, 'info');
      await this.deleteResource('peerauthentication', policyName, namespace, context);
    }
  }
}

export function createPeerAuthenticationFeature(config) {
  return new PeerAuthenticationFeature('peer-authentication', config);
}
