/**
 * @format
 * Forked from stop-slop SKILL.md scoring rubric @ 8da1f03 (MIT). See ../PROVENANCE.md.
 * The five dimensions and the revise threshold drive the linter's score output.
 */
export const RUBRIC_RULES = `# Scoring Rubric

Score the prose across five dimensions, each 1-10:

| Dimension | Assessment |
|-----------|-----------|
| Directness | Statements or announcements? |
| Rhythm | Varied or metronomic? |
| Trust | Respects reader intelligence? |
| Authenticity | Sounds human? |
| Density | Anything cuttable? |

Sum the five scores for a total out of 50. Below 35/50 means the prose needs revision.`;

/** Total (out of 50) below which prose is flagged for revision. */
export const PROSE_PASS_THRESHOLD = 35;
