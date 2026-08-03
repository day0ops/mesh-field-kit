import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner, waitForPublicUrl } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

// Solo Enterprise Management (Solo UI) Helm chart defaults
// Ref: https://docs.solo.io/istio/1.30.x/setup/setup/
const DEFAULT_SOLO_UI_MANAGEMENT_CHART_VERSION = '0.5.3';
const DEFAULT_SOLO_UI_MANAGEMENT_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management';
const DEFAULT_SOLO_UI_MANAGEMENT_CRDS_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management-crds';
const DEFAULT_SOLO_UI_RELAY_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/relay';
const RELEASE_NAME = 'solo-ui';
const CRDS_RELEASE_NAME = 'solo-ui-crds';
const RELAY_RELEASE_NAME = 'solo-relay';

// Default tunnel FQDNs — Solo UI uses mesh.internal for east-west routing
const DEFAULT_TUNNEL_FQDN = 'solo-enterprise-ui.solo-enterprise.mesh.internal';
const DEFAULT_TUNNEL_PORT = 9000;
const DEFAULT_TELEMETRY_FQDN = 'solo-enterprise-telemetry-gateway.solo-enterprise.mesh.internal';

/**
 * Solo UI Feature (Gloo UI / Solo Enterprise UI)
 *
 * Installs the Solo Enterprise management UI for observability into
 * mesh traffic, routes, policies, and more.
 *
 * Supports two modes for multi-cluster deployments:
 *   management — full UI stack (ClickHouse, UI, telemetry collector). One cluster only.
 *   relay      — lightweight relay agent that tunnels data to the management cluster.
 *                Deploy on every remote/workload cluster.
 *
 * Management mode installs:
 * - Solo Enterprise management CRDs (management-crds chart)
 * - Solo Enterprise UI (solo-enterprise-ui)
 * - ClickHouse (for observability data)
 *
 * Relay mode installs:
 * - Solo relay agent (relay chart) — connects back to management cluster via tunnel
 *
 * Configuration:
 * {
 *   mode: string,                    // 'management' (default) | 'relay'
 *   clusterName: string,             // Required: Kubernetes cluster name (passed to both charts)
 *   namespace: string,               // Default: 'solo-enterprise'
 *   managementChartVersion: string,  // Default: '0.4.1'
 *   managementChartOci: string,      // Default: OCI chart URL
 *   serviceType: string,             // Optional: e.g. 'LoadBalancer'; omit for port-forward
 *   nodeSelector: object,            // Default: {}
 *   clickhouse: {                      // Optional: management chart clickhouse values
 *     persistentVolume: {
 *       enabled: boolean,            // Default: true (from values.yaml)
 *       size: string,                // e.g. '50Gi' (default: 10Gi in values.yaml)
 *       storageClass: string,        // PVC storage class (null = cluster default)
 *     },
 *   },
 *   applyGatewayTracingPolicy: boolean, // Default: true (management mode only)
 *   hostname: string,                // Optional: public hostname for HTTPS (management only)
 *   tls: {                           // Optional: TLS config (management only)
 *     enabled: boolean,              // Default: false
 *     secretName: string,            // Default: 'solo-ui-tls'
 *     issuer: string,                // ClusterIssuer name (e.g., 'letsencrypt-dns')
 *   },
 *   oidc: {                          // Optional: OIDC auth config (management only)
 *     enabled: boolean,              // Default: false
 *     issuerUrl: string,
 *     backendClientId: string,
 *     backendClientSecret: string,
 *     frontendClientId: string,
 *   },
 *   tunnel: {                        // Relay mode: tunnel back to management cluster
 *     fqdn: string,                  // Default: solo-enterprise-ui.solo-enterprise.mesh.internal
 *     port: number,                  // Default: 9000
 *   },
 *   telemetry: {                     // Relay mode: telemetry gateway on management cluster
 *     fqdn: string,                  // Default: solo-enterprise-telemetry-gateway.solo-enterprise.mesh.internal
 *   },
 *   telemetryNamespace: string,      // Management mode: namespace of the Grafana telemetry stack.
 *                                    // When set, patches the OTEL collector to fan-out metrics→Prometheus,
 *                                    // traces→Tempo, and logs→Loki alongside ClickHouse.
 * }
 */
export class SoloUIFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.mode = config.mode || 'management';
    this.clusterName = config.clusterName || null;
    this.namespace = config.namespace || 'solo-enterprise';
    this.chartVersion =
      config.managementChartVersion || config.version || DEFAULT_SOLO_UI_MANAGEMENT_CHART_VERSION;
    this.chartOci = config.managementChartOci || DEFAULT_SOLO_UI_MANAGEMENT_CHART_OCI;
    this.serviceType = config.serviceType || null;
    this.nodeSelector = config.nodeSelector || {};
    this.clickhouse = config.clickhouse || null;
    this.applyGatewayTracingPolicy = config.applyGatewayTracingPolicy !== false;
    this.hostname = config.hostname || null;
    this.tls = config.tls || null;
    this.oidc = config.oidc || null;
    // Relay mode config
    this.tunnelFqdn = config.tunnel?.fqdn || DEFAULT_TUNNEL_FQDN;
    this.tunnelPort = config.tunnel?.port || DEFAULT_TUNNEL_PORT;
    this.telemetryFqdn = config.telemetry?.fqdn || DEFAULT_TELEMETRY_FQDN;
    // Fan-out: if set, patches the OTEL collector to also ship to the Grafana stack in this namespace
    this.telemetryNamespace = config.telemetryNamespace || null;
    this.products = config.products || null;
    this.rbacRoleMappings = config.rbacRoleMappings || null;
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (this.mode !== 'management' && this.mode !== 'relay') {
      throw new Error(`solo-ui: invalid mode '${this.mode}'. Must be 'management' or 'relay'`);
    }
    return true;
  }

  getFeaturePath() {
    return '../addons/solo-ui';
  }

  /**
   * Flatten a nested object into Helm --set key=value pairs.
   * @param {string} prefix - Helm values path prefix
   * @param {object|null} obj
   * @returns {string[]}
   */
  buildHelmSetArgs(prefix, obj) {
    if (!obj) return [];
    const args = [];
    const flatten = (val, path) => {
      for (const [key, v] of Object.entries(val)) {
        const fullPath = path ? `${path}.${key}` : key;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          flatten(v, fullPath);
        } else {
          args.push('--set', `${fullPath}=${v}`);
        }
      }
    };
    flatten(obj, prefix);
    return args;
  }

  buildProductArgs() {
    return this.buildHelmSetArgs('products', this.products);
  }

  buildNodeSelectorArgs(prefix) {
    const args = [];
    const pathPrefix = prefix ? `${prefix}.` : '';
    for (const [key, value] of Object.entries(this.nodeSelector)) {
      args.push('--set', `${pathPrefix}nodeSelector.${key}=${value}`);
    }
    return args;
  }

  async deploy() {
    if (this.mode === 'relay') {
      await this.deployRelay();
    } else {
      await this.deployManagement();
    }
  }

  async deployManagement() {
    this.log('Installing Solo UI (management mode)...', 'info');

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
    // Label namespace for ambient mesh participation
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'label',
        'namespace',
        this.namespace,
        'istio.io/dataplane-mode=ambient',
        '--overwrite',
      ],
      { spinner: this.spinner }
    );
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    if (this.oidc?.enabled) {
      await this.createOidcSecret();
    }

    await this.installManagementCrdsChart();
    await this.installManagementChart();
    await this.waitForPods();

    if (this.telemetryNamespace) {
      await this.patchTelemetryCollectorForFanout();
    }

    if (this.hostname && this.tls?.enabled) {
      await this.applyHttpsResources();
      await waitForPublicUrl(this.hostname, {
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    if (this.applyGatewayTracingPolicy) {
      await this.applyYamlFile('tracing-policy.yaml', {}, this.kubeContext);
      this.log('Gateway tracing policy applied', 'info');
    }

    let accessHint;
    if (this.hostname) {
      accessHint = `Access at https://${this.hostname}/`;
    } else if (this.serviceType) {
      const address = await this.getServiceAddress('solo-enterprise-ui');
      accessHint = address
        ? `Access at http://${address}`
        : `Access via the '${this.serviceType}' service in namespace '${this.namespace}' (address pending)`;
    } else {
      accessHint = `Port-forward with: kubectl port-forward service/solo-enterprise-ui -n ${this.namespace} 4000:80 then open http://localhost:4000/`;
    }
    this.log(`Solo UI management installed successfully. ${accessHint}`, 'success');
  }

  async deployRelay() {
    this.log(
      `Installing Solo UI relay agent (cluster: ${this.clusterName || 'unknown'})...`,
      'info'
    );

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'label',
        'namespace',
        this.namespace,
        'istio.io/dataplane-mode=ambient',
        '--overwrite',
      ],
      { spinner: this.spinner }
    );
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    await this.installRelayChart();
    await this.waitForRelayPods();

    this.log(
      `Solo UI relay installed. Tunnelling to ${this.tunnelFqdn}:${this.tunnelPort}`,
      'success'
    );
  }

  /**
   * Install the Solo Enterprise management CRDs Helm chart
   */
  async installManagementCrdsChart() {
    this.log('Installing management CRDs Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      CRDS_RELEASE_NAME,
      DEFAULT_SOLO_UI_MANAGEMENT_CRDS_CHART_OCI,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(CRDS_RELEASE_NAME, this.namespace, this.kubeContext);

    this.log('Management CRDs Helm chart installed', 'info');
  }

  /**
   * Install the Solo Enterprise management Helm chart (Solo UI + ClickHouse)
   */
  async installManagementChart() {
    this.log('Installing management Helm chart (Solo UI)...', 'info');

    const valuesFile = join(CONFIG_DIR, 'values.yaml');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      this.chartOci,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '-f',
      valuesFile,
      '--create-namespace',
      '--set',
      'management-crds.enabled=false',
      // Use in-cluster K8s API JWKS endpoint instead of the external EKS OIDC endpoint.
      // The EKS OIDC endpoint (oidc.eks.*.amazonaws.com) uses a cert not trusted by in-cluster
      // pods → "x509: certificate signed by unknown authority" → k8s token validator fails to start.
      '--set',
      'kubernetes.jwksUrl=https://kubernetes.default.svc/openid/v1/jwks',
      ...(this.clusterName ? ['--set', `cluster=${this.clusterName}`] : []),
      ...(process.env.ENTERPRISE_ISTIO_LICENSE
        ? ['--set', `licensing.licenseKey=${process.env.ENTERPRISE_ISTIO_LICENSE}`]
        : []),
      '--wait',
      '--timeout',
      '10m',
      ...(this.serviceType ? ['--set', `service.type=${this.serviceType}`] : []),
      ...this.buildHelmSetArgs('clickhouse', this.clickhouse),
      ...(this.oidc?.enabled
        ? [
            '--set',
            `oidc.issuer=${this.oidc.issuerUrl}`,
            '--set',
            `ui.backend.oidc.clientId=${this.oidc.backendClientId}`,
            '--set',
            `ui.backend.oidc.secretRef=ui-backend-oidc-secret`,
            '--set',
            `ui.frontend.oidc.clientId=${this.oidc.frontendClientId}`,
            ...(() => {
              const mappings = this.rbacRoleMappings || {
                admins: 'global.Admin',
                readers: 'global.Reader',
                writers: 'global.Writer',
              };
              return Object.entries(mappings).flatMap(([group, role]) => [
                '--set',
                `rbac.roleMapping.roleMappings.${group}=${role}`,
              ]);
            })(),
          ]
        : []),
      ...this.buildNodeSelectorArgs('ui'),
      ...this.buildNodeSelectorArgs('clickhouse'),
      ...this.buildProductArgs(),
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(RELEASE_NAME, this.namespace, this.kubeContext);

    this.log('Management Helm chart installed', 'info');
  }

  /**
   * Install the Solo Enterprise relay Helm chart (remote/workload clusters)
   */
  async installRelayChart() {
    this.log('Installing relay Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      RELAY_RELEASE_NAME,
      DEFAULT_SOLO_UI_RELAY_CHART_OCI,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
      '--set',
      `tunnel.fqdn=${this.tunnelFqdn}`,
      '--set',
      `tunnel.port=${this.tunnelPort}`,
      '--set',
      `telemetry.fqdn=${this.telemetryFqdn}`,
      ...(this.clusterName ? ['--set', `cluster=${this.clusterName}`] : []),
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(RELAY_RELEASE_NAME, this.namespace, this.kubeContext);
    this.log('Relay Helm chart installed', 'info');
  }

  /**
   * Wait for relay agent pod to be ready
   */
  async waitForRelayPods() {
    this.log('Waiting for relay agent pods...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'wait',
          '--for=condition=ready',
          'pod',
          '-l',
          'app.kubernetes.io/name=relay',
          '-n',
          this.namespace,
          '--timeout=120s',
        ],
        { ignoreError: true, spinner: this.spinner }
      );
    } catch (error) {
      this.log(`Relay pods may still be starting: ${error.message}`, 'warn');
    }
    this.log('Relay agent ready', 'info');
  }

  /**
   * Patch the solo-enterprise OTEL telemetry collector ConfigMap to fan-out
   * telemetry to the Grafana stack (Prometheus, Tempo, Loki) in addition to ClickHouse.
   *
   * Adds exporters:
   *   prometheusremotewrite/grafana → Prometheus remote-write
   *   otlp/tempo                   → Tempo distributed (traces)
   *   otlphttp/loki                → Loki OTLP (logs)
   *
   * Updates existing pipelines to include the new exporters alongside clickhouse.
   * Restarts the collector after patching.
   */
  async patchTelemetryCollectorForFanout() {
    const ns = this.telemetryNamespace;
    const configMapName = 'solo-enterprise-telemetry-collector-config';
    this.log(
      `Patching telemetry collector for fan-out to Grafana stack (namespace: '${ns}')...`,
      'info'
    );

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    // Get current ConfigMap as JSON
    const result = await KubernetesHelper.kubectl(
      [...ctxArgs, 'get', 'configmap', configMapName, '-n', this.namespace, '-o', 'json'],
      { spinner: this.spinner }
    );

    const cm = JSON.parse(result.stdout);
    const yaml = (await import('js-yaml')).default;
    const otelConfig = yaml.load(cm.data.relay);

    // Fix chart regression (v0.4.3+): clickhouse/metrics exporter uses otel_metrics_exp_histogram
    // (OTel default short name) but the migration creates otel_metrics_exponential_histogram.
    // Redirect to the actual table so inserts don't fail with UNKNOWN_TABLE.
    const chMetrics = otelConfig.exporters?.['clickhouse/metrics'];
    if (chMetrics) {
      chMetrics.metrics_tables = chMetrics.metrics_tables || {};
      if (!chMetrics.metrics_tables.exponential_histogram) {
        chMetrics.metrics_tables.exponential_histogram = 'otel_metrics_exponential_histogram';
      }
    }

    // Add fan-out exporters (non-destructive: won't overwrite existing keys)
    otelConfig.exporters = otelConfig.exporters || {};
    if (!otelConfig.exporters['prometheusremotewrite/grafana']) {
      otelConfig.exporters['prometheusremotewrite/grafana'] = {
        endpoint: `http://kube-prometheus-stack-prometheus.${ns}:9090/api/v1/write`,
      };
    }
    if (!otelConfig.exporters['otlphttp/loki']) {
      otelConfig.exporters['otlphttp/loki'] = {
        endpoint: `http://loki.${ns}:3100/otlp`,
      };
    }

    // Fan-out pipeline exporters alongside existing ClickHouse exporters
    const pipelines = otelConfig.service?.pipelines || {};
    const addExporter = (pipelineName, exporter) => {
      if (
        pipelines[pipelineName]?.exporters &&
        !pipelines[pipelineName].exporters.includes(exporter)
      ) {
        pipelines[pipelineName].exporters.push(exporter);
      }
    };

    // Metrics → Prometheus remote write
    addExporter('metrics/istio', 'prometheusremotewrite/grafana');
    addExporter('metrics/otlp', 'prometheusremotewrite/grafana');
    addExporter('metrics/platform', 'prometheusremotewrite/grafana');

    // Traces: NOT fanned out to Tempo here — otel-traces and otel-gateway already push
    // directly to Tempo. Adding otlp/tempo here would cause every span to reach Tempo twice.
    // Solo UI receives traces from otel-traces via its otlp/solo-ui exporter.

    // Logs → Loki
    addExporter('logs/remoteevents', 'otlphttp/loki');
    addExporter('logs/events', 'otlphttp/loki');

    // Write patched OTEL config back to ConfigMap.
    // Apply via SSA with Helm's own field manager to avoid upgrade conflicts:
    //   - Helm uses --server-side --field-manager=helm on upgrades
    //   - Using the same field manager here means no ownership conflict on re-runs
    //   - --force-conflicts lets us claim the field from any previous manager
    cm.data.relay = yaml.dump(otelConfig, { lineWidth: -1 });
    const patchYaml = yaml.dump(cm, { lineWidth: -1 });
    const tempFile = join(tmpdir(), `solo-fanout-patch-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, patchYaml, 'utf8');
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'apply',
          '--server-side',
          '--force-conflicts',
          '--field-manager=helm',
          '-f',
          tempFile,
        ],
        { spinner: this.spinner }
      );
    } finally {
      try {
        await unlink(tempFile);
      } catch {
        /* ignore */
      }
    }

    // Restart collector — may be StatefulSet (metrics enabled) or Deployment
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'restart',
        'statefulset/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
      ],
      { ignoreError: true, spinner: this.spinner }
    );
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'restart',
        'deployment/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
      ],
      { ignoreError: true, spinner: this.spinner }
    );
    // Wait for rollout to complete (ignoreError so a missing resource type doesn't fail)
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'status',
        'statefulset/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
        '--timeout=120s',
      ],
      { ignoreError: true, spinner: this.spinner }
    );
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'status',
        'deployment/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
        '--timeout=120s',
      ],
      { ignoreError: true, spinner: this.spinner }
    );

    this.log(
      `Telemetry fan-out active: metrics→Prometheus, traces→Tempo, logs→Loki (namespace '${ns}')`,
      'success'
    );
  }

  /**
   * Wait for management and UI pods to be ready
   */
  async waitForPods() {
    this.log('Waiting for management and UI pods...', 'info');

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    // Wait for solo-enterprise-ui deployment
    try {
      await KubernetesHelper.waitForDeployment(
        this.namespace,
        'solo-enterprise-ui',
        300,
        this.spinner,
        this.kubeContext
      );
    } catch (error) {
      this.log(`solo-enterprise-ui may still be starting: ${error.message}`, 'warn');
    }

    // ClickHouse may be a StatefulSet (e.g. management-clickhouse-shard0-0)
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'wait',
          '--for=condition=ready',
          'pod',
          '-l',
          'app.kubernetes.io/name=clickhouse',
          '-n',
          this.namespace,
          '--timeout=300s',
        ],
        { ignoreError: true, spinner: this.spinner }
      );
    } catch (error) {
      this.log('ClickHouse pods may use different labels; continuing', 'warn');
    }

    this.log('Solo UI and management components are ready', 'info');
  }

  async getServiceAddress(serviceName) {
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    const jsonpathArgs = field => [
      ...ctxArgs,
      'get',
      'svc',
      serviceName,
      '-n',
      this.namespace,
      '-o',
      `jsonpath={.status.loadBalancer.ingress[0].${field}}`,
    ];
    const ipResult = await KubernetesHelper.kubectl(jsonpathArgs('ip'), { ignoreError: true });
    const address = (ipResult.stdout || '').trim();
    if (address) return address;

    const hostResult = await KubernetesHelper.kubectl(jsonpathArgs('hostname'), {
      ignoreError: true,
    });
    return (hostResult.stdout || '').trim() || null;
  }

  async createOidcSecret() {
    this.log('Creating OIDC backend client secret...', 'info');
    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'ui-backend-oidc-secret',
          namespace: this.namespace,
          labels: { 'app.kubernetes.io/managed-by': 'mesh-demo' },
        },
        type: 'Opaque',
        stringData: { clientSecret: this.oidc.backendClientSecret },
      },
      this.kubeContext
    );
    this.log('OIDC secret created', 'info');
  }

  async applyHttpsResources() {
    this.log(`Configuring HTTPS for Solo UI at https://${this.hostname}...`, 'info');

    const secretName = this.tls.secretName || 'solo-ui-tls';
    const issuerName = this.tls.issuer || 'letsencrypt-dns';

    await this.applyYamlFile(
      'certificate.yaml',
      {
        spec: {
          secretName,
          issuerRef: { name: issuerName },
          dnsNames: [this.hostname],
        },
      },
      this.kubeContext
    );

    // Pass complete listener object — deepMerge replaces arrays wholesale
    await this.applyYamlFile(
      'https-gateway.yaml',
      {
        spec: {
          listeners: [
            {
              name: 'https',
              port: 443,
              protocol: 'HTTPS',
              hostname: this.hostname,
              tls: {
                mode: 'Terminate',
                certificateRefs: [{ name: secretName, kind: 'Secret' }],
              },
              allowedRoutes: {
                namespaces: { from: 'All' },
              },
            },
          ],
        },
      },
      this.kubeContext
    );

    await this.applyYamlFile(
      'https-route.yaml',
      {
        spec: {
          parentRefs: [
            {
              group: 'gateway.networking.k8s.io',
              kind: 'Gateway',
              name: 'solo-enterprise-ui-https',
              namespace: this.namespace,
            },
          ],
          hostnames: [this.hostname],
          rules: [
            {
              backendRefs: [{ name: 'solo-enterprise-ui', port: 80 }],
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            },
          ],
        },
      },
      this.kubeContext
    );

    await this.applyYamlFile('gateway-tracing-suppress-policy.yaml', {}, this.kubeContext);

    this.log('HTTPS resources applied', 'info');
  }

  async cleanup() {
    if (this.mode === 'relay') {
      await this.cleanupRelay();
    } else {
      await this.cleanupManagement();
    }
  }

  async cleanupManagement() {
    this.log('Cleaning up Solo UI (management)...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    if (this.oidc?.enabled) {
      await this.deleteResource(
        'Secret',
        'ui-backend-oidc-secret',
        this.namespace,
        this.kubeContext
      );
    }

    if (this.hostname && this.tls?.enabled) {
      await this.deleteResource(
        'HTTPRoute',
        'solo-enterprise-ui',
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource(
        'Gateway',
        'solo-enterprise-ui-https',
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource('Certificate', 'solo-ui-tls', this.namespace, this.kubeContext);
    }

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELEASE_NAME,
        CRDS_RELEASE_NAME,
        '-n',
        this.namespace,
        '--wait',
      ]);
      this.log('Management Helm releases uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);

    this.log('Solo UI management cleaned up', 'success');
  }

  async cleanupRelay() {
    this.log('Cleaning up Solo UI relay...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELAY_RELEASE_NAME,
        '-n',
        this.namespace,
        '--wait',
      ]);
      this.log('Relay Helm release uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);

    this.log('Solo UI relay cleaned up', 'success');
  }
}
