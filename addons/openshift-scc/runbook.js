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
