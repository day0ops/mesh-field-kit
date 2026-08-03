import { Feature } from '../../../src/lib/feature.js';

/**
 * EnvoyFilter Feature
 *
 * Deploys a raw EnvoyFilter resource for low-level proxy customization
 * (header injection, protocol transcoding, HCM field patches like
 * forward_client_cert_details, traffic normalization, etc.) that no
 * higher-level Istio API covers.
 *
 * Prefer targetRefs over workloadSelector when the target is a waypoint —
 * workloadSelector matches pod labels and predates Gateway API waypoints,
 * so its SIDECAR_INBOUND/SIDECAR_OUTBOUND contexts don't apply to them.
 * Waypoints use targetRefs pointing at the Gateway resource, and patches
 * matching context: GATEWAY.
 *
 * Configuration:
 * {
 *   filterName: string,       // Required: EnvoyFilter name
 *   namespace: string,        // Required: Namespace
 *   targetRefs: array,        // Either this or workloadSelector is required:
 *                             //   [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: string }]
 *   workloadSelector: object, // { labels: {...} } — legacy pod-selector targeting
 *   configPatches: array,     // Required: raw EnvoyFilter spec.configPatches
 * }
 */
export class EnvoyFilterFeature extends Feature {
  validate() {
    if (!this.config.filterName) {
      throw new Error('filterName is required for EnvoyFilter feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for EnvoyFilter feature');
    }
    if (!this.config.targetRefs && !this.config.workloadSelector) {
      throw new Error('EnvoyFilter feature requires either targetRefs or workloadSelector');
    }
    if (!this.config.configPatches || !this.config.configPatches.length) {
      throw new Error('configPatches is required for EnvoyFilter feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const filterName = this.config.filterName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying EnvoyFilter feature: ${filterName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const spec = {
      ...(this.config.targetRefs ? { targetRefs: this.config.targetRefs } : {}),
      ...(this.config.workloadSelector ? { workloadSelector: this.config.workloadSelector } : {}),
      configPatches: this.config.configPatches,
    };

    const envoyFilter = {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'EnvoyFilter',
      metadata: {
        name: filterName,
        namespace: namespace,
      },
      spec: spec,
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying EnvoyFilter: ${filterName}${contextInfo}...`, 'info');
      await this.applyResource(envoyFilter, context);
    }
  }

  async cleanup() {
    const filterName = this.config.filterName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up EnvoyFilter feature: ${filterName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting EnvoyFilter: ${filterName}${contextInfo}...`, 'info');
      await this.deleteResource('envoyfilter', filterName, namespace, context);
    }
  }
}

export function createEnvoyFilterFeature(config) {
  return new EnvoyFilterFeature('envoy-filter', config);
}
