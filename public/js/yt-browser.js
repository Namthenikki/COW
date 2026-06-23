/* CoWatch — In-Room YouTube (individual login, anyone picks → all watch) */
window.YTBrowser = (function () {
  'use strict';

  let onSelectVideo = null;
  let currentTab = 'discover';
  let searchTimer = null;
  let roomCode = '';
  let userName = '';

  function init(selectCallback, context = {}) {
    onSelectVideo = selectCallback;
    roomCode = context.roomCode || '';
    userName = context.userName || 'Guest';
    bindTabs();
    bindSearch();
    bindFab();
    loadDiscover();
    updateRoomCode();
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
