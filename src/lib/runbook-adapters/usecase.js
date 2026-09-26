// src/lib/runbook-adapters/usecase.js
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dump as yamlDump } from 'js-yaml';
import { TemplateResolver } from '../template-resolver.js';
import { IngressHttpRouteFeature } from '../../../features/traffic-management/ingress-httproute/index.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const FEATURE_BUILDERS = {
  'ingress-httproute': IngressHttpRouteFeature,
};

export class UseCaseAdapter {
  envVars(_selection) {
    return [];
  }
  envExports(_selection) {
    return [];
  }

  async generate(labNum, selection) {
    const { usecases = [] } = selection;
    if (usecases.length === 0) return '';

    const options = _runbookOptions(selection);
    const sections = [];
    let subIndex = 1;

    for (const usecase of usecases) {
      const heading = `### Lab ${labNum}.${subIndex} — ${usecaseTitle(usecase)}`;
      const content = this._renderUsecase(usecase, options);
      sections.push(`${heading}\n\n${content}`);
      subIndex++;
    }

    return `## Lab ${labNum} — Use Cases\n\n${sections.join('\n\n---\n\n')}`;
  }

  generateCleanupSections(labNum, selection, startIndex) {
    const { usecases = [] } = selection;
    if (usecases.length === 0) return [];

    const options = _runbookOptions(selection);
    return usecases.map((usecase, i) => {
      const heading = `### Lab ${labNum}.${startIndex + i} — ${usecaseTitle(usecase)} Cleanup`;
      return `${heading}\n\n${this._renderCleanupSteps(usecase, options)}`;
    });
  }

  _renderCleanupSteps(usecase, options) {
    const lines = [];

    const features = usecase.spec.features || [];
    if (features.length) {
      lines.push('#### Delete Features');
      lines.push('');
      lines.push('Remove in reverse order of creation:');
      lines.push('');
      for (const feature of [...features].reverse()) {
        const clusterNames = (feature.clusters || []).map(c => c.name);
        const FeatureClass = FEATURE_BUILDERS[feature.name];

        if (feature.description) {
          lines.push(`**${feature.description}** (\`${feature.name}\`)`);
        } else {
          lines.push(`**${feature.name}**`);
        }
        lines.push('');

        if (FeatureClass?.buildRunbook) {
          const resources = FeatureClass.buildRunbook(
            _resolveEnvTemplates(feature.config, options.env),
            options
          );
          const targets = clusterNames.length ? clusterNames : [null];
          const cmds = [];
          for (const clusterName of targets) {
            const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
            for (const resource of resources) {
              const kind = (resource.kind || '').toLowerCase();
              const name = resource.metadata?.name;
              const nsFlag = resource.metadata?.namespace
                ? `-n ${resource.metadata.namespace} `
                : '';
              cmds.push(
                `kubectl delete ${ctxFlag}${kind} ${name} ${nsFlag}--ignore-not-found=true`
              );
            }
          }
          lines.push('```bash');
          lines.push(cmds.join('\n'));
          lines.push('```');
          lines.push('');
        } else {
          lines.push('_No generated manifest for this feature — remove it manually if needed._');
          lines.push('');
        }
      }
    }

    const apps = usecase.spec.requires?.applications || [];
    if (apps.length) {
      lines.push('#### Delete Prerequisite Applications');
      lines.push('');
      for (const app of [...apps].reverse()) {
        lines.push(`**${app.name}**`);
        lines.push('');
        const appPath = join(PROJECT_ROOT, 'extras', 'applications', app.name, `${app.name}.yaml`);
        let appYaml;
        try {
          appYaml = readFileSync(appPath, 'utf8').trim();
        } catch {
          appYaml = `# ${app.name} manifest not found at ${appPath}`;
        }
        lines.push('```bash');
        lines.push(`kubectl delete --ignore-not-found=true -f - <<'EOF'`);
        lines.push(appYaml);
        lines.push('EOF');
        lines.push('```');
        lines.push('');
      }
    }

    return lines.join('\n').trimEnd();
  }

  _renderUsecase(usecase, options) {
    const lines = [];

    if (usecase.metadata.description) {
      lines.push(usecase.metadata.description);
      lines.push('');
    }

    if (usecase.spec.diagram) {
      lines.push('```mermaid');
      lines.push(
        usecase.spec.diagram
          .replace(/\\n/g, '<br>')
          .replace(/\s*·\s*/g, '<br>')
          .trim()
      );
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
          const resources = FeatureClass.buildRunbook(
            _resolveEnvTemplates(feature.config, options.env),
            options
          );
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
          lines.push(yamlDump(_resolveEnvTemplates(feature.config, options.env)).trim());
          lines.push('```');
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  cleanup(_selection) {
    return '';
  }
}

export function usecaseTitle(usecase) {
  return usecase.metadata.description
    ? usecase.metadata.description.split('\n')[0].trim().replace(/\.$/, '')
    : usecaseName(usecase);
}

export function usecaseName(usecase) {
  return usecase.metadata.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _runbookOptions(selection) {
  return { env: selection.environment };
}

// Resolve {{env.*}} template tokens in a feature's config against the environment spec, using
// the same recursive resolver the installer uses so nested paths ({{env.domains.app.main}}) and
// full-value tokens resolve identically. Infra/cluster tokens have no context at doc-gen time and
// are left intact rather than blanked.
function _resolveEnvTemplates(config, env) {
  if (!config || !env) return config;
  const context = TemplateResolver.buildContext({}, env);
  return TemplateResolver.resolveValues(config, context);
}
