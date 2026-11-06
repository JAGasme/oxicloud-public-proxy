(function () {
  'use strict';

  document.querySelectorAll('.card-thumb img').forEach(function (img) {
    img.addEventListener('error', function () {
      if (img.dataset.retried === '1') return;
      img.dataset.retried = '1';
      const original = img.src;
      setTimeout(function () {
        const sep = original.indexOf('?') === -1 ? '?' : '&';
        img.src = original + sep + '_r=' + Date.now();
      }, 250);
    });
  });

  function startVideoPoster(v) {
    v.addEventListener('loadedmetadata', function () {
      const t = Math.min(0.1, (v.duration || 1) * 0.1);
      try { v.currentTime = t; } catch (_) { /* unsupported */ }
    }, { once: true });
    v.addEventListener('error', function () {
      if (v.dataset.retried === '1') return;
      v.dataset.retried = '1';
      const original = v.dataset.lazySrc;
      setTimeout(function () {
        const sep = original.indexOf('?') === -1 ? '?' : '&';
        v.src = original + sep + '_r=' + Date.now();
      }, 250);
    }, { once: true });
    v.src = v.dataset.lazySrc;
  }

  const lazyVideos = document.querySelectorAll('.card-thumb video[data-lazy-src]');
  if ('IntersectionObserver' in window && lazyVideos.length > 0) {
    const obs = new IntersectionObserver(function (entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const v = e.target;
        if (v.dataset.lazySrc && !v.src) startVideoPoster(v);
        obs.unobserve(v);
      }
    }, { rootMargin: '300px' });
    lazyVideos.forEach(function (v) { obs.observe(v); });
  } else {
    lazyVideos.forEach(startVideoPoster);
  }

  const VIEW_KEY = 'oxiproxy.view';
  const body = document.body;
  const buttons = document.querySelectorAll('.view-toggle button');

  function setView(v) {
    if (v !== 'grid' && v !== 'list') v = 'grid';
    body.dataset.view = v;
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.view === v));
    });
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* sandbox */ }
  }

  let initialView = 'grid';
  try { initialView = localStorage.getItem(VIEW_KEY) || 'grid'; } catch (e) { /* sandbox */ }
  setView(initialView);
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); });
  });

  const lightbox = document.getElementById('lightbox');
  const lbContent = document.getElementById('lb-content');
  const lbTitle = document.getElementById('lb-title');
  const lbDownload = document.getElementById('lb-download');
  const lbClose = document.getElementById('lb-close');
  const lbPrev = document.getElementById('lb-prev');
  const lbNext = document.getElementById('lb-next');

  const mediaCards = Array.prototype.filter.call(
    document.querySelectorAll('.card-link[data-mediakind]'),
    function (el) { return el.dataset.mediakind === 'image' || el.dataset.mediakind === 'video'; }
  );
  const mediaItems = mediaCards.map(function (el) {
    return {
      kind: el.dataset.mediakind,
      src: el.dataset.src,
      name: el.dataset.name,
      mime: el.dataset.mime,
    };
  });

  let currentIndex = -1;

  function openAt(i) {
    if (i < 0 || i >= mediaItems.length) return;
    currentIndex = i;
    const item = mediaItems[i];
    lbContent.innerHTML = '';
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = item.src;
      img.alt = item.name;
      lbContent.appendChild(img);
    } else {
      const vid = document.createElement('video');
      vid.src = item.src;
      vid.controls = true;
      vid.autoplay = true;
      vid.preload = 'metadata';
      lbContent.appendChild(vid);
    }
    lbTitle.textContent = item.name;
    lbDownload.href = item.src;
    lbDownload.setAttribute('download', item.name);
    lbPrev.disabled = i === 0;
    lbNext.disabled = i === mediaItems.length - 1;
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  }
  function close() {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
    lbContent.innerHTML = '';
    currentIndex = -1;
  }
  function step(delta) {
    const next = currentIndex + delta;
    if (next >= 0 && next < mediaItems.length) openAt(next);
  }

  mediaCards.forEach(function (el, i) {
    el.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openAt(i);
    });
  });

  lbClose.addEventListener('click', close);
  lbPrev.addEventListener('click', function () { step(-1); });
  lbNext.addEventListener('click', function () { step(1); });
  lightbox.addEventListener('click', function (e) {
    if (e.target === lightbox) close();
  });
  document.addEventListener('keydown', function (e) {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
})();
