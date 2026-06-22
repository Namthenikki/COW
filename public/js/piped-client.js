/* CoWatch — Piped API Client (ad-free YouTube) */
window.PipedClient = (function () {
  'use strict';

  const BASE = '/api/yt';

  async function request(path) {
    const res = await fetch(BASE + path);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    return res.json();
  }

  function normalizeVideo(item) {
    if (!item) return null;
    let videoId = item.videoId || item.id;
    if (videoId && videoId.length !== 11) videoId = null;
    if (!videoId && item.url) {
      const match = String(item.url).match(/(?:v=|\/shorts\/|youtu\.be\/|\/streams\/)([a-zA-Z0-9_-]{11})/);
      videoId = match?.[1];
    }
    if (!videoId) return null;
    return {
      videoId,
      title: item.title || 'Untitled',
      thumbnail: item.thumbnail || item.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      uploader: item.uploaderName || item.uploader || item.name || 'Unknown',
      duration: item.duration || 0,
      views: item.views || 0,
      uploadedDate: item.uploadedDate || item.uploaded || ''
    };
  }

  return {
    search(query, filter = 'all') {
      return request(`/search?q=${encodeURIComponent(query)}&filter=${filter}`);
    },

    trending(region = 'US') {
      return request(`/trending?region=${region}`);
    },

    streams(videoId) {
      return request(`/streams/${videoId}`);
    },

    channel(channelId) {
      return request(`/channel/${channelId}`);
    },

    playlist(playlistId) {
      return request(`/playlists/${playlistId}`);
    },

    normalizeVideo,

    normalizeList(items) {
      if (!Array.isArray(items)) return [];
      return items.map(normalizeVideo).filter(Boolean);
    },

    pickStream(streamsData) {
      const { videoStreams = [], hls, livestream } = streamsData;

      if (livestream && hls) {
        return {
          url: hls,
          proxyUrl: `/api/yt/proxy?url=${encodeURIComponent(hls)}`,
          type: 'hls',
          quality: 'live'
        };
      }

      // Prefer combined audio+video streams (never split — causes desync & stutter)
      const combined = videoStreams
        .filter((s) => !s.videoOnly)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      // 720p max — stable download, fewer stalls than 1080p+
      const pick = combined.find((s) => (s.height || 0) <= 720)
        || combined[combined.length - 1];

      if (pick) {
        return {
          url: pick.url,
          proxyUrl: `/api/yt/proxy?url=${encodeURIComponent(pick.url)}`,
          type: 'progressive',
          quality: pick.quality || `${pick.height}p`
        };
      }

      // Last resort: 360p combined if any
      const low = combined.find((s) => (s.height || 0) <= 360);
      if (low) {
        return {
          url: low.url,
          proxyUrl: `/api/yt/proxy?url=${encodeURIComponent(low.url)}`,
          type: 'progressive',
          quality: low.quality || '360p'
        };
      }

      if (hls) {
        return {
          url: hls,
          proxyUrl: `/api/yt/proxy?url=${encodeURIComponent(hls)}`,
          type: 'hls',
          quality: 'auto'
        };
      }

      throw new Error('No playable stream found');
    },

    formatDuration(seconds) {
      if (!seconds || seconds < 0) return '0:00';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      return `${m}:${String(s).padStart(2, '0')}`;
    },

    formatViews(n) {
      if (!n) return '';
      if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B views';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K views';
      return n + ' views';
    }
  };
})();
