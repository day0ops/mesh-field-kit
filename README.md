# Mesh Field Kit

[![CI](https://img.shields.io/github/actions/workflow/status/day0ops/mesh-field-kit/ci.yml?branch=main&label=CI)](https://github.com/day0ops/mesh-field-kit/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/day0ops/mesh-field-kit)](LICENSE)

Provision, install, demo, and test Istio mesh (ambient and sidecar). Node.js/Bun CLI for cloud infrastructure provisioning and Solo Istio installation on Kubernetes clusters. Supports single-cluster and multi-cluster topologies, use cases, and addon management.

It drives infrastructure across AWS, GCP, and Azure through the same set of commands, then layers Istio features, addons, and demo applications on top through a small YAML-based config system. Everything here (provisioning, installation, use case deployment) is scriptable, so a full environment can go from nothing to a working demo in one command.

![install.gif](images/install.gif)

## Prerequisites

Ensure you have the following installed:

- **Node.js** >= 24.14.0
- **[bun](https://bun.sh)** - JavaScript runtime and package manager
- **kubectl** - Kubernetes CLI
- **helm** - Kubernetes package manager
- **[Terraform](https://www.terraform.io/) or [OpenTofu](https://opentofu.org/)** - for cloud cluster provisioning
- **jq** - JSON processor
- **[rosa](https://console.redhat.com/openshift/downloads) and [oc](https://console.redhat.com/openshift/downloads)** - only needed for ROSA infra profiles (`rosa`, `eks-rosa` providers); also requires a Red Hat Hybrid Cloud Console service account exported as `RHCS_CLIENT_ID`/`RHCS_CLIENT_SECRET` (https://console.redhat.com/iam/service-accounts)

## Install

```bash
bun install
```

To use the `mesh` command directly instead of `bun run src/cli.js`, link it globally:

```bash
bun link
```

## Quick Start

The fastest path from nothing to a running demo mesh: provision cloud infrastructure and install Istio, using one of the built-in infra/profile pairs.

```bash
export ENTERPRISE_ISTIO_LICENSE=<your-license-key>
export AWS_PROFILE=<your-aws-profile>

# Provision infra + install Istio mesh
mesh base infra cloud provision -p eks-single-cluster -y
mesh base install --profile eks-single-cluster-mesh-with-cilium --infra eks-single-cluster

# or, in one shot
make all INFRA=eks-single-cluster MESH_PROFILE=eks-single-cluster-mesh-with-cilium
```

Every `mesh` command above has an equivalent `make` target, and `make all` wraps the provision + install sequence into a single call.

## Configuration

Three-layer config system:

```
config/
├── infra/          # Cloud topology — provider, region, cluster roles  (Kind: InfraProfile)
├── profiles/       # Mesh installation — Istio version, components, addons  (Kind: Profile)
└── environments/   # Domain names, DNS, TLS config  (Kind: Environment)
    ├── aws-dev.yaml
    └── local.yaml
```

Profiles reference an infra profile via `spec.infra` and an environment via `spec.environment`. See [docs/reference.md](docs/reference.md) for the full list of built-in infra and installation profiles.

## Step-by-Step Workflow

### 1. Provision infrastructure

```bash
export AWS_PROFILE=solo-io-fe-apac
mesh base infra cloud provision -p eks-single-cluster -y
# or
make infra-provision PROFILE=eks-single-cluster
```

### 2. Load environment

```bash
source $(mesh base infra cloud env -p eks-single-cluster)
# or
make load-env PROFILE=eks-single-cluster
```

### 3. Install Istio mesh

```bash
export ENTERPRISE_ISTIO_LICENSE=<key>

mesh base install --profile eks-single-cluster-mesh-with-cilium --infra eks-single-cluster
# or
make install-mesh INFRA=eks-single-cluster MESH_PROFILE=eks-single-cluster-mesh-with-cilium
```

### 4. Verify Istio mesh installation

```bash
mesh base verify
# or
make verify-mesh
```

### 5. Deploy a use case

```bash
mesh usecase deploy --name single-cluster/traffic-management/canary-deployment
# or
make deploy-usecase USECASE=single-cluster/traffic-management/canary-deployment
```

### 6. Clean up

```bash
# Uninstall Istio mesh and profile-based addons
mesh base clean --infra eks-single-cluster -a
# or
make uninstall-mesh-with-addons INFRA=eks-single-cluster

# Destroy provisioned infrastructure
mesh base infra cloud destroy -p eks-single-cluster -y
# or
make infra-destroy PROFILE=eks-single-cluster
```

## More

See [docs/reference.md](docs/reference.md) for the full CLI reference, Makefile targets, built-in infra/installation profiles, environment variables, project structure, and troubleshooting tips.
