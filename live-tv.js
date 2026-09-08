(() => {
  const video = document.getElementById('live-video');
  const status = document.getElementById('stream-status');
  const reloadButton = document.getElementById('reload-stream');
  const streamLink = document.getElementById('stream-link');
  const channelSelect = document.getElementById('channel-select');
  let channelName = '';
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
    const channel = channelSelect.selectedOptions[0];
    const streamUrl = channel.value;
    channelName = channel.textContent;
    document.getElementById('stream-title').textContent = channelName;
    document.getElementById('stream-description').textContent = channel.dataset.description;
    document.getElementById('stream-attribution').textContent = `Stream provided by ${channelName}`;
    video.setAttribute('aria-label', `${channelName} live stream`);
    streamLink.href = streamUrl;
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
      setStatus(video.paused ? 'Ready to watch. Press play to start.' : `Playing ${channelName}.`);
    }
  });
  video.addEventListener('playing', () => {
    if (!failed) setStatus(`Playing ${channelName}.`);
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

  document.getElementById('channel-picker').hidden = false;
  channelSelect.addEventListener('change', startStream);

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
