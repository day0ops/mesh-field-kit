// addons/cilium/runbook.js

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    { name: 'CILIUM_VERSION', value: addonCfg.version || '1.19.4', comment: 'Cilium CNI version' },
  ];
}

export async function generate(_subIndex, addonCfg, _clusterName, _profile, _env) {
  const addon =
    addonCfg?.config && typeof addonCfg.config === 'object'
      ? { ...addonCfg, ...addonCfg.config }
      : addonCfg;
  const mode = addon.mode || 'chaining';
  const chainingTarget = addon.chainingTarget || 'aws-cni';
  const healthProbe = addon.enableHealthProbePolicy ? '\n  --set healthChecking=true \\' : '';

  return `Install Cilium as eBPF-based CNI in ${mode} mode on **all clusters**.

\`\`\`bash
helm repo add cilium https://helm.cilium.io/
helm repo update

# Run on each cluster context
helm upgrade --install cilium cilium/cilium \\
  --version $CILIUM_VERSION \\
  --namespace kube-system \\
  --set cni.chainingMode=${chainingTarget} \\
  --set cni.exclusive=false \\
  --set enableIPv4Masquerade=false \\
  --set routingMode=native \\
  --set hostLegacyRouting=true \\${healthProbe}
  --wait
\`\`\``;
}

export function cleanup(_addonCfg, _clusterName) {
  return `\`\`\`bash
helm uninstall cilium -n kube-system
\`\`\``;
}
