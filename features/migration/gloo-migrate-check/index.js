import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';
import { GlooHelper } from '../../../src/lib/gloo.js';

/**
 * Runs Solo's `gloo ambient migrate` tool against the live cluster and
 * surfaces its phase-by-phase recommendations. The tool is read-only —
 * it never mutates cluster state — so cleanup() is a no-op.
 *
 * Reference: https://docs.solo.io/istio/1.30.x/ambient/setup/install/migrate/
 *
 * Configuration:
 * {
 *   enterprise: boolean,   // pass --enterprise (default: false)
 *   outputDir: string,     // pass --output-dir (default: tool's own default)
 *   strict: boolean,       // throw if output contains a failure marker (default: true)
 *   kubeContext: string,   // if set, runs `kubectl config use-context` first —
 *                          // the tool has no documented --context flag of its own
 * }
 */
export class GlooMigrateCheckFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.enterprise = !!config.enterprise;
    this.outputDir = config.outputDir || null;
    this.strict = config.strict !== false;
    this.kubeContext = config.kubeContext || null;
  }

  buildCommand(glooBin) {
    const bin = glooBin.includes('/') ? `"${glooBin}"` : glooBin;
    const args = [bin, 'ambient', 'migrate', '--ignore-failures'];
    if (this.enterprise) args.push('--enterprise');
    if (this.outputDir) args.push('--output-dir', this.outputDir);
    return args.join(' ');
  }

  async deploy() {
    if (this.kubeContext) {
      await CommandRunner.exec(`kubectl config use-context ${this.kubeContext}`, {
        ignoreError: true,
      });
    }

    const glooBin = await GlooHelper.resolve({ spinner: this.spinner });
    if (!glooBin) {
      throw new Error(
        'gloo CLI could not be resolved or downloaded — install manually: ' +
          'curl -fsSL https://storage.googleapis.com/gloo-cli/install.sh | sh -'
      );
    }

    const command = this.buildCommand(glooBin);
    this.log(`Running: ${command}`, 'info');
    const result = await CommandRunner.exec(command, { ignoreError: true });
    const output = [result.stdout || '', result.stderr || ''].filter(Boolean).join('\n');
    this.log(output || '(no output)', 'info');

    if (result.exitCode !== 0) {
      throw new Error(
        `gloo ambient migrate exited with code ${result.exitCode ?? 'unknown'} — see output above.`
      );
    }

    // A non-zero exit code alone isn't reliable — the tool can exit 0 even when it
    // couldn't reach the cluster at all (e.g. "Error: Failed listing objects...").
    // That's a hard failure to run the check, not a migration-readiness finding,
    // so it's unconditional — unlike the ❌ phase markers below, which are gated
    // by `strict` since they're expected on the pre-migration assessment pass.
    if (/^Error:/m.test(output)) {
      throw new Error('gloo ambient migrate reported a hard error — see output above');
    }

    if (this.strict && /❌/.test(output)) {
      throw new Error('gloo ambient migrate reported unresolved failures — see output above');
    }
    this.log('gloo ambient migrate check complete', 'success');
  }

  async cleanup() {
    this.log('gloo ambient migrate is read-only — nothing to clean up', 'info');
  }
}
