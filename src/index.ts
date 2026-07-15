import { LMStudioClient, type PluginContext } from "@lmstudio/sdk";
import { type ModelOption, createSchematics } from "./config";
import { generate } from "./generator";

declare const process: { env: Record<string, string | undefined> };

/**
 * The plugin host passes its connection details in through the environment — the same ones the
 * generated entry point uses to build its own client. PluginContext itself exposes no client, so
 * this is the only way to read the model list while building the config schematics.
 */
async function listModelOptions(): Promise<Array<ModelOption>> {
  try {
    const client = new LMStudioClient({
      clientIdentifier: process.env.LMS_PLUGIN_CLIENT_IDENTIFIER,
      clientPasskey: process.env.LMS_PLUGIN_CLIENT_PASSKEY,
      baseUrl: process.env.LMS_PLUGIN_BASE_URL,
    });
    const models = await client.system.listDownloadedModels();
    return models
      .filter(model => model.type === "llm")
      .map(model => ({ value: model.modelKey, displayName: model.displayName }));
  } catch (error) {
    // A dropdown with only the "currently loaded" entry is worth more than a plugin that fails
    // to register at all.
    console.error("[config] could not list models, falling back to an empty picker:", error);
    return [];
  }
}

export async function main(context: PluginContext) {
  const configSchematics = createSchematics(await listModelOptions());
  context.withConfigSchematics(configSchematics);
  context.withGenerator((ctl, chat) => generate(ctl, chat, configSchematics));
}
