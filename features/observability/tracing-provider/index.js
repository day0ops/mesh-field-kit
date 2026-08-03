import { Feature } from '../../../src/lib/feature.js';
import { KubernetesHelper } from '../../../src/lib/common.js';

const ISTIOD_HELM_REPO = 'oci://us-docker.pkg.dev/soloio-img/istio-helm/istiod';

/**
 * Tracing Provider Feature
 *
 * Registers an OpenTelemetry tracing extension provider on istiod (a live
 * Helm patch, matching enable-ambient's pattern of adjusting the control
 * plane in place) and applies a Telemetry API resource activating it.
 *
 * Requires the telemetry addon (or any OTLP/gRPC trace collector) already
 * reachable at otlpService:otlpPort — this feature only wires istiod to it,
 * it doesn't install a collector itself.
 *
 * Configuration:
 * {
 *   istioVersion: string,         // Required: must match the running install (e.g. '1.30.3')
 *   otlpService: string,          // Required: e.g. 'opentelemetry-collector-traces.telemetry.svc.cluster.local'
 *   otlpPort: number,             // Default: 4317
 *   providerName: string,         // Default: 'mesh-tracing'
 *   samplingPercentage: number,   // Default: 100
 *   istioNamespace: string,       // Default: 'istio-system'
 *   telemetryName: string,        // Default: same as providerName
 *   telemetryNamespace: string,   // Default: same as istioNamespace
 *   kubeContext: string,
 * }
 */
export class TracingProviderFeature extends Feature {
  validate() {
    if (!this.config.istioVersion) {
      throw new Error(
        'istioVersion is required for TracingProvider feature (must match the running install)'
      );
    }
    if (!this.config.otlpService) {
      throw new Error('otlpService is required for TracingProvider feature');
    }
    return true;
  }

  #ctxArgs() {
    return this.config.kubeContext ? ['--kube-context', this.config.kubeContext] : [];
  }

  async deploy() {
    const providerName = this.config.providerName || 'mesh-tracing';
    const otlpPort = this.config.otlpPort || 4317;
    const istioNamespace = this.config.istioNamespace || 'istio-system';
    const istioImage = this.config.istioVersion.endsWith('-solo')
      ? this.config.istioVersion
      : `${this.config.istioVersion}-solo`;
    const ctxArgs = this.#ctxArgs();

    this.log(
      `Registering OTel tracing provider '${providerName}' -> ${this.config.otlpService}:${otlpPort}`,
      'info'
    );

    const extensionProviders = JSON.stringify([
      {
        name: providerName,
        opentelemetry: {
          port: otlpPort,
          service: this.config.otlpService,
        },
      },
    ]);

    await KubernetesHelper.helm(
      [
        ...ctxArgs,
        'upgrade',
        'istiod',
        ISTIOD_HELM_REPO,
        '-n',
        istioNamespace,
        '--version',
        istioImage,
        '--reuse-values',
        '--set',
        'meshConfig.enableTracing=true',
        '--set-json',
        `meshConfig.extensionProviders=${extensionProviders}`,
        '--wait',
      ],
      { spinner: this.spinner }
    );

    const telemetryName = this.config.telemetryName || providerName;
    const telemetryNamespace = this.config.telemetryNamespace || istioNamespace;
    const samplingPercentage = this.config.samplingPercentage ?? 100;

    this.log(
      `Applying Telemetry resource '${telemetryName}' (sampling: ${samplingPercentage}%)`,
      'info'
    );

    await this.applyResource(
      {
        apiVersion: 'telemetry.istio.io/v1',
        kind: 'Telemetry',
        metadata: {
          name: telemetryName,
          namespace: telemetryNamespace,
        },
        spec: {
          tracing: [
            {
              providers: [{ name: providerName }],
              randomSamplingPercentage: samplingPercentage,
            },
          ],
        },
      },
      this.config.kubeContext
    );

    this.log('Tracing provider registered and activated', 'success');
  }

  async cleanup() {
    const telemetryName = this.config.telemetryName || this.config.providerName || 'mesh-tracing';
    const telemetryNamespace =
      this.config.telemetryNamespace || this.config.istioNamespace || 'istio-system';

    this.log(`Cleaning up Telemetry resource '${telemetryName}'`, 'info');
    await this.deleteResource(
      'telemetry',
      telemetryName,
      telemetryNamespace,
      this.config.kubeContext
    );

    // istiod's meshConfig.enableTracing/extensionProviders are left in place —
    // a registered-but-unreferenced provider is harmless, and reverting it
    // cleanly would require a full reuse-values without those keys, which
    // Helm has no way to express (only additive --set/--set-json).
    this.log(
      'Left istiod meshConfig tracing provider registered (harmless when unreferenced)',
      'info'
    );
  }
}

export function createTracingProviderFeature(config) {
  return new TracingProviderFeature('tracing-provider', config);
}
