import type {
  PluginPackageAutomationPublication,
  PluginPackageAutomationPublicationState,
} from '@qinglong/runtime-core/plugin-package-automation-publication';

export const PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA =
  'qinglong/plugin-package-prompt-catalog@v1' as const;

export interface PluginPackagePromptCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly parameters: readonly Readonly<{
    name: string;
    description: string | null;
    required: boolean;
  }>[];
}

export interface PluginPackagePromptCatalogResult {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA;
  readonly projectId: string;
  readonly packageName: string;
  readonly found: boolean;
  readonly publicationState: PluginPackageAutomationPublicationState | null;
  readonly prompts: readonly Readonly<PluginPackagePromptCatalogItem>[];
}

export interface PluginPackagePromptCatalogCapability {
  inspect(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackagePromptCatalogResult>>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createPluginPackagePromptCatalogResult(
  projectId: string,
  packageName: string,
  publication: Readonly<PluginPackageAutomationPublication> | null,
): Readonly<PluginPackagePromptCatalogResult> {
  if (!IDENTIFIER.test(projectId) || !PACKAGE_NAME.test(packageName)) {
    throw new TypeError('Plugin Package Prompt catalog target is invalid');
  }
  if (publication === null) {
    return Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA,
      projectId,
      packageName,
      found: false,
      publicationState: null,
      prompts: Object.freeze([]),
    });
  }
  if (
    publication.target.projectId !== projectId ||
    publication.target.packageName !== packageName
  ) {
    throw new TypeError('Plugin Package Prompt catalog publication is invalid');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA,
    projectId,
    packageName,
    found: true,
    publicationState: publication.state,
    prompts: Object.freeze(
      publication.definitions.prompts.map((prompt) =>
        Object.freeze({
          id: prompt.id,
          name: prompt.name,
          description: prompt.description ?? null,
          parameters: Object.freeze(
            prompt.parameters.map((parameter) =>
              Object.freeze({
                name: parameter.name,
                description: parameter.description ?? null,
                required: parameter.required,
              }),
            ),
          ),
        }),
      ),
    ),
  });
}
