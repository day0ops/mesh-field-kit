// addons/kgateway/runbook.js
import { dump as yamlDump } from 'js-yaml';

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

/** Merge profile addon `config:` block up to the top level (same flattening as installer.js). */
const addonSettings = addonCfg =>
  addonCfg?.config && typeof addonCfg.config === 'object'
    ? { ...addonCfg, ...addonCfg.config }
    : addonCfg;

const OSS_VERSION = 'v2.3.0';
const ENTERPRISE_VERSION = '2.3.1';
const OSS_REGISTRY = 'oci://cr.kgateway.dev/kgateway-dev/charts';
const ENTERPRISE_REGISTRY = 'oci://us-docker.pkg.dev/solo-public/enterprise-kgateway/charts';
const OSS_GATEWAY_CLASS = 'kgateway';
const ENTERPRISE_GATEWAY_CLASS = 'enterprise-kgateway';
const OSS_PARAMETERS_GROUP = 'gateway.kgateway.dev';
const OSS_PARAMETERS_KIND = 'GatewayParameters';
const OSS_PARAMETERS_API_VERSION = 'gateway.kgateway.dev/v1alpha1';
const ENTERPRISE_PARAMETERS_GROUP = 'enterprisekgateway.solo.io';
const ENTERPRISE_PARAMETERS_KIND = 'EnterpriseKgatewayParameters';
const ENTERPRISE_PARAMETERS_API_VERSION = 'enterprisekgateway.solo.io/v1alpha1';

// Resolve every OSS/Enterprise-dependent name the installer derives in its constructor,
// so generate() and cleanup() stay in sync with index.js from a single place.
function settings(addonCfg) {
  const s = addonSettings(addonCfg);
  const enterprise = s.enterprise === true;
  const namespace = s.namespace || 'kgateway-system';
  const gateway = s.gateway || null;
  return {
    enterprise,
    namespace,
    registry: enterprise ? ENTERPRISE_REGISTRY : OSS_REGISTRY,
    crdsRelease: enterprise ? 'enterprise-kgateway-crds' : 'kgateway-crds',
    mainRelease: enterprise ? 'enterprise-kgateway' : 'kgateway',
    gatewayClass: enterprise ? ENTERPRISE_GATEWAY_CLASS : OSS_GATEWAY_CLASS,
    ambientEnabled: s.ambientEnabled === true,
    gateway,
    gatewayParametersName: gateway ? `${gateway.name}-params` : null,
    telemetryGatewayName: s.telemetryGatewayName || gateway?.name || null,
    telemetryGatewayNamespace: s.telemetryGatewayNamespace || gateway?.namespace || namespace,
    telemetryNamespace: s.telemetryNamespace || null,
    tracesCollectorName: s.tracesCollectorName || 'opentelemetry-collector-traces',
    tracesCollectorNamespace: s.tracesCollectorNamespace || s.telemetryNamespace || 'telemetry',
    logsCollectorName: s.logsCollectorName || 'opentelemetry-collector-logs',
    logsCollectorNamespace: s.logsCollectorNamespace || s.telemetryNamespace || 'telemetry',
  };
}

// Mirror applyResource(): dump the exact object the installer applies. lineWidth: -1 keeps the
// long access-log format string on one line.
const toYaml = resource => yamlDump(resource, { lineWidth: -1, indent: 2 }).trimEnd();

function buildGatewayResource(s, env) {
  const g = s.gateway;
  const hostname = tpl(g.hostname, env?.spec?.domains?.app);
  const port = g.port || 80;
  const protocol = g.protocol || 'HTTP';

  let listeners;
  if (g.listeners) {
    listeners = g.listeners;
  } else {
    const allowedRoutes = g.allowedRoutes || { namespaces: { from: 'Same' } };
    const httpListener = { name: 'http', port, protocol, allowedRoutes };
    if (hostname) httpListener.hostname = hostname;
    listeners = [httpListener];
  }

  const spec = { gatewayClassName: s.gatewayClass, listeners };
  if (s.ambientEnabled) {
    spec.infrastructure = {
      parametersRef: {
        group: s.enterprise ? ENTERPRISE_PARAMETERS_GROUP : OSS_PARAMETERS_GROUP,
        kind: s.enterprise ? ENTERPRISE_PARAMETERS_KIND : OSS_PARAMETERS_KIND,
        name: s.gatewayParametersName,
      },
    };
  }

  return {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'Gateway',
    metadata: { name: g.name, namespace: g.namespace },
    spec,
  };
}

function buildGatewayParametersResource(s) {
  return {
    apiVersion: s.enterprise ? ENTERPRISE_PARAMETERS_API_VERSION : OSS_PARAMETERS_API_VERSION,
    kind: s.enterprise ? ENTERPRISE_PARAMETERS_KIND : OSS_PARAMETERS_KIND,
    metadata: { name: s.gatewayParametersName, namespace: s.gateway.namespace },
    spec: {
      kube: {
        podTemplate: {
          // Bypass inbound capture only, so a STRICT PeerAuthentication doesn't reject
          // external clients reaching the gateway; outbound calls stay in the mesh.
          extraAnnotations: { 'ambient.istio.io/bypass-inbound-capture': 'true' },
        },
      },
    },
  };
}

function buildTelemetryResources(s) {
  const gatewayName = s.telemetryGatewayName;
  const gatewayNs = s.telemetryGatewayNamespace;
  return [
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
                      name: s.logsCollectorName,
                      namespace: s.logsCollectorNamespace,
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
                      name: s.tracesCollectorName,
                      namespace: s.tracesCollectorNamespace,
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
    {
      apiVersion: 'gateway.networking.k8s.io/v1beta1',
      kind: 'ReferenceGrant',
      metadata: { name: 'allow-otel-collector-logs-access', namespace: s.logsCollectorNamespace },
      spec: {
        from: [{ group: 'gateway.kgateway.dev', kind: 'ListenerPolicy', namespace: gatewayNs }],
        to: [{ group: '', kind: 'Service', name: s.logsCollectorName }],
      },
    },
    {
      apiVersion: 'gateway.networking.k8s.io/v1beta1',
      kind: 'ReferenceGrant',
      metadata: {
        name: 'allow-otel-collector-traces-access',
        namespace: s.tracesCollectorNamespace,
      },
      spec: {
        from: [{ group: 'gateway.kgateway.dev', kind: 'ListenerPolicy', namespace: gatewayNs }],
        to: [{ group: '', kind: 'Service', name: s.tracesCollectorName }],
      },
    },
  ];
}

export function envVarsFor(addonCfg, _clusterName) {
  if (addonSettings(addonCfg).enterprise === true) {
    return [
      {
        name: 'ENTERPRISE_KGATEWAY_LICENSE',
        required: true,
        description: 'kgateway Enterprise license key',
      },
    ];
  }
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  const s = addonSettings(addonCfg);
  const enterprise = s.enterprise === true;
  const version = s.version || (enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
  return [
    { name: 'KGATEWAY_VERSION', value: version, comment: 'kgateway chart version' },
    {
      name: 'KGATEWAY_NAMESPACE',
      value: s.namespace || 'kgateway-system',
      comment: 'kgateway control plane namespace',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const s = settings(addonCfg);
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const ns = s.namespace;
  const mode = s.enterprise ? 'Enterprise' : 'OSS';

  let ambientSection = '';
  if (s.ambientEnabled) {
    ambientSection = `
Label the control plane namespace for Ambient mesh:

\`\`\`bash
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`
`;
  }

  // Controller chart flags — license is only added for Enterprise, Istio integration only for Ambient.
  const mainArgs = [
    `  --kube-context=${ctx}`,
    `  -n ${ns}`,
    `  --version $KGATEWAY_VERSION`,
    `  --wait`,
    `  --timeout 5m`,
  ];
  if (s.enterprise) {
    mainArgs.push('  --set-string licensing.licenseKey=$ENTERPRISE_KGATEWAY_LICENSE');
  }
  if (s.ambientEnabled) {
    mainArgs.push('  --set controller.extraEnv.KGW_ENABLE_ISTIO_INTEGRATION=true');
  }
  const mainHelm = `helm upgrade -i ${s.mainRelease} ${s.registry}/${s.mainRelease} \\\n${mainArgs
    .map(a => `${a} \\`)
    .join('\n')
    .replace(/ \\$/, '')}`;

  let gatewaySection = '';
  if (s.gateway) {
    const gwNs = s.gateway.namespace;
    let paramsBlock = '';
    if (s.ambientEnabled) {
      paramsBlock = `Apply GatewayParameters (bypass inbound capture so external clients can reach the gateway through Ambient):

\`\`\`bash
kubectl --context=${ctx} apply -f - <<EOF
${toYaml(buildGatewayParametersResource(s))}
EOF
\`\`\`

`;
    }
    gatewaySection = `
Create the Gateway namespace and Gateway resource:

\`\`\`bash
kubectl --context=${ctx} create namespace ${gwNs} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
\`\`\`

${paramsBlock}\`\`\`bash
kubectl --context=${ctx} apply -f - <<EOF
${toYaml(buildGatewayResource(s, env))}
EOF
\`\`\`
`;
  }

  let telemetrySection = '';
  if (s.telemetryGatewayName) {
    const blocks = buildTelemetryResources(s)
      .map(
        r => `\`\`\`bash
kubectl --context=${ctx} apply -f - <<EOF
${toYaml(r)}
EOF
\`\`\``
      )
      .join('\n\n');
    telemetrySection = `
Apply OTel telemetry policies (access logs and tracing) for gateway \`${s.telemetryGatewayName}\`:

${blocks}
`;
  }

  return `Install kgateway ${mode} (\`$KGATEWAY_VERSION\`) on the **${clusterName}** cluster as the Kubernetes Gateway API ingress controller.
${ambientSection}
Install the kgateway CRDs chart:

\`\`\`bash
helm upgrade -i ${s.crdsRelease} ${s.registry}/${s.crdsRelease} \\
  --kube-context=${ctx} \\
  -n ${ns} \\
  --create-namespace \\
  --version $KGATEWAY_VERSION \\
  --wait
\`\`\`

Install the kgateway controller chart:

\`\`\`bash
${mainHelm}
\`\`\`

Wait for the controller to be ready:

\`\`\`bash
kubectl --context=${ctx} rollout status deploy/${s.mainRelease} -n ${ns} --timeout=120s
\`\`\`
${gatewaySection}${telemetrySection}`;
}

export function cleanup(addonCfg, clusterName) {
  const s = settings(addonCfg);
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const ns = s.namespace;
  const lines = [];

  if (s.gateway) {
    lines.push(
      `kubectl --context=${ctx} delete gateway ${s.gateway.name} -n ${s.gateway.namespace} --ignore-not-found=true`
    );
    if (s.ambientEnabled) {
      const paramsKind = s.enterprise ? 'enterprisekgatewayparameters' : 'gatewayparameters';
      lines.push(
        `kubectl --context=${ctx} delete ${paramsKind} ${s.gatewayParametersName} -n ${s.gateway.namespace} --ignore-not-found=true`
      );
    }
  }

  if (s.telemetryGatewayName) {
    const gwNs = s.telemetryGatewayNamespace;
    lines.push(
      `kubectl --context=${ctx} delete listenerpolicy otel-logging-policy -n ${gwNs} --ignore-not-found=true`,
      `kubectl --context=${ctx} delete listenerpolicy otel-tracing-policy -n ${gwNs} --ignore-not-found=true`,
      `kubectl --context=${ctx} delete referencegrant allow-otel-collector-logs-access -n ${s.logsCollectorNamespace} --ignore-not-found=true`,
      `kubectl --context=${ctx} delete referencegrant allow-otel-collector-traces-access -n ${s.tracesCollectorNamespace} --ignore-not-found=true`
    );
  }

  lines.push(
    `helm uninstall ${s.mainRelease} ${s.crdsRelease} -n ${ns} --kube-context=${ctx}`,
    `kubectl --context=${ctx} delete namespace ${ns} --ignore-not-found=true`
  );

  return `\`\`\`bash\n${lines.join('\n')}\n\`\`\``;
}
