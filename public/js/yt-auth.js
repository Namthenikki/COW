/* CoWatch — YouTube Google Sign-In for Library */
window.YTAuth = (function () {
  'use strict';

  const STORAGE_KEY = 'cowatch-yt-auth';
  const SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile'
  ].join(' ');

  let config = null;
  let profile = null;

  async function loadConfig() {
    if (config) return config;
    const res = await fetch('/api/auth/config');
    config = await res.json();
    config.redirectUri = `${window.location.origin}/auth/callback`;
    return config;
  }

  function getStored() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function saveStored(data) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function clearStored() {
    sessionStorage.removeItem(STORAGE_KEY);
    profile = null;
  }

  async function getAccessToken() {
    const stored = getStored();
    if (!stored?.access_token) return null;
    if (stored.expires_at && Date.now() > stored.expires_at - 60000) {
      if (stored.refresh_token) {
        return refreshToken(stored.refresh_token);
      }
      clearStored();
      return null;
    }
    return stored.access_token;
  }

  async function refreshToken(refreshToken) {
    // Refresh requires server — for now re-login if expired
    clearStored();
    return null;
  }

  async function login() {
    const cfg = await loadConfig();
    if (!cfg.authEnabled) {
      throw new Error('YouTube login not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.');
    }

    const state = crypto.randomUUID();
    sessionStorage.setItem('cowatch-oauth-state', state);

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state
    });

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async function handleCallback(code) {
    const cfg = await loadConfig();
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: cfg.redirectUri })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Auth failed');

    saveStored({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000
    });

    await fetchProfile();
    return profile;
  }

  async function fetchProfile() {
    const token = await getAccessToken();
    if (!token) return null;

    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { clearStored(); return null; }
    profile = await res.json();
    return profile;
  }

  async function apiGet(endpoint) {
    const token = await getAccessToken();
    if (!token) throw new Error('Not logged in');

    const res = await fetch(`/api/youtube/data?endpoint=${encodeURIComponent(endpoint)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || 'YouTube API error');
    }
    return res.json();
  }

  async function getSubscriptions() {
    const data = await apiGet('subscriptions?part=snippet&mine=true&maxResults=25&order=relevance');
    return (data.items || []).map((item) => ({
      channelId: item.snippet.resourceId.channelId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.default?.url,
      description: item.snippet.description
    }));
  }

  async function getPlaylists() {
    const data = await apiGet('playlists?part=snippet&mine=true&maxResults=25');
    return (data.items || []).map((item) => ({
      playlistId: item.id,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.medium?.url,
      count: item.contentDetails?.itemCount
    }));
  }

  async function getPlaylistVideos(playlistId) {
    const data = await apiGet(
      `playlistItems?part=snippet&playlistId=${playlistId}&maxResults=30`
    );
    return (data.items || []).map((item) => ({
      videoId: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.medium?.url,
      uploader: item.snippet.videoOwnerChannelTitle || item.snippet.channelTitle
    })).filter((v) => v.videoId);
  }

  async function getLikedVideos() {
    const data = await apiGet('videos?part=snippet&myRating=like&maxResults=25');
    return (data.items || []).map((item) => ({
      videoId: item.id,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.medium?.url,
      uploader: item.snippet.channelTitle
    }));
  }

  async function isLoggedIn() {
    const token = await getAccessToken();
    if (!token) return false;
    if (!profile) await fetchProfile();
    return !!profile;
  }

  function logout() {
    clearStored();
  }

  function getProfile() {
    return profile || getStored()?.profile;
  }

  return {
    loadConfig,
    login,
    handleCallback,
    logout,
    isLoggedIn,
    getProfile,
    fetchProfile,
    getSubscriptions,
    getPlaylists,
    getPlaylistVideos,
    getLikedVideos
  };
})();
