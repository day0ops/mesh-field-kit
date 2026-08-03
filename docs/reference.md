# CLI & Makefile Reference

Full command reference for the `mesh` CLI and Makefile targets, plus common troubleshooting steps. See the [README](../README.md) for prerequisites, installation, and the quick start.

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

# Clean up all profile-based addons (cert-manager, external-dns, keycloak, solo-ui, cilium, calico, kgateway, spire, telemetry)
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
