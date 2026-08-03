import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Global Service Feature
 *
 * Labels Kubernetes services with solo.io/service-scope to control
 * cross-cluster service visibility. This is label-driven (no YAML configs).
 *
 * Configuration:
 * {
 *   namespace: string,            // Required: Namespace containing the services
 *   services: array,              // Required: [{name, scope, labels?, annotations?}]
 *                                 //   scope: 'global'|'segment'|'global-only'
 *                                 //   labels: optional key/value map applied to the service
 *                                 //   annotations: optional key/value map applied to the service
 *   deploymentPatches: array,     // Optional: patch env vars on deployments
 *                                 //   [{deployment, container, env: {KEY: value}}]
 * }
 */
export class GlobalServiceFeature extends Feature {
  validate() {
    if (!this.config.namespace) {
      throw new Error('namespace is required for GlobalService feature');
    }
    if (!this.config.services || !this.config.services.length) {
      throw new Error('services is required for GlobalService feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const services = this.config.services;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying GlobalService feature`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(
      `  Services: ${services.map(s => `${s.name} (${s.scope || 'global'})`).join(', ')}`,
      'info'
    );

    const deploymentPatches = this.config.deploymentPatches || [];

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';
      const contextInfo = context ? ` (context: ${context})` : '';

      for (const svc of services) {
        const scope = svc.scope || 'global';
        this.log(`Labeling service ${svc.name} with scope=${scope}${contextInfo}...`, 'info');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} label service ${svc.name} -n ${namespace} solo.io/service-scope=${scope} --overwrite`
          );
        } catch (error) {
          this.log(`Warning: Could not label service ${svc.name}: ${error.message}`, 'warn');
        }

        if (svc.labels && Object.keys(svc.labels).length > 0) {
          const labelArgs = Object.entries(svc.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
          this.log(`Labeling service ${svc.name} with extra labels${contextInfo}...`, 'info');
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag} label service ${svc.name} -n ${namespace} ${labelArgs} --overwrite`
            );
          } catch (error) {
            this.log(
              `Warning: Could not apply labels to service ${svc.name}: ${error.message}`,
              'warn'
            );
          }
        }

        if (svc.annotations && Object.keys(svc.annotations).length > 0) {
          const annotationArgs = Object.entries(svc.annotations)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
          this.log(`Annotating service ${svc.name}${contextInfo}...`, 'info');
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag} annotate service ${svc.name} -n ${namespace} ${annotationArgs} --overwrite`
            );
          } catch (error) {
            this.log(`Warning: Could not annotate service ${svc.name}: ${error.message}`, 'warn');
          }
        }
      }

      for (const patch of deploymentPatches) {
        if (!patch.env || Object.keys(patch.env).length === 0) continue;
        const envArgs = Object.entries(patch.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        this.log(`Patching deployment ${patch.deployment} env${contextInfo}...`, 'info');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} set env deployment/${patch.deployment} -n ${namespace} ${envArgs}`
          );
        } catch (error) {
          this.log(
            `Warning: Could not patch deployment ${patch.deployment}: ${error.message}`,
            'warn'
          );
        }
      }
    }
  }

  async cleanup() {
    const namespace = this.config.namespace;
    const services = this.config.services;
    const deploymentPatches = this.config.deploymentPatches || [];

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up GlobalService feature`, 'info');

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';

      for (const svc of services) {
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} label service ${svc.name} -n ${namespace} solo.io/service-scope- --ignore-not-found=true`
          );
        } catch {
          /* ignore */
        }

        if (svc.labels && Object.keys(svc.labels).length > 0) {
          const labelKeys = Object.keys(svc.labels)
            .map(k => `${k}-`)
            .join(' ');
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag} label service ${svc.name} -n ${namespace} ${labelKeys} --ignore-not-found=true`
            );
          } catch {
            /* ignore */
          }
        }

        if (svc.annotations && Object.keys(svc.annotations).length > 0) {
          const annotationKeys = Object.keys(svc.annotations)
            .map(k => `${k}-`)
            .join(' ');
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag} annotate service ${svc.name} -n ${namespace} ${annotationKeys} --ignore-not-found=true`
            );
          } catch {
            /* ignore */
          }
        }
      }

      for (const patch of deploymentPatches) {
        if (!patch.env || Object.keys(patch.env).length === 0) continue;
        // Remove env vars by appending '-' to each key
        const envRemoveArgs = Object.keys(patch.env)
          .map(k => `${k}-`)
          .join(' ');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} set env deployment/${patch.deployment} -n ${namespace} ${envRemoveArgs}`
          );
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export function createGlobalServiceFeature(config) {
  return new GlobalServiceFeature('global-service', config);
}
