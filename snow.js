(() => {
  const STYLE_ID = 'global-snow-style';
  const LAYER_CLASS = 'snow-layer';
  const BANK_CLASS = 'snow-bank';
  const FLAKE_CLASS = 'snowflake';
  const DEFAULT_FLAKES = 30;
  const MAX_BANK_HEIGHT = 110; // px
  const BANK_CHANCE = 0.35;
  const BANK_INCREMENT_MIN = 0.8;
  const BANK_INCREMENT_MAX = 2.6;

  let bankHeight = 0;
  let bankEl = null;
  let snowActive = false;

  const STYLE_CSS = `
.snow-layer {
  pointer-events: none;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: clamp(160px, 28vh, 320px);
  overflow: hidden;
  z-index: 0;
  display: none;
}
.snow-bank {
  pointer-events: none;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 0;
  z-index: 1;
  transition: height 2.4s ease-out;
  background:
    radial-gradient(circle at 18% 0%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 60%),
    radial-gradient(circle at 72% 0%, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 62%),
    linear-gradient(to top, rgba(243,246,249,0.95) 0%, rgba(243,246,249,0.75) 38%, rgba(243,246,249,0.45) 70%, rgba(243,246,249,0));
  display: none;
}
.snow-layer.is-active, .snow-bank.is-active { display: block; }
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
}
@media (max-width: 640px) {
  .snow-bank {
    display: none;
  }
}
`;

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
      const footer = document.querySelector('.site-footer');
      if (footer && footer.parentNode) {
        footer.parentNode.insertBefore(layer, footer);
      } else {
        document.body.appendChild(layer);
      }
    }
    return layer;
  }

  function ensureBank() {
    if (bankEl && bankEl.isConnected) return bankEl;
    bankEl = document.querySelector(`.${BANK_CLASS}`);
    if (!bankEl) {
      bankEl = document.createElement('div');
      bankEl.className = BANK_CLASS;
      const footer = document.querySelector('.site-footer');
      if (footer && footer.parentNode) {
        footer.parentNode.insertBefore(bankEl, footer);
      } else {
        document.body.appendChild(bankEl);
      }
    }
    bankEl.style.height = '0px';
    return bankEl;
  }

  function randomIncrement() {
    return BANK_INCREMENT_MIN + Math.random() * (BANK_INCREMENT_MAX - BANK_INCREMENT_MIN);
  }

  function maybeGrowBank() {
    if (!bankEl || !snowActive) return;
    if (bankHeight >= MAX_BANK_HEIGHT) return;
    if (Math.random() > BANK_CHANCE) return;
    bankHeight = Math.min(MAX_BANK_HEIGHT, bankHeight + randomIncrement());
    bankEl.style.height = `${bankHeight.toFixed(1)}px`;
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

      flake.addEventListener('animationiteration', maybeGrowBank);
      flake.addEventListener('animationend', maybeGrowBank);

      frag.appendChild(flake);
    }
    layer.appendChild(frag);
    window.setTimeout(maybeGrowBank, 1000);
  }

  function setSnowActive(active) {
    snowActive = !!active;
    const layer = document.querySelector(`.${LAYER_CLASS}`);
    if (layer) layer.classList.toggle('is-active', snowActive);
    if (bankEl) bankEl.classList.toggle('is-active', snowActive);
  }

  function isFooterVisible() {
    const footer = document.querySelector('.site-footer');
    if (!footer) return false;
    const rect = footer.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.top < vh; // any part of footer is visible
  }

  function setupVisibilityObserver() {
    const footer = document.querySelector('.site-footer');
    if (!footer) {
      setSnowActive(false);
      return;
    }
    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          setSnowActive(entry.isIntersecting && entry.intersectionRatio > 0);
        }
      }, { root: null, threshold: [0, 0.05] });
      obs.observe(footer);
    } else {
      const onScroll = () => setSnowActive(isFooterVisible());
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      onScroll();
    }
  }

  function initSnow() {
    injectStyle();
    const layer = ensureLayer();
    bankEl = ensureBank();
    spawnSnow(layer);
    // activate only when footer is visible
    setSnowActive(isFooterVisible());
    setupVisibilityObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSnow, { once: true });
  } else {
    initSnow();
  }
})();
