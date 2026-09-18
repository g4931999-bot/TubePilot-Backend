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
      const base = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
      res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'unauthorized', error_description: 'No access token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'unauthorized', error_description: 'User not found or inactive' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', error_description: 'Invalid or expired access token' });
  }
};

// -----------------------------------------------------------------------
// Tool definitions — what Claude/ChatGPT see when they call "tools/list".
// Descriptions matter a lot here: this is what the AI reads to decide
// when to use each tool, so they're written plainly for that purpose.
// -----------------------------------------------------------------------
const TOOLS = [
  {
    name: 'generate_title',
    description: 'Generate a catchy, SEO-optimized YouTube video title for a given topic. Costs diamonds from the user\'s TubePilot wallet.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the video is about' } },
      required: ['topic']
    }
  },
  {
    name: 'generate_description',
    description: 'Generate an SEO-optimized YouTube video description for a given topic. Costs diamonds from the user\'s TubePilot wallet.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the video is about' } },
      required: ['topic']
    }
  },
  {
    name: 'generate_hashtags',
    description: 'Generate relevant YouTube hashtags for a given topic. Costs diamonds from the user\'s TubePilot wallet.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the video is about' } },
      required: ['topic']
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
    }
  },
  {
    name: 'check_balance',
    description: 'Check the user\'s remaining free upload credits and diamond balance on TubePilot.',
    inputSchema: { type: 'object', properties: {} }
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

// Boss's rules, enforced exactly as in the app:
//   - free upload credits used first (chargeForUpload, from routes/video.js)
//   - once free credits AND diamonds are both exhausted, scheduling is
//     blocked with an upgrade message until the user buys a package
//   - video is tagged sourceProvider: 'mcp' so cron/scheduler.js knows to
//     delete the Video document entirely (not just the stored file) once
//     it finishes publishing — see scheduler.js patch
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
    // Link case: don't re-download/re-host it ourselves — the publish
    // scheduler's getVideoFileStream() already falls back to a plain
    // axios stream for any storageProvider it doesn't specifically
    // recognize (only 'google_drive' gets special handling), so pointing
    // storageUrl straight at the given link works with zero extra code.
    stored = { storageProvider: 'mcp_external_url', storageFileId: '', storageUrl: args.videoUrl };
  } else {
    // Attached-file case (mainly Claude, which supports file resources in
    // MCP tool calls): decode and store exactly like a normal app upload.
    const buffer = Buffer.from(args.videoBase64, 'base64');
    stored = await storeVideoFile(buffer, `${user.userId}_mcp_${Date.now()}`, 'video/mp4');
  }

  const video = await Video.create({
    user: user._id,
    storageProvider: stored.storageProvider,
    storageFileId: stored.storageFileId,
    storageUrl: stored.storageUrl,
    videoUrl: stored.storageUrl,
    sourceProvider: 'mcp', // ⚠️ tells cron/scheduler.js to fully delete this Video doc after successful publish
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
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0' || !method) {
    return res.status(400).json(jsonRpcError(id ?? null, -32600, 'Invalid JSON-RPC request'));
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
        return res.status(404).json(jsonRpcError(id, -32601, `Unknown tool: ${toolName}`));
      }

      try {
        const result = await handler(req.user, args);
        return res.json(jsonRpcResult(id, result));
      } catch (err) {
        // Diamond-related errors are shown to the AI as a normal tool
        // result (isError: true) rather than a transport-level failure —
        // so it can relay "you're out of credits, upgrade here" back to
        // the user in conversation instead of just erroring out silently.
        return res.json(jsonRpcResult(id, toolErrorResult(err.message)));
      }
    }

    return res.status(404).json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
  } catch (err) {
    return res.status(500).json(jsonRpcError(id ?? null, -32000, err.message));
  }
});

module.exports = router;
