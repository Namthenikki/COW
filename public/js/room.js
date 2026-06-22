/* ═══════════════════════════════════════════════════════
   CoWatch Room — PeerJS-based P2P Sync + Video Call
   
   Architecture:
   - PeerJS handles signaling via its free cloud server
   - Data Channels carry sync events (play/pause/seek/chat)
   - Media Streams handle video calling
   - HTML5 ad-free player via Piped proxy
   - Full YouTube browser with Google sign-in
   - Zero npm dependencies needed
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── State ───
  let peer = null;
  let dataConn = null;
  let mediaCall = null;
  let cowatchPlayer = null;
  let playerReady = false;
  let currentVideoMeta = {};
  let isRemoteAction = false;
  let remoteActionTimer = null;
  let roomCode = '';
  let userName = '';
  let isHost = false;
  let currentVideoId = null;
  let pendingState = null;
  let lastKnownTime = 0;
  let lastStateChangeTime = 0;
  let partnerName = 'Partner';
  let isChatVisible = false; // Mobile: chat hidden by default

  // WebRTC / Call State
  let localStream = null;
  let isInCall = false;
  let isMuted = false;
  let isCamOff = false;
  let isCallMinimized = false;

  // Connection status
  let isConnected = false;
  let lastDriftFix = 0;

  // ─── Constants ───
  const PEER_ID_PREFIX = 'cowatch-';
  const DRIFT_THRESHOLD = 8.0;      // only hard-correct if >8s out of sync (was 5)
  const DRIFT_COOLDOWN = 45000;     // max one drift fix per 45s (stops seek loops)
  const SYNC_PLAY_SEEK = 4.0;       // don't micro-seek on play (was 3)
  const STATE_CHANGE_DEBOUNCE = 300; // ms

  // ═══════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    roomCode = (params.get('room') || '').toUpperCase();
    userName = params.get('name') || 'Guest';
    isHost = params.get('host') === 'true';

    if (!roomCode && !isHost) {
      window.location.href = '/';
      return;
    }

    initPeer();
    initPlayer();
    initUI();
  });

  // ═══════════════════════════════════════════════════════
  //  PEERJS — P2P Connection
  // ═══════════════════════════════════════════════════════

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  function initPeer() {
    if (isHost) {
      // ── HOST: Create room ──
      roomCode = generateRoomCode();
      const peerId = PEER_ID_PREFIX + roomCode;

      peer = new Peer(peerId, { debug: 0 });

      peer.on('open', () => {
        console.log('🏠 Host peer ready:', peerId);
        updateRoomInfo();
        // Update URL so refreshing works
        history.replaceState(null, '', `?room=${roomCode}&name=${encodeURIComponent(userName)}`);
        isHost = true; // Stays host even on URL update
        showNotification(`Room created! Code: ${roomCode}`, 'success');
      });

      // Listen for incoming data connections from guests
      peer.on('connection', (conn) => {
        console.log('📡 Incoming data connection');
        setupDataConnection(conn);
      });

      // Listen for incoming video calls
      peer.on('call', (call) => {
        handleIncomingMediaCall(call);
      });

    } else {
      // ── GUEST: Join existing room ──
      peer = new Peer(undefined, { debug: 0 }); // random ID for guest

      peer.on('open', () => {
        console.log('🔗 Guest peer ready, connecting to room:', roomCode);
        updateRoomInfo();

        // Connect to host via data channel
        const hostPeerId = PEER_ID_PREFIX + roomCode;
        const conn = peer.connect(hostPeerId, {
          reliable: true,
          metadata: { name: userName }
        });

        setupDataConnection(conn);
      });

      // Listen for incoming video calls from host
      peer.on('call', (call) => {
        handleIncomingMediaCall(call);
      });
    }

    // ── Error handling ──
    peer.on('error', (err) => {
      console.error('PeerJS error:', err.type, err);
      switch (err.type) {
        case 'peer-unavailable':
          showNotification('Room not found! Double-check the code.', 'error');
          setTimeout(() => window.location.href = '/', 2500);
          break;
        case 'unavailable-id':
          showNotification('Room code already in use. Try again.', 'error');
          setTimeout(() => window.location.href = '/', 2500);
          break;
        case 'network':
          showNotification('Network error — check your connection.', 'error');
          break;
        case 'disconnected':
          showNotification('Disconnected from signaling server.', 'error');
          peer.reconnect();
          break;
        default:
          showNotification(`Connection error: ${err.type}`, 'error');
      }
    });

    peer.on('disconnected', () => {
      console.log('⚠️ Peer disconnected, attempting reconnect...');
      if (!peer.destroyed) peer.reconnect();
    });
  }

  // ─── Data Connection Setup ───
  function setupDataConnection(conn) {
    dataConn = conn;

    conn.on('open', () => {
      console.log('✅ Data channel open!');
      isConnected = true;
      partnerName = conn.metadata?.name || 'Partner';
      showNotification(`${partnerName} connected! 🎉`, 'success');
      addSystemMessage(`${partnerName} joined the room 🎉`);
      document.getElementById('user-count').textContent = '2';

      // HOST: Send current video state to new joiner
      if (isHost && cowatchPlayer && playerReady && currentVideoId) {
        setTimeout(() => {
          sendData({
            type: 'sync-state',
            videoId: currentVideoId,
            title: currentVideoMeta.title,
            thumbnail: currentVideoMeta.thumbnail,
            uploader: currentVideoMeta.uploader,
            isPlaying: cowatchPlayer.isPlaying(),
            currentTime: cowatchPlayer.getCurrentTime()
          });
        }, 500);
      }
    });

    conn.on('data', handleDataMessage);

    conn.on('close', () => {
      console.log('💔 Data connection closed');
      isConnected = false;
      showNotification(`${partnerName} disconnected 😔`);
      addSystemMessage(`${partnerName} left the room 👋`);
      document.getElementById('user-count').textContent = '1';
      dataConn = null;
      cleanupCall();
    });

    conn.on('error', (err) => {
      console.error('Data connection error:', err);
      showNotification('Connection error with partner', 'error');
    });
  }

  // ─── Handle Incoming Data Messages ───
  function handleDataMessage(data) {
    switch (data.type) {
      // ── Video Sync ──
      case 'load-video':
        setRemoteAction();
        currentVideoId = data.videoId;
        loadVideoById(data.videoId, {
          title: data.title,
          thumbnail: data.thumbnail,
          uploader: data.uploader,
          pickedBy: data.pickedBy
        }, false).then(() => {
          cowatchPlayer.play();
        });
        {
          const who = data.pickedBy || partnerName;
          showNotification(`${who} picked a video for the room 🎬`, 'success');
          addSystemMessage(`🎬 ${who} started: ${data.title || 'a video'}`);
        }
        break;

      case 'sync-play':
        setRemoteAction();
        if (cowatchPlayer && playerReady) {
          const drift = Math.abs(cowatchPlayer.getCurrentTime() - data.time);
          if (drift > SYNC_PLAY_SEEK) {
            cowatchPlayer.seekTo(data.time, { silent: true, waitBuffer: false });
          }
          cowatchPlayer.play(true);
        }
        break;

      case 'sync-pause':
        setRemoteAction();
        if (cowatchPlayer && playerReady) {
          const drift = Math.abs(cowatchPlayer.getCurrentTime() - data.time);
          if (drift > 1.5) cowatchPlayer.seekTo(data.time, { silent: true, waitBuffer: false });
          cowatchPlayer.pause();
        }
        break;

      case 'sync-seek':
        setRemoteAction();
        if (cowatchPlayer && playerReady) {
          cowatchPlayer.seekTo(data.time, { silent: true });
        }
        break;

      case 'sync-state':
        if (data.videoId) {
          currentVideoId = data.videoId;
          currentVideoMeta = {
            title: data.title,
            thumbnail: data.thumbnail,
            uploader: data.uploader
          };
          if (cowatchPlayer) {
            applySyncState(data);
          } else {
            pendingState = data;
          }
        }
        break;

      case 'time-update':
        if (cowatchPlayer && playerReady && data.isPlaying) {
          try {
            if (cowatchPlayer.isPlaying()) {
              const localTime = cowatchPlayer.getCurrentTime();
              const drift = Math.abs(localTime - data.time);
              const now = Date.now();
              if (drift > DRIFT_THRESHOLD && now - lastDriftFix > DRIFT_COOLDOWN) {
                lastDriftFix = now;
                setRemoteAction();
                cowatchPlayer.seekTo(data.time, { silent: true, waitBuffer: false });
                console.log(`🔄 Drift corrected: ${drift.toFixed(2)}s`);
              }
            }
          } catch (e) { /* player not ready */ }
        }
        break;

      // ── Chat ──
      case 'chat':
        displayMessage({
          name: data.name,
          message: data.message,
          timestamp: data.timestamp,
          isOwn: false
        });
        notifyChatUnread();
        break;

      // ── Video Call Signaling ──
      case 'call-request':
        showCallModal(data.name, () => {
          sendData({ type: 'call-accepted' });
          initiateMediaCall();
        }, () => {
          sendData({ type: 'call-rejected' });
        });
        break;

      case 'call-accepted':
        showNotification('Call accepted! Connecting... 🎉', 'success');
        initiateMediaCall();
        break;

      case 'call-rejected':
        showNotification('Call was declined 😔');
        cleanupCall();
        break;

      case 'call-ended':
        showNotification('Call ended');
        cleanupCall();
        break;

      case 'buffering':
        break; // handled locally — no seek spam
    }
  }

  function applySyncState(data) {
    setRemoteAction();
    loadVideoById(data.videoId, {
      title: data.title,
      thumbnail: data.thumbnail,
      uploader: data.uploader
    }, false).then(() => {
      setTimeout(() => {
        setRemoteAction();
        if (data.isPlaying) {
          cowatchPlayer.seekTo(data.currentTime + 0.5, { silent: true, waitBuffer: true });
          cowatchPlayer.play();
        } else {
          cowatchPlayer.seekTo(data.currentTime, { silent: true, waitBuffer: false });
          cowatchPlayer.pause();
        }
      }, 500);
    }).catch((err) => {
      console.error('Sync load failed:', err);
    });
  }

  // ─── Send Data to Partner ───
  function sendData(data) {
    if (dataConn && dataConn.open) {
      try {
        dataConn.send(data);
      } catch (e) {
        console.error('Failed to send data:', e);
      }
    }
  }

  function setRemoteAction() {
    isRemoteAction = true;
    if (remoteActionTimer) clearTimeout(remoteActionTimer);
    // 3 seconds guard — must be longer than any buffer-wait that could fire
    // play/pause/seek events after the remote action
    remoteActionTimer = setTimeout(() => {
      isRemoteAction = false;
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════
  //  AD-FREE VIDEO PLAYER (Piped)
  // ═══════════════════════════════════════════════════════

  function initPlayer() {
    const videoEl = document.getElementById('cowatch-video');
    const controlsEl = document.getElementById('player-controls');
    cowatchPlayer = new CowatchPlayer(videoEl, controlsEl);

    cowatchPlayer.on('ready', () => {
      playerReady = true;
      if (pendingState) {
        applySyncState(pendingState);
        pendingState = null;
      }
    });

    cowatchPlayer.on('play', (data) => {
      if (isRemoteAction) return;
      sendData({ type: 'sync-play', time: data.time });
    });

    cowatchPlayer.on('pause', (data) => {
      if (isRemoteAction) return;
      sendData({ type: 'sync-pause', time: data.time });
    });

    cowatchPlayer.on('seeked', (data) => {
      if (isRemoteAction) return;
      sendData({ type: 'sync-seek', time: data.time });
    });

    cowatchPlayer.on('buffering', () => {
      // local stall recovery only — don't notify partner
    });

    cowatchPlayer.on('loaded', (meta) => {
      updateNowPlaying(meta);
      hideLoading();
    });

    YTBrowser.init((videoId, meta) => {
      playVideo(videoId, meta);
    }, { roomCode, userName });

    if (pendingState) {
      applySyncState(pendingState);
      pendingState = null;
    }
  }

  function showLoading() {
    document.getElementById('player-loading')?.classList.remove('hidden');
  }

  function hideLoading() {
    document.getElementById('player-loading')?.classList.add('hidden');
  }

  function updateNowPlaying(meta) {
    const title = document.getElementById('np-title');
    const uploader = document.getElementById('np-uploader');
    const thumb = document.getElementById('np-thumb');
    if (title) title.textContent = meta.title || 'Now Playing';
    if (uploader) {
      const by = meta.pickedBy ? `Picked by ${meta.pickedBy}` : '';
      uploader.textContent = by || meta.uploader || '';
    }
    if (thumb && meta.thumbnail) {
      thumb.src = meta.thumbnail;
      thumb.classList.remove('hidden');
    }
  }

  setInterval(() => {
    if (!cowatchPlayer || !playerReady) return;
    try {
      if (cowatchPlayer.isPlaying()) {
        lastKnownTime = cowatchPlayer.getCurrentTime();
        sendData({
          type: 'time-update',
          time: lastKnownTime,
          isPlaying: true
        });
      }
    } catch (e) { /* player not ready */ }
  }, 12000);  // Every 12s (was 8s — less frequent = fewer drift corrections)

  async function loadVideoById(videoId, meta = {}, broadcast = false) {
    currentVideoId = videoId;
    currentVideoMeta = { ...meta };
    showLoading();
    hidePlaceholder();

    try {
      const loaded = await cowatchPlayer.loadVideo(videoId, meta);
      currentVideoMeta = { ...currentVideoMeta, ...loaded };
      playerReady = true;
      updateNowPlaying(currentVideoMeta);

      if (broadcast) {
        sendData({
          type: 'load-video',
          videoId,
          title: currentVideoMeta.title,
          thumbnail: currentVideoMeta.thumbnail,
          uploader: currentVideoMeta.uploader,
          pickedBy: userName
        });
        addSystemMessage(`🎬 You started: ${currentVideoMeta.title || 'a video'}`);
      }
      return loaded;
    } catch (err) {
      hideLoading();
      showNotification('Failed to load video: ' + err.message, 'error');
      throw err;
    }
  }

  function playVideo(videoId, meta = {}) {
    setRemoteAction();
    loadVideoById(videoId, meta, true).then(() => {
      cowatchPlayer.play();
      showNotification('Playing for everyone in the room! 🎬', 'success');
      YTBrowser.close();
    }).catch(() => {});
  }

  function extractVideoId(input) {
    const value = input.trim();
    const rawId = value.match(/^[a-zA-Z0-9_-]{11}$/);
    if (rawId) return rawId[0];

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;

    try {
      const parsed = new URL(withProtocol);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

      if (host === 'youtu.be') {
        return parsed.pathname.split('/').filter(Boolean)[0] || null;
      }

      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
        const fromQuery = parsed.searchParams.get('v');
        if (fromQuery && /^[a-zA-Z0-9_-]{11}$/.test(fromQuery)) return fromQuery;

        const parts = parsed.pathname.split('/').filter(Boolean);
        const knownPrefixes = ['embed', 'shorts', 'live', 'v'];
        const prefixIndex = parts.findIndex((part) => knownPrefixes.includes(part));
        if (prefixIndex >= 0 && parts[prefixIndex + 1]) {
          const id = parts[prefixIndex + 1];
          if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
        }
      }
    } catch { /* fall back to regex below */ }

    const match = value.match(/(?:v=|\/embed\/|\/shorts\/|\/live\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] || null;
  }

  function handleLoadVideo() {
    const input = document.getElementById('video-url-input');
    const url = input.value.trim();
    if (!url) return;

    const videoId = extractVideoId(url);
    if (videoId) {
      playVideo(videoId);
      input.value = '';
      return;
    }

    if (url.length >= 2) {
      YTBrowser.open();
      YTBrowser.search(url);
      input.value = '';
      return;
    }

    showNotification('Enter a YouTube URL or search term', 'error');
  }

  function hidePlaceholder() {
    const ph = document.getElementById('player-placeholder');
    if (ph) ph.classList.add('hidden');
  }

  // ═══════════════════════════════════════════════════════
  //  VIDEO CALL (WebRTC via PeerJS)
  // ═══════════════════════════════════════════════════════

  async function startCallRequest() {
    // First get local media to check permissions
    try {
      await setupLocalMedia();
      // Send call request via data channel
      sendData({ type: 'call-request', name: userName });
      showNotification('Calling partner... 📞');
    } catch (err) {
      console.error('Media error:', err);
      showNotification('Camera/Mic access denied! Check browser permissions.', 'error');
    }
  }

  async function setupLocalMedia() {
    if (localStream) return;

    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640, max: 1280 },
        height: { ideal: 480, max: 720 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000
      }
    });

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    document.getElementById('call-overlay').classList.add('active');
  }

  async function initiateMediaCall() {
    try {
      await setupLocalMedia();

      // Determine who to call
      const remotePeerId = isHost
        ? dataConn.peer
        : PEER_ID_PREFIX + roomCode;

      console.log('📞 Calling peer:', remotePeerId);
      mediaCall = peer.call(remotePeerId, localStream, {
        metadata: { name: userName }
      });

      setupMediaCall(mediaCall);
    } catch (err) {
      console.error('Failed to initiate call:', err);
      showNotification('Failed to start call', 'error');
    }
  }

  function handleIncomingMediaCall(call) {
    console.log('📞 Incoming media call');
    mediaCall = call;

    // Auto-answer if we already have local media (we accepted via data channel)
    if (localStream) {
      call.answer(localStream);
      setupMediaCall(call);
    } else {
      // Setup media and then answer
      setupLocalMedia().then(() => {
        call.answer(localStream);
        setupMediaCall(call);
      }).catch(err => {
        console.error('Failed to get media for incoming call:', err);
        showNotification('Camera/Mic access denied!', 'error');
      });
    }
  }

  function setupMediaCall(call) {
    call.on('stream', (remoteStream) => {
      console.log('🎥 Remote stream received!');
      const remoteVideo = document.getElementById('remote-video');
      remoteVideo.srcObject = remoteStream;
      document.getElementById('remote-video-container').classList.add('active');
      isInCall = true;
      updateCallButtonUI();
      showNotification('Video call connected! 🎉', 'success');
    });

    call.on('close', () => {
      console.log('📴 Media call closed');
      cleanupCall();
    });

    call.on('error', (err) => {
      console.error('Media call error:', err);
      showNotification('Call error', 'error');
      cleanupCall();
    });
  }

  function endCall() {
    sendData({ type: 'call-ended' });
    if (mediaCall) {
      mediaCall.close();
    }
    cleanupCall();
  }

  function cleanupCall() {
    if (mediaCall) {
      try { mediaCall.close(); } catch (e) {}
      mediaCall = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }

    isInCall = false;
    isMuted = false;
    isCamOff = false;
    isCallMinimized = false;

    const overlay = document.getElementById('call-overlay');
    if (overlay) {
      overlay.classList.remove('active');
      overlay.classList.remove('minimized');
    }
    const minBtn = document.getElementById('minimize-btn');
    if (minBtn) {
      minBtn.innerHTML = '<i class="ph ph-arrows-in-simple"></i>';
      minBtn.title = "Minimize Call";
    }
    document.getElementById('remote-video-container').classList.remove('active');

    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    updateCallButtonUI();
    updateMuteUI();
    updateCameraUI();

    // Remove any call modals
    const modal = document.querySelector('.call-modal-overlay');
    if (modal) modal.remove();
  }

  function toggleMute() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      isMuted = !isMuted;
      audioTrack.enabled = !isMuted;
      updateMuteUI();
    }
  }

  function toggleCamera() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      isCamOff = !isCamOff;
      videoTrack.enabled = !isCamOff;
      updateCameraUI();
    }
  }

  function toggleCallMinimization() {
    const overlay = document.getElementById('call-overlay');
    const btn = document.getElementById('minimize-btn');
    if (!overlay || !btn) return;

    isCallMinimized = !isCallMinimized;

    if (isCallMinimized) {
      overlay.classList.add('minimized');
      btn.innerHTML = '<i class="ph ph-arrows-out-simple"></i>';
      btn.title = "Maximize Call";
    } else {
      overlay.classList.remove('minimized');
      btn.innerHTML = '<i class="ph ph-arrows-in-simple"></i>';
      btn.title = "Minimize Call";
    }
  }

  // ─── Draggable PiP ───
  const PIP_POS_KEY = 'cowatch-pip-pos';

  function initPipDrag() {
    const pip = document.getElementById('call-overlay');
    const dragHandle = document.getElementById('pip-drag-handle');
    if (!pip || !dragHandle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    restorePipPosition(pip);

    function getBounds() {
      const margin = 8;
      const rect = pip.getBoundingClientRect();
      return {
        minX: margin,
        minY: margin,
        maxX: window.innerWidth - rect.width - margin,
        maxY: window.innerHeight - rect.height - margin
      };
    }

    function clampPosition(left, top) {
      const bounds = getBounds();
      return {
        left: Math.max(bounds.minX, Math.min(bounds.maxX, left)),
        top: Math.max(bounds.minY, Math.min(bounds.maxY, top))
      };
    }

    function snapToEdge(left, top) {
      const rect = pip.getBoundingClientRect();
      const snap = 20;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (left < snap) left = 8;
      else if (left + rect.width > vw - snap) left = vw - rect.width - 8;

      if (top < snap) top = 8;
      else if (top + rect.height > vh - snap) top = vh - rect.height - 8;

      return clampPosition(left, top);
    }

    function applyPosition(left, top, animate) {
      pip.style.left = left + 'px';
      pip.style.top = top + 'px';
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
      if (animate) {
        pip.style.transition = 'left 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
        setTimeout(() => { pip.style.transition = ''; }, 280);
      }
    }

    function savePipPosition() {
      const rect = pip.getBoundingClientRect();
      try {
        localStorage.setItem(PIP_POS_KEY, JSON.stringify({
          left: rect.left,
          top: rect.top
        }));
      } catch (e) {}
    }

    function onPointerDown(e) {
      if (e.target.closest('.call-control-btn')) return;
      if (!pip.classList.contains('active')) return;

      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;

      const rect = pip.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      pip.classList.add('dragging');
      pip.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

      const pos = clampPosition(startLeft + dx, startTop + dy);
      applyPosition(pos.left, pos.top, false);
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      pip.classList.remove('dragging');

      try { pip.releasePointerCapture(e.pointerId); } catch (err) {}

      const rect = pip.getBoundingClientRect();
      const snapped = snapToEdge(rect.left, rect.top);
      applyPosition(snapped.left, snapped.top, true);
      savePipPosition();
    }

    pip.addEventListener('pointerdown', onPointerDown);
    pip.addEventListener('pointermove', onPointerMove);
    pip.addEventListener('pointerup', onPointerUp);
    pip.addEventListener('pointercancel', onPointerUp);

    // Prevent accidental click-through after drag on touch devices
    pip.addEventListener('click', (e) => {
      if (moved && !e.target.closest('.call-control-btn')) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    }, true);

    window.addEventListener('resize', () => {
      if (!pip.classList.contains('active')) return;
      const rect = pip.getBoundingClientRect();
      const pos = clampPosition(rect.left, rect.top);
      applyPosition(pos.left, pos.top, false);
    });
  }

  function restorePipPosition(pip) {
    try {
      const saved = JSON.parse(localStorage.getItem(PIP_POS_KEY));
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        pip.style.left = saved.left + 'px';
        pip.style.top = saved.top + 'px';
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
        return;
      }
    } catch (e) {}

    // Default: bottom-right on mobile, top-right on desktop
    if (window.matchMedia('(max-width: 767px)').matches) {
      pip.style.bottom = 'calc(16px + env(safe-area-inset-bottom))';
      pip.style.right = '12px';
      pip.style.top = 'auto';
      pip.style.left = 'auto';
    }
  }

  // ─── Call UI ───
  function updateCallButtonUI() {
    const btn = document.getElementById('call-btn');
    if (isInCall) {
      btn.classList.add('in-call');
      btn.innerHTML = '<i class="ph ph-phone-disconnect"></i><span>End</span>';
    } else {
      btn.classList.remove('in-call');
      btn.innerHTML = '<i class="ph ph-video-camera"></i><span>Call</span>';
    }
  }

  function updateMuteUI() {
    const btn = document.getElementById('mute-btn');
    if (isMuted) {
      btn.innerHTML = '<i class="ph ph-microphone-slash"></i>';
      btn.classList.add('muted');
    } else {
      btn.innerHTML = '<i class="ph ph-microphone"></i>';
      btn.classList.remove('muted');
    }
  }

  function updateCameraUI() {
    const btn = document.getElementById('camera-btn');
    if (isCamOff) {
      btn.innerHTML = '<i class="ph ph-video-camera-slash"></i>';
      btn.classList.add('cam-off');
    } else {
      btn.innerHTML = '<i class="ph ph-video-camera"></i>';
      btn.classList.remove('cam-off');
    }
  }

  // ─── Incoming Call Modal ───
  function showCallModal(callerName, onAccept, onReject) {
    const existing = document.querySelector('.call-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'call-modal-overlay';
    overlay.innerHTML = `
      <div class="call-modal">
        <div class="caller-avatar">📞</div>
        <h3>${escapeHTML(callerName)}</h3>
        <p>wants to video call you</p>
        <div class="call-modal-actions">
          <button class="reject-btn" title="Decline">
            <i class="ph ph-phone-disconnect"></i>
          </button>
          <button class="accept-btn" title="Accept">
            <i class="ph ph-phone"></i>
          </button>
        </div>
      </div>
    `;

    overlay.querySelector('.accept-btn').addEventListener('click', () => {
      overlay.remove();
      onAccept();
    });

    overlay.querySelector('.reject-btn').addEventListener('click', () => {
      overlay.remove();
      onReject();
    });

    document.body.appendChild(overlay);

    // Auto-reject after 30s
    setTimeout(() => {
      if (document.body.contains(overlay)) {
        overlay.remove();
        onReject();
      }
    }, 30000);
  }

  // ═══════════════════════════════════════════════════════
  //  CHAT
  // ═══════════════════════════════════════════════════════

  function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    const msgData = {
      type: 'chat',
      name: userName,
      message: message,
      timestamp: Date.now()
    };

    // Send to partner
    sendData(msgData);

    // Display locally
    displayMessage({
      name: userName,
      message: message,
      timestamp: msgData.timestamp,
      isOwn: true
    });

    input.value = '';
  }

  function displayMessage(data) {
    const chatMessages = document.getElementById('chat-messages');

    // Remove welcome message on first real message
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${data.isOwn ? 'own' : ''}`;

    const time = new Date(data.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });

    msgDiv.innerHTML = `
      <div class="message-header">
        <span class="message-name">${data.isOwn ? 'You' : escapeHTML(data.name)}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-text">${escapeHTML(data.message)}</div>
    `;

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addSystemMessage(text) {
    const chatMessages = document.getElementById('chat-messages');
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = 'system-message';
    msgDiv.textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════
  //  UI HELPERS
  // ═══════════════════════════════════════════════════════

  function updateRoomInfo() {
    document.getElementById('room-code').textContent = roomCode;
    document.title = `CoWatch — Room ${roomCode}`;
    if (window.YTBrowser) {
      YTBrowser.setContext({ roomCode, userName });
    }
  }

  function showRoomWelcome() {
    if (sessionStorage.getItem('cowatch-welcome-dismissed')) return;
    const overlay = document.getElementById('room-welcome');
    if (!overlay) return;
    overlay.classList.remove('hidden');
  }

  function dismissRoomWelcome() {
    sessionStorage.setItem('cowatch-welcome-dismissed', '1');
    document.getElementById('room-welcome')?.classList.add('hidden');
  }

  // ─── Mobile Chat Toggle ───
  function toggleChat() {
    const chatSection = document.getElementById('chat-section');
    const toggleBtn = document.getElementById('chat-toggle-btn');
    if (!chatSection) return;

    isChatVisible = !isChatVisible;
    chatSection.classList.toggle('mobile-hidden', !isChatVisible);

    if (toggleBtn) {
      toggleBtn.classList.remove('has-unread');
      if (isChatVisible) {
        toggleBtn.innerHTML = '<i class="ph ph-x"></i>';
        // Auto-scroll to bottom when opening
        const msgs = document.getElementById('chat-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
        // Focus chat input
        setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
      } else {
        toggleBtn.innerHTML = '<i class="ph ph-chat-dots"></i>';
      }
    }
  }

  function notifyChatUnread() {
    // Only show unread dot if chat is hidden on mobile
    if (isChatVisible) return;
    if (window.innerWidth >= 768) return; // Desktop always shows chat
    const toggleBtn = document.getElementById('chat-toggle-btn');
    if (toggleBtn) toggleBtn.classList.add('has-unread');
  }

  function copyRoomLink() {
    const link = `${window.location.origin}/room.html?room=${roomCode}&name=Guest`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => {
        showNotification('Invite link copied! 📋', 'success');
      }).catch(() => {
        fallbackCopy(link);
      });
    } else {
      fallbackCopy(link);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showNotification('Invite link copied! 📋', 'success');
    } catch (e) {
      showNotification('Failed to copy. Link: ' + text);
    }
    textarea.remove();
  }

  function showNotification(message, type = 'info') {
    const container = document.getElementById('notifications');
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    notif.textContent = message;
    container.appendChild(notif);

    setTimeout(() => {
      notif.classList.add('fade-out');
      setTimeout(() => notif.remove(), 400);
    }, 3500);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ═══════════════════════════════════════════════════════
  //  UI EVENT BINDINGS
  // ═══════════════════════════════════════════════════════

  function initUI() {
    document.getElementById('load-video-btn').addEventListener('click', handleLoadVideo);
    document.getElementById('video-url-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleLoadVideo();
    });

    document.getElementById('browse-btn')?.addEventListener('click', () => YTBrowser.toggle());
    document.getElementById('placeholder-browse-btn')?.addEventListener('click', () => {
      dismissRoomWelcome();
      YTBrowser.open();
    });
    document.getElementById('yt-close-btn')?.addEventListener('click', () => YTBrowser.close());
    document.getElementById('welcome-open-yt')?.addEventListener('click', () => {
      dismissRoomWelcome();
      YTBrowser.open();
    });
    document.getElementById('welcome-skip')?.addEventListener('click', dismissRoomWelcome);

    showRoomWelcome();

    // ── Mobile Chat Toggle ──
    document.getElementById('chat-toggle-btn')?.addEventListener('click', toggleChat);

    // ── Call Controls ──
    document.getElementById('call-btn').addEventListener('click', () => {
      if (isInCall) {
        endCall();
      } else {
        if (!isConnected) {
          showNotification('Wait for your partner to join first!', 'error');
          return;
        }
        startCallRequest();
      }
    });

    document.getElementById('mute-btn').addEventListener('click', toggleMute);
    document.getElementById('camera-btn').addEventListener('click', toggleCamera);
    document.getElementById('end-call-btn').addEventListener('click', endCall);
    document.getElementById('minimize-btn').addEventListener('click', toggleCallMinimization);

    initPipDrag();

    // ── Chat ──
    document.getElementById('send-btn').addEventListener('click', sendChatMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });

    // ── Share Link ──
    document.getElementById('copy-link-btn').addEventListener('click', copyRoomLink);

    // ── Room Info ──
    updateRoomInfo();

    // ── Page visibility: pause sync updates when tab is hidden ──
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && cowatchPlayer && playerReady) {
        lastKnownTime = cowatchPlayer.getCurrentTime();
      }
    });

    // ── Before unload: warn if in active session ──
    window.addEventListener('beforeunload', (e) => {
      if (isConnected || isInCall) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

})();
