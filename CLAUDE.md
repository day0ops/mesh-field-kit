# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Istio mesh (ambient and sidecar) demo framework. Node.js/Bun CLI (`src/cli.js`) that provisions cloud infrastructure across AWS, GCP, and Azure (Terraform), installs Solo Istio on Kubernetes clusters, and deploys/tests feature use cases.

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
bun run src/cli.js base infra cloud list
bun run src/cli.js base infra cloud provision -p <name> [-y]
bun run src/cli.js base install --profile <name> --infra <name>
bun run src/cli.js usecase deploy -n <name>
bun run src/cli.js usecase clean -n <name>
bun run src/cli.js usecase test -n <name>
bun run src/cli.js app deploy -n <name>
bun run src/cli.js check-deps
```

## Required environment variables

```bash
export ENTERPRISE_ISTIO_LICENSE=<key>    # Required for install
export ISTIO_VERSION=1.30.3              # Optional, defaults to profile spec.mesh.istioVersion
```

## Architecture

### Four-layer config system

1. **Infra profiles** (`config/infra/*.yaml`) — cloud topology (provider, region, cluster count/roles). Kind: `InfraProfile`.
2. **Installation profiles** (`config/profiles/*.yaml`) — Istio version, mesh components, addons. Kind: `Profile`. References an infra profile via `spec.infra` and an environment via `spec.environment`.
3. **Environments** (`config/environments/*.yaml`) - domain names, DNS/TLS, per-cloud settings (region, image registries). Kind: `Environment`.
4. **Use case specs** (`config/usecases/**/*.yaml`) — sequences of features + apps to deploy for a demo scenario.

### Infra state

Provisioned infra state written to `._output/infra/<name>/state.yaml`. Kubeconfigs land in `._output/infra/<name>/kubeconfig/`. Env vars exported to `._output/infra/<name>/env.sh`.

### Feature system

`Feature` (base class in `src/lib/feature.js`) — subclasses implement `deploy()` and `cleanup()`. `AddonFeature` extends `Feature` and skips dataplane-mode namespace labeling (for infra addons like cert-manager).

`FeatureManager` (static registry) — features and addons register by name at startup via `features/index.js` and `addons/index.js`. Use cases reference features by registered name.

### Feature categories

- **Traffic management** (`features/traffic-management/`): gateway, request-routing, traffic-shifting, header-routing, fault-injection, retry-policy, service-entry, destination-rule, ingress-httproute, envoy-filter, grpc-routing, traffic-mirroring, redirect-rewrite
- **Security** (`features/security/`): waypoint, deny-all-policy, authorization-policy, egress-waypoint, egress-authorization, network-policy, peer-authentication, crl-enforcement
- **Multicluster** (`features/multicluster/`): global-service, segment, global-alias
- **Observability** (`features/observability/`): ztunnel-metrics, istiod-metrics, tracing-provider
- **Migration** (`features/migration/`): gloo-migrate-check, sidecar-cutover, enable-ambient
- **Hybrid** (`features/hybrid/`): vm-integration
- **Addons** (`addons/`): cilium, calico, cert-manager, external-dns, keycloak, solo-ui, kgateway, spire, telemetry

Cross-cluster trust setup (root/intermediate CA generation, east-west gateway, cluster linking) is not part of the Feature registry - it lives in `src/lib/multicluster.js` (`CertificateManager`, `EastWestGateway`, `ClusterLinker`, `PeeringInstaller`) and runs as part of `base install` for multicluster profiles.

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
  description: <what this demonstrates>
spec:
  requires:
    applications:
      - name: bookinfo       # from extras/applications/
        namespace: bookinfo
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
