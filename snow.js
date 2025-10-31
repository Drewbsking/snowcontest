(() => {
  const STYLE_ID = 'global-snow-style';
  const LAYER_CLASS = 'snow-layer';
  const FLAKE_CLASS = 'snowflake';
  const DEFAULT_FLAKES = 30;

  const STYLE_CSS = `
.snow-layer {
  pointer-events: none;
  position: fixed;
  inset: 0;
  overflow: hidden;
  z-index: 0;
}
.snowflake {
  position: absolute;
  top: -10px;
  color: rgba(226,232,240,0.7);
  font-size: 0.6rem;
  line-height: 1;
  user-select: none;
  animation-name: fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  filter: blur(0.5px);
  text-shadow:
    0 0 6px rgba(226,232,240,0.4),
    0 0 12px rgba(226,232,240,0.2);
}
@keyframes fall {
  0% {
    transform: translate3d(var(--x, 0vw), -10px, 0) rotate(0deg);
    opacity: var(--o, 0.7);
  }
  100% {
    transform: translate3d(var(--x-end, 0vw), 110vh, 0) rotate(360deg);
    opacity: 0;
  }
}
@media (max-width: 480px) {
  .snow-layer {
    display: none;
  }
}`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  function ensureLayer() {
    let layer = document.querySelector(`.${LAYER_CLASS}`);
    if (!layer) {
      layer = document.createElement('div');
      layer.className = LAYER_CLASS;
      layer.setAttribute('aria-hidden', 'true');
      document.body.prepend(layer);
    }
    return layer;
  }

  function spawnSnow(layer) {
    if (!layer || layer.dataset.snowInitialized === '1') return;
    layer.dataset.snowInitialized = '1';
    const flakeCount = Number(layer.dataset.flakes) || DEFAULT_FLAKES;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < flakeCount; i += 1) {
      const flake = document.createElement('div');
      flake.className = FLAKE_CLASS;
      flake.textContent = '✻';

      const startX = Math.random() * 100;
      const drift = Math.random() * 10 - 5;
      const opacity = (0.4 + Math.random() * 0.4).toFixed(2);
      const size = (0.4 + Math.random() * 0.6).toFixed(2);
      const duration = (8 + Math.random() * 8).toFixed(2);
      const delay = (Math.random() * 8).toFixed(2);

      flake.style.left = `${startX}vw`;
      flake.style.setProperty('--x', '0vw');
      flake.style.setProperty('--x-end', `${drift}vw`);
      flake.style.setProperty('--o', opacity);
      flake.style.fontSize = `${size}rem`;
      flake.style.animationDuration = `${duration}s`;
      flake.style.animationDelay = `${delay}s`;

      frag.appendChild(flake);
    }
    layer.appendChild(frag);
  }

  function initSnow() {
    injectStyle();
    const layer = ensureLayer();
    spawnSnow(layer);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSnow, { once: true });
  } else {
    initSnow();
  }
})();
