// Small helper shared by routes that must not accept files from a user who has no way to pay
// for an upload (no free/plan uploads left AND not enough diamonds for a diamond-paid upload).
const DIAMOND_COST_PER_UPLOAD = Number(process.env.DIAMOND_COST_PER_UPLOAD || 10);

const hasUploadCredit = (user) =>
  (user.freeUploadsRemaining || 0) > 0 || (user.diamondBalance || 0) >= DIAMOND_COST_PER_UPLOAD;

module.exports = { DIAMOND_COST_PER_UPLOAD, hasUploadCredit };
