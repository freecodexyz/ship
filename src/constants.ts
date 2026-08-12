/** Scoring policy applied independently to each project, actor, and UTC cycle. */
export const SCORE_RULES = {
  mergedPullRequest: {
    points: 10,
    countCap: 5,
  },
  resolvedIssue: {
    points: 4,
    countCap: 5,
  },
  materialTestChange: {
    points: 4,
    countCap: 5,
  },
  substantiveReview: {
    points: 3,
    countCap: 10,
  },
  evidence: {
    weights: {
      screenshot: 1,
      video: 2,
      logs: 1,
      trajectory: 1,
      artifact: 1,
    },
    pointCap: 30,
  },
  evaluatedContribution: {
    maximumPoints: 8,
    countCap: 3,
  },
  materialTestThresholds: {
    additions: 10,
    churn: 20,
  },
  computeReward: {
    creditedTokensPerOutcomeCap: 100_000,
    saturationTokens: 1_000_000,
    maximumBonusBasisPoints: 2_500,
  },
} as const;
