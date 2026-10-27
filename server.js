const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

dotenv.config();

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-version', 'x-client-id', 'x-client-secret']
}));

// Helmet - allow Cashfree bot to crawl
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiter for API only, not for static pages
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests'
});
app.use('/api/', apiLimiter);

// MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ MongoDB Connected');
}).catch(err => {
  console.error('❌ MongoDB Error:', err.message);
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/diamonds', require('./routes/diamonds'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/youtube', require('./routes/youtube'));
app.use('/api/admin', require('./routes/admin'));

// ================== PUBLIC PAGES FOR CASHFREE BOT & PAYMENT ==================

// Landing page - Cashfree bot checks this to see if site is active
app.get('/', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TubePilot - API Service</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#fafafa;color:#222}
.container{max-width:800px;margin:0 auto;padding:40px 20px}
.header{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:40px;border-radius:16px;text-align:center;margin-bottom:24px}
.card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
.badge{display:inline-block;background:#f3f0ff;color:#7c3aed;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700}
a{color:#7c3aed;text-decoration:none}
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>🚀 TubePilot API</h1>
<p>AI-Powered YouTube Growth Platform Backend</p>
<span class="badge">● LIVE</span>
</div>
<div class="card">
<h3>✅ API Status: Operational</h3>
<p>TubePilot API service is running and accepting requests. This backend powers the TubePilot mobile application for YouTube creators.</p>
<p><strong>Base URL:</strong> https://api.tubepilot.shop</p>
<p><strong>Environment:</strong> Production</p>
</div>
<div class="card">
<h3>📦 Services</h3>
<ul>
<li>💎 Diamond Store & Payments (Cashfree Integration)</li>
<li>📊 YouTube Analytics & SEO Tools</li>
<li>🤖 AI Title, Description & Thumbnail Generation</li>
<li>📡 Live Stream Planning</li>
</ul>
</div>
<div class="card">
<h3>🔗 Links</h3>
<p><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a> | <a href="/api/health">Health Check</a> | <a href="https://www.tubepilot.shop">Main Website</a></p>
</div>
<div class="card" style="font-size:12px;color:#888">
<p>This is a backend API service for TubePilot mobile app. Main website is at <a href="https://www.tubepilot.shop">www.tubepilot.shop</a></p>
<p>© 2025 TubePilot. All rights reserved.</p>
</div>
</div>
</body>
</html>`);
});

app.get('/privacy', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy Policy - TubePilot</title>
<style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6;color:#222}</style></head>
<body><h1>Privacy Policy</h1><p>Last updated: Jan 2025</p><p>TubePilot respects your privacy. We collect only necessary data to provide YouTube growth tools.</p><h3>Data Collection</h3><p>We collect email, name, and YouTube channel data via OAuth. Payment data is handled securely by Cashfree.</p><h3>Contact</h3><p>Email: support@tubepilot.shop</p><a href="/">← Back to Home</a></body></html>`);
});

app.get('/terms', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Terms - TubePilot</title>
<style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6;color:#222}</style></head>
<body><h1>Terms of Service</h1><p>Last updated: Jan 2025</p><p>By using TubePilot, you agree to our terms.</p><h3>Payments</h3><p>All payments are processed securely via Cashfree Payment Gateway. Diamond purchases are non-refundable.</p><h3>Contact</h3><p>Email: support@tubepilot.shop</p><a href="/">← Back to Home</a></body></html>`);
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'live',
    message: 'TubePilot API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.CASHFREE_ENV || 'SANDBOX',
    cashfree: process.env.CASHFREE_APP_ID ? 'configured' : 'not configured',
    appBaseUrl: process.env.APP_BASE_URL || 'not set'
  });
});

// ================== PAYMENT SUCCESS PAGES ==================
// This is the MAIN return_url target for Cashfree - MUST be on api.tubepilot.shop domain
app.get('/payment/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || req.query.orderID || '';
  const cleanOrderId = String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 50);
  const displayOrderId = cleanOrderId || orderId || 'N/A';

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Received - TubePilot</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f8f7ff;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:480px;width:100%;background:#fff;padding:32px;border-radius:16px;box-shadow:0 4px 24px rgba(124,58,237,.12);text-align:center}
.icon{width:64px;height:64px;background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px;color:#fff}
h1{color:#7c3aed;margin:0 0 8px;font-size:24px}
.order{font-size:13px;color:#666;background:#f5f3ff;padding:8px 12px;border-radius:8px;word-break:break-all;margin:16px 0}
p{color:#555;line-height:1.5;font-size:14px}
.btn{display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;margin-top:16px}
.info{background:#f8f7ff;padding:16px;border-radius:12px;text-align:left;margin:20px 0;font-size:13px}
.info ol{margin:8px 0;padding-left:20px}
.info li{margin:4px 0}
</style>
</head>
<body>
<div class="card">
<div class="icon">✓</div>
<h1>Payment Received</h1>
<div class="order">Order ID: <strong>${displayOrderId}</strong></div>
<p>Your diamonds will be credited automatically. You can close this window and return to the app.</p>
<div class="info">
<strong>If app didn't auto-verify:</strong>
<ol>
<li>Open TubePilot App</li>
<li>Go to Diamond Store > My Requests</li>
<li>Wait 1-2 minutes, auto-check will credit it</li>
</ol>
</div>
<a class="btn" href="https://www.tubepilot.shop">Back to Home</a>
<p style="font-size:11px;color:#aaa;margin-top:16px">If you have any issues, contact support@tubepilot.shop with Order ID</p>
</div>
</body>
</html>`);
});

// Alias routes for frontend typo and alternative paths - redirect to main success page
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

// Root /verify alias (old code used this)
app.get('/verify', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || '';
  res.redirect(`/payment/success?order_id=${orderId}`);
});

// 404 for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// Default 404 for non-API - show helpful page, not JSON
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  res.status(404).send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 - TubePilot</title>
<style>body{font-family:sans-serif;text-align:center;padding-top:60px;color:#222}</style></head>
<body><h1>Page not found</h1><p>The page you're looking for doesn't exist.</p><p><a href="/">Go to Home</a> | <a href="https://www.tubepilot.shop">Main Website</a></p></body></html>`);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 App Base URL: ${process.env.APP_BASE_URL || 'https://api.tubepilot.shop'}`);
  console.log(`💳 Cashfree ENV: ${process.env.CASHFREE_ENV || 'SANDBOX'}`);
  console.log(`💳 Cashfree Configured: ${process.env.CASHFREE_APP_ID ? 'YES' : 'NO'}`);
});

module.exports = app;
