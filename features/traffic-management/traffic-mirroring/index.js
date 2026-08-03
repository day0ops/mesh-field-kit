import { Feature } from '../../../src/lib/feature.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Traffic Mirroring Feature
 *
 * Deploys HTTPRoute with a RequestMirror filter that mirrors live traffic to
 * a shadow backend, alongside normal routing to the primary backendRefs.
 *
 * Configuration:
 * {
 *   routeName: string,            // Required: HTTPRoute name
 *   namespace: string,            // Required: Namespace
 *   parentRefs: array,            // Optional: Parent references (highest priority)
 *   serviceName: string,          // Optional: Service name (shorthand for a mesh-internal parentRef)
 *   port: number,                 // Optional: Service port, used with serviceName
 *   waypointName: string,         // Optional: Waypoint Gateway name (shorthand for parentRefs)
 *   rules: array,                 // Required: Rules with backendRefs, mirrorBackendRef, and optional mirrorPercent
 * }
 */
export class TrafficMirroringFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for TrafficMirroring feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for TrafficMirroring feature');
    }
    if (!this.config.rules || this.config.rules.length === 0) {
      throw new Error('rules is required for TrafficMirroring feature');
    }
    for (const rule of this.config.rules) {
      if (!rule.backendRefs) {
        throw new Error('each rule requires backendRefs for TrafficMirroring feature');
      }
      if (!rule.mirrorBackendRef) {
        throw new Error('each rule requires mirrorBackendRef for TrafficMirroring feature');
      }
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

    this.log(`Deploying TrafficMirroring feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    let parentRefs;
    if (this.config.parentRefs) {
      parentRefs = this.config.parentRefs;
    } else if (this.config.serviceName && this.config.port) {
      parentRefs = [
        {
          group: '',
          kind: 'Service',
          name: this.config.serviceName,
          port: this.config.port,
        },
      ];
    } else if (this.config.waypointName) {
      parentRefs = [
        {
          name: this.config.waypointName,
          kind: 'Gateway',
          group: 'gateway.networking.k8s.io',
        },
      ];
    } else {
      parentRefs = [
        {
          name: 'waypoint',
          kind: 'Gateway',
          group: 'gateway.networking.k8s.io',
        },
      ];
    }

    const rules = this.config.rules.map(rule => {
      const backendRefs = rule.backendRefs.map(ref => ({
        ...ref,
        namespace: ref.namespace || namespace,
      }));

      const mirrorBackendRef = rule.mirrorBackendRef;
      const filters = [
        {
          type: 'RequestMirror',
          requestMirror: {
            backendRef: {
              name: mirrorBackendRef.name,
              port: mirrorBackendRef.port,
              namespace: mirrorBackendRef.namespace || namespace,
            },
            ...(rule.mirrorPercent !== undefined
              ? { fraction: { numerator: rule.mirrorPercent, denominator: 100 } }
              : {}),
          },
        },
      ];

      const processed = { ...rule, backendRefs, filters };
      delete processed.mirrorBackendRef;
      delete processed.mirrorPercent;
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
        rules: rules,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying mirroring HTTPRoute: ${routeName}${contextInfo}...`, 'info');
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

    this.log(`Cleaning up TrafficMirroring feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('httproute', routeName, namespace, context);
    }
  }
}

export function createTrafficMirroringFeature(config) {
  return new TrafficMirroringFeature('traffic-mirroring', config);
}
