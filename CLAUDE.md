# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Istio mesh (ambient and sidecar) demo framework. Node.js/Bun CLI (`src/cli.js`) that provisions cloud infrastructure (Terraform), installs Solo Istio on Kubernetes clusters, and deploys/tests feature use cases.

## Commands

```bash
# Install dependencies
bun install

# Run CLI (Makefile uses bun)
bun run src/cli.js <command>

# Key Makefile targets (all delegate to CLI)
make infra-provision PROFILE=eks-single-cluster   # Provision cloud infra
make install-mesh INFRA=eks-single-cluster         # Install Istio mesh
make verify-mesh                                   # Verify installation
make list-usecases                                 # List use cases
make deploy-usecase USECASE=<name>                 # Deploy a use case
make infra-destroy PROFILE=<name>                  # Destroy infra
make all INFRA=<name>                              # Full provision + install

# Direct CLI usage
bun run src/cli.js infra list
bun run src/cli.js infra provision -p <name> [-y]
bun run src/cli.js install --profile <name> --infra <name>
bun run src/cli.js usecase deploy -n <name>
bun run src/cli.js usecase clean -n <name>
bun run src/cli.js usecase test -n <name>
bun run src/cli.js app deploy -n <name>
bun run src/cli.js check-deps
```

## Required environment variables

```bash
export ENTERPRISE_ISTIO_LICENSE=<key>    # Required for install
export ISTIO_VERSION=1.30.3-solo       # Optional, set in profile
```

## Architecture

### Three-layer config system

1. **Infra profiles** (`config/infra/*.yaml`) — cloud topology (provider, region, cluster count/roles). Kind: `InfraProfile`.
2. **Installation profiles** (`config/profiles/*.yaml`) — Istio version, mesh components, addons. Kind: `Profile`. References an infra profile via `spec.infra`.
3. **Use case specs** (`config/usecases/**/*.yaml`) — sequences of features + apps to deploy for a demo scenario.

### Infra state

Provisioned infra state written to `._output/infra/<name>/state.yaml`. Kubeconfigs land in `._output/infra/<name>/kubeconfig/`. Env vars exported to `._output/infra/<name>/env.sh`.

### Feature system

`Feature` (base class in `src/lib/feature.js`) — subclasses implement `deploy()` and `cleanup()`. `AddonFeature` extends `Feature` and skips dataplane-mode namespace labeling (for infra addons like cert-manager).

`FeatureManager` (static registry) — features and addons register by name at startup via `features/index.js` and `addons/index.js`. Use cases reference features by registered name.

### Feature categories

- **Traffic management** (`features/traffic-management/`): gateway, request-routing, traffic-shifting, header-routing, fault-injection, retry-policy, service-entry, destination-rule, ingress-httproute, envoy-filter, grpc-routing, traffic-mirroring, redirect-rewrite
- **Security** (`features/security/`): waypoint, deny-all-policy, authorization-policy, egress-waypoint, egress-authorization
- **Multicluster** (`features/multicluster/`): certificates, eastwest-gateway, cluster-link, global-service, segment, global-alias, multicluster-verify
- **Observability** (`features/observability/`): ztunnel-metrics, istiod-metrics
- **Addons** (`addons/`): cilium, cert-manager, keycloak, solo-ui

Each feature directory contains `index.js` (the Feature subclass) and optionally `config/` (YAML templates applied to the cluster).

### Adding a new feature

1. Create `features/<category>/<feature-name>/index.js` extending `Feature` with `deploy()` and `cleanup()`.
2. Add static YAML templates to `features/<category>/<feature-name>/config/` if needed.
3. Register in `features/index.js` via `FeatureManager.register('<name>', FeatureClass)`.

### Adding a new use case

Create `config/usecases/<single-cluster|multi-cluster>/<category>/<use-case-name>.yaml` with:
```yaml
apiVersion: mesh.demo/v1
kind: UseCase
metadata:
  name: <display-name>
spec:
  namespace: <ns>
  requires:
    applications: [bookinfo, httpbin]  # from extras/applications/
  features:
    - name: <registered-feature-name>
      config: {}
  tests: []
```

### Applications

Reusable demo apps in `extras/applications/<name>/<name>.yaml` (multi-doc YAML). Deployed via `UseCaseManager.deployApplication()` which labels the namespace for the requested dataplane mode (`ambient` by default, or `sidecar`).

### Provisioner

`cloud-provisioner/terraform-cloud-provisioner` (git submodule) — Terraform wrapper. `src/lib/provisioner-runners/terraform-cloud.js` orchestrates it. Infra profile YAML drives Terraform variable generation.

### Current use case tracking

Tracked in a ConfigMap (`mesh-feature-catalog-current-usecase` in `default` namespace). Deploying a new use case auto-cleans the previous one.
