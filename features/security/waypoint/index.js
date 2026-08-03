import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Waypoint Feature
 *
 * Deploys an Istio waypoint proxy Gateway with gatewayClassName: istio-waypoint.
 * Optionally labels a namespace or service to use the waypoint.
 *
 * Configuration:
 * {
 *   waypointName: string,         // Required: Waypoint Gateway name
 *   namespace: string,            // Required: Namespace
 *   labels: {                     // Optional: Labels to apply to namespace/service for waypoint binding
 *     target: 'namespace'|'service', // What to label (default: 'namespace')
 *     serviceName: string,        // Required if target is 'service'
 *   },
 *   annotations: object,          // Optional: Annotations to set on the waypoint Gateway itself,
 *                                 // e.g. { 'ambient.istio.io/xfcc-include-client-identity': 'true' }
 *   listeners: array,             // Optional: Override default listeners
 * }
 */
export class WaypointFeature extends Feature {
  validate() {
    if (!this.config.waypointName) {
      throw new Error('waypointName is required for Waypoint feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for Waypoint feature');
    }
    return true;
  }

  loadWaypointFromConfig() {
    const configPath = path.join(__dirname, 'config', 'waypoint-gateway.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const waypointName = this.config.waypointName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying Waypoint feature: ${waypointName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    // 'auto' is a reserved value in Istio ambient: labeling a namespace/service
    // with istio.io/use-waypoint=auto tells istiod's own auto-provisioning
    // controller to create and own the waypoint Gateway. Pre-creating a Gateway
    // named 'auto' ourselves would just sit there unlabeled and block istiod
    // from ever provisioning its own, so skip Gateway creation entirely here.
    const isAutoProvisioned = waypointName === 'auto';

    const configWaypoint = this.loadWaypointFromConfig();

    const listeners = this.config.listeners ||
      configWaypoint?.spec?.listeners || [{ name: 'mesh', port: 15008, protocol: 'HBONE' }];

    const gateway = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: waypointName,
        namespace: namespace,
        ...(this.config.annotations ? { annotations: this.config.annotations } : {}),
      },
      spec: {
        gatewayClassName: 'istio-waypoint',
        listeners: listeners,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';

      if (!isAutoProvisioned) {
        this.log(`Applying Waypoint Gateway: ${waypointName}${contextInfo}...`, 'info');
        await this.applyResource(gateway, context);

        await this.waitForGateway(waypointName, namespace, 60, context);
      } else {
        this.log(
          `Skipping manual Gateway creation for '${waypointName}' — istiod auto-provisions it once labeled${contextInfo}`,
          'info'
        );
      }

      // Label namespace or service to use this waypoint
      if (this.config.labels) {
        const target = this.config.labels.target || 'namespace';
        const contextFlag = context ? `--context=${context} ` : '';

        if (target === 'namespace') {
          this.log(
            `Labeling namespace ${namespace} to use waypoint ${waypointName}${contextInfo}...`,
            'info'
          );
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag}label namespace ${namespace} istio.io/use-waypoint=${waypointName} --overwrite`
            );
          } catch (error) {
            this.log(`Warning: Could not label namespace: ${error.message}`, 'warn');
          }
        } else if (target === 'service' && this.config.labels.serviceName) {
          const svcName = this.config.labels.serviceName;
          this.log(
            `Labeling service ${svcName} to use waypoint ${waypointName}${contextInfo}...`,
            'info'
          );
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag}label service ${svcName} -n ${namespace} istio.io/use-waypoint=${waypointName} --overwrite`
            );
          } catch (error) {
            this.log(`Warning: Could not label service: ${error.message}`, 'warn');
          }
        }
      }
    }
  }

  async cleanup() {
    const waypointName = this.config.waypointName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up Waypoint feature: ${waypointName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      const contextFlag = context ? `--context=${context} ` : '';

      // Remove waypoint label from namespace
      if (this.config.labels) {
        const target = this.config.labels.target || 'namespace';
        if (target === 'namespace') {
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag}label namespace ${namespace} istio.io/use-waypoint- --ignore-not-found=true`
            );
          } catch {
            /* ignore */
          }
        } else if (target === 'service' && this.config.labels.serviceName) {
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag}label service ${this.config.labels.serviceName} -n ${namespace} istio.io/use-waypoint- --ignore-not-found=true`
            );
          } catch {
            /* ignore */
          }
        }
      }

      this.log(`Deleting Waypoint Gateway: ${waypointName}${contextInfo}...`, 'info');
      await this.deleteResource('gateway', waypointName, namespace, context);
    }
  }
}

export function createWaypointFeature(config) {
  return new WaypointFeature('waypoint', config);
}
