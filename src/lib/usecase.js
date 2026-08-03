import { readdir, readFile } from 'fs/promises';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, basename, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Prompts, waitForKey } from './prompts.js';
import { showUseCaseOverview, showStepHeader, showWaitPrompt } from './diagrams.js';
import { Logger, SpinnerLogger, KubernetesHelper, CommandRunner } from './common.js';
import { FeatureManager } from './feature.js';
import { InfraStateManager } from './infra-state.js';
import { UseCaseTestRunner } from './usecase-tests.js';
import { TemplateResolver } from './template-resolver.js';
import { EnvironmentManager } from './environment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const TRACKING_CONFIGMAP = 'mesh-feature-catalog-current-usecase';
const TRACKING_NAMESPACE = 'default';

/**
 * Use case management utilities
 * Handles Istio mesh use case deployments with automatic cleanup
 */
export class UseCaseManager {
  static USECASES_DIR = join(PROJECT_ROOT, 'config', 'usecases');

  /**
   * Recursively find all YAML files in a directory
   */
  static async findYamlFiles(dir, baseDir = this.USECASES_DIR) {
    const files = [];

    if (!existsSync(dir)) {
      return files;
    }

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        const subFiles = await this.findYamlFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
        files.push({
          file: fullPath,
          relativePath: relativePath.replace(/\\/g, '/'),
        });
      }
    }

    return files;
  }

  /**
   * Get all available use cases
   */
  static async list() {
    try {
      const yamlFiles = await this.findYamlFiles(this.USECASES_DIR);

      return yamlFiles.map(({ file, relativePath }) => {
        // e.g. single-cluster/traffic-management/request-routing.yaml
        //      → category = "single-cluster/traffic-management", name = "request-routing"
        const name = basename(file, '.yaml');
        const categoryPath = dirname(relativePath);
        const category = categoryPath !== '.' ? categoryPath : undefined;
        const displayName = category
          ? `${category}/${name}`.replace(/-/g, ' ')
          : name.replace(/-/g, ' ');

        return {
          name,
          file,
          displayName,
          category,
        };
      });
    } catch (error) {
      throw new Error(`Failed to list use cases: ${error.message}`);
    }
  }

  /**
   * Get a specific use case by name
   */
  static async get(name) {
    const usecases = await this.list();

    let usecase;
    if (name.includes('/')) {
      // Could be "category/name" or "top/sub/name" — last segment is the use case name
      const parts = name.split('/');
      const usecaseName = parts.pop();
      const category = parts.join('/');
      usecase = usecases.find(u => u.category === category && u.name === usecaseName);
    } else {
      usecase = usecases.find(u => u.name === name);

      const matches = usecases.filter(u => u.name === name);
      if (matches.length > 1) {
        throw new Error(
          `Ambiguous use case name '${name}'. Use category/name format. ` +
            `Found in: ${matches.map(m => m.category || 'root').join(', ')}`
        );
      }
    }

    if (!usecase) {
      throw new Error(`Use case '${name}' not found`);
    }

    return usecase;
  }

  /**
   * Prompt user to select a use case
   */
  static async select() {
    try {
      const usecases = await this.list();

      if (usecases.length === 0) {
        throw new Error('No use cases found in config/usecases/');
      }

      const tree = this.buildTree(usecases);
      const selectedName = await Prompts.selectTree('Select use case to deploy:', tree);
      const usecase = usecases.find(u => u.name === selectedName);

      return {
        name: usecase.name,
        file: usecase.file,
      };
    } catch (error) {
      throw new Error(`Failed to select use case: ${error.message}`);
    }
  }

  /**
   * Build a nested tree structure from use cases with multi-level categories.
   * Categories like "single-cluster/traffic-management" become nested branch nodes.
   */
  static buildTree(usecases) {
    const root = {};

    for (const uc of usecases) {
      const segments = uc.category ? uc.category.split('/') : [];
      let node = root;

      for (const seg of segments) {
        if (!node[seg]) node[seg] = {};
        node = node[seg];
      }

      if (!node._items) node._items = [];
      node._items.push(uc);
    }

    const toTree = obj => {
      const branches = [];
      const leaves = [];

      for (const [key, value] of Object.entries(obj)) {
        if (key === '_items') {
          for (const uc of value) {
            leaves.push({
              name: uc.name.replace(/-/g, ' '),
              value: uc.name,
            });
          }
        } else {
          branches.push({
            label: key.replace(/-/g, ' '),
            value: key,
            children: toTree(value),
          });
        }
      }

      branches.sort((a, b) => a.label.localeCompare(b.label));
      leaves.sort((a, b) => a.name.localeCompare(b.name));
      return [...branches, ...leaves];
    };

    return toTree(root);
  }

  /**
   * Parse use case YAML file
   */
  static async parse(filePath) {
    try {
      const content = await readFile(filePath, 'utf8');
      const usecase = yaml.load(content);

      if (!usecase || !usecase.spec) {
        throw new Error('Invalid use case file: missing spec');
      }

      return usecase;
    } catch (error) {
      throw new Error(`Failed to parse use case file: ${error.message}`);
    }
  }

  /**
   * Get the currently deployed use case
   */
  static async getCurrentUseCase() {
    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'configmap',
          TRACKING_CONFIGMAP,
          '-n',
          TRACKING_NAMESPACE,
          '-o',
          'jsonpath={.data.usecase}',
        ],
        { ignoreError: true }
      );

      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Set the currently deployed use case
   */
  static async setCurrentUseCase(name) {
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: TRACKING_CONFIGMAP,
        namespace: TRACKING_NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'mesh-field-kit',
          'mesh-field-kit.io/component': 'usecase-tracker',
        },
      },
      data: {
        usecase: name,
      },
    };

    const yamlContent = yaml.dump(configMap);
    await KubernetesHelper.applyYaml(yamlContent);
  }

  /**
   * Clear the current use case tracking
   */
  static async clearCurrentUseCase() {
    try {
      await KubernetesHelper.kubectl([
        'delete',
        'configmap',
        TRACKING_CONFIGMAP,
        '-n',
        TRACKING_NAMESPACE,
        '--ignore-not-found=true',
      ]);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Validate and get cluster contexts from element
   */
  static async validateAndGetClusterContexts(element, fallbackClusters = null, specInfra = null) {
    const clustersToUse = element.clusters || fallbackClusters;

    if (!clustersToUse || clustersToUse.length === 0) {
      return [];
    }

    if (!specInfra) {
      throw new Error('spec.infra is required to resolve cluster contexts');
    }

    const infraState = await InfraStateManager.load(specInfra);
    if (!infraState) {
      throw new Error(
        `Infra '${specInfra}' not found. Run 'mesh base infra cloud provision -p ${specInfra}' first.`
      );
    }

    const clusterContexts = [];
    for (const cluster of clustersToUse) {
      if (!cluster.name) {
        throw new Error('Cluster definition must include a "name" field');
      }

      const context = InfraStateManager.resolveContextForCluster(infraState, cluster.name);
      if (!context) {
        throw new Error(
          `Could not resolve context for cluster '${cluster.name}' from infra '${specInfra}'`
        );
      }

      clusterContexts.push({
        name: cluster.name,
        infra: specInfra,
        context,
      });
    }

    return clusterContexts;
  }

  /**
   * Deploy an application
   */
  static async deployApplication(
    appName,
    namespace = null,
    clusterContexts = null,
    templateContext = null,
    dataplaneMode = 'ambient'
  ) {
    const appPath = join(PROJECT_ROOT, 'extras', 'applications', appName, `${appName}.yaml`);

    if (!existsSync(appPath)) {
      throw new Error(`Application '${appName}' not found at ${appPath}`);
    }

    const content = await readFile(appPath, 'utf8');
    let resources = yaml.loadAll(content);

    // Resolve {{env.*}} / {{cluster.*}} templates if context provided
    if (templateContext) {
      resources = TemplateResolver.resolveValues(resources, templateContext);
    }

    // Update namespace if specified
    if (namespace) {
      for (const resource of resources) {
        if (resource.metadata) {
          resource.metadata.namespace = namespace;
        }
      }
    }

    const targetNamespace = namespace || resources[0]?.metadata?.namespace || 'default';
    const contexts = clusterContexts && clusterContexts.length > 0 ? clusterContexts : [null];

    for (const clusterInfo of contexts) {
      const context = clusterInfo?.context || null;
      const contextDisplay = context || 'current context';

      Logger.info(`Deploying application '${appName}' to ${contextDisplay}...`);

      // Ensure namespace exists and is labeled for the requested dataplane mode
      const contextFlag = context ? `--context=${context}` : '';
      await CommandRunner.exec(
        `kubectl ${contextFlag} create namespace ${targetNamespace} --dry-run=client -o yaml | kubectl ${contextFlag} apply -f -`
      );
      await KubernetesHelper.labelNamespaceForDataplaneMode(
        targetNamespace,
        dataplaneMode,
        context
      );

      // Apply each resource
      for (const resource of resources) {
        const yamlContent = yaml.dump(resource, { lineWidth: -1 });
        const tempFile = join(tmpdir(), `mesh-app-${Date.now()}.yaml`);
        writeFileSync(tempFile, yamlContent);
        try {
          await CommandRunner.exec(`kubectl ${contextFlag} apply -f ${tempFile}`);
        } finally {
          unlinkSync(tempFile);
        }
      }

      Logger.success(`Application '${appName}' deployed to ${contextDisplay}`);
    }
  }

  static PROTECTED_NAMESPACES = new Set([
    'default',
    'kube-system',
    'kube-public',
    'kube-node-lease',
    'istio-system',
  ]);

  /**
   * Resolve the namespace used when deploying an application (matches deployApplication).
   */
  static async resolveApplicationNamespace(appName, appNamespaceOverride, specNamespace) {
    if (appNamespaceOverride) return appNamespaceOverride;
    if (specNamespace) return specNamespace;

    const appPath = join(PROJECT_ROOT, 'extras', 'applications', appName, `${appName}.yaml`);
    if (!existsSync(appPath)) return null;

    const content = await readFile(appPath, 'utf8');
    const resources = yaml.loadAll(content);
    return resources[0]?.metadata?.namespace || null;
  }

  /**
   * Delete an application namespace from a cluster context.
   */
  static async deleteApplicationNamespace(namespace, context = null) {
    if (!namespace || this.PROTECTED_NAMESPACES.has(namespace)) {
      return;
    }

    const contextFlag = context ? `--context=${context}` : '';
    const contextDisplay = context || 'current context';

    Logger.info(`Deleting namespace '${namespace}' from ${contextDisplay}...`);
    await CommandRunner.exec(
      `kubectl ${contextFlag} delete namespace ${namespace} --ignore-not-found=true`
    );
    Logger.success(`Namespace '${namespace}' deleted from ${contextDisplay}`);
  }

  /**
   * Merge kubeconfig files from infra state into process.env.KUBECONFIG so
   * kubectl --context=<name> calls work without the user having to set KUBECONFIG manually.
   *
   * Paths come exclusively from state.yaml (infraState.status.clusters[].kubeconfig).
   * Infra kubeconfigs are prepended so their current-context takes priority over
   * any stale context in ~/.kube/config.
   */
  static async ensureKubeconfigsLoaded(specInfra) {
    if (!specInfra) return;
    try {
      const infraState = await InfraStateManager.load(specInfra);
      const paths = infraState?.status?.clusters?.map(c => c.kubeconfig).filter(Boolean) || [];
      if (paths.length === 0) return;

      const existing = process.env.KUBECONFIG || '';
      const existingParts = existing.split(':').filter(Boolean);
      const parts = [...new Set([...paths, ...existingParts])];
      process.env.KUBECONFIG = parts.join(':');
    } catch {
      // best-effort — if state missing just continue
    }
  }

  /**
   * Merge kubeconfig files from every provisioned infra into process.env.KUBECONFIG.
   * Used when the tracked use case (and therefore its infra) isn't known yet,
   * so the current-use-case ConfigMap can still be found regardless of which
   * cluster context is ambient.
   */
  static async ensureAllKubeconfigsLoaded() {
    try {
      const profiles = await InfraStateManager.listInfraProfiles();
      for (const profile of profiles) {
        await this.ensureKubeconfigsLoaded(profile.name);
      }
    } catch {
      // best-effort — if listing fails just continue
    }
  }

  /**
   * Build a template context from spec.infra for {{env.*}} resolution in feature configs.
   * Returns null if no infra or environment is resolvable.
   */
  static async buildTemplateContext(specInfra) {
    if (!specInfra) return null;
    try {
      const infraPath = join(PROJECT_ROOT, 'config', 'infra', `${specInfra}.yaml`);
      if (!existsSync(infraPath)) return null;
      const infraProfile = yaml.load(await readFile(infraPath, 'utf8'));
      const envName = infraProfile?.spec?.environment;
      if (!envName) return null;
      const environment = await EnvironmentManager.load(envName);
      const infraState = await InfraStateManager.load(specInfra);
      return TemplateResolver.buildContext(
        { name: '', context: '', role: '' },
        environment,
        infraState
      );
    } catch {
      return null;
    }
  }

  /**
   * Deploy a use case
   */
  static async deploy(name, options = {}) {
    const spinner = new SpinnerLogger();

    try {
      let filePath;
      if (name.endsWith('.yaml')) {
        filePath = name;
      } else {
        const usecase = await this.get(name);
        filePath = usecase.file;
      }

      const usecase = await this.parse(filePath);
      const { metadata, spec } = usecase;

      // Load kubeconfig files from infra state so cluster contexts are resolvable.
      // Must happen before getCurrentUseCase/setCurrentUseCase below, since those
      // rely on the ambient kubectl context resolving to the right cluster.
      if (spec.infra) {
        await this.ensureKubeconfigsLoaded(spec.infra);
      }

      // Check for existing use case
      const currentUseCase = await this.getCurrentUseCase();
      if (currentUseCase && currentUseCase !== filePath) {
        Logger.warn('Found existing use case deployed');
        Logger.info(`Cleaning up previous use case before deploying '${metadata.name}'...`);

        try {
          await this.cleanup(currentUseCase);
          Logger.success('Previous use case cleaned up');
        } catch (error) {
          Logger.warn(`Failed to clean up previous use case: ${error.message}`);
          throw error;
        }
      }

      const interactive = options.interactive !== false;
      const diagrams = options.diagrams !== false;

      // Show overview and optionally wait for user confirmation
      const steps = (spec.features || []).map(f => ({
        title: f.description || f.name,
        features: [{ name: f.name }],
      }));
      // spec.diagram: false explicitly opts a use case out of the diagram/feature-box
      // display (e.g. when it wouldn't add anything beyond the Steps list above it).
      const diagramSetting = spec.diagram === false ? false : spec.diagram || null;
      if (diagrams) await showUseCaseOverview(metadata, spec, steps, diagramSetting);
      if (interactive) {
        showWaitPrompt();
        await waitForKey();
        console.log('');
      }

      const { namespace } = spec;
      if (namespace) {
        Logger.info(`Using namespace: ${namespace}`);
        FeatureManager.setDefaultNamespace(namespace);
      }

      const templateContext = await this.buildTemplateContext(spec.infra);

      // Record current use case before any deployment so cleanup works even if deployment fails
      await this.setCurrentUseCase(filePath);

      // Deploy required applications
      const requiredApps = spec.requires?.applications || [];
      const features = spec.features || [];
      const hasApps = requiredApps.length > 0;
      const totalSteps = (hasApps ? 1 : 0) + features.length;
      let stepIndex = 1;

      if (hasApps) {
        const appNames = requiredApps
          .map(a => (typeof a === 'string' ? a : a?.name))
          .filter(Boolean)
          .join(', ');
        if (diagrams)
          showStepHeader(stepIndex++, totalSteps, `Deploy required applications: ${appNames}`);
        if (interactive) {
          showWaitPrompt();
          await waitForKey();
          console.log('');
        }

        const specLevelClusters = spec.clusters || null;
        const specLevelInfra = spec.infra || null;
        for (const app of requiredApps) {
          const appNameToDeploy = typeof app === 'string' ? app : app?.name || app;
          const appNamespace = typeof app === 'object' && app.namespace ? app.namespace : null;
          const appDataplaneMode =
            typeof app === 'object' && app.dataplaneMode ? app.dataplaneMode : 'ambient';

          let appClusterContexts = null;
          if (typeof app === 'object' && app.clusters) {
            appClusterContexts = await this.validateAndGetClusterContexts(
              app,
              specLevelClusters,
              specLevelInfra
            );
          } else if (specLevelClusters) {
            appClusterContexts = await this.validateAndGetClusterContexts(
              { clusters: specLevelClusters },
              null,
              specLevelInfra
            );
          }

          await this.deployApplication(
            appNameToDeploy,
            appNamespace,
            appClusterContexts,
            templateContext,
            appDataplaneMode
          );
        }
        Logger.success('All required applications deployed');
      }

      if (features.length === 0) {
        Logger.warn('No features configured in use case');
      }

      for (let i = 0; i < features.length; i++) {
        const feature = features[i];
        const featureName = feature.name;
        const rawConfig = feature.config || {};
        const resolved = templateContext
          ? TemplateResolver.resolveValues(rawConfig, templateContext)
          : rawConfig;

        const featureConfig = { ...resolved };
        if (feature.clusters) {
          featureConfig.clusterContexts = await this.validateAndGetClusterContexts(
            feature,
            spec.clusters || null,
            spec.infra || null
          );
        }

        if (diagrams) showStepHeader(stepIndex++, totalSteps, feature.description || featureName);
        if (feature.notes) {
          const notesArr = Array.isArray(feature.notes) ? feature.notes : [feature.notes];
          for (const note of notesArr) {
            Logger.warn(`📝 NOTE: ${note}`);
          }
        }
        if (interactive) {
          showWaitPrompt();
          await waitForKey();
          console.log('');
        }

        try {
          await FeatureManager.deploy(featureName, featureConfig);
        } catch (error) {
          Logger.error(`Failed to deploy feature '${featureName}': ${error.message}`);
          throw error;
        }
      }

      Logger.success(`Use case '${metadata.name}' deployed successfully`);

      // Run tests if configured
      if (spec.tests && spec.tests.length > 0 && !options.skipTests && !process.env.DISABLE_TEST) {
        const resolvedSpec = templateContext
          ? TemplateResolver.resolveValues(spec, templateContext)
          : spec;
        await UseCaseTestRunner.runTests({ metadata, spec: resolvedSpec });
      }
    } catch (error) {
      spinner.fail(`Failed to deploy use case: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up a use case
   */
  static async cleanup(name) {
    const spinner = new SpinnerLogger();

    try {
      let filePath;
      if (name.endsWith('.yaml')) {
        filePath = name;
      } else {
        const usecase = await this.get(name);
        filePath = usecase.file;
      }

      const usecase = await this.parse(filePath);
      const { metadata, spec } = usecase;

      const { namespace } = spec;
      const features = spec.features || [];

      if (namespace) {
        FeatureManager.setDefaultNamespace(namespace);
      }

      // Load kubeconfig files from infra state so cluster contexts are resolvable
      if (spec.infra) {
        await this.ensureKubeconfigsLoaded(spec.infra);
      }

      const templateContext = await this.buildTemplateContext(spec.infra);
      const requiredApps = spec.requires?.applications || [];
      const specLevelClusters = spec.clusters || null;
      const specLevelInfra = spec.infra || null;

      if (features.length > 0) {
        Logger.info(`Cleaning up use case '${metadata.name}' (${features.length} feature(s))`);

        // Clean up features in reverse order
        for (const feature of [...features].reverse()) {
          const featureName = feature.name;
          const rawConfig = feature.config || {};
          const resolved = templateContext
            ? TemplateResolver.resolveValues(rawConfig, templateContext)
            : rawConfig;

          const featureConfig = { ...resolved };
          if (feature.clusters) {
            featureConfig.clusterContexts = await this.validateAndGetClusterContexts(
              feature,
              spec.clusters || null,
              spec.infra || null
            );
          }

          try {
            await FeatureManager.cleanup(featureName, featureConfig);
          } catch (error) {
            Logger.warn(`Failed to clean up feature '${featureName}': ${error.message}`);
            throw error;
          }
        }
      }

      if (requiredApps.length > 0) {
        console.log('');
        Logger.info('Cleaning up applications...');

        const namespacesToDelete = new Map();

        for (const app of [...requiredApps].reverse()) {
          const appNameToClean = typeof app === 'string' ? app : app?.name || app;
          const appNamespaceOverride =
            typeof app === 'object' && app.namespace ? app.namespace : null;
          const appNamespace = await this.resolveApplicationNamespace(
            appNameToClean,
            appNamespaceOverride,
            namespace
          );

          let appClusterContexts = null;
          if (typeof app === 'object' && app.clusters) {
            appClusterContexts = await this.validateAndGetClusterContexts(
              app,
              specLevelClusters,
              specLevelInfra
            );
          } else if (specLevelClusters) {
            appClusterContexts = await this.validateAndGetClusterContexts(
              { clusters: specLevelClusters },
              null,
              specLevelInfra
            );
          }
          const contexts = appClusterContexts?.length > 0 ? appClusterContexts : [null];

          try {
            const appPath = join(
              PROJECT_ROOT,
              'extras',
              'applications',
              appNameToClean,
              `${appNameToClean}.yaml`
            );
            if (existsSync(appPath)) {
              const content = await readFile(appPath, 'utf8');
              const resources = yaml.loadAll(content);
              if (appNamespace) {
                for (const resource of resources) {
                  if (resource?.metadata) resource.metadata.namespace = appNamespace;
                }
              }
              const tempFile = join(tmpdir(), `mesh-cleanup-${Date.now()}.yaml`);
              writeFileSync(
                tempFile,
                resources.map(r => yaml.dump(r, { lineWidth: -1 })).join('---\n')
              );
              try {
                for (const clusterInfo of contexts) {
                  const contextFlag = clusterInfo?.context
                    ? `--context=${clusterInfo.context}`
                    : '';
                  await CommandRunner.exec(
                    `kubectl ${contextFlag} delete -f ${tempFile} --ignore-not-found=true`
                  );
                }
              } finally {
                unlinkSync(tempFile);
              }
              Logger.success(`Application '${appNameToClean}' cleaned up`);

              if (appNamespaceOverride) {
                for (const clusterInfo of contexts) {
                  const context = clusterInfo?.context || null;
                  const key = `${context || ''}:${appNamespaceOverride}`;
                  namespacesToDelete.set(key, { namespace: appNamespaceOverride, context });
                }
              }
            }
          } catch (error) {
            Logger.warn(`Failed to clean up application '${appNameToClean}': ${error.message}`);
            throw error;
          }
        }

        if (namespacesToDelete.size > 0) {
          console.log('');
          Logger.info('Deleting application namespaces...');
          for (const { namespace: ns, context } of namespacesToDelete.values()) {
            await this.deleteApplicationNamespace(ns, context);
          }
        }
      }

      const currentUseCase = await this.getCurrentUseCase();
      if (currentUseCase === filePath) {
        await this.clearCurrentUseCase();
      }

      Logger.success(`Use case '${metadata.name}' cleaned up successfully`);
    } catch (error) {
      spinner.fail(`Failed to clean up use case: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up the currently deployed use case
   */
  static async cleanupAll() {
    await this.ensureAllKubeconfigsLoaded();
    const currentUseCase = await this.getCurrentUseCase();
    if (currentUseCase) {
      await this.cleanup(currentUseCase);
    } else {
      await this.clearCurrentUseCase();
      Logger.info('No use case currently deployed; nothing to clean');
    }
  }

  /**
   * Test a use case
   */
  static async test(name) {
    let filePath;
    if (name.endsWith('.yaml')) {
      filePath = name;
    } else {
      const usecase = await this.get(name);
      filePath = usecase.file;
    }

    const usecase = await this.parse(filePath);
    if (usecase.spec?.infra) {
      await this.ensureKubeconfigsLoaded(usecase.spec.infra);
    }
    const templateContext = await this.buildTemplateContext(usecase.spec?.infra);
    const resolved = templateContext
      ? { ...usecase, spec: TemplateResolver.resolveValues(usecase.spec, templateContext) }
      : usecase;
    await UseCaseTestRunner.runTests(resolved);
  }
}
