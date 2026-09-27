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

const axios = require('axios');
const { refreshAccessToken, isInvalidGrantError } = require('./youtube');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

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
        title: title || 'Live Stream via TubePilot',
        description: description || '',
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
        latencyPreference: 'normal'
      }
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data; // { id, snippet, status, contentDetails, ... }
}

async function createLiveStream(accessToken, title) {
  const response = await axios.post(
    `${YOUTUBE_API_BASE}/liveStreams?part=snippet,cdn,contentDetails`,
    {
      snippet: { title: title || 'TubePilot Live Stream' },
      cdn: {
        frameRate: 'variable',
        ingestionType: 'rtmp',
        resolution: 'variable'
      },
      contentDetails: { isReusable: false }
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data; // { id, cdn: { ingestionInfo: { streamName, ingestionAddress } } }
}

async function bindBroadcastToStream(accessToken, broadcastId, streamId) {
  const response = await axios.post(
    `${YOUTUBE_API_BASE}/liveBroadcasts/bind?id=${broadcastId}&streamId=${streamId}&part=id,contentDetails`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return response.data;
}

async function transitionBroadcast(accessToken, broadcastId, broadcastStatus) {
  // broadcastStatus: 'testing' | 'live' | 'complete'
  try {
    const response = await axios.post(
      `${YOUTUBE_API_BASE}/liveBroadcasts/transition?broadcastStatus=${broadcastStatus}&id=${broadcastId}&part=id,status`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return response.data;
  } catch (err) {
    // Agar broadcast already complete/ended hai to YouTube error deta hai —
    // isko fail mat mano, stop process ko rukna nahi chahiye isi wajah se.
    console.error('⚠️ [YouTube Live] transition failed (ignored):', err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * MAIN FUNCTION — Live streaming shuru karne ke liye ye ek hi function
 * call karo. Poora broadcast + stream + bind process khud handle karta hai.
 *
 * @param {object} user - Mongoose User document (req.user)
 * @param {object} options - { title, description }
 * @returns {{ streamKey, ingestionAddress, broadcastId, youtubeStreamId, watchUrl }}
 */
async function startYouTubeLiveSession(user, { title, description } = {}) {
  const accessToken = await ensureFreshYouTubeToken(user);

  console.log(`[YouTube Live] Broadcast bana rahe hain — user ${user._id}, title="${title}"`);
  const broadcast = await createLiveBroadcast(accessToken, { title, description });

  console.log(`[YouTube Live] Stream bana rahe hain — broadcastId=${broadcast.id}`);
  const stream = await createLiveStream(accessToken, title);

  console.log(`[YouTube Live] Bind kar rahe hain — streamId=${stream.id}`);
  await bindBroadcastToStream(accessToken, broadcast.id, stream.id);

  const ingestionInfo = stream.cdn.ingestionInfo;

  console.log(`[YouTube Live] Ready! Stream key mil gayi, broadcastId=${broadcast.id}`);

  return {
    streamKey: ingestionInfo.streamName,
    ingestionAddress: ingestionInfo.ingestionAddress, // usually rtmp://a.rtmp.youtube.com/live2
    broadcastId: broadcast.id,
    youtubeStreamId: stream.id,
    watchUrl: `https://youtube.com/watch?v=${broadcast.id}`
  };
}

/**
 * Live session ko YouTube ki taraf se bhi properly "complete" karta hai
 * (sirf FFmpeg band karna kaafi nahi — broadcast bhi close karna chahiye
 * warna YouTube pe "stuck live" dikh sakta hai).
 */
async function endYouTubeLiveSession(user, broadcastId) {
  if (!broadcastId) return;
  try {
    const accessToken = await ensureFreshYouTubeToken(user);
    await transitionBroadcast(accessToken, broadcastId, 'complete');
    console.log(`[YouTube Live] Broadcast ${broadcastId} complete kar diya.`);
  } catch (err) {
    console.error(`⚠️ [YouTube Live] End session failed (ignored, stream EC2 side to band ho hi chuka hai):`, err.message);
  }
}

module.exports = {
  startYouTubeLiveSession,
  endYouTubeLiveSession
};
