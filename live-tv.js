(() => {
  const video = document.getElementById('live-video');
  const status = document.getElementById('stream-status');
  const reloadButton = document.getElementById('reload-stream');
  const streamUrl = document.getElementById('stream-link').href;
  let hls = null;
  let failed = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function destroyPlayer() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function showError(message) {
    failed = true;
    destroyPlayer();
    setStatus(message, true);
  }

  function startStream() {
    destroyPlayer();
    failed = false;
    reloadButton.hidden = false;
    setStatus('Loading stream…');

    // Prefer HLS.js; use native HLS on browsers without MediaSource support.
    // https://github.com/video-dev/hls.js#using-hlsjs
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ backBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // HLS.js handles transient errors and retries before reporting a fatal error.
        if (data.fatal) {
          showError('The stream is unavailable right now. Try reloading the stream.');
        }
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.load();
    } else if (!window.Hls) {
      showError('The video player could not load. Check your connection and try reloading the stream.');
    } else {
      showError('This browser cannot play the stream. Open the stream directly in a compatible player.');
      reloadButton.hidden = true;
    }
  }

  video.addEventListener('canplay', () => {
    if (!failed) {
      setStatus(video.paused ? 'Ready to watch. Press play to start.' : 'Playing FOX 2 Detroit.');
    }
  });
  video.addEventListener('playing', () => {
    if (!failed) setStatus('Playing FOX 2 Detroit.');
  });
  video.addEventListener('pause', () => {
    if (!failed && video.readyState > 0) setStatus('Paused. Press play to resume.');
  });
  video.addEventListener('waiting', () => {
    if (!failed) setStatus('Buffering stream…');
  });
  video.addEventListener('ended', () => {
    if (!failed) setStatus('The stream has ended. Reload to reconnect.');
  });
  video.addEventListener('error', () => {
    // Let HLS.js handle media errors when it owns playback.
    if (!hls && !failed) {
      showError('The stream could not be played. Try reloading the stream.');
    }
  });

  reloadButton.addEventListener('click', () => {
    if (!window.Hls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      // Retry the CDN script as well if it failed to load.
      window.location.reload();
    } else {
      startStream();
    }
  });

  window.addEventListener('pagehide', destroyPlayer);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) startStream();
  });

  startStream();
})();
