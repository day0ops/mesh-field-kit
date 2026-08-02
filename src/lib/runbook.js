// src/lib/runbook.js
import inquirer from 'inquirer';
const { Separator } = inquirer;
import fs from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { glob } from 'glob';
import { Prompts } from './prompts.js';

export class RunbookPicker {
  async pick(options = {}) {
    // 1. Load and filter profiles
    const profiles = await this.listProfiles();
    const filtered = profiles.filter(p => p.spec?.infra && p.spec?.environment);

    if (filtered.length === 0) {
      throw new Error('No profiles with spec.infra found in config/profiles/');
    }

    // 2. Interactive profile selection
    const profileName = await Prompts.select(
      'Select a profile to generate a runbook for:',
      filtered.map(p => ({
        name: p.metadata.name,
        short: p.metadata.name,
        description: (p.metadata.description || '').trim() || null,
        value: p.metadata.name,
      })),
    );

    const profile = filtered.find(p => p.metadata.name === profileName);
    const infraProfile = await this.loadInfraProfile(profile.spec.infra);
    const environment = await this.loadEnvironment(profile.spec.environment);

    // 3. Use case selection — three-step funnel: scope → categories → use cases
    const allUsecases = await this.listUsecases(infraProfile);
    let selectedUsecases = [];
    if (allUsecases.length > 0) {
      const humanize = s => s.replace(/-/g, ' ');
      const getPathParts = u => u._filePath.split('/'); // config/usecases/<scope>/<category>/...

      // Step 3a: scope
      const availableScopes = [...new Set(allUsecases.map(u => getPathParts(u)[2]))].sort((a, b) => {
        if (a === 'single-cluster') return -1;
        if (b === 'single-cluster') return 1;
        return a.localeCompare(b);
      });
      const { selectedScope } = await inquirer.prompt([{
        type: 'list',
        name: 'selectedScope',
        message: 'Select use case scope:',
        choices: [
          ...availableScopes.map(s => ({ name: humanize(s), value: s })),
          new Separator(),
          { name: 'skip', value: 'skip' },
        ],
      }]);

      if (selectedScope === 'skip') {
        // fall through to output config with no use cases
      } else {

      const scopeFiltered = allUsecases.filter(u => getPathParts(u)[2] === selectedScope);

      // Steps 3b+3c: loop — category → use cases → back, until done
      const availableCategories = [...new Set(scopeFiltered.map(u => getPathParts(u)[3]))].sort();
      const selectedNames = new Set();

      while (true) {
        const count = selectedNames.size;
        const { selectedCategory } = await inquirer.prompt([{
          type: 'list',
          name: 'selectedCategory',
          message: `Select category${count > 0 ? ` (${count} use case${count > 1 ? 's' : ''} selected)` : ''}:`,
          choices: [
            ...availableCategories.map(c => ({ name: humanize(c), value: c })),
            new Separator(),
            { name: 'done', value: '__done__' },
          ],
        }]);

        if (selectedCategory === '__done__') break;

        const categoryFiltered = scopeFiltered.filter(u => getPathParts(u)[3] === selectedCategory);
        const usecaseChoices = categoryFiltered.map(u => ({
          name: `${u.metadata.name}  —  ${(u.metadata.description || '').split('\n')[0].trim()}`,
          value: u.metadata.name,
          checked: selectedNames.has(u.metadata.name),
        }));

        const { usecaseNames } = await inquirer.prompt([{
          type: 'checkbox',
          name: 'usecaseNames',
          message: `Select use cases from ${humanize(selectedCategory)}:`,
          choices: usecaseChoices,
        }]);

        // Sync selections for this category (allow deselect on revisit)
        for (const u of categoryFiltered) {
          if (usecaseNames.includes(u.metadata.name)) selectedNames.add(u.metadata.name);
          else selectedNames.delete(u.metadata.name);
        }

        // Show current selection summary
        if (selectedNames.size === 0) {
          console.log('\n  (none selected)\n');
        } else {
          console.log('');
          for (const name of selectedNames) {
            console.log(`  • ${name}`);
          }
          console.log('');
        }
      }

      selectedUsecases = allUsecases.filter(u => selectedNames.has(u.metadata.name));

      } // end else (selectedScope !== 'skip')
    }

    // 4. Output config — always prefix today's date (local), stripping any existing date prefix
    const _d = new Date();
    const today = [_d.getFullYear(), String(_d.getMonth() + 1).padStart(2, '0'), String(_d.getDate()).padStart(2, '0')].join('-');
    const baseFilename = (options.filename || profileName).replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const defaultFilename = `${today}-${baseFilename}`;

    const { outputDir, filename } = await inquirer.prompt([
      {
        type: 'input',
        name: 'outputDir',
        message: 'Output directory:',
        default: options.output || 'docs/runbooks',
      },
      {
        type: 'input',
        name: 'filename',
        message: 'Filename (without .md):',
        default: defaultFilename,
      },
    ]);

    return { profile, infraProfile, environment, usecases: selectedUsecases, outputDir, filename };
  }

  async listProfiles() {
    const files = await glob('config/profiles/*.yaml');
    const loaded = await Promise.all(
      files.map(async f => {
        try {
          return yamlLoad(await fs.promises.readFile(f, 'utf8'));
        } catch {
          return null;
        }
      })
    );
    return loaded.filter(Boolean);
  }

  async loadInfraProfile(name) {
    const filePath = `config/infra/${name}.yaml`;
    return yamlLoad(await fs.promises.readFile(filePath, 'utf8'));
  }

  async loadEnvironment(name) {
    const filePath = `config/environments/${name}.yaml`;
    return yamlLoad(await fs.promises.readFile(filePath, 'utf8'));
  }

  async listUsecases(infraProfile) {
    const files = await glob('config/usecases/**/*.yaml');
    const clusterNames = (infraProfile.spec.clusters || []).map(c => c.name);
    const loaded = await Promise.all(
      files.map(async f => {
        try {
          const data = yamlLoad(await fs.promises.readFile(f, 'utf8'));
          if (data) {
            // Derive category from path: config/usecases/<scope>/<category>/...
            const parts = f.split('/');
            data._filePath = f;
            data._category = parts.length >= 4 ? `${parts[2]} / ${parts[3]}` : 'other';
          }
          return data;
        } catch {
          return null;
        }
      })
    );
    return loaded.filter(u => {
      if (!u || u.kind !== 'UseCase') return false;
      if (!u.spec?.clusters || u.spec.clusters.length === 0) return true;
      return u.spec.clusters.some(c => clusterNames.includes(c.name));
    });
  }
}

function _buildToc(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)$/);
    const h3 = line.match(/^### (.+)$/);
    if (h2) {
      const text = h2[1];
      const anchor = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
      entries.push(`- [${text}](#${anchor})`);
    } else if (h3) {
      const text = h3[1];
      const anchor = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
      entries.push(`  - [${text}](#${anchor})`);
    }
  }
  return `## Table of Contents\n\n${entries.join('\n')}`;
}

export class RunbookBuilder {
  constructor(selection) {
    this.selection = selection;
  }

  async build() {
    const { InfraAdapter } = await import('./runbook-adapters/infra.js');
    const { EnvAdapter } = await import('./runbook-adapters/env.js');
    const { DiagramAdapter } = await import('./runbook-adapters/diagram.js');
    const { InstallAdapter } = await import('./runbook-adapters/install.js');
    const { AddonAdapter } = await import('./runbook-adapters/addon.js');
    const { UseCaseAdapter } = await import('./runbook-adapters/usecase.js');

    const infraAdapter = new InfraAdapter();
    const envAdapter = new EnvAdapter();
    const diagramAdapter = new DiagramAdapter();
    const installAdapter = new InstallAdapter();
    const addonAdapter = new AddonAdapter();
    const usecaseAdapter = new UseCaseAdapter();

    // Collect env vars from sync adapters (deduplicated)
    const allEnvVars = [];
    const allEnvExports = [];
    const seenVars = new Set();
    const seenExports = new Set();

    const syncAdapters = [infraAdapter, envAdapter, diagramAdapter, installAdapter, usecaseAdapter];
    for (const adapter of syncAdapters) {
      for (const v of (adapter.envVars(this.selection) || [])) {
        if (!seenVars.has(v.name)) { seenVars.add(v.name); allEnvVars.push(v); }
      }
      for (const e of (adapter.envExports(this.selection) || [])) {
        if (!seenExports.has(e.name)) { seenExports.add(e.name); allEnvExports.push(e); }
      }
    }

    // Collect from async addon sidecars
    for (const v of (await addonAdapter.envVars(this.selection))) {
      if (!seenVars.has(v.name)) { seenVars.add(v.name); allEnvVars.push(v); }
    }
    for (const e of (await addonAdapter.envExports(this.selection))) {
      if (!seenExports.has(e.name)) { seenExports.add(e.name); allEnvExports.push(e); }
    }

    // Generate all lab sections
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const timestamp = `${today} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')} (local)`;

    const header = `# Mesh Demo Runbook\n\nGenerated: ${timestamp}\n\n---\n`;
    // infra generates 3 labs: 0 (prereqs), 1 (auth), 2 (provisioning)
    const labs012 = infraAdapter.generate(0, this.selection);
    const lab3 = envAdapter.generate(3, this.selection, allEnvVars, allEnvExports);
    const lab4 = diagramAdapter.generate(4, this.selection);
    const lab5 = await addonAdapter.generate(5, this.selection);
    const lab6 = installAdapter.generate(6, this.selection);
    const lab7 = await usecaseAdapter.generate(7, this.selection);

    const body = [labs012, lab3, lab4, lab5, lab6, lab7].filter(Boolean).join('\n\n');
    const toc = _buildToc(body);
    const content = [header, toc, body].join('\n\n');

    // TODO: cleanup labs not yet wired — future: append cleanup section from each adapter

    // Write file
    const { outputDir, filename } = this.selection;
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${filename}.md`);
    fs.writeFileSync(outputPath, content, 'utf8');

    const lineCount = content.split('\n').length;
    console.log(`\nRunbook written to ${outputPath} (${lineCount} lines)`);
    return outputPath;
  }
}
