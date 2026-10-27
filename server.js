const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-version', 'x-client-id', 'x-client-secret']
}));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests, please try again later'
});
app.use('/api/', apiLimiter);

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL || process.env.MONGODB_URL || process.env.MONGO_URL;

console.log('🔍 Checking MongoDB ENV...');
console.log('MONGODB_URI exists:', !!process.env.MONGODB_URI);

if (!mongoUri) {
  console.error('❌ MONGODB_URI missing! Add it in Render ENV');
} else {
  mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000
  }).then(() => {
    console.log('✅ MongoDB Connected Successfully');
  }).catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
  });
}

app.use('/api/auth', require('./routes/auth'));
app.use('/api/diamonds', require('./routes/diamond'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/youtube', require('./routes/youtube'));
app.use('/api/admin', require('./routes/admin'));

app.get('/', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatusText = dbState === 1 ? '✅ Connected' : dbState === 2 ? '⏳ Connecting' : '❌ Disconnected - Check MONGODB_URI';
  res.status(200).send(`<!DOCTYPE html><html><head><title>TubePilot API</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;margin:0;background:#fafafa;color:#222}.container{max-width:800px;margin:0 auto;padding:40px 20px}.header{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:40px;border-radius:16px;text-align:center;margin-bottom:24px}.card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}.badge{display:inline-block;background:#f3f0ff;color:#7c3aed;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700}a{color:#7c3aed}</style></head><body><div class="container"><div class="header"><h1>🚀 TubePilot API</h1><p>Backend Live</p><span class="badge">● LIVE</span></div><div class="card"><h3>API Status</h3><p>DB: ${dbStatusText} (State ${dbState})</p><p>Base: https://api.tubepilot.shop</p></div><div class="card"><a href="/privacy">Privacy</a> | <a href="/terms">Terms</a> | <a href="/api/health">Health</a> | <a href="https://www.tubepilot.shop">Website</a></div></div></body></html>`);
});

app.get('/privacy', (req, res) => res.send('<h1>Privacy Policy</h1><p>TubePilot respects privacy.</p><a href="/">Back</a>'));
app.get('/terms', (req, res) => res.send('<h1>Terms</h1><p>By using TubePilot you agree.</p><a href="/">Back</a>'));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'live',
    timestamp: new Date().toISOString(),
    environment: process.env.CASHFREE_ENV || 'SANDBOX',
    cashfree: process.env.CASHFREE_APP_ID ? 'configured' : 'not configured',
    appBaseUrl: process.env.APP_BASE_URL || 'not set',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    mongoState: mongoose.connection.readyState
  });
});

app.get('/payment/success', (req, res) => {
  const orderId = req.query.order_id || req.query.orderId || '';
  const cleanOrderId = String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 50);
  const displayOrderId = cleanOrderId || orderId || 'N/A';
  res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Payment Received</title><style>body{font-family:sans-serif;margin:0;background:#f8f7ff;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{max-width:480px;width:100%;background:#fff;padding:32px;border-radius:16px;box-shadow:0 4px 24px rgba(124,58,237,.12);text-align:center}.icon{width:64px;height:64px;background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px;color:#fff}h1{color:#7c3aed;margin:0 0 8px;font-size:24px}.order{font-size:13px;color:#666;background:#f5f3ff;padding:8px 12px;border-radius:8px;word-break:break-all;margin:16px 0}p{color:#555;line-height:1.5;font-size:14px}.btn{display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;margin-top:16px}</style></head><body><div class="card"><div class="icon">✓</div><h1>Payment Received</h1><div class="order">Order ID: <strong>${displayOrderId}</strong></div><p>Your diamonds will be credited automatically.</p><a class="btn" href="https://www.tubepilot.shop">Back to Home</a></div></body></html>`);
});

app.get('/diamonds/success', (req, res) => res.redirect(`/payment/success?order_id=${req.query.order_id || req.query.orderId || ''}`));
app.get('/daimonds/success', (req, res) => res.redirect(`/payment/success?order_id=${req.query.order_id || req.query.orderId || ''}`));
app.get('/diamond/success', (req, res) => res.redirect(`/payment/success?order_id=${req.query.order_id || req.query.orderId || ''}`));
app.get('/verify', (req, res) => res.redirect(`/payment/success?order_id=${req.query.order_id || req.query.orderId || ''}`));

app.use('/api/*', (req, res) => res.status(404).json({ success: false, message: 'API endpoint not found' }));
app.use((req, res) => res.status(404).send('<html><body><h1>404 Not Found</h1><a href="/">Home</a></body></html>'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 App Base URL: ${process.env.APP_BASE_URL || 'https://api.tubepilot.shop'}`);
  console.log(`💳 Cashfree ENV: ${process.env.CASHFREE_ENV || 'SANDBOX'}`);
  console.log(`💾 MongoDB: ${mongoUri ? 'URI found' : 'MISSING'}`);
});

module.exports = app;
