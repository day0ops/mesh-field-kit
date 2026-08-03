// src/lib/runbook-adapters/install.js
import { dump as yamlDump } from 'js-yaml';
import { ConfigResolver } from '../config-resolver.js';

// Mirrors installer.js constants
const CHART_MAP = {
  base: 'base',
  istiod: 'istiod',
  cni: 'cni',
  ztunnel: 'ztunnel',
  'peering-eastwest': 'peering',
};

const RELEASE_NAME_MAP = {
  base: 'istio-base',
  istiod: 'istiod',
  cni: 'istio-cni',
  ztunnel: 'ztunnel',
  'peering-eastwest': 'peering-eastwest',
};

const NAMESPACE_MAP = {
  'peering-eastwest': 'istio-eastwest',
};

// Installed in a deferred post phase — not per-cluster during main loop
const DEFERRED = new Set(['peering-remote']);

function deepMerge(target, source) {
  if (!source) return { ...target };
  if (!target) return { ...source };
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const s = source[key];
    const t = result[key];
    if (Array.isArray(s)) {
      result[key] = [...s];
    } else if (s && typeof s === 'object' && !Array.isArray(s)) {
      result[key] = deepMerge(t && typeof t === 'object' ? t : {}, s);
    } else {
      result[key] = s;
    }
  }
  return result;
}

function resolveTemplates(obj, clusterName) {
  const resolved = JSON.stringify(obj).replace(/\{\{cluster\.name\}\}/g, clusterName);
  return JSON.parse(resolved);
}

function buildBaseValues(componentName, { istioRepo, istioTag, meshProfile, ns }, clusterName) {
  switch (componentName) {
    case 'base':
      return { defaultRevision: 'stable', profile: meshProfile };
    case 'istiod':
      return {
        global: {
          hub: istioRepo,
          tag: istioTag,
          network: clusterName,
          proxy: { clusterDomain: 'cluster.local' },
        },
        profile: meshProfile,
        license: { value: '$ENTERPRISE_ISTIO_LICENSE' },
      };
    case 'cni':
      return {
        ambient: { dnsCapture: true },
        excludeNamespaces: [ns, 'kube-system'],
        global: { hub: istioRepo, tag: istioTag },
        profile: meshProfile,
      };
    case 'ztunnel':
      return {
        hub: istioRepo,
        tag: istioTag,
        profile: meshProfile,
        istioNamespace: ns,
        namespace: ns,
        enabled: true,
        configValidation: true,
        network: clusterName,
        env: { L7_ENABLED: 'true' },
        proxy: { clusterDomain: 'cluster.local' },
        terminationGracePeriodSeconds: 29,
        variant: 'distroless',
      };
    case 'peering-eastwest':
      return { eastwest: { create: true, deployment: {} } };
    default:
      return {};
  }
}

export class InstallAdapter {
  envVars(_selection) {
    return [];
  }
  envExports(_selection) {
    return [];
  }

  generate(labNum, selection) {
    const { profile, infraProfile } = selection;
    const mesh = profile.spec?.mesh || {};
    const clusters = infraProfile.spec?.clusters || [];
    const isMultiCluster = clusters.length > 1;

    const ns = 'istio-system';
    const istioRepo = mesh.image?.istioRepo || 'us-docker.pkg.dev/soloio-img/istio';
    const helmIstioRepo = mesh.image?.helmIstioRepo || 'us-docker.pkg.dev/soloio-img/istio-helm';
    const istioVersion = mesh.istioVersion || '';
    const istioTag = mesh.image?.tag || (istioVersion ? `${istioVersion}-solo` : '');
    const gatewayApiVersion = mesh.gatewayApiVersion || 'v1.5.0';
    const meshProfile = mesh.profile || 'ambient';
    const certMode = mesh.certificates?.mode || 'self-signed';
    const peeringMethod = mesh.peering || 'helm';

    const cfg = { istioRepo, helmIstioRepo, istioTag, meshProfile, ns };

    // Normalise components list from profile
    const rawComponents = (mesh.components || []).map(c =>
      typeof c === 'string' ? { name: c, values: {} } : { name: c.name, values: c.values || {} }
    );

    const sections = [];

    // ── Gateway API CRDs ────────────────────────────────────────────────────
    sections.push(`### Install Gateway API CRDs

\`\`\`bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${gatewayApiVersion}/standard-install.yaml
\`\`\``);

    // ── Certificate setup (multicluster) ────────────────────────────────────
    if (isMultiCluster) {
      sections.push(this._certSection(certMode, clusters, ns));
    }

    // ── Per-cluster install ──────────────────────────────────────────────────
    for (const cluster of clusters) {
      sections.push(this._clusterSection(cluster, rawComponents, cfg, isMultiCluster));
    }

    // ── Multicluster linking ─────────────────────────────────────────────────
    if (isMultiCluster) {
      sections.push(this._multiclusterSection(clusters, rawComponents, cfg, peeringMethod));
    }

    const label = ConfigResolver.meshModeLabel(rawComponents.map(c => c.name));

    return `## Lab ${labNum} — Install ${label}

Install Solo Istio ${istioVersion}${istioVersion ? ' ' : ''}in ${label === 'Istio Ambient' ? 'ambient' : 'sidecar'} mode on all clusters using Helm.

${sections.join('\n\n')}`;
  }

  // ── Certificate setup ──────────────────────────────────────────────────────

  _certSection(certMode, clusters, ns) {
    if (certMode === 'self-signed') {
      const clusterBlocks = clusters
        .map(c => {
          const ctx = `$${c.name.toUpperCase()}_CONTEXT`;
          return `# ${c.name}
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} delete secret cacerts -n ${ns} --ignore-not-found=true
kubectl --context=${ctx} create secret generic cacerts -n ${ns} \\
  --from-file=certs/${c.name}/ca-cert.pem \\
  --from-file=certs/${c.name}/ca-key.pem \\
  --from-file=certs/${c.name}/root-cert.pem \\
  --from-file=certs/${c.name}/cert-chain.pem`;
        })
        .join('\n\n');

      const clusterCertGen = clusters
        .map(
          c => `
# Intermediate CA — ${c.name}
mkdir -p certs/${c.name}
cat > certs/${c.name}/ca-ext.cnf <<'EOF'
basicConstraints=CA:true,pathlen:0
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl genrsa -out certs/${c.name}/ca-key.pem 4096
openssl req -new -sha256 -key certs/${c.name}/ca-key.pem \\
  -out certs/${c.name}/ca-csr.pem \\
  -subj "/O=Istio/CN=Intermediate CA - ${c.name}"
openssl x509 -req -days 3650 -sha256 \\
  -CA certs/root-cert.pem -CAkey certs/root-key.pem -CAcreateserial \\
  -in certs/${c.name}/ca-csr.pem -out certs/${c.name}/ca-cert.pem \\
  -extfile certs/${c.name}/ca-ext.cnf
cat certs/${c.name}/ca-cert.pem certs/root-cert.pem > certs/${c.name}/cert-chain.pem
cp certs/root-cert.pem certs/${c.name}/root-cert.pem`
        )
        .join('\n');

      return `### Set Up Shared Root of Trust

Generate a shared root CA and per-cluster intermediate CAs. The \`cacerts\` secret must exist in \`${ns}\` before istiod starts.

\`\`\`bash
mkdir -p certs

# Shared root CA
openssl genrsa -out certs/root-key.pem 4096
openssl req -new -x509 -days 3650 -key certs/root-key.pem -sha256 \\
  -out certs/root-cert.pem -subj "/O=Istio/CN=Root CA"
${clusterCertGen}
\`\`\`

Apply \`cacerts\` secret to each cluster before installing istiod:

\`\`\`bash
${clusterBlocks}
\`\`\``;
    }

    // cert-manager mode
    const clusterBlocks = clusters
      .map(c => {
        const ctx = `$${c.name.toUpperCase()}_CONTEXT`;
        return `# ${c.name}
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} create secret tls istio-root-ca-secret -n ${ns} \\
  --cert=/tmp/ambient-root-ca-cert.pem --key=/tmp/ambient-root-ca-key.pem
kubectl --context=${ctx} apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: istio-root-ca
  namespace: ${ns}
spec:
  ca:
    secretName: istio-root-ca-secret
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: istio-cacerts
  namespace: ${ns}
spec:
  secretName: cacerts
  duration: 87600h
  renewBefore: 720h
  isCA: true
  commonName: "Intermediate CA - ${c.name}"
  subject:
    organizations: [Istio]
    localities: [${c.name}]
  issuerRef:
    name: istio-root-ca
    kind: Issuer
    group: cert-manager.io
  secretTemplate:
    labels:
      istio.io/key-and-cert: "true"
  privateKey:
    algorithm: RSA
    size: 4096
EOF
kubectl --context=${ctx} wait secret/cacerts -n ${ns} --for=jsonpath='{.data}' --timeout=120s`;
      })
      .join('\n\n');

    return `### Set Up Shared Root of Trust (cert-manager)

\`\`\`bash
# Shared root CA key pair (local only — key deleted after distribution)
openssl genrsa -out /tmp/ambient-root-ca-key.pem 4096
openssl req -new -x509 -key /tmp/ambient-root-ca-key.pem \\
  -out /tmp/ambient-root-ca-cert.pem -days 3650 -subj "/O=Istio/CN=Root CA"
\`\`\`

Create cert-manager resources on each cluster:

\`\`\`bash
${clusterBlocks}
\`\`\`

\`\`\`bash
rm /tmp/ambient-root-ca-key.pem /tmp/ambient-root-ca-cert.pem
\`\`\``;
  }

  // ── Per-cluster installation ───────────────────────────────────────────────

  _clusterSection(cluster, rawComponents, cfg, _isMultiCluster) {
    const { helmIstioRepo, istioTag, ns } = cfg;
    const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
    const installable = rawComponents.filter(c => !DEFERRED.has(c.name) && CHART_MAP[c.name]);

    const helmBlocks = installable.map(comp => {
      const chart = CHART_MAP[comp.name];
      const release = RELEASE_NAME_MAP[comp.name];
      const compNs = NAMESPACE_MAP[comp.name] || ns;

      const baseVals = buildBaseValues(comp.name, cfg, cluster.name);
      const profileVals = resolveTemplates(comp.values, cluster.name);
      const mergedVals = deepMerge(baseVals, profileVals);
      const valuesYaml = yamlDump(mergedVals, {
        lineWidth: 120,
        quotingType: '"',
        forceQuotes: false,
      })
        .trimEnd()
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n');

      return `# ${comp.name}
helm upgrade --install ${release} oci://${helmIstioRepo}/${chart} \\
  --kube-context=${ctx} \\
  --namespace ${compNs} \\
  --create-namespace \\
  --version ${istioTag} \\
  --wait \\
  --timeout 10m \\
  -f - <<'EOF'
${valuesYaml}
EOF`;
    });

    const networkLabel = `kubectl --context=${ctx} label namespace ${ns} \\
  topology.istio.io/network=${cluster.name} --overwrite`;

    return `### Install on \`${cluster.name}\`

\`\`\`bash
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
\`\`\`

\`\`\`bash
${helmBlocks.join('\n\n')}
\`\`\`

Label namespace with network topology:

\`\`\`bash
${networkLabel}
\`\`\``;
  }

  // ── Multicluster linking ───────────────────────────────────────────────────

  _multiclusterSection(clusters, rawComponents, cfg, peeringMethod) {
    const { helmIstioRepo, istioTag } = cfg;
    const peeringRemote = rawComponents.find(c => c.name === 'peering-remote');

    const sections = [];

    if (peeringMethod === 'helm' && peeringRemote) {
      // helm peering-remote chart installed on each cluster pointing to all others
      const helmBlocks = clusters
        .map(cluster => {
          const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
          const profileVals = resolveTemplates(peeringRemote.values || {}, cluster.name);
          const valuesYaml = yamlDump(profileVals, { lineWidth: 120 })
            .trimEnd()
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n');

          return `# peering-remote on ${cluster.name}
helm upgrade --install peering-remote oci://${helmIstioRepo}/peering \\
  --kube-context=${ctx} \\
  --namespace istio-eastwest \\
  --create-namespace \\
  --version ${istioTag} \\
  --wait \\
  -f - <<'EOF'
${valuesYaml}
EOF`;
        })
        .join('\n\n');

      sections.push(`### Link Clusters (Helm Peering)

\`\`\`bash
${helmBlocks}
\`\`\``);
    } else {
      // East-west gateway (istioctl method)
      const gwBlocks = clusters
        .map(c => {
          const ctx = `$${c.name.toUpperCase()}_CONTEXT`;
          return `# ${c.name}
kubectl --context=${ctx} create namespace istio-eastwest --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
istioctl --context=${ctx} install -y -f - <<'EOF'
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  profile: empty
  components:
    ingressGateways:
      - name: istio-eastwest
        label:
          istio: eastwestgateway
          app: istio-eastwestgateway
          topology.istio.io/network: ${c.name}
        enabled: true
        k8s:
          env:
            - name: ISTIO_META_ROUTER_MODE
              value: sni-dnat
            - name: ISTIO_META_REQUESTED_NETWORK_VIEW
              value: ${c.name}
          service:
            ports:
              - name: status-port
                port: 15021
                targetPort: 15021
              - name: tls
                port: 15443
                targetPort: 15443
              - name: tls-istiod
                port: 15012
                targetPort: 15012
              - name: tls-webhook
                port: 15017
                targetPort: 15017
EOF`;
        })
        .join('\n\n');

      sections.push(`### Deploy East-West Gateways

\`\`\`bash
${gwBlocks}
\`\`\``);

      sections.push(`### Exchange Service Accounts and Link Clusters

\`\`\`bash
${clusters
  .flatMap(src =>
    clusters
      .filter(dst => dst.name !== src.name)
      .map(
        dst =>
          `istioctl x create-remote-secret --context=$${src.name.toUpperCase()}_CONTEXT \\
  --name=${src.name} | kubectl --context=$${dst.name.toUpperCase()}_CONTEXT apply -f -`
      )
  )
  .join('\n')}
\`\`\``);
    }

    return sections.join('\n\n');
  }

  cleanup(_selection) {
    return '';
  }
}
