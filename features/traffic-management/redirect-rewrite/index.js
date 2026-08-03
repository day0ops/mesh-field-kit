import { Feature } from '../../../src/lib/feature.js';

/**
 * Redirect/Rewrite Feature
 *
 * Deploys an HTTPRoute using RequestRedirect and/or URLRewrite filters, per
 * https://ambientmesh.io traffic-management "Redirects and rewrites" docs.
 * Can parent to an ingress Gateway or a waypoint/Service, since both are
 * valid targets for these filters.
 *
 * Configuration:
 * {
 *   routeName: string,          // Required: HTTPRoute name
 *   namespace: string,          // Required: Namespace
 *   parentRefs: array,          // Optional: Parent references (highest priority)
 *   serviceName: string,        // Optional: Service name shorthand (waypoint-attached route)
 *   port: number,               // Optional: Port for serviceName shorthand
 *   gatewayName: string,        // Optional: Gateway name shorthand (ingress route)
 *   gatewayNamespace: string,   // Optional: Gateway namespace (defaults to route namespace)
 *   waypointName: string,       // Optional: Waypoint Gateway name shorthand
 *   hostname: string,           // Optional: Hostname for the route (wraps to hostnames array)
 *   rules: array,               // Required: HTTPRoute rules with RequestRedirect/URLRewrite filters
 * }
 */
export class RedirectRewriteFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for RedirectRewrite feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for RedirectRewrite feature');
    }
    if (!this.config.rules || !Array.isArray(this.config.rules) || this.config.rules.length === 0) {
      throw new Error('rules is required for RedirectRewrite feature');
    }
    if (
      !this.config.parentRefs &&
      !this.config.serviceName &&
      !this.config.gatewayName &&
      !this.config.waypointName
    ) {
      throw new Error(
        'One of parentRefs, serviceName, gatewayName, or waypointName is required for RedirectRewrite feature'
      );
    }
    return true;
  }

  buildParentRefs(namespace) {
    if (this.config.parentRefs) {
      return this.config.parentRefs;
    }
    if (this.config.serviceName) {
      return [
        {
          group: '',
          kind: 'Service',
          name: this.config.serviceName,
          port: this.config.port,
        },
      ];
    }
    if (this.config.gatewayName) {
      const gatewayNamespace = this.config.gatewayNamespace || namespace;
      return [
        {
          name: this.config.gatewayName,
          namespace: gatewayNamespace !== namespace ? gatewayNamespace : undefined,
        },
      ];
    }
    return [
      {
        name: this.config.waypointName,
        kind: 'Gateway',
        group: 'gateway.networking.k8s.io',
      },
    ];
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying RedirectRewrite feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const parentRefs = this.buildParentRefs(namespace);

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

    const httpRoute = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
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
      this.log(`Applying redirect/rewrite HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.applyResource(httpRoute, context);
    }
  }

  async cleanup() {
    const routeName = this.config.routeName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up RedirectRewrite feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('httproute', routeName, namespace, context);
    }
  }
}

export function createRedirectRewriteFeature(config) {
  return new RedirectRewriteFeature('redirect-rewrite', config);
}
