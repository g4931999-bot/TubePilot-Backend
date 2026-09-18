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

// Enable reverse proxy trust (Render / Heroku / AWS / Cloudflare)
app.set('trust proxy', 1);

// -----------------------------------------------------------------------
// Security Headers
// ⚠️ FIX: default helmet() blocks any script/frame/connection that isn't
// same-origin — that silently breaks the Google Sign-In button on the
// /oauth/authorize page, which needs to load
// https://accounts.google.com/gsi/client, render Google's iframe, and
// call back to accounts.google.com. Everything else keeps helmet's normal
// safe defaults ('self' for everything not explicitly listed here).
// -----------------------------------------------------------------------
app.use(helmet({
  // ⚠️ FIX: helmet's default Cross-Origin-Opener-Policy is 'same-origin',
  // which silently breaks Google Sign-In's popup — the popup
  // (accounts.google.com/gsi/transform) can no longer message its opener
  // window to pass the credential back, so it just sits blank forever.
  // 'same-origin-allow-popups' keeps the same protection for everything
  // else while letting that one popup communicate back.
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

// -----------------------------------------------------------------------
// ⚠️ FIX (Critical — MCP connector discovery): Claude and ChatGPT both
// probe /.well-known/oauth-authorization-server and
// /.well-known/oauth-protected-resource automatically when a user tries
// to connect TubePilot. These MUST be at the ROOT path — not under /oauth.
// Previously they were on the /oauth router, which made them land at
// /oauth/.well-known/... and Claude/ChatGPT could never find them, so the
// connector never appeared in the store / connect flow.
//
// Mounted here directly on `app`, BEFORE any rate limiters, so discovery
// probes are never accidentally rate-limited.
// -----------------------------------------------------------------------
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
// /oauth/authorize (POST) is where email/password is verified for the MCP
// connector login screen, exactly like /api/auth/login — without this it
// sat completely outside globalLimiter's '/api/' scope too, so it had ZERO
// brute-force protection while the normal login did.
app.use('/oauth/authorize', authLimiter);
// Google flow bypasses password guessing entirely (Google verifies the
// credential), but still rate-limit it against abuse/spam of the endpoint.
app.use('/oauth/google', authLimiter);

// --- API Route Mappings ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/drive', driveRoutes);

// Meta / Facebook Routes (Primary & Fallback Multi-Prefix Support)
app.use('/api/meta', metaRoutes);
app.use('/api/facebook', metaRoutes);
app.use('/api/meta/facebook', metaRoutes);

// Video Routes
app.use('/', require('./routes/share'));
app.use('/api/videos', videoRoutes);
app.use('/api/video', videoRoutes);

// Diamond & Payment Routes
app.use('/api/diamonds', diamondRoutes);
app.use('/api/diamond', diamondRoutes);
app.use('/api/payment', diamondRoutes);

// -----------------------------------------------------------------------
// MCP + OAuth routes.
// Note: /.well-known/* are already mounted directly on `app` above —
// oauthRoutes no longer contains those handlers (removed from oauth.js),
// so /oauth only handles /authorize, /google, /token, /register.
// -----------------------------------------------------------------------
app.use('/oauth', oauthRoutes);
app.use('/mcp', require('./routes/mcp'));

// Management & Analytics
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ratings', ratingsRoutes);
app.use('/api/seed-admin', seedAdminRoute);

// Generic image upload (Instagram Carousel support — returns hosted URLs
// for POST /api/posts/instagram/carousel to consume)
app.use('/api/uploads', uploadsRoutes);

if (require('fs').existsSync('./routes/posts.js')) {
  app.use('/api/posts', require('./routes/posts'));
}

// Health Check Endpoint
app.get('/api/health', (req, res) => res.json({
  success: true,
  status: 'healthy',
  message: 'TubePilot Production API is running smoothly',
  timestamp: new Date().toISOString()
}));

// Global 404 Catch-All for API Routes
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'API route not found' }));

// Global Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('❌ [Global Server Error]:', err.stack || err.message);

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
