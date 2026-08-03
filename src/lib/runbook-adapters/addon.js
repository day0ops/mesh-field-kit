// src/lib/runbook-adapters/addon.js
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AddonAdapter {
  async envVars(selection) {
    const results = [];
    const seen = new Set();
    for (const { addon, clusterName, sidecar } of await this._iterateAddons(selection)) {
      if (!sidecar?.envVarsFor) continue;
      for (const v of sidecar.envVarsFor(addon, clusterName) || []) {
        if (!seen.has(v.name)) {
          seen.add(v.name);
          results.push(v);
        }
      }
    }
    return results;
  }

  async envExports(selection) {
    const results = [];
    const seen = new Set();
    const { profile, environment } = selection;
    for (const { addon, sidecar } of await this._iterateAddons(selection)) {
      if (!sidecar?.envExportsFor) continue;
      for (const e of sidecar.envExportsFor(addon, profile, environment) || []) {
        if (!seen.has(e.name)) {
          seen.add(e.name);
          results.push(e);
        }
      }
    }
    return results;
  }

  async generate(labNum, selection) {
    const { profile, environment } = selection;
    const addons = await this._iterateAddons(selection);
    const sections = [];
    let subIndex = 1;

    for (const { addon, clusterName, sidecar } of addons) {
      const label = clusterName === 'global' ? '(global)' : `(${clusterName})`;
      const heading = `### Lab ${labNum}.${subIndex} — ${addon.name} ${label}`;

      if (!sidecar?.generate) {
        sections.push(
          `${heading}\n\n> _No runbook sidecar found for \`${addon.name}\`. Skipping._`
        );
      } else {
        const content = await sidecar.generate(subIndex, addon, clusterName, profile, environment);
        sections.push(`${heading}\n\n${content}`);
      }
      subIndex++;
    }

    return `## Lab ${labNum} — Addon Installation\n\n${sections.join('\n\n---\n\n')}`;
  }

  async _iterateAddons(selection) {
    const { profile } = selection;
    const result = [];

    for (const addon of profile.spec.addons?.global || []) {
      const sidecar = await this._loadSidecar(addon.name);
      result.push({ addon, clusterName: 'global', sidecar });
    }

    for (const clusterDef of profile.spec.addons?.clusters || []) {
      for (const addon of clusterDef.addons || []) {
        const sidecar = await this._loadSidecar(addon.name);
        result.push({ addon, clusterName: clusterDef.name, sidecar });
      }
    }

    return result;
  }

  async _loadSidecar(addonName) {
    const sidecarPath = path.resolve(__dirname, `../../../addons/${addonName}/runbook.js`);
    try {
      return await import(sidecarPath);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') {
        console.warn(`[runbook] Warning: no runbook.js sidecar for addon "${addonName}", skipping`);
        return null;
      }
      throw e;
    }
  }

  cleanup(_selection) {
    return '';
  }
}
