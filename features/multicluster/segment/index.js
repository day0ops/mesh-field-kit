import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Segment Feature
 *
 * Creates admin.solo.io/v1alpha1 Segment CRs for DNS domain isolation across
 * clusters, and optionally assigns a cluster to a segment.
 *
 * Segments partition the mesh at cluster granularity: a cluster belongs to
 * exactly one segment at a time, assigned by labeling its istio-system
 * namespace with admin.solo.io/segment=<segmentName>. Segment CRs must
 * always live in istio-system, and the same set of Segment CRs is normally
 * applied to every peered cluster (see
 * https://docs.solo.io/istio/1.30.x/ambient/multicluster/segments/create/).
 *
 * Configuration:
 * {
 *   segmentName: string,     // Required: Segment name
 *   domain: string,          // Required: DNS domain for the segment (e.g. 'team-a.global')
 *   assignCluster: string,   // Optional: cluster name (matching this feature's `clusters`
 *                            //   entries) to assign to this segment via the istio-system
 *                            //   namespace label
 * }
 */
export class SegmentFeature extends Feature {
  static SEGMENT_NAMESPACE = 'istio-system';

  validate() {
    if (!this.config.segmentName) {
      throw new Error('segmentName is required for Segment feature');
    }
    if (!this.config.domain) {
      throw new Error('domain is required for Segment feature');
    }
    return true;
  }

  #contexts() {
    return this.clusterContexts && this.clusterContexts.length > 0
      ? this.clusterContexts
      : [{ name: null, context: null }];
  }

  async deploy() {
    const namespace = SegmentFeature.SEGMENT_NAMESPACE;
    const segmentName = this.config.segmentName;
    const assignCluster = this.config.assignCluster || null;

    this.log(`Deploying Segment feature: ${segmentName}`, 'info');
    this.log(`  Domain: ${this.config.domain}`, 'info');

    const segment = {
      apiVersion: 'admin.solo.io/v1alpha1',
      kind: 'Segment',
      metadata: {
        name: segmentName,
        namespace,
      },
      spec: {
        domain: this.config.domain,
      },
    };

    for (const { name: clusterName, context } of this.#contexts()) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying Segment: ${segmentName}${contextInfo}...`, 'info');
      await this.applyResource(segment, context);

      if (assignCluster && clusterName === assignCluster) {
        this.log(
          `Assigning cluster '${clusterName}' to segment '${segmentName}'${contextInfo}...`,
          'info'
        );
        const contextFlag = context ? `--context=${context}` : '';
        await CommandRunner.exec(
          `kubectl ${contextFlag} label namespace ${namespace} admin.solo.io/segment=${segmentName} --overwrite`
        );
      }
    }
  }

  async cleanup() {
    const namespace = SegmentFeature.SEGMENT_NAMESPACE;
    const segmentName = this.config.segmentName;
    const assignCluster = this.config.assignCluster || null;

    this.log(`Cleaning up Segment feature: ${segmentName}`, 'info');

    for (const { name: clusterName, context } of this.#contexts()) {
      const contextInfo = context ? ` (context: ${context})` : '';

      if (assignCluster && clusterName === assignCluster) {
        const contextFlag = context ? `--context=${context}` : '';
        await CommandRunner.exec(
          `kubectl ${contextFlag} label namespace ${namespace} admin.solo.io/segment-`,
          { ignoreError: true }
        );
      }

      this.log(`Deleting Segment: ${segmentName}${contextInfo}...`, 'info');
      await this.deleteResource('segment', segmentName, namespace, context);
    }
  }
}

export function createSegmentFeature(config) {
  return new SegmentFeature('segment', config);
}
