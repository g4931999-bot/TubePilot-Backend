// Competitor Radar — plan limits.
//
// Maps the EXISTING User.competitorLevel field (set by the Diamond Store
// purchase in routes/diamond.js) to a maximum number of tracked competitors:
//   'none'    (free, also ₹10 / ₹50 packs) → 2
//   'basic'   (₹100 pack)                   → 5
//   'advance' (₹200 pack)                   → 15
// Nothing about the subscription / payment logic is changed — this file only
// READS the level.
const LIMITS = { none: 2, basic: 5, advance: 15 };

const normalizeLevel = (level) => (level === 'basic' || level === 'advance' ? level : 'none');

const getCompetitorLimit = (level) => LIMITS[normalizeLevel(level)];

// Deeper insights (measured growth, VPH, topics, opportunities, trend
// charts) stay on the highest tier, exactly like the VPH gate that already
// existed in routes/analytics.js.
const hasAdvancedInsights = (level) => normalizeLevel(level) === 'advance';

const limitReachedBody = ({ level, current }) => {
  const limit = getCompetitorLimit(level);
  return {
    success: false,
    code: 'COMPETITOR_LIMIT_REACHED',
    message: `Your plan can track up to ${limit} competitors. Upgrade to track more.`,
    limit,
    current,
    level: normalizeLevel(level)
  };
};

module.exports = { LIMITS, normalizeLevel, getCompetitorLimit, hasAdvancedInsights, limitReachedBody };
