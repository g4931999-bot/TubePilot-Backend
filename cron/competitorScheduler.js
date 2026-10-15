const cron = require('node-cron');
const { runDailyCompetitorSnapshot } = require('../utils/competitorIngest');

// Daily competitor snapshot — default 04:30 IST (override with COMPETITOR_SNAPSHOT_CRON).
// One run collects every distinct tracked channel once (shared across users).
let running = false;

const startCompetitorSnapshotScheduler = () => {
  cron.schedule(process.env.COMPETITOR_SNAPSHOT_CRON || '30 4 * * *', async () => {
    if (running) return;
    running = true;
    try {
      const r = await runDailyCompetitorSnapshot();
      console.log(`📸 [Competitor snapshot] ${r.distinctChannels} channel(s), ${r.videos} video(s) captured` + (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.slice(0, 3).join(' | ')}` : ''));
    } catch (err) {
      console.error('❌ [Competitor snapshot] job failed:', err.message);
    } finally {
      running = false;
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('📸 Competitor snapshot scheduler is running (daily 04:30 IST)');
};

module.exports = { startCompetitorSnapshotScheduler };
