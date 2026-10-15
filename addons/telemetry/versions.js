// Default Helm chart versions for the telemetry stack
// Ref: https://docs.solo.io/gloo-mesh/main/setup/observability/prometheus/
// Ref: https://docs.solo.io/gloo-mesh/main/setup/observability/grafana/
export const DEFAULT_CHART_VERSIONS = {
  'kube-prom-stack': '92.8.0',
  loki: '7.3.0',
  tempo: '1.61.3',
  alloy: '1.13.0',
  otel: '0.175.1',
};

/**
 * Resolve effective Helm chart versions from addon config.
 * @param {{ version?: string, chartVersions?: object }} config - Flattened addon config (index.js)
 *   or { version, chartVersions } derived from profile addon entry (runbook.js)
 */
export function resolveChartVersions({ version, chartVersions } = {}) {
  const overrides = chartVersions || {};
  return {
    'kube-prom-stack':
      overrides['kube-prom-stack']?.version ||
      overrides.prometheus?.version ||
      DEFAULT_CHART_VERSIONS['kube-prom-stack'],
    loki: overrides.loki?.version || DEFAULT_CHART_VERSIONS.loki,
    tempo: overrides.tempo?.version || DEFAULT_CHART_VERSIONS.tempo,
    alloy: overrides.alloy?.version || DEFAULT_CHART_VERSIONS.alloy,
    otel: version || overrides.otel?.version || DEFAULT_CHART_VERSIONS.otel,
  };
}
