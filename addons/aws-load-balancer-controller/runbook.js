// addons/aws-load-balancer-controller/runbook.js

// Profile addon entries nest their fields under `config:` (flattened onto the addon by
// the real installer before use - see installer.js#installAddons). The runbook pipeline
// doesn't do this flattening itself, so every sidecar that reads config fields must.
function flatten(addonCfg) {
  return addonCfg?.config && typeof addonCfg.config === 'object'
    ? { ...addonCfg, ...addonCfg.config }
    : addonCfg;
}

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    {
      name: 'AWS_LOAD_BALANCER_CONTROLLER_VERSION',
      value: addonCfg.version || '3.5.0',
      comment: 'aws-load-balancer-controller chart version',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const cfg = flatten(addonCfg);
  const ns = cfg.namespace || 'kube-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  const clusterNameValue = tpl(cfg.clusterName, '<eks-cluster-name>');
  const roleArn = tpl(cfg.serviceAccountRoleArn, '<alb-controller-irsa-role-arn>');
  const vpcId = tpl(cfg.vpcId, null);

  const vpcIdFlag = vpcId
    ? ` \\
  --set vpcId=${vpcId}`
    : '';
  const clusterTagCheckFlag = cfg.disableSubnetClusterTagCheck
    ? ` \\
  --set controllerConfig.featureGates.SubnetsClusterTagCheck=false`
    : '';

  return `Install the AWS Load Balancer Controller on the **${clusterName}** cluster.

\`\`\`bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --version $AWS_LOAD_BALANCER_CONTROLLER_VERSION \\
  --set clusterName=${clusterNameValue} \\
  --set serviceAccount.annotations."eks\\.amazonaws\\.com/role-arn"=${roleArn}${vpcIdFlag}${clusterTagCheckFlag} \\
  --wait
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const cfg = flatten(addonCfg);
  const ns = cfg.namespace || 'kube-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
helm uninstall aws-load-balancer-controller -n ${ns} --kube-context ${ctx}
\`\`\``;
}
