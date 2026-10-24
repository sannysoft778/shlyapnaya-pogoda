const missingClip = 'Ролик ещё не подключён';
const photoFallback = 'Ролик недоступен — показана осенняя фотография.';

// Only a local, explicitly enabled file can enter the media pipeline.
function clipPath(manifest) {
  const src = manifest?.src;
  return manifest?.enabled === true && typeof src === 'string' &&
    /^(?:[a-z0-9_-]+\/)*[a-z0-9_-][a-z0-9_.-]*\.(mp4|webm)$/i.test(src) ? src : null;
}

export function createPilotPlayer({
  video, decodeImage, render, manifest = {}, initial = 'winter',
  reducedMotion = () => false, isMobile = () => false,
  setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  requestFrame = globalThis.requestAnimationFrame, cancelFrame = globalThis.cancelAnimationFrame
}) {
  const src = clipPath(manifest);
  let current = initial === 'autumn' ? 'autumn' : 'winter';
  let operation = null;
  let navigated = false;
  let stopMedia = () => {};
  let state = { current, still: current, phase: 'idle', videoVisible: false, captionHidden: false,
    error: false, status: src ? 'Готов к пробному перелёту' : missingClip };
  const emit = (changes = {}) => {
    state = { ...state, ...changes, current };
    render({ ...state, nextLabel: state.phase === 'playing' ? 'Пропустить' :
      current === 'autumn' && state.phase === 'idle' ? 'Вы в осени' : 'К осени',
      nextDisabled: current === 'autumn' && state.phase === 'idle',
      resetDisabled: current === 'winter' && state.phase === 'idle' });
  };
  const finish = (id, status) => {
    operation = null;
    current = id;
    // The decoded target is already behind the last video frame before this render hides it.
    emit({ still: id, phase: 'idle', videoVisible: false, captionHidden: false, error: false, status });
    stopMedia();
  };
  const stillStatus = () => src ? 'Показана осенняя фотография.' : missingClip;

  function play(op) {
    const live = () => operation === op;
    const fallback = () => { if (live()) finish('autumn', photoFallback); };
    let loadTimer, progressTimer, videoFrame, animationFrame;
    let lastTime = -1;
    let firstPaintPending = false;
    const listeners = [];
    const on = (name, fn) => {
      video.addEventListener(name, fn);
      listeners.push([name, fn]);
    };
    const watchdog = () => {
      cancel(progressTimer);
      progressTimer = later(fallback, 2000);
    };
    const reveal = () => {
      if (!live()) return;
      cancel(loadTimer);
      if (state.phase !== 'playing') {
        emit({ still: 'autumn', phase: 'playing', videoVisible: true,
          captionHidden: true, status: 'Пробный перелёт: зима → осень' });
      }
      watchdog();
    };
    stopMedia = () => {
      cancel(loadTimer); cancel(progressTimer);
      if (videoFrame != null) video.cancelVideoFrameCallback?.(videoFrame);
      if (animationFrame != null) cancelFrame?.(animationFrame);
      listeners.forEach(([name, fn]) => video.removeEventListener(name, fn));
      video.pause();
      video.removeAttribute('src');
      video.preload = 'none';
      video.load();
      stopMedia = () => {};
    };

    on('error', fallback);
    on('ended', () => {
      if (live()) finish('autumn', state.phase === 'playing' ? 'Перелёт завершён.' : photoFallback);
    });
    // The progress watchdog also bounds waiting/stalled events; those events
    // must not renew their own deadline without a newly displayed frame.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const frame = () => {
        if (!live()) return;
        reveal();
        videoFrame = video.requestVideoFrameCallback(frame);
      };
      videoFrame = video.requestVideoFrameCallback(frame);
    } else {
      // A loaded/playing event alone does not prove a displayed frame. Wait for
      // actual clock progress and two paints on browsers without rVFC.
      const progress = () => {
        if (!live() || video.readyState < 2 || video.currentTime <= 0) return;
        if (state.phase === 'playing') {
          if (video.currentTime !== lastTime) watchdog();
        } else if (!firstPaintPending && typeof requestFrame === 'function') {
          firstPaintPending = true;
          animationFrame = requestFrame(() => {
            if (!live()) return;
            animationFrame = requestFrame(() => { if (live()) reveal(); });
          });
        }
        lastTime = video.currentTime;
      };
      on('playing', progress);
      on('timeupdate', progress);
    }
    loadTimer = later(fallback, 500);
    try {
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = src;
      video.load();
      Promise.resolve(video.play()).catch(fallback);
    } catch {
      fallback();
    }
  }

  function begin(id, animate) {
    navigated = true;
    stopMedia();
    const op = { id, decoded: false, skip: false };
    operation = op;
    emit({ still: current, phase: 'loading', videoVisible: false, captionHidden: false,
      error: false, status: 'Подготавливаем фотографию…' });
    Promise.resolve().then(() => decodeImage(id)).then(() => {
      if (operation !== op) return;
      op.decoded = true;
      const allowed = animate && !op.skip && src && !reducedMotion() &&
        (!isMobile() || manifest.mobile_ready === true);
      if (allowed) {
        emit({ status: 'Подготавливаем ролик…' });
        play(op);
      } else {
        const status = id === 'winter' ? (src ? 'Готов к пробному перелёту' : missingClip) :
          !src ? missingClip : isMobile() && manifest.mobile_ready !== true ?
            'На телефоне показана фотография: кадрирование ролика ещё не проверено.' : stillStatus();
        finish(id, status);
      }
    }).catch(() => {
      if (operation !== op) return;
      operation = null;
      emit({ still: current, phase: 'idle', videoVisible: false, captionHidden: false,
        error: true, status: 'Фотография не загрузилась. Текущий сезон сохранён.' });
    });
  }
  const skip = () => {
    if (!operation) return;
    operation.skip = true;
    if (operation.decoded) finish(operation.id, stillStatus());
  };
  const go = (id) => {
    if (id !== 'winter' && id !== 'autumn') return;
    navigated = true;
    if (id === current) {
      operation = null;
      stopMedia();
      emit({ still: current, phase: 'idle', videoVisible: false, captionHidden: false,
        error: false, status: src ? 'Готов к пробному перелёту' : missingClip });
    } else begin(id, false);
  };
  emit();
  const firstStill = current;
  Promise.resolve().then(() => decodeImage(firstStill)).catch(() => {
    if (!navigated) emit({ error: true,
      status: 'Фотография не загрузилась. Выберите другой сезон или обновите страницу.' });
  });
  return {
    next({ keyboard = false } = {}) {
      if (operation) { if (keyboard || state.phase === 'playing') skip(); return; }
      if (current === 'winter') begin('autumn', !keyboard);
    },
    go,
    skip,
    reset: () => go('winter')
  };
}


export function bindPilotControls({ player, next, reset, links, document, window }) {
  const instant = (on = true) => document.documentElement?.classList.toggle('is-instant', on);
  next.addEventListener('click', (event) => {
    instant(event.detail === 0);
    player.next({ keyboard: event.detail === 0 });
  });
  reset.addEventListener('click', () => { instant(); player.reset(); });
  links.forEach((link) => link.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    instant();
    player.go(link.hash.slice(1));
  }));
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
      event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const action = {
      ArrowRight: () => player.next({ keyboard: true }),
      Escape: () => player.skip()
    }[event.key];
    if (action) { event.preventDefault(); instant(); action(); }
  });
  window.addEventListener('hashchange', () => { instant(); player.go(window.location.hash.slice(1)); });
  window.addEventListener('pagehide', () => player.skip());
}


async function mountPilot() {
  const root = document.documentElement;
  const stage = document.querySelector('.stage');
  const video = document.querySelector('.pilot-video');
  const shade = document.querySelector('.pilot-video-shade');
  const copy = document.querySelector('.pilot-copy');
  const status = document.querySelector('.pilot-status');
  const announcement = document.querySelector('.status');
  const next = document.querySelector('.next');
  const reset = document.querySelector('.pilot-reset');
  const links = [...document.querySelectorAll('.season-nav__link')];
  const scenes = new Map(['winter', 'autumn'].map((id) => [id, document.getElementById(id)]));
  if (!stage || !video || !copy || !status || !next || !reset) return;

  let manifest = {};
  const abort = new AbortController();
  const manifestTimer = setTimeout(() => abort.abort(), 2000);
  try {
    const response = await fetch('assets/transitions/pilot-clip.json', { cache: 'no-store', signal: abort.signal });
    if (response.ok) manifest = await response.json();
  } catch { /* A missing manifest is an honest still-only pilot. */ }
  clearTimeout(manifestTimer);

  const decoded = new Map();
  const decodeImage = (id) => {
    if (!decoded.has(id)) {
      const image = scenes.get(id).querySelector('.scene__img');
      decoded.set(id, (async () => {
        if (image.decode) await image.decode();
        else if (!image.complete) await new Promise((resolve, reject) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', reject, { once: true });
        });
        if (!image.naturalWidth) throw new Error('Still unavailable');
        scenes.get(id).classList.remove('is-unavailable');
      })().catch((error) => {
        scenes.get(id).classList.add('is-unavailable');
        decoded.delete(id);
        throw error;
      }));
    }
    return decoded.get(id);
  };
  const captions = {
    winter: ['01 / Зима', 'Пойдём по снегу', 'Тёмно-синяя вязаная шапка-клош с\u00a0молочными цветами.'],
    autumn: ['02 / Осень', 'Пойдём длинной дорогой', 'Фетровый клош кирпично-красного цвета.']
  };
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const phone = window.matchMedia('(max-width: 700px), (max-aspect-ratio: 4/5)');
  const initial = location.hash === '#autumn' ? 'autumn' : 'winter';
  let lastCurrent = initial;
  let lastPhase = 'idle';
  const player = createPilotPlayer({
    video, manifest, initial, decodeImage,
    reducedMotion: () => motion.matches,
    isMobile: () => phone.matches,
    render(state) {
      scenes.forEach((scene, id) => {
        scene.classList.toggle('is-active', id === state.still);
        scene.toggleAttribute('inert', id !== state.current || state.phase === 'playing');
      });
      video.classList.toggle('is-visible', state.videoVisible);
      shade.classList.toggle('is-visible', state.videoVisible);
      copy.classList.toggle('is-hidden', state.captionHidden);
      copy.setAttribute('aria-hidden', String(state.captionHidden));
      const [mood, title, text] = captions[state.current];
      copy.querySelector('.scene__mood').textContent = mood;
      copy.querySelector('.scene__title').textContent = title;
      copy.querySelector('.scene__text').textContent = text;
      next.querySelector('.next__label').textContent = state.nextLabel;
      // aria-disabled keeps the active control focused when a flight settles.
      next.setAttribute('aria-disabled', String(state.nextDisabled));
      reset.setAttribute('aria-disabled', String(state.resetDisabled));
      status.textContent = state.status;
      status.classList.toggle('is-error', state.error);
      stage.dataset.phase = state.phase;
      links.forEach((link) => {
        if (link.hash === '#' + state.current) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
      if (state.phase === 'idle') {
        if (state.error) announcement.textContent = state.status;
        else if (state.current !== lastCurrent || lastPhase !== 'idle') {
          announcement.textContent = mood + '. ' + title;
        }
        if (location.hash !== '#' + state.current) history.replaceState(null, '', '#' + state.current);
      }
      lastCurrent = state.current;
      lastPhase = state.phase;
    }
  });
  bindPilotControls({ player, next, reset, links, document, window });
  motion.addEventListener('change', () => { if (motion.matches) player.skip(); });
  phone.addEventListener('change', () => { if (phone.matches && manifest.mobile_ready !== true) player.skip(); });
  root.classList.add('is-ready', 'is-instant');

  // Keep the existing photo composition when text grows or a phone is short.
  const title = document.querySelector('.title');
  const header = document.querySelector('.site-top');
  const nav = document.querySelector('.season-nav');
  let pending = false;
  const fit = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const top = stage.getBoundingClientRect().top;
      root.style.setProperty('--title-reserve-top', Math.ceil(header.getBoundingClientRect().bottom - top + 12) + 'px');
      root.style.setProperty('--copy-reserve', Math.ceil(nav.getBoundingClientRect().height +
        (parseFloat(getComputedStyle(nav).bottom) || 0) + 24) + 'px');
      const minimum = parseFloat(getComputedStyle(root).getPropertyValue('--minimum-scene-height')) || 560;
      stage.style.minHeight = Math.ceil(Math.max(minimum, title.getBoundingClientRect().bottom - top +
        48 + copy.getBoundingClientRect().height + (parseFloat(getComputedStyle(copy).bottom) || 0))) + 'px';
    });
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(fit);
    [header, title, copy, nav].forEach((node) => observer.observe(node));
  }
  window.addEventListener('resize', fit);
  document.fonts?.ready?.then(fit);
  fit();
}

if (typeof document !== 'undefined') mountPilot();
