/* CoWatch — Normal YouTube iframe player */
window.CowatchPlayer = (function () {
  'use strict';

  let apiReadyPromise = null;

  function loadYouTubeAPI() {
    if (window.YT?.Player) return Promise.resolve();
    if (apiReadyPromise) return apiReadyPromise;

    apiReadyPromise = new Promise((resolve) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof previousReady === 'function') previousReady();
        resolve();
      };

      const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (!existing) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    });

    return apiReadyPromise;
  }

  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function CowatchPlayer(videoEl, controlsEl) {
    this.video = videoEl;
    this.controls = controlsEl;
    this.ready = false;
    this.currentVideoId = null;
    this.meta = {};
    this._callbacks = {};
    this._internal = false;
    this._player = null;
    this._playerReady = false;
    this._lastState = null;
    this._progressTimer = null;

    this._mount();
    this._init();
  }

  CowatchPlayer.prototype._mount = function () {
    const wrapper = this.video.closest('.player-wrapper') || this.video.parentElement;
    this.host = document.createElement('div');
    this.host.id = 'youtube-player-' + Math.random().toString(36).slice(2);
    this.host.className = 'youtube-player-frame';
    this.video.style.display = 'none';
    this.video.insertAdjacentElement('afterend', this.host);

    if (this.controls) {
      this.controls.innerHTML = '';
      this.controls.style.display = 'none';
    }

    if (wrapper) wrapper.classList.add('uses-youtube-player');
  };

  CowatchPlayer.prototype._init = function () {
    this._readyPromise = loadYouTubeAPI().then(() => new Promise((resolve) => {
      this._player = new YT.Player(this.host.id, {
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            this._playerReady = true;
            resolve();
          },
          onStateChange: (event) => this._handleState(event.data),
          onError: () => this._emit('error')
        }
      });
    }));
  };

  CowatchPlayer.prototype.on = function (event, fn) {
    (this._callbacks[event] = this._callbacks[event] || []).push(fn);
  };

  CowatchPlayer.prototype._emit = function (event, data) {
    (this._callbacks[event] || []).forEach((fn) => fn(data));
  };

  CowatchPlayer.prototype._handleState = function (state) {
    this._lastState = state;
    if (state === YT.PlayerState.CUED) {
      this.ready = true;
      this._emit('ready');
      this._emit('loaded', this.meta);
      return;
    }

    if (this._internal) return;

    if (state === YT.PlayerState.PLAYING) {
      this._emit('play', { time: this.getCurrentTime() });
    } else if (state === YT.PlayerState.PAUSED) {
      this._emit('pause', { time: this.getCurrentTime() });
    } else if (state === YT.PlayerState.ENDED) {
      this._emit('ended');
    }
  };

  CowatchPlayer.prototype._updateProgress = function () {
    if (!this._playerReady) return;
    const duration = this.getDuration();
    const current = this.getCurrentTime();
    const time = document.getElementById('cp-time');
    if (time) time.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
  };

  CowatchPlayer.prototype.loadVideo = async function (videoId, meta = {}) {
    await this._readyPromise;

    this.currentVideoId = videoId;
    this.meta = {
      title: meta.title || 'YouTube video',
      uploader: meta.uploader || '',
      thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: meta.duration || 0,
      ...meta
    };
    this.ready = false;

    this._internal = true;
    this._player.cueVideoById(videoId);
    setTimeout(() => { this._internal = false; }, 250);

    clearInterval(this._progressTimer);
    this._progressTimer = setInterval(() => this._updateProgress(), 1000);

    this.ready = true;
    this._emit('ready');
    this._emit('loaded', this.meta);
    return this.meta;
  };

  CowatchPlayer.prototype.getCurrentTime = function () {
    if (!this._playerReady) return 0;
    return this._player.getCurrentTime() || 0;
  };

  CowatchPlayer.prototype.getDuration = function () {
    if (!this._playerReady) return 0;
    return this._player.getDuration() || 0;
  };

  CowatchPlayer.prototype.isPlaying = function () {
    return this._lastState === YT.PlayerState.PLAYING;
  };

  CowatchPlayer.prototype.play = async function () {
    await this._readyPromise;
    this._player.playVideo();
  };

  CowatchPlayer.prototype.pause = function () {
    if (this._playerReady) this._player.pauseVideo();
  };

  CowatchPlayer.prototype.togglePlay = async function () {
    if (this.isPlaying()) this.pause();
    else await this.play();
  };

  CowatchPlayer.prototype.seekTo = function (time, opts) {
    if (!this._playerReady) return;
    const options = typeof opts === 'object' ? opts : { silent: opts === true };
    const t = Math.max(0, Math.min(time, this.getDuration() || time));

    this._internal = !!options.silent;
    this._player.seekTo(t, true);
    setTimeout(() => { this._internal = false; }, 250);

    if (!options.silent) this._emit('seeked', { time: t });
  };

  CowatchPlayer.prototype.seekBy = function (delta) {
    this.seekTo(this.getCurrentTime() + delta);
  };

  CowatchPlayer.prototype.setVolume = function (v) {
    if (this._playerReady) this._player.setVolume(Math.round(v * 100));
  };

  CowatchPlayer.prototype.toggleMute = function () {
    if (!this._playerReady) return;
    if (this._player.isMuted()) this._player.unMute();
    else this._player.mute();
  };

  CowatchPlayer.prototype.toggleFullscreen = function () {
    const iframe = this.host.querySelector('iframe');
    const el = iframe || this.host;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  return CowatchPlayer;
})();
