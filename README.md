# Mesh Field Kit

[![CI](https://img.shields.io/github/actions/workflow/status/solo-io/mesh-field-kit/ci.yml?branch=main&label=CI)](https://github.com/solo-io/mesh-field-kit/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/solo-io/mesh-field-kit)](LICENSE)

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

Every `mesh` command above has an equivalent `make` target, and `make all` wraps the provision + install sequence into a single call. For the full CLI command reference, Makefile targets, and troubleshooting tips, see [docs/reference.md](docs/reference.md).

## Configuration

### Three-layer config system

```
config/
├── infra/          # Cloud topology — provider, region, cluster roles  (Kind: InfraProfile)
├── profiles/       # Mesh installation — Istio version, components, addons  (Kind: Profile)
└── environments/   # Domain names, DNS, TLS config  (Kind: Environment)
    ├── aws-dev.yaml
    └── local.yaml
```

Profiles reference an infra profile via `spec.infra` and an environment via `spec.environment`.

### Available infra profiles

| Profile | Provider | Clusters |
|---------|----------|-----|
| `eks-single-cluster` | EKS | 1 |
| `eks-single-cluster-ipv6` | EKS IPv6 | 1 |
| `eks-multi-cluster` | EKS | 2 (east, west) |
| `eks-multi-cluster-ipv6` | EKS IPv6 | 2 (east, west) |
| `gke-single-cluster` | GKE | 1 |
| `gke-multi-cluster` | GKE | 2 (east, west) |
| `aks-single-cluster` | AKS | 1 |
| `aks-multi-cluster` | AKS | 2 (east, west) |
| `hybrid-multi-cloud` | EKS + GKE + AKS | 3 (mgmt on EKS, workload on GKE + AKS) |

### Available installation profiles

| Profile | Description |
|---------|-------------|
| `eks-single-cluster-mesh-with-cilium` | Single-cluster ambient mesh with Cilium CNI chaining |
| `eks-single-cluster-mesh-with-calico` | Single-cluster ambient mesh with Calico |
| `eks-single-cluster-mesh-with-spire` | Single-cluster ambient mesh with SPIRE workload identity attestation |
| `eks-single-cluster-mesh-with-crl` | Single-cluster ambient mesh with a plugged-in CA and certificate revocation list (CRL) enforcement |
| `eks-single-cluster-mesh-sidecar` | Single-cluster classic sidecar mesh (no ambient components) |
| `eks-multi-cluster-peering-with-istio-ingress` | Multi-cluster ambient mesh, helm-based peering, Istio ingress |
| `eks-multi-cluster-peering-with-kgateway` | Multi-cluster ambient mesh, helm-based peering, kgateway ingress |
| `eks-multi-cluster-auto-peering-operator` | Multi-cluster ambient mesh, operator-managed auto-peering, kgateway ingress |

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENTERPRISE_ISTIO_LICENSE` | Yes (install) | Solo Istio enterprise license key |
| `AWS_PROFILE` | Yes (EKS) | AWS SSO profile name |
| `GCP_PROJECT` | Yes (GKE) | GCP project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes (GKE) | Path to GCP service account credentials |
| `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_OBJECT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID` | Yes (AKS) | Azure service principal credentials |

## Project Structure

```
.
├── src/
│   ├── cli.js                  # CLI entry point
│   └── lib/                    # Core libraries
│       ├── installer.js        # Mesh installation logic
│       ├── infra-manager.js    # Cloud infra orchestration
│       ├── infra-state.js      # Provisioned state management
│       ├── environment.js      # Environment resolution + templating
│       ├── feature.js          # Feature/addon base classes + registry
│       └── usecase.js          # Use case deployment
├── features/                   # Feature implementations
│   ├── traffic-management/
│   ├── security/
│   ├── multicluster/
│   ├── observability/
│   ├── migration/
│   └── hybrid/
├── addons/                     # Addon implementations
│   ├── cert-manager/
│   ├── external-dns/
│   ├── keycloak/
│   ├── solo-ui/
│   ├── cilium/
│   ├── calico/
│   ├── kgateway/
│   ├── spire/
│   └── telemetry/
├── config/
│   ├── infra/                  # InfraProfile YAMLs
│   ├── profiles/               # Installation Profile YAMLs
│   ├── environments/           # Environment YAMLs
│   └── usecases/               # UseCase specs
├── extras/
│   └── applications/           # Reusable demo apps (bookinfo, httpbin, grpcbin, grpcurl, curl)
└── cloud-provisioner/          # Terraform provisioner (git submodule)
```

See [docs/reference.md](docs/reference.md) for the full CLI reference, Makefile targets, and troubleshooting tips.
