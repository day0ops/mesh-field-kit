import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Ztunnel Metrics Feature
 *
 * Inspection feature that port-forwards to ztunnel pods and scrapes metrics.
 * Optionally also deploys a PodMonitor for persistent Prometheus Operator
 * scraping (requires the telemetry addon's kube-prometheus-stack already
 * installed — podMonitorSelectorNilUsesHelmValues: false there means its
 * Prometheus picks up any PodMonitor cluster-wide, no extra labels needed).
 *
 * Configuration:
 * {
 *   namespace: string,            // Optional: Ztunnel namespace (default: 'istio-system')
 *   metricsPort: number,          // Optional: Metrics port (default: 15020)
 *   localPort: number,            // Optional: Local port for forwarding (default: 15020)
 *   installPodMonitor: boolean,   // Optional: Also deploy a PodMonitor (default: false)
 * }
 */
export class ZtunnelMetricsFeature extends Feature {
  validate() {
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'istio-system';
    const metricsPort = this.config.metricsPort || 15020;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying ZtunnelMetrics feature (inspection)`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Metrics port: ${metricsPort}`, 'info');

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';
      const contextInfo = context ? ` (context: ${context})` : '';

      // Verify ztunnel pods exist
      this.log(`Checking ztunnel pods${contextInfo}...`, 'info');
      try {
        const result = await CommandRunner.exec(
          `kubectl ${contextFlag} get pods -n ${namespace} -l app=ztunnel -o name`
        );
        const pods = result.stdout.trim().split('\n').filter(Boolean);
        this.log(`  Found ${pods.length} ztunnel pod(s)`, 'info');

        if (pods.length > 0) {
          // Fetch metrics snapshot from the first ztunnel pod
          const podName = pods[0].replace('pod/', '');
          this.log(`Fetching metrics from ${podName}${contextInfo}...`, 'info');
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag} exec -n ${namespace} ${podName} -- curl -s localhost:${metricsPort}/metrics | head -50`
            );
            this.log(`  Metrics sample retrieved successfully`, 'success');
          } catch (error) {
            this.log(`Warning: Could not fetch metrics: ${error.message}`, 'warn');
          }
        }
      } catch (error) {
        this.log(`Warning: Could not find ztunnel pods: ${error.message}`, 'warn');
      }

      if (this.config.installPodMonitor) {
        this.log(`Applying PodMonitor for ztunnel${contextInfo}...`, 'info');
        await this.applyResource(
          {
            apiVersion: 'monitoring.coreos.com/v1',
            kind: 'PodMonitor',
            metadata: {
              name: 'ztunnel',
              namespace: namespace,
            },
            spec: {
              selector: {
                matchLabels: { app: 'ztunnel' },
              },
              podMetricsEndpoints: [
                {
                  targetPort: metricsPort,
                  path: '/metrics',
                  interval: '15s',
                },
              ],
            },
          },
          context
        );
        this.log('PodMonitor applied', 'success');
      }
    }
  }

  async cleanup() {
    if (this.config.installPodMonitor) {
      const namespace = this.config.namespace || 'istio-system';
      const contextsToDeploy =
        this.clusterContexts && this.clusterContexts.length > 0
          ? this.clusterContexts.map(c => c.context)
          : [null];

      for (const context of contextsToDeploy) {
        this.log('Deleting ztunnel PodMonitor...', 'info');
        await this.deleteResource('podmonitor', 'ztunnel', namespace, context);
      }
    }
    this.log(`ZtunnelMetrics inspection has nothing else to clean up`, 'info');
  }
}

export function createZtunnelMetricsFeature(config) {
  return new ZtunnelMetricsFeature('ztunnel-metrics', config);
}
