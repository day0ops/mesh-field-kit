// addons/redpanda/runbook.js

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(_addonCfg, _profile, _env) {
  return [];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const ns = addonCfg.namespace || 'redpanda';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  return `## Redpanda\n\nInstall a single-node dev-mode Redpanda broker from the bundled local chart:\n\n\`\`\`bash\nkubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -\nhelm upgrade -i redpanda addons/redpanda/config/chart -n ${ns} --wait --timeout 5m --kube-context=${ctx}\n\`\`\`\n\nBroker is reachable in-cluster at \`redpanda.${ns}.svc.cluster.local:9092\`.`;
}
