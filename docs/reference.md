# Reference

Full reference for the `mesh` CLI, Makefile targets, built-in profiles, environment variables, project structure, and common troubleshooting steps. See the [README](../README.md) for prerequisites, installation, and the quick start.

## Infra Profiles

| Profile                   | Provider         | Clusters                                    |
| ------------------------- | ---------------- | ------------------------------------------- |
| `eks-single-cluster`      | EKS              | 1                                           |
| `eks-single-cluster-ipv6` | EKS IPv6         | 1                                           |
| `eks-multi-cluster`       | EKS              | 2 (east, west)                              |
| `eks-multi-cluster-ipv6`  | EKS IPv6         | 2 (east, west)                              |
| `gke-single-cluster`      | GKE              | 1                                           |
| `gke-multi-cluster`       | GKE              | 2 (east, west)                              |
| `aks-single-cluster`      | AKS              | 1                                           |
| `aks-multi-cluster`       | AKS              | 2 (east, west)                              |
| `hybrid-multi-cloud`      | EKS + GKE + AKS  | 3 (mgmt on EKS, workload on GKE + AKS)      |
| `rosa-eks-multi-cluster`  | ROSA (HCP) + EKS | 2 (rosa-cluster mgmt, eks-cluster workload) |

## Installation Profiles

| Profile                                        | Description                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eks-single-cluster-mesh-with-cilium`          | Single-cluster ambient mesh with Cilium CNI chaining, plus the telemetry stack                                         |
| `eks-single-cluster-mesh-with-calico`          | Single-cluster ambient mesh with Calico CNI chaining (Tigera operator install)                                         |
| `eks-single-cluster-mesh-with-spire`           | Single-cluster ambient mesh with SPIRE workload identity attestation                                                   |
| `eks-single-cluster-mesh-with-crl`             | Single-cluster ambient mesh with a plugged-in CA and certificate revocation list (CRL) enforcement                     |
| `eks-single-cluster-mesh-sidecar`              | Single-cluster classic sidecar mesh (no ambient components)                                                            |
| `eks-multi-cluster-peering-with-istio-ingress` | Multi-cluster ambient mesh, helm-based peering, Istio's built-in ingress gateway                                       |
| `eks-multi-cluster-peering-with-kgateway`      | Multi-cluster ambient mesh, helm-based peering, kgateway ingress, Keycloak OIDC                                        |
| `eks-multi-cluster-auto-peering-operator`      | Multi-cluster ambient mesh installed and peered via the Solo operator, kgateway ingress                                |
| `rosa-eks-ambient-peering`                     | Multi-cluster ambient mesh, ROSA + EKS, helm-based Solo peering, SPIRE, managed telemetry, Solo UI behind a public NLB |

## Environment Variables

| Variable                                                                                      | Required                              | Description                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `ENTERPRISE_ISTIO_LICENSE`                                                                    | Yes (install)                         | Solo Istio enterprise license key                           |
| `AWS_PROFILE`                                                                                 | Yes (EKS)                             | AWS SSO profile name                                        |
| `GCP_PROJECT`                                                                                 | Yes (GKE)                             | GCP project ID                                              |
| `GOOGLE_APPLICATION_CREDENTIALS`                                                              | Yes (GKE)                             | Path to GCP service account credentials                     |
| `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_OBJECT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID` | Yes (AKS)                             | Azure service principal credentials                         |
| `RHCS_CLIENT_ID`, `RHCS_CLIENT_SECRET`                                                        | Yes (ROSA)                            | Red Hat Hybrid Cloud Console service account credentials    |
| `KEYCLOAK_ADMIN_USERNAME`                                                                     | Yes (keycloak addon)                  | Keycloak master realm bootstrap admin username              |
| `KEYCLOAK_ADMIN_PASSWORD`                                                                     | Yes (keycloak addon)                  | Keycloak master realm bootstrap admin password              |
| `KEYCLOAK_POSTGRES_USER`                                                                      | Yes (keycloak addon)                  | Postgres superuser backing Keycloak's DB                    |
| `KEYCLOAK_POSTGRES_PASSWORD`                                                                  | Yes (keycloak addon)                  | Postgres superuser password                                 |
| `SOLO_UI_DEFAULT_PASSWORD`                                                                    | Yes (soloUIClients)                   | solo-admin/solo-reader/solo-writer bootstrap password       |
| `GRAFANA_REALM_ADMIN_USERNAME`                                                                | No (default: grafana-admin)           | Grafana OIDC demo admin username (keycloak 'grafana' realm) |
| `GRAFANA_REALM_ADMIN_PASSWORD`                                                                | Yes (when 'grafana' realm configured) | Grafana OIDC demo admin password                            |
| `GRAFANA_ADMIN_USERNAME`                                                                      | Yes (telemetry addon, full mode)      | Grafana admin login username                                |
| `GRAFANA_ADMIN_PASSWORD`                                                                      | Yes (telemetry addon, full mode)      | Grafana admin login password                                |

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
│   ├── aws-load-balancer-controller/
│   ├── cert-manager/
│   ├── external-dns/
│   ├── keycloak/
│   ├── openshift-scc/
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

| Target                                | Description                                    |
| ------------------------------------- | ---------------------------------------------- |
| `make infra-list`                     | List available infra profiles                  |
| `make infra-provision [PROFILE=name]` | Provision infrastructure from an infra profile |
| `make infra-destroy [PROFILE=name]`   | Destroy provisioned infrastructure             |
| `make infra-status [PROFILE=name]`    | Show infrastructure provisioning status        |
| `make infra-env [PROFILE=name]`       | Print path to env.sh                           |

### Mesh installation

| Target                                               | Description                                       |
| ---------------------------------------------------- | ------------------------------------------------- |
| `make install-mesh [INFRA=name] [MESH_PROFILE=name]` | Install Istio mesh on clusters                    |
| `make uninstall-mesh [INFRA=name]`                   | Uninstall Istio mesh from cluster(s)              |
| `make uninstall-mesh-with-addons [INFRA=name]`       | Uninstall Istio mesh and all profile-based addons |
| `make clean-addons`                                  | Clean up all profile-based addons                 |
| `make verify-mesh`                                   | Verify Istio mesh installation                    |

### Workflows

| Target                                    | Description                                   |
| ----------------------------------------- | --------------------------------------------- |
| `make all INFRA=name [MESH_PROFILE=name]` | Provision infrastructure + install Istio mesh |
| `make clean PROFILE=name`                 | Destroy provisioned infrastructure            |

### Use cases

| Target                               | Description              |
| ------------------------------------ | ------------------------ |
| `make list-usecases`                 | List available use cases |
| `make deploy-usecase [USECASE=name]` | Deploy a use case        |
| `make test-usecase [USECASE=name]`   | Test a deployed use case |

### Utilities

| Target                           | Description                                  |
| -------------------------------- | -------------------------------------------- |
| `make load-env [PROFILE=name]`   | Show command to source env.sh                |
| `make kubeconfig [PROFILE=name]` | Print env.sh contents (kubeconfig paths)     |
| `make check-env`                 | Validate required tools and license env vars |
| `mesh check-deps`                | Check if required dependencies are installed |

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

**ROSA cluster access token expired**

`mesh base clean`/`base install` fails with `Cluster is not accessible` on a ROSA cluster context, even though the cluster is up. ROSA's kubeconfig is generated once via `oc login` at cluster creation time (Terraform doesn't refresh it automatically), and that token expires after ~24h. Refresh it directly - get the admin credentials from Terraform state, then re-login into the exact kubeconfig file the CLI uses:

```bash
# From the eks-rosa environment's state, find module.rosa[0].module.hcp's
# admin_credentials attribute (username/password) and api_url.
oc login <api_url> \
  --username=<username> \
  --password='<password>' \
  --insecure-skip-tls-verify=true \
  --kubeconfig=._output/infra/<infra-name>/kubeconfig/<rosa-cluster-name>.yaml
```
