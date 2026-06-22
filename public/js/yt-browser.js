/* CoWatch — In-Room YouTube (individual login, anyone picks → all watch) */
window.YTBrowser = (function () {
  'use strict';

  let onSelectVideo = null;
  let currentTab = 'discover';
  let searchTimer = null;
  let roomCode = '';
  let userName = '';
  let authEnabled = false; // Whether OAuth is configured on the server

  function init(selectCallback, context = {}) {
    onSelectVideo = selectCallback;
    roomCode = context.roomCode || '';
    userName = context.userName || 'Guest';
    bindTabs();
    bindSearch();
    bindAuth();
    bindFab();
    loadDiscover();
    updateRoomCode();

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'cowatch-auth-success') {
        updateAuthUI();
        if (currentTab === 'library') loadLibrary();
        showBrowserToast('Signed in! Your library is ready.');
      }
    });
  }

  function setContext(ctx) {
    roomCode = ctx.roomCode || roomCode;
    userName = ctx.userName || userName;
    updateRoomCode();
  }

  function updateRoomCode() {
    const el = document.getElementById('yt-room-code');
    if (el) el.textContent = roomCode || '------';
  }

  function bindFab() {
    document.getElementById('yt-fab')?.addEventListener('click', () => open());
  }

  function bindTabs() {
    document.querySelectorAll('.yt-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.yt-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        document.querySelectorAll('.yt-panel').forEach((p) => p.classList.remove('active'));
        document.getElementById(`yt-panel-${currentTab}`)?.classList.add('active');

        if (currentTab === 'discover') loadDiscover();
        if (currentTab === 'library') loadLibrary();
      });
    });
  }

  function bindSearch() {
    const input = document.getElementById('yt-search-input');
    if (!input) return;

    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = input.value.trim();
        if (q.length >= 2) search(q);
      }, 400);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = input.value.trim();
        if (q) search(q);
      }
    });
  }

  function bindAuth() {
    document.getElementById('yt-login-btn')?.addEventListener('click', async () => {
      try {
        sessionStorage.setItem('cowatch-return-url', location.href);
        await YTAuth.login();
      } catch (e) {
        showBrowserToast(e.message);
      }
    });

    document.getElementById('yt-logout-btn')?.addEventListener('click', () => {
      YTAuth.logout();
      updateAuthUI();
      loadLibrary();
      showBrowserToast('Signed out');
    });

    // Check if OAuth is configured on the server
    checkAuthConfig();
  }

  async function checkAuthConfig() {
    try {
      authEnabled = await YTAuth.isConfigured();
    } catch {
      authEnabled = false;
    }
    updateAuthUI();
  }

  async function updateAuthUI() {
    const loginBtn = document.getElementById('yt-login-btn');
    const userBar = document.getElementById('yt-user-bar');
    const loginPrompt = document.getElementById('yt-login-prompt');
    const authRow = document.querySelector('.yt-auth-row');
    const libraryTab = document.querySelector('.yt-tab[data-tab="library"]');

    // If OAuth is not configured, hide all auth UI
    if (!authEnabled) {
      if (loginBtn) loginBtn.style.display = 'none';
      if (loginPrompt) loginPrompt.style.display = 'none';
      if (userBar) userBar.style.display = 'none';
      if (authRow) authRow.style.display = 'none';
      // Rename "My Account" tab to indicate it's unavailable or hide it
      if (libraryTab) {
        libraryTab.innerHTML = '<i class="ph ph-user-circle"></i> Library';
        libraryTab.title = 'Set up Google OAuth to use your library';
      }
      return;
    }

    const loggedIn = await YTAuth.isLoggedIn();
    const profile = loggedIn ? await YTAuth.fetchProfile() : null;

    if (authRow) authRow.style.display = '';
    if (loginBtn) loginBtn.style.display = loggedIn ? 'none' : 'flex';
    if (loginPrompt) loginPrompt.style.display = loggedIn ? 'none' : 'flex';
    if (userBar) {
      userBar.style.display = loggedIn ? 'flex' : 'none';
      if (profile) {
        userBar.querySelector('.yt-user-name').textContent = profile.name || 'You';
        const img = userBar.querySelector('img');
        if (img && profile.picture) img.src = profile.picture;
      }
    }
  }

  function showBrowserToast(msg) {
    const el = document.getElementById('yt-browser-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3500);
  }

  function setLoading(panelId, loading) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.classList.toggle('loading', loading);
  }

  function renderGrid(containerId, videos, emptyMsg) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!videos?.length) {
      el.innerHTML = `<div class="yt-empty"><i class="ph ph-film-strip"></i><p>${emptyMsg || 'Nothing here yet'}</p></div>`;
      return;
    }

    el.innerHTML = videos.map((v) => `
      <button class="yt-card" data-vid="${v.videoId}" type="button" aria-label="Play ${escapeHTML(v.title)} for everyone">
        <div class="yt-card-thumb">
          <img src="${v.thumbnail}" alt="" loading="lazy">
          ${v.duration ? `<span class="yt-card-dur">${PipedClient.formatDuration(v.duration)}</span>` : ''}
          <div class="yt-card-play">
            <i class="ph ph-play-fill"></i>
            <span>Play for room</span>
          </div>
        </div>
        <div class="yt-card-info">
          <h4>${escapeHTML(v.title)}</h4>
          <p>${escapeHTML(v.uploader || '')}</p>
          ${v.views ? `<span>${PipedClient.formatViews(v.views)}</span>` : ''}
        </div>
      </button>
    `).join('');

    el.querySelectorAll('.yt-card').forEach((card) => {
      card.addEventListener('click', () => {
        const videoId = card.dataset.vid;
        const title = card.querySelector('h4')?.textContent;
        const thumbnail = card.querySelector('img')?.src;
        const uploader = card.querySelector('.yt-card-info p')?.textContent;
        showBrowserToast(`Playing for everyone in the room…`);
        onSelectVideo?.(videoId, { title, thumbnail, uploader, pickedBy: userName });
      });
    });
  }

  async function loadDiscover() {
    setLoading('yt-panel-discover', true);
    try {
      const data = await PipedClient.trending();
      const videos = PipedClient.normalizeList(data);
      renderGrid('yt-discover-grid', videos, 'Could not load trending');
    } catch (e) {
      renderGrid('yt-discover-grid', [], e.message);
    }
    setLoading('yt-panel-discover', false);
  }

  async function search(query) {
    currentTab = 'search';
    document.querySelectorAll('.yt-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === 'search');
    });
    document.querySelectorAll('.yt-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('yt-panel-search')?.classList.add('active');

    setLoading('yt-panel-search', true);
    try {
      const data = await PipedClient.search(query);
      const items = data.items || data.relatedStreams || data;
      const videos = PipedClient.normalizeList(Array.isArray(items) ? items : []);
      renderGrid('yt-search-grid', videos, `No results for "${query}"`);
    } catch (e) {
      renderGrid('yt-search-grid', [], e.message);
    }
    setLoading('yt-panel-search', false);
  }

  async function loadLibrary() {
    const subsEl = document.getElementById('yt-subs-grid');
    const playlistsEl = document.getElementById('yt-playlists-grid');
    const likedEl = document.getElementById('yt-liked-grid');
    const loginPrompt = document.getElementById('yt-login-prompt');

    // If OAuth is not configured, show a helpful message
    if (!authEnabled) {
      if (subsEl) subsEl.innerHTML = '';
      if (playlistsEl) playlistsEl.innerHTML = '';
      if (likedEl) likedEl.innerHTML = `
        <div class="yt-empty">
          <i class="ph ph-lock-key"></i>
          <p>YouTube login requires Google OAuth setup on the server.<br>
          <strong>You can still search and play any video!</strong><br>
          Use the Search tab or Home tab to find videos.</p>
        </div>`;
      if (loginPrompt) loginPrompt.style.display = 'none';
      return;
    }

    const loggedIn = await YTAuth.isLoggedIn();
    if (loginPrompt) loginPrompt.style.display = loggedIn ? 'none' : 'flex';
    if (!loggedIn) {
      if (subsEl) subsEl.innerHTML = '';
      if (playlistsEl) playlistsEl.innerHTML = '';
      if (likedEl) likedEl.innerHTML = '';
      return;
    }

    setLoading('yt-panel-library', true);
    try {
      const [subs, playlists, liked] = await Promise.all([
        YTAuth.getSubscriptions().catch(() => []),
        YTAuth.getPlaylists().catch(() => []),
        YTAuth.getLikedVideos().catch(() => [])
      ]);

      if (subsEl) {
        subsEl.innerHTML = subs.map((s) => `
          <button class="yt-channel-card" data-channel="${s.channelId}" type="button">
            <img src="${s.thumbnail}" alt="">
            <span>${escapeHTML(s.title)}</span>
          </button>
        `).join('') || '<p class="yt-muted">No subscriptions</p>';

        subsEl.querySelectorAll('.yt-channel-card').forEach((card) => {
          card.addEventListener('click', () => loadChannel(card.dataset.channel));
        });
      }

      if (playlistsEl) {
        playlistsEl.innerHTML = playlists.map((p) => `
          <button class="yt-playlist-card" data-playlist="${p.playlistId}" type="button">
            <img src="${p.thumbnail || ''}" alt="">
            <div><strong>${escapeHTML(p.title)}</strong></div>
          </button>
        `).join('') || '<p class="yt-muted">No playlists</p>';

        playlistsEl.querySelectorAll('.yt-playlist-card').forEach((card) => {
          card.addEventListener('click', () => loadPlaylist(card.dataset.playlist));
        });
      }

      renderGrid('yt-liked-grid', liked, 'No liked videos');
    } catch (e) {
      showBrowserToast(e.message);
    }
    setLoading('yt-panel-library', false);
  }

  async function loadChannel(channelId) {
    try {
      const data = await PipedClient.channel(channelId);
      const videos = PipedClient.normalizeList(data.relatedStreams || []);
      currentTab = 'search';
      document.querySelectorAll('.yt-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'search'));
      document.querySelectorAll('.yt-panel').forEach((p) => p.classList.remove('active'));
      document.getElementById('yt-panel-search')?.classList.add('active');
      renderGrid('yt-search-grid', videos, 'No videos from this channel');
    } catch (e) {
      showBrowserToast(e.message);
    }
  }

  async function loadPlaylist(playlistId) {
    try {
      const videos = await YTAuth.getPlaylistVideos(playlistId);
      currentTab = 'search';
      document.querySelectorAll('.yt-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'search'));
      document.querySelectorAll('.yt-panel').forEach((p) => p.classList.remove('active'));
      document.getElementById('yt-panel-search')?.classList.add('active');
      renderGrid('yt-search-grid', videos, 'Playlist empty');
    } catch (e) {
      showBrowserToast(e.message);
    }
  }

  function _updateFab() {
    const fab = document.getElementById('yt-fab');
    const browser = document.getElementById('yt-browser');
    if (!fab || !browser) return;
    fab.classList.toggle('hidden', browser.classList.contains('open'));
  }

  function toggle() {
    const browser = document.getElementById('yt-browser');
    if (browser?.classList.contains('open')) close();
    else open();
  }

  function open() {
    const browser = document.getElementById('yt-browser');
    browser?.classList.add('open');
    document.body.classList.add('yt-open');
    _updateFab();
    document.getElementById('yt-search-input')?.focus();
  }

  function close() {
    document.getElementById('yt-browser')?.classList.remove('open');
    document.body.classList.remove('yt-open');
    _updateFab();
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  return { init, setContext, toggle, open, close, search, loadDiscover };
})();
