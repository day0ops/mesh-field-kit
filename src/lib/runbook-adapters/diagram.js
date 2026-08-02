// src/lib/runbook-adapters/diagram.js

export class DiagramAdapter {
  envVars(_selection) { return []; }
  envExports(_selection) { return []; }

  generate(labNum, selection) {
    const { profile, infraProfile } = selection;
    const diagram1 = this._topologyDiagram(profile, infraProfile);
    const descriptions = this._descriptions(profile, infraProfile);

    return `## Lab ${labNum} — Architecture Overview

### Cluster Topology

\`\`\`mermaid
${diagram1}
\`\`\`

### Component Descriptions

${descriptions}`;
  }

  _topologyDiagram(profile, infraProfile) {
    const globalAddons = profile.spec.addons?.global || [];
    const clusterAddonDefs = profile.spec.addons?.clusters || [];
    const lines = [`graph TD`];

    // Global addons node
    if (globalAddons.length > 0) {
      const label = globalAddons.map(a => a.name).join(' · ');
      lines.push(`  GLOBAL["Global addons<br>${label}"]`);
    }

    // Cluster subgraphs
    for (const cluster of (infraProfile.spec.clusters || [])) {
      const clusterDef = clusterAddonDefs.find(c => c.name === cluster.name);
      const addons = clusterDef?.addons || [];
      lines.push(`  subgraph ${cluster.name.toUpperCase()}["${cluster.name} cluster"]`);
      for (const addon of addons) {
        const nodeId = `${cluster.name.toUpperCase()}_${addon.name.replace(/-/g, '_').toUpperCase()}`;
        const desc = addon.description ? `<br>${addon.description.substring(0, 40)}` : '';
        lines.push(`    ${nodeId}["${addon.name}${desc}"]`);
      }
      lines.push(`  end`);
    }

    // Global → each cluster
    if (globalAddons.length > 0) {
      for (const cluster of (infraProfile.spec.clusters || [])) {
        lines.push(`  GLOBAL --> ${cluster.name.toUpperCase()}`);
      }
    }

    return lines.join('\n');
  }

  _interactionDiagram(profile, infraProfile) {
    const clusterAddonDefs = profile.spec.addons?.clusters || [];
    const lines = [`graph LR`];

    // Solo-UI relay → mgmt
    let soloUIMgmtCluster = null;
    let soloUIRelayCluster = null;
    for (const clusterDef of clusterAddonDefs) {
      const sui = clusterDef.addons?.find(a => a.name === 'solo-ui');
      if (sui?.mode === 'management') soloUIMgmtCluster = clusterDef.name;
      if (sui?.mode === 'relay') soloUIRelayCluster = clusterDef.name;
    }
    if (soloUIMgmtCluster && soloUIRelayCluster) {
      lines.push(
        `  SUI_M["solo-ui mgmt\\n(${soloUIMgmtCluster})"] -->|"relay tunnel\\nmesh.internal"| SUI_R["solo-ui relay\\n(${soloUIRelayCluster})"]`
      );
    }

    // Telemetry agent → gateway
    let telGatewayCluster = null;
    let telAgentCluster = null;
    for (const clusterDef of clusterAddonDefs) {
      const tel = clusterDef.addons?.find(a => a.name === 'telemetry');
      if (tel && !tel.config?.mode) telGatewayCluster = clusterDef.name;
      if (tel?.config?.mode === 'agent') telAgentCluster = clusterDef.name;
    }
    if (telGatewayCluster && telAgentCluster) {
      lines.push(
        `  TEL_A["telemetry agent\\n(${telAgentCluster})"] -->|"OTLP\\nmesh.internal"| TEL_G["telemetry gateway\\n(${telGatewayCluster})"]`
      );
    }

    return lines.join('\n');
  }

  _descriptions(profile, infraProfile) {
    const globalAddons = profile.spec.addons?.global || [];
    const clusterAddonDefs = profile.spec.addons?.clusters || [];
    const lines = [];

    for (const addon of globalAddons) {
      if (addon.description) {
        lines.push(`**${addon.name}** (global): ${addon.description}`);
      }
    }
    for (const clusterDef of clusterAddonDefs) {
      for (const addon of (clusterDef.addons || [])) {
        if (addon.description) {
          lines.push(`**${addon.name}** (${clusterDef.name}): ${addon.description}`);
        }
      }
    }

    return lines.join('\n\n');
  }

  cleanup(_selection) { return ''; }
}
