export interface RetrievalEvalCase {
  expectedSourceIds: string[];
  forbiddenSourceIds?: string[];
  retrievedSourceIds: string[];
}

export interface RetrievalMetrics {
  cases: number;
  recallAtK: number;
  citationPrecision: number;
  aclLeaks: number;
}

export const evaluateRetrieval = (cases: readonly RetrievalEvalCase[]): RetrievalMetrics => {
  let expected = 0, found = 0, retrieved = 0, relevant = 0, aclLeaks = 0;
  for (const item of cases) {
    const wanted = new Set(item.expectedSourceIds);
    const forbidden = new Set(item.forbiddenSourceIds ?? []);
    expected += wanted.size;
    retrieved += item.retrievedSourceIds.length;
    for (const source of item.retrievedSourceIds) {
      if (wanted.has(source)) { found += 1; relevant += 1; }
      if (forbidden.has(source)) aclLeaks += 1;
    }
  }
  return {
    cases: cases.length,
    recallAtK: expected ? found / expected : 1,
    citationPrecision: retrieved ? relevant / retrieved : 1,
    aclLeaks,
  };
};

export const assertRetrievalGate = (metrics: RetrievalMetrics, minimumRecall = 0.8, minimumPrecision = 0.8) => {
  if (metrics.aclLeaks > 0) throw new Error(`Retrieval gate failed: ${metrics.aclLeaks} ACL leak(s)`);
  if (metrics.recallAtK < minimumRecall) throw new Error(`Retrieval gate failed: recall ${metrics.recallAtK.toFixed(3)} < ${minimumRecall}`);
  if (metrics.citationPrecision < minimumPrecision) throw new Error(`Retrieval gate failed: precision ${metrics.citationPrecision.toFixed(3)} < ${minimumPrecision}`);
};
