import path from 'path';
import { fileURLToPath } from 'url';
import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, 'config');

const OSS_VERSION = 'v2.3.0';
const ENTERPRISE_VERSION = '2.3.1';
const OSS_REGISTRY = 'oci://cr.kgateway.dev/kgateway-dev/charts';
const ENTERPRISE_REGISTRY = 'oci://us-docker.pkg.dev/solo-public/enterprise-kgateway/charts';
const OSS_GATEWAY_CLASS = 'kgateway';
const ENTERPRISE_GATEWAY_CLASS = 'enterprise-kgateway';

// GatewayParameters is the only mechanism kgateway honors for pod-template
// annotations - Gateway.spec.infrastructure.annotations is not propagated to
// the proxy pod, despite looking like it should be (Gateway API's generic
// infrastructure field). See https://docs.solo.io/kgateway/2.3.x/integrations/istio/ambient/additional-settings/#strict-mode
const OSS_PARAMETERS_GROUP = 'gateway.kgateway.dev';
const OSS_PARAMETERS_KIND = 'GatewayParameters';
const OSS_PARAMETERS_API_VERSION = 'gateway.kgateway.dev/v1alpha1';
const ENTERPRISE_PARAMETERS_GROUP = 'enterprisekgateway.solo.io';
const ENTERPRISE_PARAMETERS_KIND = 'EnterpriseKgatewayParameters';
const ENTERPRISE_PARAMETERS_API_VERSION = 'enterprisekgateway.solo.io/v1alpha1';

export class KgatewayFeature extends AddonFeature {
  constructor(name, config = {}) {
    super(name, config);
    this.enterprise = config.enterprise === true;
    this.namespace = config.namespace || 'kgateway-system';
    this.version = config.version || (this.enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
    this.registry = this.enterprise ? ENTERPRISE_REGISTRY : OSS_REGISTRY;
    this.crdsRelease = this.enterprise ? 'enterprise-kgateway-crds' : 'kgateway-crds';
    this.mainRelease = this.enterprise ? 'enterprise-kgateway' : 'kgateway';
    this.kubeContext = config.kubeContext || null;
    this.gateway = config.gateway || null;
    this.gatewayParametersName = this.gateway ? `${this.gateway.name}-params` : null;
    this.telemetryNamespace = config.telemetryNamespace || null;
    this.telemetryGatewayName = config.telemetryGatewayName || config.gateway?.name || null;
    this.telemetryGatewayNamespace =
      config.telemetryGatewayNamespace || config.gateway?.namespace || this.namespace;
    this.ambientEnabled = config.ambientEnabled === true;
    this.tracesCollectorName = config.tracesCollectorName || 'opentelemetry-collector-traces';
    this.tracesCollectorNamespace =
      config.tracesCollectorNamespace || this.telemetryNamespace || 'telemetry';
    this.logsCollectorName = config.logsCollectorName || 'opentelemetry-collector-logs';
    this.logsCollectorNamespace =
      config.logsCollectorNamespace || this.telemetryNamespace || 'telemetry';
  }

  validate() {
    if (this.enterprise && !process.env.ENTERPRISE_KGATEWAY_LICENSE) {
      throw new Error(
        'ENTERPRISE_KGATEWAY_LICENSE environment variable is required for kgateway Enterprise'
      );
    }
    return true;
  }

  async deploy() {
    const licenseKey = this.enterprise ? process.env.ENTERPRISE_KGATEWAY_LICENSE : undefined;

    const mode = this.enterprise ? 'Enterprise' : 'OSS';
    this.log(`Installing kgateway ${mode} ${this.version}`);

    const ctxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    // Label control plane namespace for Ambient mesh
    if (this.ambientEnabled) {
      await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
      await KubernetesHelper.labelNamespaceForDataplaneMode(
        this.namespace,
        'ambient',
        this.kubeContext,
        { quiet: true }
      );
      this.log(`Namespace '${this.namespace}' labeled for Ambient mode`);
    }

    // Install CRDs chart
    this.log('Installing kgateway CRDs');
    await KubernetesHelper.helm(
      [
        'upgrade',
        '-i',
        this.crdsRelease,
        `${this.registry}/${this.crdsRelease}`,
        '-n',
        this.namespace,
        '--create-namespace',
        '--version',
        this.version,
        '--wait',
        ...ctxArgs,
      ],
      { spinner: this.spinner }
    );

    // Install main chart
    this.log('Installing kgateway controller');
    const mainArgs = [
      'upgrade',
      '-i',
      this.mainRelease,
      `${this.registry}/${this.mainRelease}`,
      '-n',
      this.namespace,
      '--version',
      this.version,
      '--wait',
      '--timeout',
      '5m',
      '--values',
      path.join(CONFIG_DIR, 'values.yaml'),
      ...ctxArgs,
    ];
    if (this.enterprise) {
      mainArgs.push('--set-string', `licensing.licenseKey=${licenseKey}`);
    }
    if (this.ambientEnabled) {
      mainArgs.push('--set', 'controller.extraEnv.KGW_ENABLE_ISTIO_INTEGRATION=true');
    }
    await KubernetesHelper.helm(mainArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(this.mainRelease, this.namespace, this.kubeContext);

    await KubernetesHelper.waitForDeployment(
      this.namespace,
      this.mainRelease,
      120,
      this.spinner,
      this.kubeContext
    );

    if (this.gateway) {
      await this.createGatewayResource(
        this.enterprise ? ENTERPRISE_GATEWAY_CLASS : OSS_GATEWAY_CLASS
      );
    }

    if (this.telemetryGatewayName) {
      await this.applyTelemetryPolicies();
    }

    this.log(`kgateway ${mode} installed successfully`, 'success');
  }

  buildGatewayResource(gatewayClassName) {
    const hostname = this.gateway.hostname;
    const port = this.gateway.port || 80;
    const protocol = this.gateway.protocol || 'HTTP';

    let listeners;
    if (this.gateway.listeners) {
      listeners = this.gateway.listeners;
    } else {
      const allowedRoutes = this.gateway.allowedRoutes || { namespaces: { from: 'Same' } };
      const httpListener = { name: 'http', port, protocol, allowedRoutes };
      if (hostname) httpListener.hostname = hostname;
      listeners = [httpListener];
    }

    const spec = { gatewayClassName, listeners };
    if (this.ambientEnabled) {
      spec.infrastructure = {
        parametersRef: {
          group: this.enterprise ? ENTERPRISE_PARAMETERS_GROUP : OSS_PARAMETERS_GROUP,
          kind: this.enterprise ? ENTERPRISE_PARAMETERS_KIND : OSS_PARAMETERS_KIND,
          name: this.gatewayParametersName,
        },
      };
    }

    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: this.gateway.name,
        namespace: this.gateway.namespace,
      },
      spec,
    };
  }

  buildGatewayParametersResource() {
    return {
      apiVersion: this.enterprise ? ENTERPRISE_PARAMETERS_API_VERSION : OSS_PARAMETERS_API_VERSION,
      kind: this.enterprise ? ENTERPRISE_PARAMETERS_KIND : OSS_PARAMETERS_KIND,
      metadata: {
        name: this.gatewayParametersName,
        namespace: this.gateway.namespace,
      },
      spec: {
        kube: {
          podTemplate: {
            // Ambient enrolls the gateway pod's outbound calls to backends, but
            // by default also captures its inbound calls. Without this, a
            // STRICT PeerAuthentication rejects external clients (no mesh
            // identity) trying to reach the gateway. This bypasses capture for
            // inbound only, so outbound stays in the mesh.
            extraAnnotations: { 'ambient.istio.io/bypass-inbound-capture': 'true' },
          },
        },
      },
    };
  }

  async createGatewayResource(gatewayClassName) {
    const name = this.gateway.name;
    const namespace = this.gateway.namespace;
    this.log(`Creating Gateway "${name}" (class: ${gatewayClassName}, namespace: ${namespace})`);

    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    await CommandRunner.exec(
      `kubectl ${ctxFlag} create namespace ${namespace} --dry-run=client -o yaml | kubectl ${ctxFlag} apply -f -`,
      { ignoreError: true }
    );

    if (this.ambientEnabled) {
      this.log(
        `Applying GatewayParameters "${this.gatewayParametersName}" (bypass-inbound-capture)`
      );
      await this.applyResource(this.buildGatewayParametersResource(), this.kubeContext);
    }

    const resource = this.buildGatewayResource(gatewayClassName);
    await this.applyResource(resource, this.kubeContext);
    this.log(`Gateway "${name}" created`, 'success');
  }

  async applyTelemetryPolicies() {
    this.log(
      `Applying OTel telemetry policies for gateway '${this.telemetryGatewayName}'...`,
      'info'
    );
    const gatewayName = this.telemetryGatewayName;
    const gatewayNs = this.telemetryGatewayNamespace;

    // ListenerPolicy: access log → OTel logs collector
    await this.applyResource(
      {
        apiVersion: 'gateway.kgateway.dev/v1alpha1',
        kind: 'ListenerPolicy',
        metadata: { name: 'otel-logging-policy', namespace: gatewayNs },
        spec: {
          targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayName }],
          default: {
            httpSettings: {
              accessLog: [
                {
                  openTelemetry: {
                    grpcService: {
                      logName: `${gatewayName}-access-logs`,
                      backendRef: {
                        name: this.logsCollectorName,
                        namespace: this.logsCollectorNamespace,
                        port: 4317,
                      },
                    },
                    body: '%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %RESPONSE_CODE% "%REQ(:AUTHORITY)%" "%UPSTREAM_CLUSTER%"',
                  },
                },
              ],
            },
          },
        },
      },
      this.kubeContext
    );

    // ListenerPolicy: tracing → OTel traces collector
    await this.applyResource(
      {
        apiVersion: 'gateway.kgateway.dev/v1alpha1',
        kind: 'ListenerPolicy',
        metadata: { name: 'otel-tracing-policy', namespace: gatewayNs },
        spec: {
          targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayName }],
          default: {
            httpSettings: {
              tracing: {
                provider: {
                  openTelemetry: {
                    serviceName: gatewayName,
                    grpcService: {
                      backendRef: {
                        name: this.tracesCollectorName,
                        namespace: this.tracesCollectorNamespace,
                        port: 4317,
                      },
                    },
                  },
                },
                spawnUpstreamSpan: true,
              },
            },
          },
        },
      },
      this.kubeContext
    );

    // ReferenceGrant: allow ListenerPolicy in gatewayNs to reach logs collector
    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1beta1',
        kind: 'ReferenceGrant',
        metadata: {
          name: 'allow-otel-collector-logs-access',
          namespace: this.logsCollectorNamespace,
        },
        spec: {
          from: [{ group: 'gateway.kgateway.dev', kind: 'ListenerPolicy', namespace: gatewayNs }],
          to: [{ group: '', kind: 'Service', name: this.logsCollectorName }],
        },
      },
      this.kubeContext
    );

    // ReferenceGrant: allow ListenerPolicy in gatewayNs to reach traces collector
    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1beta1',
        kind: 'ReferenceGrant',
        metadata: {
          name: 'allow-otel-collector-traces-access',
          namespace: this.tracesCollectorNamespace,
        },
        spec: {
          from: [{ group: 'gateway.kgateway.dev', kind: 'ListenerPolicy', namespace: gatewayNs }],
          to: [{ group: '', kind: 'Service', name: this.tracesCollectorName }],
        },
      },
      this.kubeContext
    );

    this.log('OTel telemetry policies applied', 'info');
  }

  async cleanup() {
    this.log('Removing kgateway');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const kubectlCtxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    if (this.gateway) {
      await this.deleteResource(
        'gateway',
        this.gateway.name,
        this.gateway.namespace,
        this.kubeContext
      );
      if (this.ambientEnabled) {
        const parametersKind = this.enterprise
          ? 'enterprisekgatewayparameters'
          : 'gatewayparameters';
        await this.deleteResource(
          parametersKind,
          this.gatewayParametersName,
          this.gateway.namespace,
          this.kubeContext
        );
      }
    }

    if (this.telemetryGatewayName) {
      const gatewayNs = this.telemetryGatewayNamespace;
      for (const name of ['otel-logging-policy', 'otel-tracing-policy']) {
        await this.deleteResource('listenerpolicy', name, gatewayNs, this.kubeContext);
      }
      await this.deleteResource(
        'referencegrant',
        'allow-otel-collector-logs-access',
        this.logsCollectorNamespace,
        this.kubeContext
      );
      await this.deleteResource(
        'referencegrant',
        'allow-otel-collector-traces-access',
        this.tracesCollectorNamespace,
        this.kubeContext
      );
    }

    for (const release of [this.mainRelease, this.crdsRelease]) {
      try {
        await KubernetesHelper.helm(['uninstall', release, '-n', this.namespace, ...helmCtxArgs], {
          spinner: this.spinner,
        });
      } catch (err) {
        if (!/not found|no deployed releases/i.test(err.message)) throw err;
      }
    }
    await KubernetesHelper.kubectl([
      ...kubectlCtxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);
    this.log('kgateway removed', 'success');
  }
}
