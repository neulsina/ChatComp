import { type Chat, type GeneratorController } from "@lmstudio/sdk";
import { compact } from "./compactor";
import { type AppConfigSchematics, USE_LOADED_MODEL } from "./config";

export async function generate(
  ctl: GeneratorController,
  chat: Chat,
  configSchematics: AppConfigSchematics,
) {
  const pluginConfig = ctl.getPluginConfig(configSchematics);
  const modelKey = pluginConfig.get("modelKey").trim();
  const temperature = pluginConfig.get("temperature");

  // ctl.client is already connected to the LM Studio instance hosting this plugin, so there is no
  // base URL to configure and no need for the local server to be enabled.
  const client = ctl.client;

  // The only overloads are model(key, opts) and model(); there is no model(undefined, opts). The
  // no-argument path returns "any loaded model", which is why pinning a specific one is better
  // when several are loaded. Naming a model that is not loaded makes the SDK load it, which can
  // take tens of seconds on first use.
  const model =
    modelKey === USE_LOADED_MODEL
      ? await client.llm.model()
      : await client.llm.model(modelKey, { signal: ctl.abortSignal, verbose: false });

  let outgoingChat = chat;
  if (pluginConfig.get("enableCompaction")) {
    // A generator has no way to draw a status block — createStatus lives on ProcessingController,
    // which only prompt preprocessors get. Compaction progress can only go to the dev server log.
    const result = await compact(
      model,
      chat,
      {
        thresholdPercent: pluginConfig.get("compactThreshold"),
        keepRecentTurns: pluginConfig.get("keepRecentTurns"),
        summaryMaxTokens: pluginConfig.get("summaryMaxTokens"),
      },
      ctl.abortSignal,
    );
    outgoingChat = result.chat;
    console.info(
      `[compaction] ${result.action} at ${result.usagePercent.toFixed(1)}% of context` +
        (result.detail === undefined ? "" : ` (${result.detail})`),
    );
  }

  await model.respond(outgoingChat, {
    rawTools: {
      type: "toolArray",
      tools: ctl.getToolDefinitions(),
    },
    temperature,
    onPredictionFragment: fragment => ctl.fragmentGenerated(fragment.content, fragment),
    onToolCallRequestStart: () => ctl.toolCallGenerationStarted(),
    onToolCallRequestNameReceived: (_callId, name) => ctl.toolCallGenerationNameReceived(name),
    onToolCallRequestArgumentFragmentGenerated: (_callId, content) =>
      ctl.toolCallGenerationArgumentFragmentGenerated(content),
    onToolCallRequestEnd: (_callId, info) => ctl.toolCallGenerationEnded(info.toolCallRequest),
    onToolCallRequestFailure: (_callId, error) => ctl.toolCallGenerationFailed(error),
    signal: ctl.abortSignal,
  });
}
