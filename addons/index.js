/**
 * Addon Registry
 *
 * Central registry for all profile-based addons.
 * Addons are infrastructure components installed alongside Istio Ambient
 * (e.g., cert-manager, keycloak, solo-ui, etc.)
 */

import { FeatureManager } from '../src/lib/feature.js';
import { CertManagerFeature } from './cert-manager/index.js';
import { ExternalDnsFeature } from './external-dns/index.js';
import { SoloUIFeature } from './solo-ui/index.js';
import { KeycloakFeature } from './keycloak/index.js';
import { CiliumFeature } from './cilium/index.js';
import { CalicoFeature } from './calico/index.js';
import { TelemetryFeature } from './telemetry/index.js';
import { KgatewayFeature } from './kgateway/index.js';
import { SpireFeature } from './spire/index.js';

// Register all addons
FeatureManager.register('cert-manager', CertManagerFeature);
FeatureManager.register('external-dns', ExternalDnsFeature);
FeatureManager.register('solo-ui', SoloUIFeature);
FeatureManager.register('keycloak', KeycloakFeature);
FeatureManager.register('cilium', CiliumFeature);
FeatureManager.register('calico', CalicoFeature);
FeatureManager.register('telemetry', TelemetryFeature);
FeatureManager.register('kgateway', KgatewayFeature);
FeatureManager.register('spire', SpireFeature);

// Export for direct use if needed
export {
  CertManagerFeature,
  ExternalDnsFeature,
  SoloUIFeature,
  KeycloakFeature,
  CiliumFeature,
  CalicoFeature,
  TelemetryFeature,
  KgatewayFeature,
  SpireFeature,
};
