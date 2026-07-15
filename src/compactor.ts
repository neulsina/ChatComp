import { Chat, type ChatMessage, type LLM } from "@lmstudio/sdk";
import { type ConversationSummary, renderSummary, summarySchema } from "./schema";

export interface CompactOptions {
  thresholdPercent: number;
  keepRecentTurns: number;
  summaryMaxTokens: number;
}

export interface CompactResult {
  chat: Chat;
  /** What happened, for surfacing as a status in the UI and for tests. */
  action: "passthrough" | "compacted" | "reused-summary" | "fallback";
  usagePercent: number;
  detail?: string;
}

const SUMMARIZE_SYSTEM_PROMPT =
  "You compact conversations so they fit in a limited context window. Summarize the conversation " +
  "into the given schema. Record concrete decisions, constraints, and unresolved questions — not " +
  "pleasantries. Be factual and concise. Write in the language the conversation uses.";

const UPDATE_SYSTEM_PROMPT =
  "You maintain a running structured summary of a long conversation. Update the existing summary " +
  "with the new messages. Preserve every existing decision and constraint, then append what the " +
  "new messages add. Never drop prior entries. Write in the language the conversation uses.";

/**
 * Compaction re-runs on every turn because LM Studio hands the generator the full, unmodified
 * history each time — nothing we return is persisted. Summarizing from scratch each turn would
 * cost an LLM call per message, so summaries are cached per conversation.
 */
interface CacheEntry {
  /** How many leading messages this summary covers. */
  covered: number;
  fingerprint: string;
  summary: ConversationSummary;
}
const summaryCache = new Map<string, CacheEntry>();

/** The plugin process outlives any one chat, so the cache needs a ceiling. */
const MAX_CACHED_CONVERSATIONS = 32;

/**
 * Advancing the compaction boundary one message at a time would invalidate the cache every turn.
 * Quantizing it means the boundary only moves every BLOCK_SIZE messages, so the turns in between
 * reuse the cached summary and cost nothing.
 */
const BLOCK_SIZE = 4;

function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function fingerprintOf(messages: Array<ChatMessage>): string {
  // NUL cannot appear in message text, so joining on it keeps two different message lists from
  // fingerprinting alike. It has to stay written as an escape: a literal NUL byte in the source
  // makes git treat this file as binary.
  return hash(messages.map(m => `${m.getRole()}:${m.getText()}`).join("\u0000"));
}

function transcriptOf(messages: Array<ChatMessage>): string {
  return messages.map(m => `${m.getRole()}: ${m.getText()}`).join("\n\n");
}

async function measureUsage(model: LLM, chat: Chat): Promise<number> {
  const [formatted, contextLength] = await Promise.all([
    model.applyPromptTemplate(chat),
    model.getContextLength(),
  ]);
  const used = await model.countTokens(formatted);
  return (used / contextLength) * 100;
}

async function summarize(
  model: LLM,
  messages: Array<ChatMessage>,
  previous: ConversationSummary | undefined,
  maxTokens: number,
  signal: AbortSignal,
): Promise<ConversationSummary> {
  const prompt =
    previous === undefined
      ? transcriptOf(messages)
      : `EXISTING SUMMARY:\n${JSON.stringify(previous, null, 2)}\n\n` +
        `NEW MESSAGES:\n${transcriptOf(messages)}`;

  const result = await model.respond(
    [
      { role: "system", content: previous === undefined ? SUMMARIZE_SYSTEM_PROMPT : UPDATE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    {
      structured: summarySchema,
      // Without a cap a model that never closes the JSON would generate forever. With one, a
      // truncated response fails schema validation and throws — which the caller turns into a
      // passthrough rather than a broken summary.
      maxTokens,
      temperature: 0,
      signal,
    },
  );
  return result.parsed;
}

export async function compact(
  model: LLM,
  chat: Chat,
  opts: CompactOptions,
  signal: AbortSignal,
): Promise<CompactResult> {
  const usagePercent = await measureUsage(model, chat);
  if (usagePercent < opts.thresholdPercent) {
    return { chat, action: "passthrough", usagePercent };
  }

  const messages = chat.getMessagesArray();
  // System messages are pulled out wherever they sit and put back at the front, since that is
  // where a system prompt belongs and LM Studio does not put them anywhere else in practice.
  const systemMessages = messages.filter(m => m.isSystemPrompt());
  const body = messages.filter(m => !m.isSystemPrompt());

  const boundary =
    Math.floor(Math.max(0, body.length - opts.keepRecentTurns) / BLOCK_SIZE) * BLOCK_SIZE;
  if (boundary <= 0) {
    // Over threshold but too short to compact: a single huge message, most likely.
    return { chat, action: "passthrough", usagePercent, detail: "nothing old enough to compact" };
  }

  const toSummarize = body.slice(0, boundary);
  const recent = body.slice(boundary);
  const cacheKey = hash(`${body[0].getRole()}:${body[0].getText()}`);
  const fingerprint = fingerprintOf(toSummarize);
  const cached = summaryCache.get(cacheKey);

  // The key is only the opening message, so two chats that start alike land on the same entry. An
  // entry is only usable if its fingerprint still matches this conversation's prefix of the same
  // length — without that check, extending would build this chat's summary on another chat's.
  const usable =
    cached !== undefined &&
    cached.covered <= boundary &&
    fingerprintOf(toSummarize.slice(0, cached.covered)) === cached.fingerprint;

  let summary: ConversationSummary;
  let action: CompactResult["action"];

  if (usable && cached!.covered === boundary) {
    summary = cached!.summary;
    action = "reused-summary";
  } else {
    try {
      // When the boundary has only advanced, feed the previous summary plus the newly-covered
      // messages instead of re-reading the whole history. Re-summarizing a summary loses detail
      // each generation; updating a structured one appends to it instead.
      const canExtend = usable && cached!.covered < boundary;
      summary = await summarize(
        model,
        canExtend ? toSummarize.slice(cached!.covered) : toSummarize,
        canExtend ? cached!.summary : undefined,
        opts.summaryMaxTokens,
        signal,
      );
      action = "compacted";
    } catch (error) {
      if (signal.aborted) throw error;
      // A truncated or malformed summary must not take the conversation down with it. Forwarding
      // the history untouched leaves LM Studio's own context overflow policy to cope.
      return {
        chat,
        action: "fallback",
        usagePercent,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!summaryCache.has(cacheKey) && summaryCache.size >= MAX_CACHED_CONVERSATIONS) {
      // A Map iterates in insertion order, so the first key is the least recently added.
      const oldest = summaryCache.keys().next().value;
      if (oldest !== undefined) summaryCache.delete(oldest);
    }
    summaryCache.set(cacheKey, { covered: boundary, fingerprint, summary });
  }

  const compacted = Chat.empty();
  for (const message of systemMessages) {
    compacted.append(message);
  }
  compacted.append("system", renderSummary(summary));
  for (const message of recent) {
    compacted.append(message);
  }

  return { chat: compacted, action, usagePercent };
}
