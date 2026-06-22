/* CoWatch — Ad-Free HTML5 Player with smart pre-buffering */
window.CowatchPlayer = (function () {
  'use strict';

  const BUFFER_RATIO = 0.10;   // always keep 10% ahead
  const BUFFER_MIN_SEC = 15;   // minimum 15s ahead for short videos
  const BUFFER_TIMEOUT = 90000;

  function CowatchPlayer(videoEl, controlsEl) {
    this.video = videoEl;
    this.controls = controlsEl;
    this.ready = false;
    this.currentVideoId = null;
    this.meta = {};
    this._muted = false;
    this._volume = 1;
    this._callbacks = {};
    this._seeking = false;
    this._internal = false;
    this._recovering = false;
    this._hls = null;
    this._bufferWatch = null;
    this._initControls();
    this._bindEvents();
    this._startBufferWatch();
  }

  CowatchPlayer.prototype.on = function (event, fn) {
    (this._callbacks[event] = this._callbacks[event] || []).push(fn);
  };

  CowatchPlayer.prototype._emit = function (event, data) {
    (this._callbacks[event] || []).forEach((fn) => fn(data));
  };

  CowatchPlayer.prototype._initControls = function () {
    if (!this.controls) return;
    this.controls.innerHTML = `
      <div class="cp-progress-wrap" id="cp-progress-wrap">
        <div class="cp-progress-buffer" id="cp-buffer"></div>
        <div class="cp-progress-bar" id="cp-progress"></div>
        <div class="cp-buffer-target" id="cp-buffer-target"></div>
        <input type="range" class="cp-seek" id="cp-seek" min="0" max="1000" value="0" step="1">
      </div>
      <div class="cp-controls-row">
        <button class="cp-btn" id="cp-play" title="Play/Pause"><i class="ph ph-play"></i></button>
        <button class="cp-btn" id="cp-back" title="Back 10s"><i class="ph ph-rewind"></i></button>
        <button class="cp-btn" id="cp-forward" title="Forward 10s"><i class="ph ph-fast-forward"></i></button>
        <span class="cp-time" id="cp-time">0:00 / 0:00</span>
        <div class="cp-spacer"></div>
        <span class="cp-buffer-pct" id="cp-buffer-pct" title="Buffer ahead">⬇ 0%</span>
        <span class="cp-quality" id="cp-quality">HD</span>
        <button class="cp-btn" id="cp-mute" title="Mute"><i class="ph ph-speaker-high"></i></button>
        <input type="range" class="cp-volume" id="cp-volume" min="0" max="100" value="100">
        <button class="cp-btn" id="cp-fs" title="Fullscreen"><i class="ph ph-corners-out"></i></button>
      </div>
    `;

    this.el = {
      play: this.controls.querySelector('#cp-play'),
      back: this.controls.querySelector('#cp-back'),
      forward: this.controls.querySelector('#cp-forward'),
      time: this.controls.querySelector('#cp-time'),
      quality: this.controls.querySelector('#cp-quality'),
      bufferPct: this.controls.querySelector('#cp-buffer-pct'),
      bufferTarget: this.controls.querySelector('#cp-buffer-target'),
      mute: this.controls.querySelector('#cp-mute'),
      volume: this.controls.querySelector('#cp-volume'),
      seek: this.controls.querySelector('#cp-seek'),
      progress: this.controls.querySelector('#cp-progress'),
      buffer: this.controls.querySelector('#cp-buffer'),
      fs: this.controls.querySelector('#cp-fs')
    };

    this.el.play.addEventListener('click', () => this.togglePlay());
    this.el.back.addEventListener('click', () => this.seekBy(-10));
    this.el.forward.addEventListener('click', () => this.seekBy(10));
    this.el.mute.addEventListener('click', () => this.toggleMute());
    this.el.fs.addEventListener('click', () => this.toggleFullscreen());
    this.el.volume.addEventListener('input', (e) => this.setVolume(e.target.value / 100));
    this.el.seek.addEventListener('input', () => { this._seeking = true; });
    this.el.seek.addEventListener('change', () => {
      const t = (this.el.seek.value / 1000) * (this.video.duration || 0);
      this.seekTo(t, false);
      this._seeking = false;
    });
  };

  CowatchPlayer.prototype._bindEvents = function () {
    this.video.addEventListener('loadedmetadata', () => {
      this.ready = true;
      this._updateBufferTargetMarker();
      this._emit('ready');
    });

    this.video.addEventListener('play', () => {
      this._updatePlayBtn(true);
      if (!this._internal) this._emit('play', { time: this.getCurrentTime() });
    });

    this.video.addEventListener('pause', () => {
      this._updatePlayBtn(false);
      if (!this._internal && !this._recovering) {
        this._emit('pause', { time: this.getCurrentTime() });
      }
    });

    this.video.addEventListener('seeked', () => {
      if (!this._internal) this._emit('seeked', { time: this.getCurrentTime() });
    });

    this.video.addEventListener('waiting', () => this._onStall());
    this.video.addEventListener('timeupdate', () => this._updateProgress());
    this.video.addEventListener('ended', () => this._emit('ended'));
    this.video.addEventListener('progress', () => this._updateProgress());
    this.video.addEventListener('click', () => this.togglePlay());
  };

  CowatchPlayer.prototype._bufferTargetSec = function () {
    const dur = this.video.duration || 0;
    if (!dur || !isFinite(dur)) return BUFFER_MIN_SEC;
    return Math.max(BUFFER_MIN_SEC, dur * BUFFER_RATIO);
  };

  CowatchPlayer.prototype.getBufferedAhead = function () {
    const t = this.video.currentTime;
    const buffered = this.video.buffered;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= t + 0.1 && buffered.end(i) > t) {
        return buffered.end(i) - t;
      }
    }
    return 0;
  };

  CowatchPlayer.prototype.isFullyBuffered = function () {
    const dur = this.video.duration;
    if (!dur) return false;
    const buffered = this.video.buffered;
    if (!buffered.length) return false;
    return buffered.end(buffered.length - 1) >= dur - 1;
  };

  CowatchPlayer.prototype.hasEnoughBuffer = function () {
    if (this.isFullyBuffered()) return true;
    return this.getBufferedAhead() >= this._bufferTargetSec();
  };

  CowatchPlayer.prototype.waitForBuffer = function (atTime) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const target = this._bufferTargetSec();

      const tick = () => {
        if (Date.now() - start > BUFFER_TIMEOUT) {
          reject(new Error('Buffer timeout'));
          return;
        }

        if (atTime != null && Math.abs(this.video.currentTime - atTime) > 0.25) {
          this._internal = true;
          this.video.currentTime = atTime;
          this._internal = false;
        }

        if (this.hasEnoughBuffer()) {
          resolve();
          return;
        }

        // Nudge browser to keep downloading
        if (this.video.preload !== 'auto') this.video.preload = 'auto';
        setTimeout(tick, 150);
      };

      tick();
    });
  };

  CowatchPlayer.prototype._onStall = function () {
    if (this._recovering) return;
    this._recovering = true;
    const wasPlaying = !this.video.paused;

    this._internal = true;
    this.video.pause();
    this._internal = false;

    this._emit('stall-recover');

    this.waitForBuffer(this.video.currentTime)
      .then(() => {
        if (wasPlaying) return this.play(true);
      })
      .catch(() => {})
      .finally(() => { this._recovering = false; });
  };

  CowatchPlayer.prototype._startBufferWatch = function () {
    this._bufferWatch = setInterval(() => {
      if (!this.ready || this.video.paused || this._recovering) return;
      const ahead = this.getBufferedAhead();
      const target = this._bufferTargetSec();
      if (ahead < target * 0.5 && !this.isFullyBuffered()) {
        this._onStall();
      }
    }, 500);
  };

  CowatchPlayer.prototype._updateBufferTargetMarker = function () {
    if (!this.el?.bufferTarget) return;
    const dur = this.video.duration || 0;
    if (!dur) return;
    const pct = Math.min(100, (this._bufferTargetSec() / dur) * 100);
    this.el.bufferTarget.style.width = pct + '%';
  };

  CowatchPlayer.prototype._updatePlayBtn = function (playing) {
    if (!this.el?.play) return;
    this.el.play.innerHTML = playing
      ? '<i class="ph ph-pause"></i>'
      : '<i class="ph ph-play"></i>';
  };

  CowatchPlayer.prototype._updateProgress = function () {
    if (!this.el || this._seeking) return;
    const dur = this.video.duration || 0;
    const cur = this.video.currentTime || 0;
    const pct = dur ? (cur / dur) * 100 : 0;
    this.el.progress.style.width = pct + '%';
    this.el.seek.value = dur ? (cur / dur) * 1000 : 0;

    if (this.video.buffered.length) {
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      this.el.buffer.style.width = dur ? (end / dur) * 100 + '%' : '0%';
    }

    const ahead = this.getBufferedAhead();
    const target = this._bufferTargetSec();
    const aheadPct = dur ? Math.round((ahead / dur) * 100) : 0;
    if (this.el.bufferPct) {
      const ok = ahead >= target || this.isFullyBuffered();
      this.el.bufferPct.textContent = `⬇ ${aheadPct}%`;
      this.el.bufferPct.classList.toggle('buffer-ok', ok);
      this.el.bufferPct.classList.toggle('buffer-low', !ok);
    }

    this.el.time.textContent =
      `${PipedClient.formatDuration(cur)} / ${PipedClient.formatDuration(dur)}`;
  };

  CowatchPlayer.prototype.getCurrentTime = function () {
    return this.video.currentTime || 0;
  };

  CowatchPlayer.prototype.getDuration = function () {
    return this.video.duration || 0;
  };

  CowatchPlayer.prototype.isPlaying = function () {
    return !this.video.paused && !this.video.ended;
  };

  CowatchPlayer.prototype.play = async function (skipBufferCheck) {
    if (!skipBufferCheck) {
      await this.waitForBuffer(this.getCurrentTime());
    }
    return this.video.play();
  };

  CowatchPlayer.prototype.pause = function () {
    this.video.pause();
  };

  CowatchPlayer.prototype.togglePlay = async function () {
    if (this.video.paused) {
      await this.play();
    } else {
      this.pause();
    }
  };

  CowatchPlayer.prototype.seekTo = function (time, opts) {
    const options = typeof opts === 'object' ? opts : { silent: opts === true };
    const silent = options.silent || false;
    const waitBuffer = options.waitBuffer !== false;

    const t = Math.max(0, Math.min(time, this.video.duration || time));
    this._internal = true;
    this.video.currentTime = t;
    this._internal = false;

    if (!silent) this._emit('seeked', { time: t });

    if (waitBuffer) {
      this.waitForBuffer(t).then(() => {
        if (!this.video.paused) this.video.play().catch(() => {});
      }).catch(() => {});
    }
  };

  CowatchPlayer.prototype.seekBy = function (delta) {
    this.seekTo(this.getCurrentTime() + delta);
  };

  CowatchPlayer.prototype.setVolume = function (v) {
    this._volume = v;
    this.video.volume = v;
    this._muted = v === 0;
    this._updateMuteBtn();
  };

  CowatchPlayer.prototype.toggleMute = function () {
    this._muted = !this._muted;
    this.video.muted = this._muted;
    this._updateMuteBtn();
  };

  CowatchPlayer.prototype._updateMuteBtn = function () {
    if (!this.el?.mute) return;
    const icon = this._muted || this._volume === 0 ? 'speaker-slash' : 'speaker-high';
    this.el.mute.innerHTML = `<i class="ph ph-${icon}"></i>`;
  };

  CowatchPlayer.prototype.toggleFullscreen = function () {
    const wrapper = this.video.closest('.player-wrapper');
    const el = wrapper || this.video;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  CowatchPlayer.prototype._destroyHls = function () {
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
  };

  CowatchPlayer.prototype._attachSource = function (url, stream) {
    this._destroyHls();

    if (stream.type === 'hls' && window.Hls?.isSupported()) {
      this._hls = new Hls({
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 80 * 1000 * 1000,
        maxBufferHole: 0.5,
        enableWorker: true
      });
      this._hls.loadSource(url);
      this._hls.attachMedia(this.video);
      return 'hls';
    }

    this.video.src = url;
    return 'progressive';
  };

  CowatchPlayer.prototype.loadVideo = async function (videoId, meta = {}) {
    this.ready = false;
    this.currentVideoId = videoId;
    this.meta = meta;
    this._destroyHls();

    const data = await PipedClient.streams(videoId);
    const stream = PipedClient.pickStream(data);

    this.meta = {
      ...meta,
      title: data.title || meta.title,
      uploader: data.uploader || meta.uploader,
      thumbnail: data.thumbnailUrl || meta.thumbnail,
      duration: data.duration,
      views: data.views
    };

    if (this.el?.quality) {
      this.el.quality.textContent = stream.quality || 'HD';
    }

    const urls = [stream.url, stream.proxyUrl].filter(Boolean);

    let lastErr;
    for (const url of urls) {
      try {
        await this._loadUrl(url, stream);
        this._emit('loaded', this.meta);
        return this.meta;
      } catch (e) {
        lastErr = e;
        this.video.removeAttribute('src');
        this.video.load();
      }
    }
    throw lastErr || new Error('Failed to load video stream');
  };

  CowatchPlayer.prototype._loadUrl = function (url, stream) {
    return new Promise((resolve, reject) => {
      const onMeta = async () => {
        cleanup();
        try {
          this.video.preload = 'auto';
          this.video.currentTime = 0;
          await this.waitForBuffer(0);
          this.ready = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      const onErr = () => {
        cleanup();
        reject(new Error('Stream failed'));
      };

      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', onMeta);
        this.video.removeEventListener('error', onErr);
        if (this._hls) {
          this._hls.off(Hls.Events.MANIFEST_PARSED, onMeta);
          this._hls.off(Hls.Events.ERROR, onErr);
        }
      };

      const mode = this._attachSource(url, stream);

      if (mode === 'hls') {
        this._hls.on(Hls.Events.MANIFEST_PARSED, onMeta);
        this._hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) onErr();
        });
      } else {
        this.video.addEventListener('loadedmetadata', onMeta);
        this.video.addEventListener('error', onErr);
        this.video.load();
      }
    });
  };

  return CowatchPlayer;
})();
