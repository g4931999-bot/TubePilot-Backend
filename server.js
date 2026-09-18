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
  startDriveAutoUploadScheduler
} = require('./cron/scheduler');

// Core Routes Import
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const youtubeRoutes = require('./routes/youtube');
const driveRoutes = require('./routes/drive');
const metaRoutes = require('./routes/meta');
const videoRoutes = require('./routes/video');
const diamondRoutes = require('./routes/diamond');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const analyticsRoutes = require('./routes/analytics');
const ratingsRoutes = require('./routes/ratings');
const seedAdminRoute = require('./routes/seedAdmin');
const uploadsRoutes = require('./routes/uploads');
const oauthRoutes = require('./routes/oauth');

const app = express();

// -----------------------------------------------------------------------
// ⚠️ NEW: process-level safety nets. Without these, an unhandled promise
// rejection or a thrown error outside of an Express route handler (e.g.
// inside a cron job, a DB driver callback, etc.) can crash the whole
// process SILENTLY on some Node/Render setups, or print nothing useful.
// These guarantee a full stack trace always lands in Render's logs before
// anything else happens.
// -----------------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [Unhandled Rejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception]', err && err.stack ? err.stack : err);
  // Intentionally NOT calling process.exit() here — on Render, an
  // uncaught exception during a single request handling a crash would
  // otherwise kill the whole server for all users. We log and keep going;
  // if this fires often, that's itself a signal something needs a proper
  // try/catch added at the source.
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

// ⚠️ NEW: lightweight request logger scoped to /mcp and /oauth only (not
// every route, to keep logs readable) — confirms requests are actually
// reaching the process, with what content-type/body they arrived with,
// before any route-specific logic runs.
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
app.use('/api/seed-admin', seedAdminRoute);

app.use('/api/uploads', uploadsRoutes);

if (require('fs').existsSync('./routes/posts.js')) {
  app.use('/api/posts', require('./routes/posts'));
}

app.get('/api/health', (req, res) => res.json({
  success: true,
  status: 'healthy',
  message: 'TubePilot Production API is running smoothly',
  timestamp: new Date().toISOString()
}));

app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'API route not found' }));

// Global Centralized Error Handler
app.use((err, req, res, next) => {
  // ⚠️ NEW: also print the request path/method that caused it, not just
  // the stack — makes it much faster to match a log line back to a
  // specific failing call in Render.
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
      startPublishScheduler();
      startRetryScheduler();
      startFreeUploadReset();
      startDriveAutoUploadScheduler();
    });
  } catch (error) {
    console.error('❌ Fatal Server Startup Error:', error.message);
    process.exit(1);
  }
};

startServer();

module.exports = app;
