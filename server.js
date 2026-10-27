require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

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
// ⚠️ NEW: process-level safety nets
// -----------------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [Unhandled Rejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception]', err && err.stack ? err.stack : err);
});

// Enable reverse proxy trust (Render / Heroku / AWS / Cloudflare)
app.set('trust proxy', 1);

// -----------------------------------------------------------------------
// Security Headers
// -----------------------------------------------------------------------
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com/gsi/client"],
      styleSrc: ["'self'", "https:", "'unsafe-inline'"],
      frameSrc: ["https://accounts.google.com"],
      connectSrc: ["'self'", "https://accounts.google.com"],
      imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"]
    }
  }
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

// Request logger scoped to /mcp and /oauth only
app.use(['/mcp', '/oauth'], (req, res, next) => {
  console.log(
    '[REQ]', new Date().toISOString(),
    req.method, req.originalUrl,
    'content-type:', req.headers['content-type'],
    'has-auth-header:', !!req.headers.authorization
  );
  next();
});

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

// ================== PUBLIC PAGES FOR CASHFREE BOT & PAYMENT ==================

// Landing page - Cashfree bot checks this
app.get('/landing', (req, res) => {
  res.redirect('/');
});

app.get('/', (req, res) => {
  // Don't interfere with share route - if path is exactly / and share route already handled, this will still work
  // Check if this is API base request (no share slug)
  if (req.query.slug || req.path.length > 1) {
    return res.status(404).send('Not found');
  }
  const dbState = mongoose.connection.readyState;
  const dbStatusText = dbState === 1 ? '✅ Connected' : dbState === 2 ? '⏳ Connecting' : '❌ Disconnected';
  res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TubePilot API - Live</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#fafafa;color:#222}.container{max-width:800px;margin:0 auto;padding:40px 20px}.header{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:40px;border-radius:16px;text-align:center;margin-bottom:24px}.card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}.badge{display:inline-block;background:#f3f0ff;color:#7c3aed;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700}a{color:#7c3aed;text-decoration:none}</style></head>
<body><div class="container"><div class="header"><h1>🚀 TubePilot API</h1><p>AI-Powered YouTube Growth Platform - Backend Live</p><span class="badge">● LIVE</span></div>
<div class="card"><h3>✅ API Status: Operational</h3><p>DB: ${dbStatusText} (State: ${dbState})</p><p>Base: https://api.tubepilot.shop</p><p>Cashfree: ${process.env.CASHFREE_APP_ID ? '✅ Configured (' + (process.env.CASHFREE_ENV || 'SANDBOX') + ')' : '❌ Not Configured'}</p></div>
<div class="card"><h3>📦 Services</h3><ul><li>💎 Diamond Store & Cashfree Payments</li><li>📊 YouTube Analytics & SEO</li><li>🤖 AI Title, Description, Thumbnails</li><li>📡 Live Stream Planning</li></ul></div>
<div class="card"><h3>🔗 Links</h3><p><a href="/privacy">Privacy</a> | <a href="/terms">Terms</a> | <a href="/api/health">Health Check</a> | <a href="https://www.tubepilot.shop">Main Website</a></p></div></div></body></html>`);
});

app.get('/privacy', (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy - TubePilot</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6;color:#222}</style></head><body><h1>Privacy Policy</h1><p>Last updated: Jan 2025</p><p>TubePilot respects your privacy. We collect only necessary data for YouTube growth tools. Payment data is handled securely by Cashfree Payment Gateway.</p><p>Contact: support@tubepilot.shop</p><a href="/">← Back to Home</a></body></html>`);
});

app.get('/terms', (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Terms - TubePilot</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6;color:#222}</style></head><body><h1>Terms of Service</h1><p>Last updated: Jan 2025</p><p>By using TubePilot you agree to our terms. All payments processed via Cashfree, diamonds are non-refundable.</p><p>Contact: support@tubepilot.shop</p><a href="/">← Back to Home</a></body></html>`);
});

// ================== PAYMENT SUCCESS PAGES - MAIN FIX ==================
// This is the MAIN return_url target for Cashfree - MUST be on api.tubepilot.shop
app.get('/payment/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || req.query.orderID || '';
  const cleanOrderId = String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 50);
  const displayOrderId = cleanOrderId || orderId || 'N/A';
  res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Payment Received - TubePilot</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#f8f7ff;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{max-width:480px;width:100%;background:#fff;padding:32px;border-radius:16px;box-shadow:0 4px 24px rgba(124,58,237,.12);text-align:center}.icon{width:64px;height:64px;background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px;color:#fff}h1{color:#7c3aed;margin:0 0 8px;font-size:24px}.order{font-size:13px;color:#666;background:#f5f3ff;padding:8px 12px;border-radius:8px;word-break:break-all;margin:16px 0}p{color:#555;line-height:1.5;font-size:14px}.btn{display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;margin-top:16px}.info{background:#f8f7ff;padding:16px;border-radius:12px;text-align:left;margin:20px 0;font-size:13px}.info ol{margin:8px 0;padding-left:20px}</style></head>
<body><div class="card"><div class="icon">✓</div><h1>Payment Received</h1><div class="order">Order ID: <strong>${displayOrderId}</strong></div><p>Your diamonds will be credited automatically. You can close this window and return to the app.</p><div class="info"><strong>If app didn't auto-verify:</strong><ol><li>Open TubePilot App</li><li>Go to Diamond Store > My Requests</li><li>Wait 1-2 minutes, auto-check will credit it</li></ol></div><a class="btn" href="https://www.tubepilot.shop">Back to Home</a><p style="font-size:11px;color:#aaa;margin-top:16px">support@tubepilot.shop | Order: ${displayOrderId}</p></div></body></html>`);
});

// Alias routes for frontend typo and alternative paths
app.get('/diamonds/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || '';
  res.redirect(`/payment/success?order_id=${orderId}`);
});
app.get('/daimonds/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || '';
  res.redirect(`/payment/success?order_id=${orderId}`);
});
app.get('/diamond/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || '';
  res.redirect(`/payment/success?order_id=${orderId}`);
});
app.get('/payment/daimonds/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || '';
  res.redirect(`/payment/success?order_id=${orderId}`);
});

app.get('/api/health', (req, res) => res.json({
  success: true,
  status: 'healthy',
  message: 'TubePilot Production API is running smoothly',
  timestamp: new Date().toISOString(),
  environment: process.env.CASHFREE_ENV || 'SANDBOX',
  cashfree: process.env.CASHFREE_APP_ID ? 'configured' : 'not configured',
  appBaseUrl: process.env.APP_BASE_URL || 'https://api.tubepilot.shop',
  mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  mongoState: mongoose.connection.readyState
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
      console.log(`🌐 App Base URL: ${process.env.APP_BASE_URL || 'https://api.tubepilot.shop'}`);
      console.log(`💳 Cashfree ENV: ${process.env.CASHFREE_ENV || 'SANDBOX'}`);
      console.log(`💳 Cashfree Configured: ${process.env.CASHFREE_APP_ID ? 'YES' : 'NO'}`);
      console.log(`💾 MongoDB State: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}`);
      startPublishScheduler();
      startRetryScheduler();
      startFreeUploadReset();
      startDriveAutoUploadScheduler();
      startMilestoneScheduler();
      startCompetitorSnapshotScheduler();
    });
  } catch (error) {
    console.error('❌ Fatal Server Startup Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
};

startServer();

module.exports = app;
