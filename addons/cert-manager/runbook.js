// addons/cert-manager/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, env) {
  const exports = [
    {
      name: 'CERT_MANAGER_VERSION',
      value: addonCfg.version || '1.20.2',
      comment: 'cert-manager version',
    },
  ];
  const letsencrypt = addonCfg.config?.letsencrypt;
  if (letsencrypt?.enabled) {
    exports.push({
      name: 'ACME_EMAIL',
      value: tpl(letsencrypt.email, env.spec.acme?.email || '<your-email@example.com>'),
      comment: 'ACME/LetsEncrypt email for certificate issuance',
    });
  }
  return exports;
}

export async function generate(_subIndex, addonCfg, _clusterName, _profile, env) {
  const version = addonCfg.version || '1.20.2';
  const ns = addonCfg.namespace || 'cert-manager';
  const letsencrypt = addonCfg.config?.letsencrypt;

  const selfSignedIssuer = `

Create a self-signed ClusterIssuer (used for bootstrapping and internal certs):

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
EOF
\`\`\``;

  let clusterIssuer = selfSignedIssuer;
  if (letsencrypt?.enabled) {
    const email = tpl(letsencrypt.email, env.spec.acme?.email) || '$ACME_EMAIL';
    const region = tpl(letsencrypt.region, env.spec.aws?.region) || '$AWS_REGION';
    clusterIssuer += `

Create the Route53 DNS ClusterIssuer for Let's Encrypt:

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns
spec:
  acme:
    email: ${email}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-dns-key
    solvers:
      - dns01:
          route53:
            region: ${region}
EOF
\`\`\``;
  }

  return `Install cert-manager for TLS certificate management on **all clusters**.

\`\`\`bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Run on each cluster — repeat with the appropriate --kube-context flag
helm upgrade --install cert-manager jetstack/cert-manager \\
  --namespace ${ns} \\
  --create-namespace \\
  --version v$CERT_MANAGER_VERSION \\
  --set crds.enabled=true \\
  --wait
\`\`\`
${clusterIssuer}`;
}

export function cleanup(addonCfg, _clusterName) {
  const ns = addonCfg.namespace || 'cert-manager';
  return `\`\`\`bash
helm uninstall cert-manager -n ${ns}
\`\`\``;
}
