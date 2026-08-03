import { Feature } from '../../../src/lib/feature.js';

/**
 * gRPC Routing Feature
 *
 * Deploys a GRPCRoute for method-based request routing to a gRPC backend.
 *
 * Configuration:
 * {
 *   routeName: string,            // Required: GRPCRoute name
 *   namespace: string,            // Required: Namespace
 *   parentRefs: array,            // Optional: Parent references (if not provided, uses gatewayName/gatewayNamespace)
 *   gatewayName: string,          // Optional: Parent Gateway name (required if parentRefs not provided)
 *   gatewayNamespace: string,     // Optional: Gateway namespace (defaults to route namespace)
 *   hostname: string,             // Optional: Hostname for the route
 *   rules: array,                 // Required: GRPCRoute rules (matches on service/method, backendRefs)
 * }
 */
export class GrpcRoutingFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for GrpcRouting feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for GrpcRouting feature');
    }
    if (!this.config.parentRefs && !this.config.gatewayName) {
      throw new Error('Either parentRefs or gatewayName is required for GrpcRouting feature');
    }
    if (!this.config.rules || this.config.rules.length === 0) {
      throw new Error('rules is required for GrpcRouting feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying GrpcRouting feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    let parentRefs;
    if (this.config.parentRefs) {
      parentRefs = this.config.parentRefs;
    } else {
      const gatewayNamespace = this.config.gatewayNamespace || namespace;
      parentRefs = [
        {
          name: this.config.gatewayName,
          namespace: gatewayNamespace !== namespace ? gatewayNamespace : undefined,
        },
      ];
    }

    const rules = this.config.rules.map(rule => {
      const processed = { ...rule };
      if (processed.backendRefs) {
        processed.backendRefs = processed.backendRefs.map(ref => ({
          ...ref,
          namespace: ref.namespace || namespace,
        }));
      }
      return processed;
    });

    const grpcRoute = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'GRPCRoute',
      metadata: {
        name: routeName,
        namespace: namespace,
      },
      spec: {
        parentRefs: parentRefs,
        ...(this.config.hostname ? { hostnames: [this.config.hostname] } : {}),
        rules: rules,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying GRPCRoute: ${routeName}${contextInfo}...`, 'info');
      await this.applyResource(grpcRoute, context);
    }
  }

  async cleanup() {
    const routeName = this.config.routeName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up GrpcRouting feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting GRPCRoute: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('grpcroute', routeName, namespace, context);
    }
  }
}

export function createGrpcRoutingFeature(config) {
  return new GrpcRoutingFeature('grpc-routing', config);
}
