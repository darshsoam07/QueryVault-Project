/** Gemini 3/4 use levels; older 2.5 supports a thinking budget. Keep the
 * verifier's output deadline/cap separate from its reasoning policy. */
export function googleThinkingOptions(model: string) {
  return {
    google: {
      thinkingConfig: /^gemini-[34](?:[.-]|$)/.test(model.replace(/^google\//, ""))
        ? { thinkingLevel: "low" as const }
        : { thinkingBudget: 0 },
    },
  };
}
