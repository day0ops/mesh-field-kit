# Mesh Field Kit

Provision, install, demo, and test Istio mesh (ambient and sidecar). Node.js/Bun CLI for cloud infrastructure provisioning and Solo Istio installation on Kubernetes clusters. Supports single-cluster and multi-cluster topologies, use cases, and addon management.

## Prerequisites

Ensure you have the following installed:

- **Node.js** >= 24.14.0
- **[bun](https://bun.sh)** - JavaScript runtime and package manager
- **Docker Desktop** - for building and pushing images
- **kubectl** - Kubernetes CLI
- **helm** - Kubernetes package manager
- **[Terraform](https://www.terraform.io/) or [OpenTofu](https://opentofu.org/)** - for cloud cluster provisioning
- **jq** - JSON processor

## Install

```bash
bun install
```

## Quick Start

```bash
export ENTERPRISE_ISTIO_LICENSE=<your-license-key>
export SOLO_ISTIO_REPO_KEY=<your-repo-key>
export AWS_PROFILE=<your-aws-profile>

# Provision infra + install Istio mesh in one shot
make all INFRA=eks-single-cluster MESH_PROFILE=single
```

## CLI Reference

Invoke via `bun run src/cli.js` (or `mesh` if installed globally). Commands follow the `mesh <group> <subcommand>` pattern.

### Utilities

```bash
mesh version [-s|--short]   # Display banner, version, and description
mesh check-deps             # Check if required dependencies are installed
```

### Base — Manage base infrastructure

```bash
# Install Istio mesh (ambient or sidecar) on clusters
mesh base install [--profile <name>] [--infra <name>] [--context <ctx...>]
#   --profile  Installation profile (from config/profiles/)
#   --infra    Infra profile name (resolves cluster contexts from provisioned state)
#   --context  Explicit kube context(s) for pre-existing clusters

# Verify Istio mesh installation
mesh base verify [-c|--context <context>]

# Uninstall Istio mesh from cluster(s)
mesh base clean [--profile <name>] [--infra <name>] [--context <ctx...>] [-a|--addons]
#   -a, --addons  Also clean up all profile-based addons

# Clean up all profile-based addons (cert-manager, external-dns, keycloak, solo-ui, cilium)
mesh base clean-addons
```

### Cloud infrastructure — Manage cloud infrastructure (EKS, GKE, AKS)

```bash
mesh base infra cloud list                              # List available infra profiles
mesh base infra cloud provision [-p|--profile <name>] [-y|--yes]
mesh base infra cloud destroy   [-p|--profile <name>] [-y|--yes]
mesh base infra cloud status    [-p|--profile <name>]   # Show infrastructure provisioning status
mesh base infra cloud env       [-p|--profile <name>] [--print]
#   --print  Print env.sh contents to stdout instead of the path
```

### Use cases — Manage use cases

```bash
mesh usecase list
mesh usecase deploy [-n|--name <name>]
mesh usecase clean  [-n|--name <name>] [-c|--current]
mesh usecase test   [-n|--name <name>]
```

`-c` / `--current` on `clean`: remove the use case tracked as currently deployed (ConfigMap `mesh-feature-catalog-current-usecase`). Omit `--name` when using this flag.

### Applications — Manage applications

```bash
mesh app list
mesh app deploy [-n|--name <name>] [--namespace <ns>]
```

### Installation profiles — Manage installation profiles

```bash
mesh profile list                 # List available installation profiles
mesh profile show [-n|--name <name>]   # Show details of an installation profile
```

## Makefile Targets

### Infrastructure

| Target | Description |
|--------|-------------|
| `make infra-list` | List available infra profiles |
| `make infra-provision [PROFILE=name]` | Provision infrastructure from an infra profile |
| `make infra-destroy [PROFILE=name]` | Destroy provisioned infrastructure |
| `make infra-status [PROFILE=name]` | Show infrastructure provisioning status |
| `make infra-env [PROFILE=name]` | Print path to env.sh |

### Mesh installation

| Target | Description |
|--------|-------------|
| `make install-mesh [INFRA=name] [MESH_PROFILE=name]` | Install Istio mesh on clusters |
| `make uninstall-mesh [INFRA=name]` | Uninstall Istio mesh from cluster(s) |
| `make uninstall-mesh-with-addons [INFRA=name]` | Uninstall Istio mesh and all profile-based addons |
| `make clean-addons` | Clean up all profile-based addons |
| `make verify-mesh` | Verify Istio mesh installation |

### Workflows

| Target | Description |
|--------|-------------|
| `make all INFRA=name [MESH_PROFILE=name]` | Provision infrastructure + install Istio mesh |
| `make clean PROFILE=name` | Destroy provisioned infrastructure |

### Use cases

| Target | Description |
|--------|-------------|
| `make list-usecases` | List available use cases |
| `make deploy-usecase [USECASE=name]` | Deploy a use case |
| `make test-usecase [USECASE=name]` | Test a deployed use case |

### Utilities

| Target | Description |
|--------|-------------|
| `make load-env [PROFILE=name]` | Show command to source env.sh |
| `make kubeconfig [PROFILE=name]` | Print env.sh contents (kubeconfig paths) |
| `make check-env` | Validate required tools and license env vars |
| `mesh check-deps` | Check if required dependencies are installed |

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
|---------|----------|---------|
| `eks-single-cluster` | EKS | 1 (management) |
| `eks-single-cluster-ipv6` | EKS IPv6 | 1 (management) |
| `eks-multi-cluster` | EKS | 3 (mgmt, east, west) |
| `eks-multi-cluster-ipv6` | EKS IPv6 | 3 (mgmt, east, west) |

### Available installation profiles

| Profile | Description |
|---------|-------------|
| `single` | Single-cluster ambient mesh |
| `multicluster` | Multi-cluster with east-west peering (helm) |
| `multicluster-auto` | Multi-cluster with auto-peering (operator) |
| `eks-single-cluster-mesh-with-cilium` | Single-cluster with Cilium CNI chaining |
| `eks-single-cluster-mesh-sidecar` | Single-cluster classic sidecar mesh (no ambient components) |

## Step-by-Step Workflow

### 1. Provision infrastructure

```bash
export AWS_PROFILE=solo-io-fe-apac
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
export SOLO_ISTIO_REPO_KEY=<key>

make install-mesh INFRA=eks-single-cluster MESH_PROFILE=single
```

### 4. Verify Istio mesh installation

```bash
make verify-mesh
```

### 5. Deploy a use case

```bash
make deploy-usecase USECASE=security/authorization-policy
```

### 6. Clean up

```bash
# Uninstall Istio mesh and profile-based addons
make uninstall-mesh-with-addons INFRA=eks-single-cluster

# Destroy provisioned infrastructure
make infra-destroy PROFILE=eks-single-cluster
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENTERPRISE_ISTIO_LICENSE` | Yes (install) | Solo Istio enterprise license key |
| `SOLO_ISTIO_REPO_KEY` | Yes (install) | Image repository key |
| `AWS_PROFILE` | Yes (EKS) | AWS SSO profile name |

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
│   └── migration/
├── addons/                     # Addon implementations
│   ├── cert-manager/
│   ├── external-dns/
│   ├── keycloak/
│   ├── solo-ui/
│   └── cilium/
├── config/
│   ├── infra/                  # InfraProfile YAMLs
│   ├── profiles/               # Installation Profile YAMLs
│   ├── environments/           # Environment YAMLs
│   └── usecases/               # UseCase specs
├── extras/
│   └── applications/           # Reusable demo apps (bookinfo, httpbin, grpcbin, grpcurl, curl)
└── cloud-provisioner/          # Terraform provisioner (git submodule)
```

## Troubleshooting

**AWS credentials error during provision**
```bash
# Re-authenticate SSO
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile>
```

**Check all dependencies**
```bash
mesh check-deps
```

**View infra state**
```bash
make infra-status PROFILE=<name>
```
