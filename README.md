# context-compaction

**An LM Studio plugin that lets long chats keep going without forgetting what you said.**

[![LM Studio](https://img.shields.io/badge/LM%20Studio-plugin-blue)](https://lmstudio.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## The problem

When a chat fills up the context window, LM Studio can only throw messages away:

| Policy | What it does |
| --- | --- |
| **Rolling Window** | Drops the oldest messages |
| **Truncate Middle** | Drops the middle of the conversation |
| **Stop at Limit** | Stops replying |

Whatever gets dropped is gone. Ask about a decision from fifty messages ago and the model has no
idea what you mean.

## What this does

Instead of deleting old turns, it **summarizes** them into a compact system message and keeps your
recent turns word-for-word:

```
Before  ─ system │ msg 1 │ msg 2 │ ... │ msg 40 │ msg 41 │ msg 42    ← over the limit
After   ─ system │ summary of 1–36  │  msg 37 │ ... │ msg 42          ← fits, still remembers
```

The summary is not free prose — the model fills in a fixed structure (objective, decisions,
constraints, open questions, artifacts), which is then rendered into the system message. That keeps
the size predictable and the important parts from being paraphrased away.

Summarization is not something LM Studio does on its own; it is an
[open feature request](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1677).

---

## Install

You need **LM Studio** with at least one LLM downloaded. You do **not** need Node.js — LM Studio
ships its own runtime and `lms dev` uses it.

```bash
git clone https://github.com/neulsina/lmstudio-context-compaction.git
cd lmstudio-context-compaction
lms dev --install
```

That installs the plugin permanently. To hack on it instead, run `lms dev` — it rebuilds on every
save, but the plugin only exists while that command is running and shows up as
`dev/local/context-compaction`.

> `lms` comes with LM Studio. If it is not on your PATH, it lives in `~/.lmstudio/bin`.

---

## Use

**1. Pick it in the model dropdown.**

This plugin *is* the model as far as LM Studio is concerned — selecting it is what turns it on.
Your real model gets chosen in step 3.

**2. Open the settings tab.**

Top right, the sliders icon next to Integrations. It normally reads **Model**; with this plugin
selected it reads **Generator**. That is where the settings live.

> Looking in **Integrations** will not find it. Plugins that provide a generator never appear in
> that list — the model dropdown is where they go.

**3. Set the target model.**

| Setting | Default | What it does |
| --- | --- | --- |
| **Target Model** | Whichever model is currently loaded | The model that answers you *and* writes the summaries. |
| **Enable Compaction** | On | Off forwards the chat untouched. |
| **Compaction Threshold** | 70% | How full the context gets before compacting. |
| **Keep Recent Turns** | 6 | How many recent messages stay word-for-word. |
| **Summary Token Budget** | 1024 | Room the summary gets. Too little and it is cut off, and that turn is skipped. |
| **Temperature** | 0.8 | Your replies only — summaries always run at 0. |

Then just chat. Compaction happens on its own once you cross the threshold; there is nothing to
type and no command to run.

### Good to know

**The context meter never goes down.** It shows what LM Studio is storing, and no plugin can change
that. Only what gets *sent to the model* is compacted. A chat sitting at 108% can be working
perfectly.

**Summarizing takes a few seconds of silence.** Generators cannot draw a progress indicator, so
there is no spinner. Check the `lms dev` log if you want to see it happen.

**Leaving Target Model on the default is fine with one model loaded.** With several, it resolves to
"any of them", so pin the one you want. Naming a model that is not loaded will load it, which can
take a while.

---

## How it works

Every turn, the plugin:

1. **Measures** context usage.
2. **Passes through** untouched if you are under the threshold — no cost at all.
3. **Summarizes** the older messages into a zod schema using grammar-constrained structured output,
   then forwards `[your system prompt] + [summary] + [recent turns]` to the real model.

Two things make it usable rather than merely correct:

- **Summaries are cached.** LM Studio hands the plugin the full history every single turn, so a
  naive version would re-summarize on every message. The compaction point only moves every few
  messages, and the turns in between reuse the cached summary — about 20 ms instead of 2.5 s.
- **Re-compaction updates the summary instead of re-summarizing it.** Summarizing a summary loses
  a little more each time. Feeding the previous structure back and asking for an updated one
  appends to the decision list rather than eroding it.

If a summary comes back malformed, the chat is forwarded untouched rather than injected with a
broken summary. A skipped compaction is recoverable; a corrupted system message is not.

### Why a generator?

A prompt preprocessor would be nicer — it works with whatever model you already picked and shows up
in Integrations. It cannot do this job. A preprocessor can *read* history but may only return a
replacement for your current message; the SDK gives it no way to remove or rewrite earlier ones.
Adding a summary without removing anything just makes the context bigger.

Only a generator receives the whole conversation and decides what the model actually sees. Having
to select it as the model is the price of that.

### Known limits

- Summaries break on **gpt-oss** models — grammar-constrained decoding blocks Harmony control
  tokens ([bug](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1555)). Reasoning models
  using ChatML are fine; the grammar suppresses the `<think>` block and the summary comes back as
  clean JSON.
- The **model list is read at startup**, so a model downloaded later will not show up in Target
  Model until the plugin reloads.

---

## Develop

```bash
lms dev              # build, watch, register with the running LM Studio
npm run typecheck    # needs Node.js
```

`esbuild` does not type-check, so `npm run typecheck` is not optional — it is the only thing that
catches type errors before runtime. Several bugs here reached runtime with a perfectly clean build:
the SDK rejects `llm.model("")`, and rejects a `select` option whose value is an empty string.
Neither is visible to the bundler.

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point. Builds the config from your installed models, registers the generator. |
| `src/config.ts` | Settings schema. |
| `src/generator.ts` | Forwards to the real model — streaming, tool calls, cancellation. |
| `src/compactor.ts` | All the compaction logic: measuring, thresholds, caching, fallback. |
| `src/schema.ts` | The summary structure and how it is rendered. |

To publish to LM Studio Hub, change `"owner"` in `manifest.json` from `local` to your Hub username
and run `lms push`.

## License

MIT
