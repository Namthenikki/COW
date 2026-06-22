/* ═══════════════════════════════════════════════════════
   CoWatch Room — PeerJS-based P2P Sync + Video Call
   
   Architecture:
   - PeerJS handles signaling via its free cloud server
   - Data Channels carry sync events (play/pause/seek/chat)
   - Media Streams handle video calling
   - YouTube IFrame API controls the player
   - Zero npm dependencies needed
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── State ───
  let peer = null;
  let dataConn = null;
  let mediaCall = null;
  let player = null;
  let playerReady = false;
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

  // WebRTC / Call State
  let localStream = null;
  let isInCall = false;
  let isMuted = false;
  let isCamOff = false;
  let isCallMinimized = false;

  // Connection status
  let isConnected = false;

  // ─── Constants ───
  const PEER_ID_PREFIX = 'cowatch-';
  const DRIFT_THRESHOLD = 1.0;     // seconds before drift correction kicks in
  const SEEK_DETECT_THRESHOLD = 2; // seconds jump to count as a seek
  const STATE_CHANGE_DEBOUNCE = 250; // ms

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
    initYouTubeAPI();
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
      if (isHost && player && playerReady && currentVideoId) {
        setTimeout(() => {
          sendData({
            type: 'sync-state',
            videoId: currentVideoId,
            isPlaying: player.getPlayerState() === 1, // YT.PlayerState.PLAYING
            currentTime: player.getCurrentTime()
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
        loadVideoById(data.videoId);
        showNotification('Partner loaded a video 🎬');
        break;

      case 'sync-play':
        setRemoteAction();
        if (player && playerReady) {
          const drift = Math.abs(player.getCurrentTime() - data.time);
          if (drift > 0.5) player.seekTo(data.time, true);
          player.playVideo();
        }
        break;

      case 'sync-pause':
        setRemoteAction();
        if (player && playerReady) {
          player.seekTo(data.time, true);
          player.pauseVideo();
        }
        break;

      case 'sync-seek':
        setRemoteAction();
        if (player && playerReady) {
          player.seekTo(data.time, true);
        }
        break;

      case 'sync-state':
        // Full state sync (usually on join)
        if (data.videoId) {
          currentVideoId = data.videoId;
          if (player && playerReady) {
            applySyncState(data);
          } else {
            pendingState = data;
          }
        }
        break;

      case 'time-update':
        // Periodic drift correction
        if (player && playerReady && data.isPlaying) {
          try {
            if (player.getPlayerState() === 1) { // PLAYING
              const localTime = player.getCurrentTime();
              const drift = Math.abs(localTime - data.time);
              if (drift > DRIFT_THRESHOLD) {
                setRemoteAction();
                player.seekTo(data.time, true);
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
        showNotification(`${data.name || 'Partner'} is buffering...`);
        break;
    }
  }

  function applySyncState(data) {
    setRemoteAction();
    player.loadVideoById(data.videoId);
    hidePlaceholder();

    setTimeout(() => {
      setRemoteAction();
      if (data.isPlaying) {
        player.seekTo(data.currentTime + 1.5, true); // +1.5s to compensate for load delay
        player.playVideo();
      } else {
        player.seekTo(data.currentTime, true);
        player.pauseVideo();
      }
    }, 1500);
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
    remoteActionTimer = setTimeout(() => {
      isRemoteAction = false;
    }, 800);
  }

  // ═══════════════════════════════════════════════════════
  //  YOUTUBE PLAYER
  // ═══════════════════════════════════════════════════════

  function initYouTubeAPI() {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  // Called by YouTube API when ready
  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('youtube-player', {
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        fs: 1,
        iv_load_policy: 3,
        disablekb: 0
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange
      }
    });
  };

  function onPlayerReady() {
    playerReady = true;
    console.log('🎬 YouTube player ready');

    // Apply any pending state from joining
    if (pendingState) {
      applySyncState(pendingState);
      pendingState = null;
    }
  }

  function onPlayerStateChange(event) {
    if (isRemoteAction) return;

    const now = Date.now();
    if (now - lastStateChangeTime < STATE_CHANGE_DEBOUNCE) return;
    lastStateChangeTime = now;

    const currentTime = player.getCurrentTime();

    switch (event.data) {
      case 1: // YT.PlayerState.PLAYING
        sendData({ type: 'sync-play', time: currentTime });
        break;

      case 2: // YT.PlayerState.PAUSED
        sendData({ type: 'sync-pause', time: currentTime });
        break;

      case 3: // YT.PlayerState.BUFFERING
        // Detect seek
        const timeDiff = Math.abs(currentTime - lastKnownTime);
        if (timeDiff > SEEK_DETECT_THRESHOLD) {
          sendData({ type: 'sync-seek', time: currentTime });
        }
        sendData({ type: 'buffering', name: userName });
        break;
    }

    lastKnownTime = currentTime;
  }

  // ── Periodic time tracking for seek detection + drift correction ──
  setInterval(() => {
    if (!player || !playerReady) return;
    try {
      const state = player.getPlayerState();
      if (state === 1) { // PLAYING
        lastKnownTime = player.getCurrentTime();

        // Send time updates to partner for drift correction
        sendData({
          type: 'time-update',
          time: lastKnownTime,
          isPlaying: true
        });
      }
    } catch (e) { /* player not ready */ }
  }, 4000);

  // ── Video Loading ──
  function loadVideoById(videoId) {
    currentVideoId = videoId;
    if (player && playerReady) {
      player.loadVideoById(videoId);
      hidePlaceholder();
    }
  }

  function extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([^&\s?#]+)/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function handleLoadVideo() {
    const input = document.getElementById('video-url-input');
    const url = input.value.trim();
    if (!url) return;

    const videoId = extractVideoId(url);
    if (!videoId) {
      showNotification('Invalid YouTube URL! Try again.', 'error');
      return;
    }

    setRemoteAction();
    loadVideoById(videoId);
    sendData({ type: 'load-video', videoId });
    input.value = '';
    showNotification('Video loaded! 🎬', 'success');
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
    document.getElementById('local-video-container').classList.add('active');
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
    document.getElementById('local-video-container').classList.remove('active');
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
    // ── Load Video ──
    document.getElementById('load-video-btn').addEventListener('click', handleLoadVideo);
    document.getElementById('video-url-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleLoadVideo();
    });

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
      if (!document.hidden && player && playerReady) {
        // Tab became visible again, re-check time
        lastKnownTime = player.getCurrentTime();
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
