/**
 * Central Feature Registry
 *
 * This file imports and registers all available features with the FeatureManager.
 * Features are organized by category in subdirectories.
 */

import { FeatureManager } from '../src/lib/feature.js';

// Traffic Management Features
import { GatewayFeature } from './traffic-management/gateway/index.js';
import { RequestRoutingFeature } from './traffic-management/request-routing/index.js';
import { TrafficShiftingFeature } from './traffic-management/traffic-shifting/index.js';
import { HeaderRoutingFeature } from './traffic-management/header-routing/index.js';
import { FaultInjectionFeature } from './traffic-management/fault-injection/index.js';
import { RetryPolicyFeature } from './traffic-management/retry-policy/index.js';
import { ServiceEntryFeature } from './traffic-management/service-entry/index.js';
import { DestinationRuleFeature } from './traffic-management/destination-rule/index.js';
import { IngressHttpRouteFeature } from './traffic-management/ingress-httproute/index.js';
import { EnvoyFilterFeature } from './traffic-management/envoy-filter/index.js';
import { GrpcRoutingFeature } from './traffic-management/grpc-routing/index.js';
import { TrafficMirroringFeature } from './traffic-management/traffic-mirroring/index.js';
import { RedirectRewriteFeature } from './traffic-management/redirect-rewrite/index.js';

// Security Features
import { WaypointFeature } from './security/waypoint/index.js';
import { DenyAllPolicyFeature } from './security/deny-all-policy/index.js';
import { AuthorizationPolicyFeature } from './security/authorization-policy/index.js';
import { EgressWaypointFeature } from './security/egress-waypoint/index.js';
import { EgressAuthorizationFeature } from './security/egress-authorization/index.js';
import { NetworkPolicyFeature } from './security/network-policy/index.js';

// Multicluster Features
import { GlobalServiceFeature } from './multicluster/global-service/index.js';
import { SegmentFeature } from './multicluster/segment/index.js';
import { GlobalAliasFeature } from './multicluster/global-alias/index.js';

// Observability Features
import { ZtunnelMetricsFeature } from './observability/ztunnel-metrics/index.js';
import { IstiodMetricsFeature } from './observability/istiod-metrics/index.js';
import { TracingProviderFeature } from './observability/tracing-provider/index.js';

// Migration Features
import { GlooMigrateCheckFeature } from './migration/gloo-migrate-check/index.js';
import { SidecarCutoverFeature } from './migration/sidecar-cutover/index.js';
import { EnableAmbientFeature } from './migration/enable-ambient/index.js';

// Hybrid Features
import { VmIntegrationFeature } from './hybrid/vm-integration/index.js';

// Register all features
// Traffic Management
FeatureManager.register('gateway', GatewayFeature);
FeatureManager.register('request-routing', RequestRoutingFeature);
FeatureManager.register('traffic-shifting', TrafficShiftingFeature);
FeatureManager.register('header-routing', HeaderRoutingFeature);
FeatureManager.register('fault-injection', FaultInjectionFeature);
FeatureManager.register('retry-policy', RetryPolicyFeature);
FeatureManager.register('service-entry', ServiceEntryFeature);
FeatureManager.register('destination-rule', DestinationRuleFeature);
FeatureManager.register('ingress-httproute', IngressHttpRouteFeature);
FeatureManager.register('envoy-filter', EnvoyFilterFeature);
FeatureManager.register('grpc-routing', GrpcRoutingFeature);
FeatureManager.register('traffic-mirroring', TrafficMirroringFeature);
FeatureManager.register('redirect-rewrite', RedirectRewriteFeature);

// Security
FeatureManager.register('waypoint', WaypointFeature);
FeatureManager.register('deny-all-policy', DenyAllPolicyFeature);
FeatureManager.register('authorization-policy', AuthorizationPolicyFeature);
FeatureManager.register('egress-waypoint', EgressWaypointFeature);
FeatureManager.register('egress-authorization', EgressAuthorizationFeature);
FeatureManager.register('network-policy', NetworkPolicyFeature);

// Multicluster
FeatureManager.register('global-service', GlobalServiceFeature);
FeatureManager.register('segment', SegmentFeature);
FeatureManager.register('global-alias', GlobalAliasFeature);

// Observability
FeatureManager.register('ztunnel-metrics', ZtunnelMetricsFeature);
FeatureManager.register('istiod-metrics', IstiodMetricsFeature);
FeatureManager.register('tracing-provider', TracingProviderFeature);

// Migration
FeatureManager.register('gloo-migrate-check', GlooMigrateCheckFeature);
FeatureManager.register('sidecar-cutover', SidecarCutoverFeature);
FeatureManager.register('enable-ambient', EnableAmbientFeature);

// Hybrid
FeatureManager.register('vm-integration', VmIntegrationFeature);

// Re-export for convenience
export { FeatureManager };

// Traffic Management
export { GatewayFeature } from './traffic-management/gateway/index.js';
export { RequestRoutingFeature } from './traffic-management/request-routing/index.js';
export { TrafficShiftingFeature } from './traffic-management/traffic-shifting/index.js';
export { HeaderRoutingFeature } from './traffic-management/header-routing/index.js';
export { FaultInjectionFeature } from './traffic-management/fault-injection/index.js';
export { RetryPolicyFeature } from './traffic-management/retry-policy/index.js';
export { ServiceEntryFeature } from './traffic-management/service-entry/index.js';
export { DestinationRuleFeature } from './traffic-management/destination-rule/index.js';
export { IngressHttpRouteFeature } from './traffic-management/ingress-httproute/index.js';
export { EnvoyFilterFeature } from './traffic-management/envoy-filter/index.js';
export { GrpcRoutingFeature } from './traffic-management/grpc-routing/index.js';
export { TrafficMirroringFeature } from './traffic-management/traffic-mirroring/index.js';
export { RedirectRewriteFeature } from './traffic-management/redirect-rewrite/index.js';

// Security
export { WaypointFeature } from './security/waypoint/index.js';
export { DenyAllPolicyFeature } from './security/deny-all-policy/index.js';
export { AuthorizationPolicyFeature } from './security/authorization-policy/index.js';
export { EgressWaypointFeature } from './security/egress-waypoint/index.js';
export { EgressAuthorizationFeature } from './security/egress-authorization/index.js';
export { NetworkPolicyFeature } from './security/network-policy/index.js';

// Multicluster
export { GlobalServiceFeature } from './multicluster/global-service/index.js';
export { SegmentFeature } from './multicluster/segment/index.js';
export { GlobalAliasFeature } from './multicluster/global-alias/index.js';

// Observability
export { ZtunnelMetricsFeature } from './observability/ztunnel-metrics/index.js';
export { TracingProviderFeature } from './observability/tracing-provider/index.js';
export { IstiodMetricsFeature } from './observability/istiod-metrics/index.js';

// Migration
export { GlooMigrateCheckFeature } from './migration/gloo-migrate-check/index.js';
export { SidecarCutoverFeature } from './migration/sidecar-cutover/index.js';
export { EnableAmbientFeature } from './migration/enable-ambient/index.js';

// Hybrid
export { VmIntegrationFeature } from './hybrid/vm-integration/index.js';
