// addons/calico/runbook.js

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    {
      name: 'CALICO_VERSION',
      value: addonCfg.version || '3.32.1',
      comment: 'Calico (Tigera operator) chart version',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const addon =
    addonCfg?.config && typeof addonCfg.config === 'object'
      ? { ...addonCfg, ...addonCfg.config }
      : addonCfg;
  const version = addon.version || '3.32.1';
  const mode = addon.mode || 'chaining';
  const chainingTarget = addon.chainingTarget || 'AmazonVPC';
  const kubernetesProvider = addon.kubernetesProvider || 'EKS';

  const installationValues =
    mode === 'primary'
      ? `--set installation.kubernetesProvider="" \\
  --set installation.cni.type=Calico \\`
      : `--set installation.kubernetesProvider=${kubernetesProvider} \\
  --set installation.cni.type=${chainingTarget} \\`;

  return `Install Calico (via the Tigera operator) in ${mode} mode on **all clusters**.

\`\`\`bash
helm repo add projectcalico https://docs.tigera.io/calico/charts
helm repo update

# Run on each cluster context
helm upgrade --install calico projectcalico/tigera-operator \\
  --version $CALICO_VERSION \\
  --namespace tigera-operator \\
  --create-namespace \\
  ${installationValues}
  --wait
\`\`\``;
}

export function cleanup(_addonCfg, _clusterName) {
  return `\`\`\`bash
helm uninstall calico -n tigera-operator
\`\`\``;
}
