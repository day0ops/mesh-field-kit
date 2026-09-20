// addons/openshift-scc/runbook.js

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(_addonCfg, _profile, _env) {
  return [];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const ns = addonCfg.namespace || 'kube-system';
  const scc = addonCfg.scc || 'privileged';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  return `Grant the ${scc} SecurityContextConstraint to every ServiceAccount in **${ns}** on the **${clusterName}** cluster - required for Istio ambient's istio-cni/ztunnel node agents on OpenShift/ROSA.

\`\`\`bash
oc --context=${ctx} adm policy add-scc-to-group ${scc} system:serviceaccounts:${ns}
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const ns = addonCfg.namespace || 'kube-system';
  const scc = addonCfg.scc || 'privileged';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
oc --context=${ctx} adm policy remove-scc-from-group ${scc} system:serviceaccounts:${ns}
\`\`\``;
}
