// addons/solo-ui/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v)) ? v : fb

/** Merge profile addon `config:` block (same flattening as installer.js). */
const addonSettings = (addonCfg) =>
  addonCfg?.config && typeof addonCfg.config === 'object'
    ? { ...addonCfg, ...addonCfg.config }
    : addonCfg

export function envVarsFor(_addonCfg, _clusterName) {
  return [
    { name: 'ENTERPRISE_ISTIO_LICENSE', description: 'Solo.io license key (also used for Solo UI)', required: true },
  ];
}

export function envExportsFor(addonCfg, _profile, env) {
  const addon = addonSettings(addonCfg);
  const mode = addon.mode || 'management';
  if (mode === 'relay') return [];
  const hostname = tpl(addon.hostname, env.spec.domains?.soloUI) || 'soloui.example.com';
  const version = addon.version || '0.4.3';
  return [
    { name: 'SOLO_UI_VERSION', value: version, comment: 'Solo UI chart version' },
    { name: 'SOLO_UI_HOSTNAME', value: hostname, comment: 'Solo UI public hostname' },
    { name: 'SOLO_UI_NAMESPACE', value: addon.namespace || 'solo-enterprise', comment: 'Solo UI namespace' },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const mode = addonSettings(addonCfg).mode || 'management';
  if (mode === 'relay') return _generateRelay(addonCfg, clusterName, env);
  return _generateManagement(addonCfg, clusterName, env);
}

function _generateManagement(addonCfg, clusterName, env) {
  const addon = addonSettings(addonCfg);
  const ns = addon.namespace || 'solo-enterprise';
  const version = addon.version || '0.4.3';
  const hostname = tpl(addon.hostname, env.spec.domains?.soloUI) || 'soloui.example.com';
  const oidc = addon.oidc || {};
  const storageClass = addon.clickhouse?.persistentVolume?.storageClass || 'gp3';
  const storageSize = addon.clickhouse?.persistentVolume?.size || '100Gi';
  const products = addon.products || {};
  const telNs = addon.telemetryNamespace || 'telemetry';
  const tls = addon.tls || {};

  const keycloakHostname = env.spec?.domains?.keycloak || '$KEYCLOAK_HOSTNAME';
  const oidcIssuerUrl = tpl(oidc.issuerUrl, null)
    || (oidc.issuerUrl || '').replace(/\{\{env\.domains\.keycloak\}\}/g, keycloakHostname);

  // OCI chart URLs — no helm repo add needed
  const crdsChartOci = 'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management-crds';
  const mgmtChartOci = 'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management';

  // OIDC secret + helm flags (index.js pattern: clientSecret in k8s secret, not direct helm flag)
  const oidcSecretBlock = oidc.enabled ? `
Create OIDC backend client secret:

\`\`\`bash
kubectl create secret generic ui-backend-oidc-secret \\
  --from-literal=clientSecret="${oidc.backendClientSecret || ''}" \\
  --namespace ${ns} \\
  --dry-run=client -o yaml \\
  | kubectl apply -f -
\`\`\`
` : '';

  const oidcArgs = oidc.enabled ? [
    `  --set oidc.issuer="${oidcIssuerUrl}"`,
    `  --set ui.backend.oidc.clientId="${oidc.backendClientId || ''}"`,
    `  --set ui.backend.oidc.secretRef=ui-backend-oidc-secret`,
    `  --set ui.frontend.oidc.clientId="${oidc.frontendClientId || ''}"`,
    `  --set rbac.roleMapping.roleMappings.admins=global.Admin`,
    `  --set rbac.roleMapping.roleMappings.readers=global.Reader`,
    `  --set rbac.roleMapping.roleMappings.writers=global.Writer`,
  ] : [];

  const helmArgs = [
    `  ${mgmtChartOci}`,
    `  --namespace ${ns}`,
    `  --create-namespace`,
    `  --version $SOLO_UI_VERSION`,
    `  --set licensing.licenseKey="$ENTERPRISE_ISTIO_LICENSE"`,
    `  --set management-crds.enabled=false`,
    `  --set ui.hostname=${hostname}`,
    `  --set telemetry.namespace=${telNs}`,
    `  --set clickhouse.persistence.storageClass=${storageClass}`,
    `  --set clickhouse.persistence.size=${storageSize}`,
    `  --set products.mesh.enabled=${products.mesh?.enabled === true}`,
    ...oidcArgs,
    `  --wait`,
    `  --timeout 10m`,
  ];
  const helmCmd = `helm upgrade --install solo-ui \\\n${helmArgs.map(a => `${a} \\`).join('\n').replace(/ \\$/, '')}`;

  // HTTPS resources when TLS is enabled
  let httpsBlock = '';
  if (hostname && tls.enabled) {
    const tlsSecret = tls.secretName || 'solo-ui-tls';
    const tlsIssuer = tls.issuer || 'letsencrypt-dns';
    httpsBlock = `
Apply HTTPS resources (Certificate, Gateway, HTTPRoute):

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${tlsSecret}
  namespace: ${ns}
spec:
  secretName: ${tlsSecret}
  issuerRef:
    name: ${tlsIssuer}
    kind: ClusterIssuer
  dnsNames:
    - ${hostname}
EOF

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: solo-enterprise-ui-https
  namespace: ${ns}
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: ${hostname}
      tls:
        mode: Terminate
        certificateRefs:
          - name: ${tlsSecret}
            kind: Secret
      allowedRoutes:
        namespaces:
          from: All
EOF

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: solo-enterprise-ui
  namespace: ${ns}
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: solo-enterprise-ui-https
      namespace: ${ns}
  hostnames:
    - ${hostname}
  rules:
    - backendRefs:
        - name: solo-enterprise-ui
          port: 80
      matches:
        - path:
            type: PathPrefix
            value: /
EOF
\`\`\``;
  }

  return `Install Solo UI in **management** mode on the **${clusterName}** cluster.

Label namespace for Ambient mesh:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`
${oidcSecretBlock}
Install management CRDs chart:

\`\`\`bash
helm upgrade --install solo-ui-crds ${crdsChartOci} \\
  --namespace ${ns} \\
  --version $SOLO_UI_VERSION \\
  --create-namespace \\
  --wait \\
  --timeout 5m
\`\`\`

Install Solo UI management chart:

\`\`\`bash
${helmCmd}
\`\`\`
${httpsBlock}`;
}

function _generateRelay(addonCfg, clusterName, _env) {
  const addon = addonSettings(addonCfg);
  const ns = addon.namespace || 'solo-enterprise';
  const tunnel = addon.tunnel || {};
  const telemetry = addon.telemetry || {};

  // OCI chart URL — no helm repo add needed
  const relayChartOci = 'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/relay';

  return `Install Solo UI in **relay** mode on the **${clusterName}** cluster. Connects to the management plane on the east cluster via ambient mesh \`mesh.internal\` DNS.

Label namespace for Ambient mesh:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`

\`\`\`bash
helm upgrade --install solo-relay ${relayChartOci} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version $SOLO_UI_VERSION \\
  --set tunnel.fqdn="${tunnel.fqdn || ''}" \\
  --set tunnel.port=${tunnel.port || 9000} \\
  --set telemetry.fqdn="${telemetry.fqdn || ''}" \\
  --set cluster=${clusterName} \\
  --wait \\
  --timeout 5m
\`\`\``;
}

export function cleanup(addonCfg, _clusterName) {
  const ns = addonCfg.namespace || 'solo-enterprise';
  const mode = addonCfg.mode || 'management';
  const releases = mode === 'relay' ? 'solo-relay' : 'solo-ui solo-ui-crds';
  return `\`\`\`bash
helm uninstall ${releases} -n ${ns}
\`\`\``;
}
