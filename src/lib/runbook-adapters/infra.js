// src/lib/runbook-adapters/infra.js

export class InfraAdapter {
  envVars(selection) {
    const provider = selection?.infraProfile?.spec?.provider || 'eks';
    const isAws = provider.startsWith('eks');
    const vars = [
      {
        name: 'ENTERPRISE_ISTIO_LICENSE',
        description: 'Solo.io Istio enterprise license key',
        required: true,
      },
    ];
    if (isAws) {
      vars.push({
        name: 'AWS_PROFILE',
        description: 'AWS CLI profile configured for the target account',
        required: true,
      });
    }
    return vars;
  }

  envExports(selection) {
    const { infraProfile, environment } = selection;
    const provider = infraProfile.spec.provider || 'eks';
    const isAws = provider.startsWith('eks');
    const exports = [];
    if (isAws) {
      exports.push({
        name: 'AWS_REGION',
        value: environment.spec.aws?.region || 'us-east-1',
        comment: 'AWS region for EKS clusters',
      });
    }
    exports.push({
      name: 'INFRA_NAME',
      value: infraProfile.spec.name,
      comment: 'Terraform infrastructure name',
    });
    return exports;
  }

  generate(labNum, selection) {
    return [
      this._generatePrereqs(labNum, selection),
      this._generateAuth(labNum + 1, selection),
      this._generateProvisioning(labNum + 2, selection),
    ].join('\n\n');
  }

  _generatePrereqs(labNum, selection) {
    const provider = selection.infraProfile?.spec?.provider || 'eks';
    const isAws = provider.startsWith('eks');
    const isGke = provider === 'gke';
    const isAks = provider === 'aks';

    const cliRow = isAws
      ? '| aws CLI | v2.x | https://aws.amazon.com/cli/ |'
      : isGke
        ? '| gcloud CLI | latest | https://cloud.google.com/sdk/docs/install |'
        : isAks
          ? '| azure CLI | latest | https://learn.microsoft.com/en-us/cli/azure/install-azure-cli |'
          : '| cloud CLI | — | See your cloud provider docs |';

    return `## Lab ${labNum} — Prerequisite Tools

Install required CLI tools before proceeding:

| Tool | Minimum Version | Install |
|------|----------------|---------|
| kubectl | v1.33+ | https://kubernetes.io/docs/tasks/tools/ |
| helm | v4.0.0+ | https://helm.sh/docs/intro/install/ |
${cliRow}
| jq | v1.6+ | https://jqlang.org/download/ |`;
  }

  _generateAuth(labNum, selection) {
    const { infraProfile, environment } = selection;
    const provider = infraProfile.spec.provider || 'eks';
    const isAws = provider.startsWith('eks');
    const isGke = provider === 'gke';
    const isAks = provider === 'aks';

    let authSection;
    if (isAws) {
      const region = environment.spec.aws?.region || 'us-east-1';
      authSection = `### AWS Credentials

\`\`\`bash
export AWS_PROFILE="<your-aws-profile>"
aws sso login
\`\`\`

Verify access:

\`\`\`bash
aws sts get-caller-identity --region ${region}
\`\`\``;
    } else if (isGke) {
      const project = environment.spec.gcp?.project || '<your-gcp-project>';
      authSection = `### GCP Credentials

\`\`\`bash
gcloud auth login
gcloud config set project ${project}
\`\`\`

Verify access:

\`\`\`bash
gcloud projects describe ${project}
\`\`\``;
    } else if (isAks) {
      authSection = `### Azure Credentials

\`\`\`bash
az login
\`\`\`

Verify access:

\`\`\`bash
az account show
\`\`\``;
    } else {
      authSection =
        '### Cloud Credentials\n\nAuthenticate with your cloud provider before proceeding.';
    }

    return `## Lab ${labNum} — Cloud Ecosystem Authentication

${authSection}`;
  }

  _generateProvisioning(labNum, selection) {
    const { infraProfile, environment, profile } = selection;
    const infraName = infraProfile.spec.name;
    const provider = infraProfile.spec.provider || 'eks';
    const envDir = `environments/${provider}`;
    const clusters = infraProfile.spec.clusters || [];
    const settings = infraProfile.spec.settings || {};
    const isAws = provider.startsWith('eks');

    // DNS vars if any cluster has external-dns addon
    const allClusterAddons = (profile.spec.addons?.clusters || []).flatMap(c => c.addons || []);
    const hasDns = allClusterAddons.some(a => a.name === 'external-dns');
    const dns = environment.spec.dns || {};
    const dnsVars = hasDns
      ? `
enable_dns          = true
dns_parent_zone_id  = "${dns.parentZone?.hostedZoneId || '<hosted-zone-id>'}"
dns_parent_domain   = "${dns.parentZone?.domain || '<parent-domain>'}"
dns_child_zone_name = "${dns.childZone || '<child-zone>'}"`
      : '';

    const tfvars = isAws
      ? `owner               = "<your-name>"
aws_profile         = "$AWS_PROFILE"
eks_region          = "${environment.spec.aws?.region || 'us-east-1'}"
eks_cluster_name    = "${infraName}"
eks_cluster_count   = ${clusters.length}
eks_node_type       = "${settings.node_type || 't3.medium'}"
eks_nodes           = ${settings.nodes || 2}
eks_min_nodes       = ${Math.max(1, (settings.nodes || 2) - 1)}
eks_max_nodes       = ${(settings.nodes || 2) + 2}${dnsVars}`
      : `# Fill in your provider-specific terraform.tfvars`;

    const contextExports = clusters
      .map(
        (c, i) =>
          `export ${c.name.toUpperCase()}_CONTEXT="$(terraform -chdir=${envDir} output -json eks_kubeconfig_context | jq -r '.[${i}]')"`
      )
      .join('\n');

    const nextLab = labNum + 1;

    return `## Lab ${labNum} — Infrastructure Provisioning (Optional)

> **Skip this lab** if clusters are already provisioned — set context variables directly in **Lab ${nextLab} — Environment Variables**.

### Additional Prerequisites

Install **terraform** or **opentofu** (they share the same CLI syntax):

| Tool | Minimum Version | Install |
|------|----------------|---------|
| terraform | v1.6+ | https://developer.hashicorp.com/terraform/install |
| opentofu | v1.6+ | https://opentofu.org/docs/intro/install/ |

### Provision Clusters

Clone the Terraform provisioner ([day0ops/terraform-cloud-provisioner](https://github.com/day0ops/terraform-cloud-provisioner)):

\`\`\`bash
git clone https://github.com/day0ops/terraform-cloud-provisioner
cd terraform-cloud-provisioner
\`\`\`

Create \`${envDir}/terraform.tfvars\`:

\`\`\`hcl
${tfvars}
\`\`\`

Initialize and apply:

\`\`\`bash
terraform -chdir=${envDir} init
terraform -chdir=${envDir} plan  -var-file=${envDir}/terraform.tfvars
terraform -chdir=${envDir} apply -var-file=${envDir}/terraform.tfvars
\`\`\`

This provisions ${clusters.length} cluster${clusters.length !== 1 ? 's' : ''}: **${clusters.map(c => c.name).join('**, **')}**.

### Verify Cluster Access

\`\`\`bash
export KUBECONFIG=$(terraform -chdir=${envDir} output -raw eks_kubeconfig)
kubectl config get-contexts
\`\`\`

Expected: ${clusters.length} context${clusters.length !== 1 ? 's' : ''} listed (${clusters.map(c => c.name).join(', ')}).

### Extract Context Variables

\`\`\`bash
${contextExports}
\`\`\``;
  }

  cleanup(selection) {
    const { infraProfile } = selection;
    const provider = infraProfile.spec.provider || 'eks';
    const envDir = `environments/${provider}`;
    return `\`\`\`bash
cd terraform-cloud-provisioner
terraform -chdir=${envDir} destroy -var-file=${envDir}/terraform.tfvars
\`\`\``;
  }
}
