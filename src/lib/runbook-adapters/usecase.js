// src/lib/runbook-adapters/usecase.js
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dump as yamlDump } from 'js-yaml';
import { IngressHttpRouteFeature } from '../../../features/traffic-management/ingress-httproute/index.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const FEATURE_BUILDERS = {
  'ingress-httproute': IngressHttpRouteFeature,
};

export class UseCaseAdapter {
  envVars(_selection) { return []; }
  envExports(_selection) { return []; }

  async generate(labNum, selection) {
    const { usecases = [] } = selection;
    if (usecases.length === 0) return '';

    const options = _runbookOptions(selection);
    const sections = [];
    let subIndex = 1;

    for (const usecase of usecases) {
      const title = usecase.metadata.description
        ? usecase.metadata.description.split('\n')[0].trim().replace(/\.$/, '')
        : usecase.metadata.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const heading = `### Lab ${labNum}.${subIndex} — ${title}`;
      const content = this._renderUsecase(usecase, options);
      sections.push(`${heading}\n\n${content}`);
      subIndex++;
    }

    return `## Lab ${labNum} — Use Cases\n\n${sections.join('\n\n---\n\n')}`;
  }

  _renderUsecase(usecase, options) {
    const lines = [];

    if (usecase.metadata.description) {
      lines.push(usecase.metadata.description);
      lines.push('');
    }

    if (usecase.spec.diagram) {
      lines.push('```mermaid');
      lines.push(usecase.spec.diagram.replace(/\\n/g, '<br>').replace(/\s*·\s*/g, '<br>').trim());
      lines.push('```');
      lines.push('');
    }

    const apps = usecase.spec.requires?.applications || [];
    if (apps.length) {
      lines.push('#### Prerequisites');
      lines.push('');
      lines.push('Deploy required applications:');
      lines.push('');
      for (const app of apps) {
        const appPath = join(PROJECT_ROOT, 'extras', 'applications', app.name, `${app.name}.yaml`);
        let appYaml;
        try {
          appYaml = readFileSync(appPath, 'utf8').trim();
        } catch {
          appYaml = `# ${app.name} manifest not found at ${appPath}`;
        }
        lines.push('```bash');
        lines.push(`kubectl apply -f - <<'EOF'`);
        lines.push(appYaml);
        lines.push('EOF');
        lines.push('```');
        lines.push('');
      }
    }

    if (usecase.spec.features?.length) {
      lines.push('#### Steps');
      lines.push('');
      for (const feature of usecase.spec.features) {
        const clusterNames = (feature.clusters || []).map(c => c.name);
        const FeatureClass = FEATURE_BUILDERS[feature.name];

        if (feature.description) {
          lines.push(`**${feature.description}** (\`${feature.name}\`)`);
          lines.push('');
        } else {
          lines.push(`**${feature.name}**`);
          lines.push('');
        }

        if (FeatureClass?.buildRunbook) {
          const resources = FeatureClass.buildRunbook(_resolveEnvTemplates(feature.config, options.env), options);
          const targets = clusterNames.length ? clusterNames : [null];
          for (const clusterName of targets) {
            const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
            if (clusterName) lines.push(`Apply on **${clusterName}** cluster:`);
            lines.push('```bash');
            lines.push(`kubectl apply ${ctxFlag}-f - <<'EOF'`);
            for (const resource of resources) {
              lines.push(yamlDump(resource, { lineWidth: -1, indent: 2 }).trimEnd());
            }
            lines.push('EOF');
            lines.push('```');
            lines.push('');
          }
        } else if (feature.config && Object.keys(feature.config).length > 0) {
          lines.push('```yaml');
          lines.push(yamlDump(feature.config).trim());
          lines.push('```');
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  cleanup(_selection) { return ''; }
}

function _runbookOptions(selection) {
  return { env: selection.environment };
}

function _resolveEnvTemplates(config, env) {
  if (!config || !env) return config;
  const domains = env.spec?.domains || {};
  const str = JSON.stringify(config);
  const resolved = str.replace(/\{\{env\.domains\.(\w+)\}\}/g, (_, key) => domains[key] || '');
  return JSON.parse(resolved);
}
