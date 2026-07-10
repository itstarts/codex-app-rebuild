function normalizeModels({
  authMethod: e,
  availableModels: t,
  defaultModel: r,
  enabledReasoningEfforts: i,
  includeUltraReasoningEffort: d,
  models: a,
  useHiddenModels: o,
}) {
  const output = [];
  const useAllowlist = o && e !== `amazonBedrock`;
  a.forEach((item) => {
    if (useAllowlist ? t.has(item.model) : !item.hidden) {
      output.push({
        ...item,
        defaultModel: r,
        enabledReasoningEfforts: i,
        includeUltraReasoningEffort: d,
        supportedReasoningEfforts: item.supportedReasoningEfforts,
      });
    }
  });
  return output;
}
