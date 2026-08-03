// src/lib/runbook-adapters/env.js

export class EnvAdapter {
  envVars(_selection) {
    return [];
  }

  envExports(_selection) {
    return [];
  }

  // Note: special signature — receives consolidated vars from RunbookBuilder
  generate(labNum, selection, consolidatedVars = [], consolidatedExports = []) {
    const clusters = selection?.infraProfile?.spec?.clusters || [];

    // Merge: user-supplied vars first, then computed exports not already listed
    const varNames = new Set(consolidatedVars.map(v => v.name));
    const allTableVars = [
      ...consolidatedVars,
      ...consolidatedExports
        .filter(e => !varNames.has(e.name))
        .map(e => ({
          name: e.name,
          value: e.value,
          description: e.comment || '',
          required: false,
        })),
    ];

    const table = [
      '| Variable | Value | Description | Required |',
      '|----------|-------|-------------|----------|',
      ...allTableVars.map(
        v =>
          `| \`${v.name}\` | ${v.value != null ? `\`${v.value}\`` : ''} | ${v.description} | ${v.required ? 'Yes' : 'No'} |`
      ),
    ].join('\n');

    const exportLines = consolidatedExports
      .map(e => `${e.comment ? `# ${e.comment}\n` : ''}export ${e.name}="${e.value}"`)
      .join('\n');

    // Cluster context section — highlighted separately for clarity
    let contextSection = '';
    if (clusters.length > 0) {
      const prevLab = labNum - 1;
      const ctxLines = clusters
        .map(c => `export ${c.name.toUpperCase()}_CONTEXT="<your-${c.name}-context>"`)
        .join('\n');
      contextSection = `
### Cluster Contexts

Set one variable per cluster. If provisioned via **Lab ${prevLab}**, get values from terraform output — otherwise use your existing kubeconfig context names:

\`\`\`bash
kubectl config get-contexts  # list available contexts
\`\`\`

\`\`\`bash
${ctxLines}
\`\`\`

`;
    }

    return `## Lab ${labNum} — Environment Variables

Set all required credentials and computed values before proceeding.
${contextSection}
### All Variables

${table}

<details>
<summary>Copy-paste export block</summary>

\`\`\`bash
${exportLines}
\`\`\`

</details>`;
  }

  cleanup(_selection) {
    return '';
  }
}
