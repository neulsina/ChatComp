import { createConfigSchematics } from "@lmstudio/sdk";

export interface ModelOption {
  value: string;
  displayName: string;
}

/**
 * Stands in for "don't pin a model". It cannot be the empty string: the SDK rejects select options
 * whose value is shorter than one character.
 */
export const USE_LOADED_MODEL = "__use_loaded_model__";

/**
 * Built at plugin startup rather than at module scope so the model list can be filled in with the
 * models actually on this machine. The consequence is that a model downloaded later will not
 * appear until the plugin reloads.
 */
export function createSchematics(modelOptions: Array<ModelOption>) {
  return createConfigSchematics()
    .field(
      "modelKey",
      "select",
      {
        displayName: "Target Model",
        subtitle: "The model that generates responses and writes the summaries.",
        options: [
          { value: USE_LOADED_MODEL, displayName: "Whichever model is currently loaded" },
          ...modelOptions,
        ],
      },
      USE_LOADED_MODEL,
    )
    .field(
      "enableCompaction",
      "boolean",
      {
        displayName: "Enable Compaction",
        subtitle: "When off, the conversation is forwarded untouched.",
      },
      true,
    )
    .field(
      "compactThreshold",
      "numeric",
      {
        displayName: "Compaction Threshold",
        subtitle: "Compact once context usage exceeds this percentage.",
        min: 10,
        max: 95,
        step: 1,
        slider: { min: 10, max: 95, step: 1 },
        shortHand: "thresh",
      },
      70,
    )
    .field(
      "keepRecentTurns",
      "numeric",
      {
        displayName: "Keep Recent Turns",
        subtitle: "How many of the most recent messages to keep verbatim.",
        min: 2,
        max: 50,
        step: 1,
        slider: { min: 2, max: 50, step: 1 },
      },
      6,
    )
    .field(
      "summaryMaxTokens",
      "numeric",
      {
        displayName: "Summary Token Budget",
        subtitle:
          "Cap on the summary generation. Too low and the summary is cut off mid-JSON, which " +
          "makes compaction skip that turn rather than inject a broken summary.",
        min: 128,
        max: 4096,
        step: 32,
        slider: { min: 128, max: 4096, step: 32 },
      },
      1024,
    )
    .field(
      "temperature",
      "numeric",
      {
        displayName: "Temperature",
        min: 0,
        step: 0.01,
        slider: { min: 0, max: 1, step: 0.01 },
        precision: 2,
        shortHand: "temp",
      },
      0.8,
    )
    .build();
}

export type AppConfigSchematics = ReturnType<typeof createSchematics>;
