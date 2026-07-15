import { z } from "zod";

/**
 * Kept deliberately flat: nested objects make small local models drift, and grammar-constrained
 * decoding is more likely to stall. The `.max()` caps are the token budget for the rendered
 * summary — an array that saturates its cap is silently dropping detail, so raising a cap is the
 * lever to pull when summaries feel lossy.
 */
export const summarySchema = z.object({
  objective: z.string(),
  decisions: z.array(z.string()).max(12),
  constraints: z.array(z.string()).max(8),
  openQuestions: z.array(z.string()).max(6),
  artifacts: z.array(z.string()).max(10),
});

export type ConversationSummary = z.infer<typeof summarySchema>;

const section = (title: string, items: Array<string>): string =>
  items.length === 0 ? "" : `\n\n${title}:\n${items.map(item => `- ${item}`).join("\n")}`;

/**
 * Renders the summary deterministically rather than letting the model write the system message
 * directly, so the shape and size of the injected text stay under our control.
 */
export function renderSummary(summary: ConversationSummary): string {
  return (
    "## Summary of earlier conversation\n\n" +
    "The earlier part of this conversation was compacted into the summary below. " +
    "Treat it as established context and continue naturally. Do not mention this summary.\n\n" +
    `Objective: ${summary.objective}` +
    section("Decisions made", summary.decisions) +
    section("Constraints", summary.constraints) +
    section("Open questions", summary.openQuestions) +
    section("Artifacts referenced", summary.artifacts)
  );
}
