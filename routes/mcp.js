const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Video = require('../models/Video');
const { generateTitle, generateDescription, generateHashtags } = require('../utils/groq');
const { chargeForUpload, storeVideoFile, assertScheduleBufferOk, assertDailyLimitOk } = require('./video');
const { toISTDateStr } = require('../utils/dateHelpers');

const router = express.Router();

// -----------------------------------------------------------------------
// MCP (Model Context Protocol) server — this is what Claude and ChatGPT
// actually talk to once a user connects TubePilot (via routes/oauth.js).
// It speaks JSON-RPC 2.0 over a single POST /mcp endpoint, per the MCP
// spec's "Streamable HTTP" transport (request/response, no SSE needed for
// this simple a toolset).
//
// AI_FEATURE_COST mirrors routes/ai.js's diamond costs exactly, so a title
// generated via Claude/ChatGPT costs the same diamonds as generating it
// inside the app — one shared wallet, no separate MCP-only pricing.
// -----------------------------------------------------------------------
const AI_FEATURE_COST = { title: 2, description: 2, hashtags: 2 };
const DIAMOND_COST_PER_UPLOAD = Number(process.env.DIAMOND_COST_PER_UPLOAD || 10);

// ⚠️ NEW: tiny logger so every log line from this file is easy to grep in
// Render ("grep MCP" will find everything below). Logs go to stdout/stderr
// via console.*, which Render already captures — nothing extra to set up.
const log = (...args) => console.log('[MCP]', new Date().toISOString(), ...args);
const logError = (label, err, extra = {}) => {
  console.error(
    '[MCP][ERROR]',
    new Date().toISOString(),
    label,
    '\nmessage:', err && err.message,
    '\ncode:', err && err.code,
    '\nextra:', JSON.stringify(extra),
    '\nstack:', err && err.stack
  );
};

const chargeDiamonds = async (user, cost) => {
  if (user.diamondBalance < cost) {
    const err = new Error(`Not enough diamonds for this action. Buy more at ${process.env.PUBLIC_APP_STORE_URL || 'the TubePilot Diamond Store'} (starting at ₹10).`);
    err.code = 'INSUFFICIENT_DIAMONDS';
    throw err;
  }
  user.diamondBalance -= cost;
  await user.save();
};

// -----------------------------------------------------------------------
// Auth — every /mcp call carries the OAuth access token issued by
// routes/oauth.js as a normal "Authorization: Bearer <jwt>" header. This
// is deliberately the SAME jwt.verify + User.findById logic as
// middleware/auth.js's `protect`, just returning MCP-flavored 401 JSON
// (with a WWW-Authenticate header pointing at the resource metadata,
// which is what tells Claude/ChatGPT to kick off the OAuth flow again if
// the token is missing/expired) instead of protect's plain 401 shape.
// -----------------------------------------------------------------------
const mcpAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      log('mcpAuth: no bearer token on', req.method, req.originalUrl);
      const base = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
      res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'unauthorized', error_description: 'No access token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      log('mcpAuth: user not found or inactive for decoded id', decoded.id);
      return res.status(401).json({ error: 'unauthorized', error_description: 'User not found or inactive' });
    }
    req.user = user;
    next();
  } catch (err) {
    // ⚠️ NEW: this used to fail silently (just a 401 with no server-side
    // trace). Any jwt.verify failure, DB timeout, etc. now gets logged
    // with a full stack trace so it's visible in Render.
    logError('mcpAuth threw', err, { hasAuthHeader: !!req.headers.authorization });
    return res.status(401).json({ error: 'unauthorized', error_description: 'Invalid or expired access token' });
  }
};

// -----------------------------------------------------------------------
// Tool definitions — what Claude/ChatGPT see when they call "tools/list".
// -----------------------------------------------------------------------
const TOOLS = [
  {
    name: 'generate_title',
    description: 'Generate a catchy, SEO-optimized YouTube video title for a given topic. Costs diamonds from the user\'s TubePilot wallet.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the video is about' } },
      required: ['topic']
    },
    annotations: {
      title: 'Generate Video Title',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'generate_description',
    description: 'Generate an SEO-optimized YouTube video description for a given topic. Costs diamonds from the user\'s TubePilot wallet.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the video is about' } },
      required: ['topic']
    },
    annotations: {
      title: 'Generate Video Description',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'generate_hashtags',
    description: 'Generate relevant YouTube hashtags for a given topic. Costs diamonds from the user\'s TubePilot wallet.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the video is about' } },
      required: ['topic']
    },
    annotations: {
      title: 'Generate Video Hashtags',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'schedule_video',
    description:
      'Schedule a video to publish on the user\'s connected YouTube channel via TubePilot. Provide EITHER a videoUrl (a link to an already-hosted video file, e.g. Google Drive share link or any direct video URL) OR videoBase64 (the raw video file, base64-encoded, if the user attached it directly in the conversation). Uses the user\'s free upload credits first, then diamonds. Once the video finishes publishing, TubePilot automatically deletes it from its own servers.',
    inputSchema: {
      type: 'object',
      properties: {
        videoUrl: { type: 'string', description: 'A direct or shareable link to the video file' },
        videoBase64: { type: 'string', description: 'Base64-encoded raw video bytes, if the user attached the file instead of giving a link' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        scheduledAt: { type: 'string', description: 'ISO 8601 datetime to publish at. Omit to publish as soon as processed.' }
      },
      required: ['title']
    },
    annotations: {
      title: 'Schedule YouTube Upload',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'check_balance',
    description: 'Check the user\'s remaining free upload credits and diamond balance on TubePilot.',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      title: 'Check TubePilot Balance',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];

const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const jsonRpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

const toolTextResult = (text) => ({ content: [{ type: 'text', text }] });
const toolErrorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

// -----------------------------------------------------------------------
// Individual tool implementations
// -----------------------------------------------------------------------
const runGenerateTitle = async (user, args) => {
  if (!args.topic) return toolErrorResult('topic is required');
  await chargeDiamonds(user, AI_FEATURE_COST.title);
  const title = await generateTitle(args.topic);
  return toolTextResult(`Title: ${title}\n\n(${AI_FEATURE_COST.title} diamonds used — ${user.diamondBalance} remaining)`);
};

const runGenerateDescription = async (user, args) => {
  if (!args.topic) return toolErrorResult('topic is required');
  await chargeDiamonds(user, AI_FEATURE_COST.description);
  const description = await generateDescription(args.topic);
  return toolTextResult(`Description:\n${description}\n\n(${AI_FEATURE_COST.description} diamonds used — ${user.diamondBalance} remaining)`);
};

const runGenerateHashtags = async (user, args) => {
  if (!args.topic) return toolErrorResult('topic is required');
  await chargeDiamonds(user, AI_FEATURE_COST.hashtags);
  const hashtags = await generateHashtags(args.topic, 'youtube');
  return toolTextResult(`Hashtags: ${hashtags.map((h) => `#${h}`).join(' ')}\n\n(${AI_FEATURE_COST.hashtags} diamonds used — ${user.diamondBalance} remaining)`);
};

const runScheduleVideo = async (user, args) => {
  if (!user.youtubeChannel) {
    return toolErrorResult('This TubePilot account has no YouTube channel connected yet. Connect one in the TubePilot app first, then try again.');
  }
  if (!args.title) return toolErrorResult('title is required');
  if (!args.videoUrl && !args.videoBase64) {
    return toolErrorResult('Provide either videoUrl (a link to the video) or videoBase64 (the attached video file).');
  }

  let scheduledAt = null;
  if (args.scheduledAt) {
    scheduledAt = new Date(args.scheduledAt);
    try {
      assertScheduleBufferOk(scheduledAt);
    } catch (err) {
      return toolErrorResult(err.message);
    }
  }

  const dateStr = scheduledAt ? toISTDateStr(scheduledAt) : toISTDateStr(new Date());
  try {
    await assertDailyLimitOk(user, dateStr);
  } catch (err) {
    return toolErrorResult(err.message);
  }

  let charge;
  try {
    charge = chargeForUpload(user);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_DIAMONDS') {
      return toolErrorResult(`${err.message} Buy diamonds at ${process.env.PUBLIC_APP_STORE_URL || 'the TubePilot Diamond Store'} — packages start at ₹10.`);
    }
    return toolErrorResult(err.message);
  }

  let stored;
  if (args.videoUrl) {
    stored = { storageProvider: 'mcp_external_url', storageFileId: '', storageUrl: args.videoUrl };
  } else {
    const buffer = Buffer.from(args.videoBase64, 'base64');
    stored = await storeVideoFile(buffer, `${user.userId}_mcp_${Date.now()}`, 'video/mp4');
  }

  const video = await Video.create({
    user: user._id,
    storageProvider: stored.storageProvider,
    storageFileId: stored.storageFileId,
    storageUrl: stored.storageUrl,
    videoUrl: stored.storageUrl,
    sourceProvider: 'mcp',
    platforms: [{
      platform: 'youtube',
      postType: 'video',
      status: 'queued',
      scheduledAt,
      title: args.title,
      description: args.description || '',
      tags: (args.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      category: '22',
      audience: 'not_for_kids',
      privacyStatus: 'public',
      targetPrivacyStatus: 'public',
      youtubePrivacyPromoted: false
    }],
    postType: 'video',
    platform: 'youtube',
    status: 'queued',
    diamondsCharged: charge.diamondsCharged,
    usedFreeUpload: charge.usedFreeUpload
  });

  await user.save();

  const whenLabel = scheduledAt ? `scheduled for ${scheduledAt.toISOString()}` : 'queued to publish shortly';
  const costLabel = charge.usedFreeUpload ? 'used 1 free upload credit' : `used ${charge.diamondsCharged} diamonds`;
  return toolTextResult(`✅ "${args.title}" is ${whenLabel} on YouTube (${costLabel}). It will be automatically removed from TubePilot's servers once it's live.`);
};

const runCheckBalance = async (user) => {
  return toolTextResult(
    `Free uploads remaining: ${user.freeUploadsRemaining}\n` +
    `Diamond balance: ${user.diamondBalance}\n` +
    `Video SEO Optimizer: ${user.seoScoreLevel !== 'none' ? 'unlocked' : 'locked — buy any package'}\n` +
    `Channel SEO Score suggestions: ${user.seoScoreLevel === 'advance' ? 'unlocked' : 'locked — needs ₹100+ package'}`
  );
};

const TOOL_HANDLERS = {
  generate_title: runGenerateTitle,
  generate_description: runGenerateDescription,
  generate_hashtags: runGenerateHashtags,
  schedule_video: runScheduleVideo,
  check_balance: runCheckBalance
};

// -----------------------------------------------------------------------
// The single MCP endpoint. Every request is a JSON-RPC 2.0 envelope; the
// three methods below are the minimum set Claude/ChatGPT need to discover
// and call tools. (Resources/prompts are intentionally left out — this
// connector only needs tools.)
// -----------------------------------------------------------------------
router.post('/', mcpAuth, express.json(), async (req, res) => {
  // ⚠️ NEW: log every incoming MCP call before doing anything else. This
  // alone will show in Render logs whether the request even reached us
  // with a parsed body, which method/tool it was, and which user.
  log('incoming', {
    method: req.body && req.body.method,
    toolName: req.body && req.body.params && req.body.params.name,
    userId: req.user && req.user._id,
    contentType: req.headers['content-type'],
    bodyIsEmpty: !req.body || Object.keys(req.body).length === 0
  });

  const body = req.body || {};
  const { jsonrpc, id, method, params } = body;

  // -----------------------------------------------------------------------
  // 🔧 FIX (root cause of the "Error occurred during tool execution"
  // failure): a JSON-RPC *notification* has NO "id" field at all — the
  // MCP client sends "notifications/initialized" right after every
  // successful "initialize" call, and per JSON-RPC 2.0 spec the server
  // MUST NOT send any response to a notification.
  //
  // This server was previously falling through to the "unknown method"
  // branch for it and replying with an HTTP 404 + JSON-RPC error body.
  // The client treated that invalid/unexpected response as a broken
  // session and silently restarted the whole handshake — which is
  // exactly the initialize → notifications/initialized → tools/list loop
  // seen 3x in the logs, with tools/call never once being reached. After
  // enough failed retries the client just surfaces a generic tool error.
  //
  // Fix: detect "no id field" = notification, and just ack with a bare
  // 202 Accepted, no body, no JSON-RPC envelope at all.
  // -----------------------------------------------------------------------
  const isNotification = !('id' in body);
  if (isNotification) {
    log('notification (no response sent, per JSON-RPC spec)', method);
    return res.status(202).end();
  }

  if (jsonrpc !== '2.0' || !method) {
    log('rejected: bad JSON-RPC envelope', { jsonrpc, method, rawBody: req.body });
    return res.status(200).json(jsonRpcError(id ?? null, -32600, 'Invalid JSON-RPC request'));
  }

  try {
    if (method === 'initialize') {
      return res.json(jsonRpcResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tubepilot', version: '1.0.0' }
      }));
    }

    if (method === 'tools/list') {
      return res.json(jsonRpcResult(id, { tools: TOOLS }));
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        log('unknown tool requested', toolName);
        // 🔧 FIX: 200 + JSON-RPC error, not HTTP 404 — same reasoning as
        // the notification fix above: a non-200 HTTP status on an actual
        // JSON-RPC response can make the MCP client treat this as a
        // transport failure instead of a normal JSON-RPC error it can
        // read and relay to the model.
        return res.status(200).json(jsonRpcError(id, -32601, `Unknown tool: ${toolName}`));
      }

      try {
        const result = await handler(req.user, args);
        log('tool call ok', { toolName, userId: req.user._id, isError: !!result.isError });
        return res.json(jsonRpcResult(id, result));
      } catch (err) {
        // ⚠️ NEW: this is almost certainly where your check_balance
        // failure is coming from — any exception thrown inside a tool
        // handler (DB error, undefined field access, etc.) lands here.
        // Previously it was swallowed into a plain toolErrorResult with
        // no server-side trace. Now it's fully logged first.
        logError(`tool "${toolName}" handler threw`, err, { userId: req.user && req.user._id, args });
        return res.json(jsonRpcResult(id, toolErrorResult(err.message)));
      }
    }

    log('unknown method', method);
    return res.status(200).json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
  } catch (err) {
    // ⚠️ NEW: top-level catch-all — if this fires, the bug is in envelope
    // handling itself (not inside a specific tool), so it's logged
    // separately to make that distinction obvious in Render.
    logError('top-level /mcp handler threw', err, { method, toolName: params?.name });
    return res.status(500).json(jsonRpcError(id ?? null, -32000, err.message));
  }
});

module.exports = router;
