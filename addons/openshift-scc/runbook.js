// addons/openshift-scc/runbook.js

// Profile addon entries nest their fields under `config:` (flattened onto the addon by
// the real installer before use - see installer.js#installAddons). The runbook pipeline
// doesn't do this flattening itself, so every sidecar that reads config fields must.
function flatten(addonCfg) {
  return addonCfg?.config && typeof addonCfg.config === 'object'
    ? { ...addonCfg, ...addonCfg.config }
    : addonCfg;
}

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(_addonCfg, _profile, _env) {
  return [];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const cfg = flatten(addonCfg);
  const ns = cfg.namespace || 'kube-system';
  const scc = cfg.scc || 'privileged';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  return `Grant the ${scc} SecurityContextConstraint to every ServiceAccount in **${ns}** on the **${clusterName}** cluster - required for Istio ambient's istio-cni/ztunnel node agents on OpenShift/ROSA.

\`\`\`bash
oc --context=${ctx} adm policy add-scc-to-group ${scc} system:serviceaccounts:${ns}
\`\`\`

Enable OVN-Kubernetes local gateway mode (\`routingViaHost\`) cluster-wide - required so kubelet liveness/readiness probe traffic reaches pods directly instead of being pulled into ztunnel's ambient datapath and dropped:

\`\`\`bash
oc --context=${ctx} patch networks.operator.openshift.io cluster --type=merge \\
  -p '{"spec":{"defaultNetwork":{"ovnKubernetesConfig":{"gatewayConfig":{"routingViaHost":true}}}}}'
oc --context=${ctx} wait clusteroperator/network --for=condition=Progressing=false --timeout=600s
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const cfg = flatten(addonCfg);
  const ns = cfg.namespace || 'kube-system';
  const scc = cfg.scc || 'privileged';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
oc --context=${ctx} adm policy remove-scc-from-group ${scc} system:serviceaccounts:${ns}
\`\`\``;
}
