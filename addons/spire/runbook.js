// addons/spire/runbook.js

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    {
      name: 'SPIRE_VERSION',
      value: addonCfg.spireVersion || '0.24.2',
      comment: 'SPIRE Helm chart version',
    },
    {
      name: 'SPIRE_CRDS_VERSION',
      value: addonCfg.spireCrdsVersion || '0.5.0',
      comment: 'SPIRE CRDs Helm chart version',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const ns = addonCfg.spireNamespace || 'spire-server';
  const trustDomain = addonCfg.trustDomain || clusterName;
  const certMode = addonCfg.certMode || 'self-signed';
  const spireVersion = addonCfg.spireVersion || '0.24.2';
  const spireCrdsVersion = addonCfg.spireCrdsVersion || '0.5.0';

  const certSection =
    certMode === 'self-signed'
      ? `
Generate SPIRE upstream CA certificates using openssl:

\`\`\`bash
mkdir -p /tmp/spire-certs/${trustDomain}

# Generate root CA
openssl genrsa -out /tmp/spire-certs/root-key.pem 2048
openssl req -new -x509 -days 3650 -key /tmp/spire-certs/root-key.pem \\
  -out /tmp/spire-certs/root-cert.pem -subj "/CN=SPIRE Root CA"

# Generate intermediate CA for this cluster
openssl genrsa -out /tmp/spire-certs/${trustDomain}/ca.key 2048
openssl req -new -key /tmp/spire-certs/${trustDomain}/ca.key \\
  -out /tmp/spire-certs/${trustDomain}/ca.csr \\
  -subj "/CN=SPIRE Intermediate CA"
openssl x509 -req -in /tmp/spire-certs/${trustDomain}/ca.csr \\
  -CA /tmp/spire-certs/root-cert.pem -CAkey /tmp/spire-certs/root-key.pem \\
  -CAcreateserial -out /tmp/spire-certs/${trustDomain}/ca.crt -days 1825

# Build cert chain
cat /tmp/spire-certs/${trustDomain}/ca.crt /tmp/spire-certs/root-cert.pem \\
  > /tmp/spire-certs/${trustDomain}/ca-chain.pem

# Create namespace and secret
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl delete secret spiffe-upstream-ca -n ${ns} --ignore-not-found=true
kubectl create secret generic spiffe-upstream-ca -n ${ns} \\
  --from-file=tls.crt=/tmp/spire-certs/${trustDomain}/ca.crt \\
  --from-file=tls.key=/tmp/spire-certs/${trustDomain}/ca.key \\
  --from-file=bundle.crt=/tmp/spire-certs/${trustDomain}/ca-chain.pem
\`\`\``
      : certMode === 'cert-manager'
        ? `
Create the SPIRE upstream CA certificate using cert-manager:

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: spire-upstream-ca
  namespace: ${ns}
spec:
  secretName: spire-upstream-ca-cm
  isCA: true
  commonName: "SPIRE Intermediate CA - ${trustDomain}"
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
    group: cert-manager.io
  privateKey:
    algorithm: RSA
    size: 2048
EOF
\`\`\`

Wait for the secret to be created:

\`\`\`bash
kubectl wait --for=jsonpath='{.data.tls\\.crt}' secret/spire-upstream-ca-cm -n ${ns} --timeout=60s
\`\`\``
        : `
Copy your pre-existing CA cert files and create the \`spiffe-upstream-ca\` secret:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic spiffe-upstream-ca -n ${ns} \\
  --from-file=tls.crt=<path-to-ca.crt> \\
  --from-file=tls.key=<path-to-ca.key> \\
  --from-file=bundle.crt=<path-to-ca-chain.pem>
\`\`\``;

  return `Install SPIRE for workload identity attestation in the ambient mesh on **${trustDomain}**.
${certSection}

Add the SPIRE Helm repository and install the charts:

\`\`\`bash
helm repo add spire https://spiffe.github.io/helm-charts-hardened/
helm repo update spire

helm upgrade -i spire-crds spire/spire-crds \\
  --namespace ${ns} \\
  --create-namespace \\
  --version ${spireCrdsVersion} \\
  --wait

helm upgrade -i spire spire/spire \\
  --namespace ${ns} \\
  --version ${spireVersion} \\
  -f - <<EOF
global:
  spire:
    trustDomain: ${trustDomain}
spire-agent:
  authorizedDelegates:
    - "spiffe://${trustDomain}/ns/istio-system/sa/ztunnel"
  sockets:
    admin:
      enabled: true
      mountOnHost: true
    hostBasePath: /run/spire/agent/sockets
  tolerations:
    - effect: NoSchedule
      operator: Exists
    - key: CriticalAddonsOnly
      operator: Exists
    - effect: NoExecute
      operator: Exists
spire-server:
  upstreamAuthority:
    disk:
      enabled: true
      secret:
        create: false
        name: "spiffe-upstream-ca"
spiffe-csi-driver:
  tolerations:
    - effect: NoSchedule
      operator: Exists
    - key: CriticalAddonsOnly
      operator: Exists
    - effect: NoExecute
      operator: Exists
EOF
\`\`\`

Verify SPIRE pods are ready:

\`\`\`bash
kubectl -n ${ns} wait --for=condition=Ready pods --all --timeout=300s
\`\`\`

Register ClusterSPIFFEID resources so SPIRE issues identities to ambient workloads:

\`\`\`bash
kubectl apply -f - <<EOF
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-ztunnel-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      app: "ztunnel"
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-waypoint-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      istio.io/gateway-name: waypoint
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-ambient-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      istio.io/dataplane-mode: ambient
EOF
\`\`\``;
}

export function cleanup(addonCfg, _clusterName) {
  const ns = addonCfg.spireNamespace || 'spire-server';
  return `\`\`\`bash
kubectl delete clusterspiffeid istio-ambient-reg istio-waypoint-reg istio-ztunnel-reg --ignore-not-found=true
helm uninstall spire -n ${ns} || true
helm uninstall spire-crds -n ${ns} || true
kubectl delete namespace ${ns} --ignore-not-found=true
\`\`\``;
}
