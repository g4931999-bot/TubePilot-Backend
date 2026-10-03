// utils/youtubeLive.js
//
// User ke connected YouTube channel se AUTOMATICALLY ek Live Broadcast +
// Stream banata hai aur stream key nikalta hai — user ko YouTube Studio
// jaake manually copy-paste karne ki zarurat NAHI padti.
//
// Flow (YouTube Data API v3):
//   1. liveBroadcasts.insert  -> ek "broadcast" banta hai (title/description)
//   2. liveStreams.insert     -> asli RTMP stream + stream key milta hai
//   3. liveBroadcasts.bind    -> broadcast aur stream ko jodta hai
//   4. (stop hone par) liveBroadcasts.transition -> broadcast ko "complete" karta hai
//
// ⚠️ UPDATE (limits + old-video live):
//   - Har YouTube call par timeout (pehle koi timeout nahi tha).
//   - Session banate waqt beech mein fail ho jaye to jo kuch ban chuka hai
//     (broadcast/stream) wo khud delete ho jata hai — orphan nahi bachta.
//   - discardYouTubeLiveSession ab broadcast ke saath stream resource bhi
//     delete karta hai.
//   - isVideoOwnedByUserChannel(): purani video live karne se pehle check
//     ki wo video isi user ke connected channel ki hai (dusre ki video
//     stream na ho sake).
//   - describeYouTubeError(): route ke liye ek jagah se error -> status/code/message.

const axios = require('axios');
const { refreshAccessToken, isInvalidGrantError } = require('./youtube');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_TIMEOUT_MS = 20000;

function ytConfig(accessToken, extra = {}) {
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: YOUTUBE_TIMEOUT_MS,
    ...extra
  };
}

// YouTube limits: title max 100 chars, description max 5000 chars.
function cleanTitle(title, fallback) {
  const t = typeof title === 'string' ? title.trim() : '';
  return (t || fallback).slice(0, 100);
}

function cleanDescription(description) {
  return (typeof description === 'string' ? description : '').slice(0, 5000);
}

/**
 * User ka access token check karta hai — agar expire ho chuka hai to
 * refresh karke User document mein save karta hai. (Ye scheduler.js ke
 * ensureFreshYouTubeToken jaisa hi hai — wahi logic, isi jagah taaki
 * live-streaming ka code apne aap mein self-contained rahe.)
 */
async function ensureFreshYouTubeToken(user) {
  const channel = user.youtubeChannel;

  if (!channel) {
    const err = new Error('YouTube channel connected nahi hai. Pehle YouTube connect karein.');
    err.code = 'YOUTUBE_NOT_CONNECTED';
    throw err;
  }

  const isExpired = !channel.tokenExpiryDate || Date.now() > channel.tokenExpiryDate - 60000;
  if (!isExpired) return channel.accessToken;

  try {
    const credentials = await refreshAccessToken(channel.refreshToken);
    user.youtubeChannel.accessToken = credentials.access_token;
    user.youtubeChannel.tokenExpiryDate = credentials.expiry_date;
    await user.save();
    return credentials.access_token;
  } catch (err) {
    if (isInvalidGrantError(err)) {
      const reauthErr = new Error('Aapka YouTube authorization expire/revoke ho gaya hai. Please YouTube dobara connect karein.');
      reauthErr.code = 'YOUTUBE_REAUTH_REQUIRED';
      throw reauthErr;
    }
    throw err;
  }
}

async function createLiveBroadcast(accessToken, { title, description }) {
  const response = await axios.post(
    `${YOUTUBE_API_BASE}/liveBroadcasts?part=snippet,status,contentDetails`,
    {
      snippet: {
        title: cleanTitle(title, 'Live Stream via TubePilot'),
        description: cleanDescription(description),
        scheduledStartTime: new Date().toISOString()
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false
      },
      contentDetails: {
        enableAutoStart: true, // RTMP data aate hi automatically "live" ho jayega — koi extra transition call nahi chahiye
        enableAutoStop: true,  // agar RTMP data rukk jaye, YouTube khud broadcast end kar dega (safety net)
        enableDvr: true,
        enableEmbed: true,     // app ke andar YouTube preview player chale, isliye embed allowed
        latencyPreference: 'normal'
      }
    },
    ytConfig(accessToken)
  );

  return response.data; // { id, snippet, status, contentDetails, ... }
}

async function createLiveStream(accessToken, title) {
  const response = await axios.post(
    `${YOUTUBE_API_BASE}/liveStreams?part=snippet,cdn,contentDetails`,
    {
      snippet: { title: cleanTitle(title, 'TubePilot Live Stream') },
      cdn: {
        frameRate: 'variable',
        ingestionType: 'rtmp',
        resolution: 'variable'
      },
      contentDetails: { isReusable: false }
    },
    ytConfig(accessToken)
  );

  return response.data; // { id, cdn: { ingestionInfo: { streamName, ingestionAddress } } }
}

async function bindBroadcastToStream(accessToken, broadcastId, streamId) {
  const response = await axios.post(
    `${YOUTUBE_API_BASE}/liveBroadcasts/bind?id=${broadcastId}&streamId=${streamId}&part=id,contentDetails`,
    {},
    ytConfig(accessToken)
  );
  return response.data;
}

async function transitionBroadcast(accessToken, broadcastId, broadcastStatus) {
  // broadcastStatus: 'testing' | 'live' | 'complete'
  try {
    const response = await axios.post(
      `${YOUTUBE_API_BASE}/liveBroadcasts/transition?broadcastStatus=${broadcastStatus}&id=${broadcastId}&part=id,status`,
      {},
      ytConfig(accessToken)
    );
    return response.data;
  } catch (err) {
    // Agar broadcast already complete/ended hai to YouTube error deta hai —
    // isko fail mat mano, stop process ko rukna nahi chahiye isi wajah se.
    console.error('⚠️ [YouTube Live] transition failed (ignored):', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Broadcast aur/ya stream resource ko delete karta hai. Kabhi throw nahi
// karta — cleanup ki wajah se asli error dab nahi jana chahiye.
async function deleteYouTubeResources(accessToken, { broadcastId, streamId } = {}) {
  if (broadcastId) {
    try {
      await axios.delete(`${YOUTUBE_API_BASE}/liveBroadcasts?id=${broadcastId}`, ytConfig(accessToken));
      console.log(`[YouTube Live] Broadcast ${broadcastId} delete kar diya.`);
    } catch (err) {
      console.error('⚠️ [YouTube Live] Broadcast delete failed (ignored):', err.response?.data?.error?.message || err.message);
    }
  }
  if (streamId) {
    try {
      await axios.delete(`${YOUTUBE_API_BASE}/liveStreams?id=${streamId}`, ytConfig(accessToken));
      console.log(`[YouTube Live] Stream resource ${streamId} delete kar diya.`);
    } catch (err) {
      console.error('⚠️ [YouTube Live] Stream delete failed (ignored):', err.response?.data?.error?.message || err.message);
    }
  }
}

/**
 * MAIN FUNCTION — Live streaming shuru karne ke liye ye ek hi function
 * call karo. Poora broadcast + stream + bind process khud handle karta hai.
 * Beech mein kahin fail hua to jo ban chuka hai use delete karke error
 * upar throw karta hai.
 *
 * @param {object} user - Mongoose User document (req.user)
 * @param {object} options - { title, description }
 * @returns {{ streamKey, ingestionAddress, broadcastId, youtubeStreamId, watchUrl }}
 */
async function startYouTubeLiveSession(user, { title, description } = {}) {
  const accessToken = await ensureFreshYouTubeToken(user);

  let broadcast = null;
  let stream = null;

  try {
    console.log(`[YouTube Live] Broadcast bana rahe hain — user ${user._id}, title="${title}"`);
    broadcast = await createLiveBroadcast(accessToken, { title, description });

    console.log(`[YouTube Live] Stream bana rahe hain — broadcastId=${broadcast.id}`);
    stream = await createLiveStream(accessToken, title);

    console.log(`[YouTube Live] Bind kar rahe hain — streamId=${stream.id}`);
    await bindBroadcastToStream(accessToken, broadcast.id, stream.id);
  } catch (err) {
    await deleteYouTubeResources(accessToken, { broadcastId: broadcast?.id, streamId: stream?.id });
    throw err;
  }

  const ingestionInfo = stream.cdn.ingestionInfo;

  console.log(`[YouTube Live] Ready! Stream key mil gayi, broadcastId=${broadcast.id}`);

  return {
    streamKey: ingestionInfo.streamName,
    ingestionAddress: ingestionInfo.ingestionAddress, // usually rtmp://a.rtmp.youtube.com/live2
    rtmpsAddress: ingestionInfo.rtmpsIngestionAddress || null, // usually rtmps://a.rtmps.youtube.com:443/live2
    broadcastId: broadcast.id,
    youtubeStreamId: stream.id,
    watchUrl: `https://youtube.com/watch?v=${broadcast.id}`
  };
}

async function getBroadcastLifecycle(accessToken, broadcastId) {
  try {
    const response = await axios.get(
      `${YOUTUBE_API_BASE}/liveBroadcasts`,
      ytConfig(accessToken, { params: { part: 'status', id: broadcastId } })
    );
    return response.data?.items?.[0]?.status?.lifeCycleStatus || null;
  } catch (err) {
    console.error('⚠️ [YouTube Live] lifecycle check failed (ignored):', err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * Live session ko YouTube ki taraf se properly band karta hai.
 *   - Broadcast kabhi live hi nahi hua (created/ready) -> delete karta hai
 *     aur { neverLive: true } deta hai (route us live ka slot/hours wapas karta hai).
 *   - Live tha -> "complete" karta hai (sirf FFmpeg/camera band karna kaafi nahi,
 *     warna YouTube pe "stuck live" dikh sakta hai).
 * Kabhi throw nahi karta.
 */
async function endYouTubeLiveSession(user, broadcastId, youtubeStreamId) {
  if (!broadcastId) return { neverLive: false };
  try {
    const accessToken = await ensureFreshYouTubeToken(user);
    const lifecycle = await getBroadcastLifecycle(accessToken, broadcastId);

    if (lifecycle === 'created' || lifecycle === 'ready') {
      console.log(`[YouTube Live] Broadcast ${broadcastId} kabhi live nahi hua (${lifecycle}) — delete kar rahe hain.`);
      await deleteYouTubeResources(accessToken, { broadcastId, streamId: youtubeStreamId });
      return { neverLive: true };
    }

    if (lifecycle === 'complete' || lifecycle === 'revoked') {
      return { neverLive: false }; // already khatam (autoStop ne kar diya)
    }

    await transitionBroadcast(accessToken, broadcastId, 'complete');
    console.log(`[YouTube Live] Broadcast ${broadcastId} complete kar diya.`);
    return { neverLive: false };
  } catch (err) {
    console.error('⚠️ [YouTube Live] End session failed (ignored):', err.message);
    return { neverLive: false };
  }
}

/**
 * Jo broadcast kabhi live gaya hi nahi (jaise EC2 connect fail hone par),
 * use "complete" nahi kar sakte — YouTube sirf live broadcast ko complete
 * hone deta hai. Aise broadcast ko DELETE karna padta hai, warna wo
 * YouTube Studio mein "upcoming" bankar pada rehta hai. Ab stream resource
 * (youtubeStreamId) bhi delete hota hai agar diya gaya ho.
 */
async function discardYouTubeLiveSession(user, broadcastId, youtubeStreamId) {
  if (!broadcastId && !youtubeStreamId) return;
  try {
    const accessToken = await ensureFreshYouTubeToken(user);
    await deleteYouTubeResources(accessToken, { broadcastId, streamId: youtubeStreamId });
  } catch (err) {
    console.error('⚠️ [YouTube Live] Discard failed (ignored):', err.message);
  }
}

/**
 * YouTube ki taraf se is stream ki sthiti: kya YouTube ko data mil raha hai?
 * streamStatus: 'active' = data aa raha hai, 'inactive'/'ready' = nahi aa raha.
 * Camera live debug/confirmation ke liye (1 quota unit).
 */
async function getYouTubeStreamStatus(user, youtubeStreamId) {
  const accessToken = await ensureFreshYouTubeToken(user);
  const response = await axios.get(
    `${YOUTUBE_API_BASE}/liveStreams`,
    ytConfig(accessToken, { params: { part: 'status', id: youtubeStreamId } })
  );
  const status = response.data?.items?.[0]?.status || {};
  return {
    streamStatus: status.streamStatus || null,
    health: status.healthStatus?.status || null
  };
}

/**
 * Purani video live karne se pehle: kya ye videoId user ke apne connected
 * YouTube channel ki hai? (Sirf apni video hi stream ho sakti hai.)
 * Cost: 2 chhoti API calls (1 quota unit each).
 */
async function isVideoOwnedByUserChannel(user, videoId) {
  const accessToken = await ensureFreshYouTubeToken(user);

  const [mine, video] = await Promise.all([
    axios.get(`${YOUTUBE_API_BASE}/channels`, ytConfig(accessToken, { params: { part: 'id', mine: true } })),
    axios.get(`${YOUTUBE_API_BASE}/videos`, ytConfig(accessToken, { params: { part: 'snippet', id: videoId } }))
  ]);

  const myChannelId = mine.data?.items?.[0]?.id;
  const videoChannelId = video.data?.items?.[0]?.snippet?.channelId;
  return Boolean(myChannelId) && myChannelId === videoChannelId;
}

/**
 * Kisi bhi YouTube-related error ko route ke liye { status, code, message }
 * mein badalta hai.
 */
function describeYouTubeError(err) {
  if (err.code === 'YOUTUBE_NOT_CONNECTED' || err.code === 'YOUTUBE_REAUTH_REQUIRED') {
    return { status: 400, code: err.code, message: err.message };
  }

  const reason = err.response?.data?.error?.errors?.[0]?.reason;

  if (reason === 'liveStreamingNotEnabled') {
    return {
      status: 400,
      code: 'YOUTUBE_LIVE_NOT_ENABLED',
      message: 'Aapke YouTube channel par live streaming enabled nahi hai. YouTube Studio mein "Go Live" kholkar phone verify karein — enable hone mein 24 ghante lag sakte hain.'
    };
  }

  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return { status: 429, code: 'YOUTUBE_RATE_LIMITED', message: 'YouTube abhi busy hai. Thodi der baad try karein.' };
  }

  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return { status: 504, code: 'YOUTUBE_TIMEOUT', message: 'YouTube se response nahi aaya. Thodi der baad try karein.' };
  }

  return { status: 500, code: 'YOUTUBE_LIVE_ERROR', message: 'YouTube live session banane mein error aayi.' };
}

module.exports = {
  startYouTubeLiveSession,
  endYouTubeLiveSession,
  discardYouTubeLiveSession,
  isVideoOwnedByUserChannel,
  getYouTubeStreamStatus,
  describeYouTubeError
};
