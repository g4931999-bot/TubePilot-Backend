require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');
const {
  startPublishScheduler,
  startRetryScheduler,
  startFreeUploadReset,
  startDriveAutoUploadScheduler,
  startMilestoneScheduler
} = require('./cron/scheduler');
const { startCompetitorSnapshotScheduler } = require('./cron/competitorScheduler');

// Core Routes Import
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const youtubeRoutes = require('./routes/youtube');
const driveRoutes = require('./routes/drive');
const metaRoutes = require('./routes/meta');
const videoRoutes = require('./routes/video');
const diamondRoutes = require('./routes/diamond');
const walletRoutes = require('./routes/wallet');
const liveStreamRoutes = require('./routes/liveStream');
const livePlansRoutes = require('./routes/livePlans');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const analyticsRoutes = require('./routes/analytics');
const ratingsRoutes = require('./routes/ratings');
const seedAdminRoute = require('./routes/seedAdmin');
const uploadsRoutes = require('./routes/uploads');
const oauthRoutes = require('./routes/oauth');
const milestoneRoutes = require('./routes/milestones');

const app = express();

// -----------------------------------------------------------------------
// Process-level safety nets
// -----------------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [Unhandled Rejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception]', err && err.stack ? err.stack : err);
});

app.set('trust proxy', 1);

// -----------------------------------------------------------------------
// Security Headers - relaxed for public pages
// -----------------------------------------------------------------------
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: false, // Disabled for public landing pages to avoid bot blocking
}));

// Dynamic CORS Configuration
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    console.warn(`⚠️ CORS blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

app.use(['/mcp', '/oauth'], (req, res, next) => {
  console.log(
    '[REQ]', new Date().toISOString(),
    req.method, req.originalUrl,
    'content-type:', req.headers['content-type'],
    'has-auth-header:', !!req.headers.authorization
  );
  next();
});

// =======================================================================
// ✅ NEW PUBLIC PAGES - FOR CASHFREE WHITELISTING & BOT CHECKS
// These must be BEFORE /api 404 handler
// =======================================================================

const publicHtml = (title, body) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - TubePilot</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;line-height:1.6;color:#222;max-width:800px;margin:0 auto;padding:24px;background:#fafafa}h1{color:#6C3CE0}a{color:#6C3CE0} .card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.06);margin:20px 0} .badge{display:inline-block;background:#6C3CE0;color:#fff;padding:4px 12px;border-radius:999px;font-size:12px}</style>
</head><body>${body}<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;text-align:center;color:#888;font-size:12px"><p>© ${new Date().getFullYear()} TubePilot • support@tubepilot.com • <a href="/privacy">Privacy</a> • <a href="/terms">Terms</a> • <a href="/api/health">API Status</a></p></footer></body></html>`;

app.get('/', (req, res) => {
  res.status(200).send(publicHtml('API Live', `
    <div style="text-align:center;padding:20px 0">
      <h1>🚀 TubePilot API is Live</h1>
      <p><span class="badge">PRODUCTION</span></p>
      <p>Backend API for TubePilot Android App - AI tools for YouTubers</p>
    </div>
    <div class="card">
      <h3>📱 About TubePilot</h3>
      <p>TubePilot is a mobile app that helps YouTubers with AI Title Generation, Description, Hashtags, Thumbnail Prompts & SEO Optimization.</p>
      <p><strong>Package:</strong> com.tubepilot.app<br><strong>API Base:</strong> https://api.tubepilot.shop<br><strong>Contact:</strong> support@tubepilot.com</p>
    </div>
    <div class="card">
      <h3>🔗 Quick Links</h3>
      <ul>
        <li><a href="/api/health">/api/health</a> - Health Check (JSON)</li>
        <li><a href="/privacy">/privacy</a> - Privacy Policy</li>
        <li><a href="/terms">/terms</a> - Terms & Conditions</li>
        <li><a href="/payment/success?order_id=TEST123">/payment/success</a> - Payment Return URL (for Cashfree)</li>
      </ul>
    </div>
    <div class="card">
      <h3>💳 Payments</h3>
      <p>We use <strong>Cashfree Payment Gateway</strong> (PRODUCTION - api.cashfree.com) for secure payments. All diamond purchases are processed via Cashfree PG.</p>
    </div>
  `));
});

app.get('/privacy', (req, res) => {
  res.status(200).send(publicHtml('Privacy Policy', `
    <h1>Privacy Policy</h1><p>Last updated: ${new Date().toISOString().split('T')[0]}</p>
    <div class="card"><p>TubePilot ("we") respects your privacy. This policy covers our mobile app and API at api.tubepilot.shop.</p>
    <h3>Data We Collect</h3><ul><li>Account info (email, name)</li><li>YouTube data (with OAuth permission)</li><li>Payment info processed securely via Cashfree - we don't store card details</li><li>Usage analytics</li></ul>
    <h3>Contact</h3><p>support@tubepilot.com</p></div>
  `));
});

app.get('/terms', (req, res) => {
  res.status(200).send(publicHtml('Terms', `
    <h1>Terms & Conditions</h1><div class="card"><p>By using TubePilot app and API, you agree to our terms.</p>
    <h3>Payments</h3><p>All payments are processed via Cashfree PG. Diamonds are virtual currency, non-refundable except as per Google Play policy.</p>
    <h3>Contact</h3><p>support@tubepilot.com</p></div>
  `));
});

// Cashfree return_url target - MUST exist for whitelisting
app.get('/payment/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || 'Unknown';
  res.status(200).send(publicHtml('Payment Success', `
    <div style="text-align:center;padding:30px 0">
      <h1>✅ Payment Received</h1>
      <p>Order ID: <strong>${orderId}</strong></p>
      <p>Your diamonds will be credited automatically. You can close this window and return to the app.</p>
      <div class="card" style="text-align:left">
        <p>If app didn't auto-verify:</p>
        <ol><li>Open TubePilot App</li><li>Go to Diamond Store > My Requests</li><li>Wait 1-2 minutes, auto-check will credit it</li></ol>
      </div>
      <a href="/" style="display:inline-block;margin-top:20px;background:#6C3CE0;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Back to Home</a>
    </div>
  `));
});

// Legacy routes that Cashfree might still call
app.get('/api/payment/verify', (req, res) => res.redirect(`/payment/success?order_id=${req.query.order_id || req.query.orderId || ''}`));
app.get('/api/diamonds/verify', (req, res) => res.redirect(`/payment/success?order_id=${req.query.order_id || req.query.orderId || ''}`));

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['tubepilot']
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base]
  });
});

// Rate Limiters
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/oauth/authorize', authLimiter);
app.use('/oauth/google', authLimiter);

// --- API Route Mappings ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/drive', driveRoutes);

app.use('/api/meta', metaRoutes);
app.use('/api/facebook', metaRoutes);
app.use('/api/meta/facebook', metaRoutes);

app.use('/', require('./routes/share'));
app.use('/api/videos', videoRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/live-stream', liveStreamRoutes);
app.use('/api/live-plans', livePlansRoutes);

app.use('/api/diamonds', diamondRoutes);
app.use('/api/diamond', diamondRoutes);
app.use('/api/payment', diamondRoutes);

app.use('/oauth', oauthRoutes);
app.use('/mcp', require('./routes/mcp'));

app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ratings', ratingsRoutes);
app.use('/api/milestones', milestoneRoutes);
app.use('/api/seed-admin', seedAdminRoute);

app.use('/api/uploads', uploadsRoutes);

if (require('fs').existsSync('./routes/posts.js')) {
  app.use('/api/posts', require('./routes/posts'));
}

app.get('/api/health', (req, res) => res.json({
  success: true,
  status: 'healthy',
  message: 'TubePilot Production API is running smoothly',
  timestamp: new Date().toISOString(),
  env: process.env.CASHFREE_ENV || 'PRODUCTION',
  whitelisting: {
    message: 'For Cashfree whitelist bot - this API is live',
    domains: ['api.tubepilot.shop', 'tubepilot.shop'],
    return_url: `${process.env.APP_BASE_URL || 'https://api.tubepilot.shop'}/payment/success?order_id={order_id}`
  }
}));

app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'API route not found' }));

// Global Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('❌ [Global Server Error]', req.method, req.originalUrl, '\n', err.stack || err.message);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'CORS policy blocked this request' });
  }
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 TubePilot production backend live on port ${PORT}`);
      console.log(`✅ Public pages: / , /privacy, /terms, /payment/success - ready for Cashfree whitelisting`);
      startPublishScheduler();
      startRetryScheduler();
      startFreeUploadReset();
      startDriveAutoUploadScheduler();
      startMilestoneScheduler();
      startCompetitorSnapshotScheduler();
    });
  } catch (error) {
    console.error('❌ Fatal Server Startup Error:', error.message);
    process.exit(1);
  }
};

startServer();

module.exports = app;
