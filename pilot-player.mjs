import { createFlightAudio } from './pilot-audio.mjs';

const missingClip = 'Ролик ещё не подключён';
const photoFallback = 'Ролик недоступен — показана осенняя фотография.';
const scrubFailure = 'Ролик не загрузился. Нажмите «К осени», чтобы открыть фотографию.';
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function clipPath(manifest) {
  const src = manifest?.src;
  return manifest?.enabled === true && typeof src === 'string' &&
    /^(?:[a-z0-9_-]+\/)*[a-z0-9_-][a-z0-9_.-]*\.(mp4|webm)$/i.test(src) ? src : null;
}

export function createPilotPlayer({
  video, decodeImage, render, manifest = {}, initial = 'winter', onMotionChange = () => {},
  reducedMotion = () => false, isMobile = () => false,
  setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  requestFrame = globalThis.requestAnimationFrame, cancelFrame = globalThis.cancelAnimationFrame
}) {
  const src = clipPath(manifest);
  let current = initial === 'autumn' ? 'autumn' : 'winter';
  let operation = null, navigated = false, clipFailed = false;
  let stopMedia = () => {};
  let lastMotion, snapshot;
  let state = { current, still: current, phase: 'idle', mode: 'still', progress: current === 'autumn' ? 1 : 0,
    time: 0, duration: 0, moving: false, videoVisible: false, captionHidden: false,
    error: false, status: src ? 'Готов к пробному перелёту' : missingClip };
  const emit = (changes = {}) => {
    state = { ...state, ...changes, current };
    snapshot = Object.freeze({ ...state,
      nextLabel: state.mode === 'auto' && state.phase === 'playing' ? 'Пропустить' :
        state.mode === 'scrub' && state.videoVisible && !state.error ? 'Продолжить полёт' :
        current === 'autumn' && state.phase === 'idle' ? 'Вы в осени' : 'К осени',
      nextDisabled: current === 'autumn' && state.phase === 'idle',
      resetDisabled: current === 'winter' && state.phase === 'idle' && !clipFailed });
    render(snapshot);
    if (lastMotion !== state.moving) { lastMotion = state.moving; onMotionChange(state.moving); }
  };
  const allowed = () => src && !clipFailed && !reducedMotion() && (!isMobile() || manifest.mobile_ready === true);
  const stillStatus = () => src ? 'Показана осенняя фотография.' : missingClip;
  const finish = (id, status) => {
    operation = null; current = id;
    emit({ still: id, phase: 'idle', mode: 'still', moving: false, progress: id === 'autumn' ? 1 : 0,
      time: id === 'autumn' ? state.duration : 0, videoVisible: false, captionHidden: false, error: false, status });
    stopMedia();
  };

  function load(op) {
    const live = () => operation === op && !op.failed;
    let loadTimer, progressTimer, quietTimer, videoFrame, paintFrame, seekFrame;
    let lastTime = -1, appliedTime = -1, seekInFlight = false, metadata = false, inputActive = false;
    const listeners = [];
    const on = (name, fn) => { video.addEventListener(name, fn); listeners.push([name, fn]); };
    const clearTimers = () => { cancel(loadTimer); cancel(progressTimer); cancel(quietTimer); };
    const clearFrames = () => {
      if (videoFrame != null) video.cancelVideoFrameCallback?.(videoFrame);
      if (paintFrame != null) cancelFrame?.(paintFrame);
      if (seekFrame != null) cancelFrame?.(seekFrame);
      videoFrame = paintFrame = seekFrame = null;
    };
    const fail = () => {
      if (!live()) return;
      if (op.mode === 'auto') { finish('autumn', photoFallback); return; }
      clipFailed = true; clearTimers(); clearFrames(); video.pause();
      if (state.videoVisible) {
        op.failed = true;
        emit({ phase: 'scrubbing', mode: 'scrub', moving: false, error: true,
          status: 'Ролик остановился. Нажмите «К осени», чтобы открыть фотографию.' });
      } else {
        operation = null;
        emit({ phase: 'idle', mode: 'still', still: current, progress: 0, moving: false,
          videoVisible: false, captionHidden: false, error: true, status: scrubFailure });
        stopMedia();
      }
    };
    const watchdog = () => { cancel(progressTimer); progressTimer = later(fail, 2000); };
    const desiredTime = () => clamp(op.targetProgress * video.duration, 0, video.duration);
    const seekTime = () => Math.min(desiredTime(), Math.max(0, video.duration - 1 / 30));
    const canSeek = (time) => {
      const ranges = video.seekable;
      if (!ranges) return false;
      for (let index = 0; index < ranges.length; index++) {
        if (time >= ranges.start(index) && time <= ranges.end(index)) return true;
      }
      return false;
    };
    const displayed = (time = video.currentTime) => {
      if (!live()) return;
      // A superseded seek must not update progress or reveal the source prematurely.
      if (op.mode === 'scrub' && metadata && Math.abs(time - seekTime()) > .08) return;
      cancel(loadTimer);
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (op.mode === 'scrub' && metadata && op.targetProgress >= 1 && time >= video.duration - 1 / 30 - .02) {
        finish('autumn', 'Перелёт завершён.'); return;
      }
      if (op.mode === 'scrub' && time > state.time + .001) quiet();
      emit({ still: 'autumn', phase: op.mode === 'auto' ? 'playing' : 'scrubbing', mode: op.mode,
        time, duration, progress: duration > 0 ? clamp(time / duration, 0, 1) : 0,
        videoVisible: true, captionHidden: true, moving: op.mode === 'auto' || inputActive,
        status: op.mode === 'auto' ? 'Пробный перелёт: зима → осень' : 'Камера под вашим управлением.' });
      if (op.mode === 'auto') watchdog();
      else if (!seekInFlight && !video.seeking) { cancel(progressTimer); progressTimer = null; }
      else if (progressTimer == null) watchdog();
    };
    const watchFrame = () => {
      if (!live() || videoFrame != null || typeof video.requestVideoFrameCallback !== 'function') return;
      videoFrame = video.requestVideoFrameCallback((_now, frame) => {
        videoFrame = null;
        displayed(frame?.mediaTime ?? video.currentTime);
        if (live() && (op.mode === 'auto' || metadata && Math.abs((frame?.mediaTime ?? video.currentTime) - seekTime()) > .08)) watchFrame();
      });
    };
    const paintDisplayed = () => {
      if (typeof requestFrame !== 'function' || paintFrame != null) return;
      paintFrame = requestFrame(() => {
        if (!live()) return;
        paintFrame = requestFrame(() => { paintFrame = null; if (live()) displayed(); });
      });
    };
    const applySeek = () => {
      if (!live() || !metadata || seekInFlight || video.seeking || op.mode !== 'scrub') return;
      const target = seekTime();
      // A metadata-only source may have no seekable ranges. The native seek
      // then silently aborts without seeked; do not acquire our lock yet.
      if (!canSeek(target) || Math.abs(appliedTime - target) < .001) return;
      appliedTime = target; seekInFlight = true;
      if (state.videoVisible && progressTimer == null) watchdog();
      watchFrame();
      try { video.currentTime = target; } catch { fail(); }
    };
    const scheduleSeek = () => {
      if (!live() || !metadata || seekFrame != null || seekInFlight || video.seeking) return;
      if (typeof requestFrame !== 'function') { applySeek(); return; }
      seekFrame = requestFrame(() => { seekFrame = null; applySeek(); });
    };
    const quiet = () => {
      inputActive = true; cancel(quietTimer);
      quietTimer = later(() => {
        inputActive = false;
        if (live() && op.mode === 'scrub') emit({ moving: false });
      }, 120);
    };
    const auto = () => {
      if (!live()) return;
      cancel(quietTimer); cancel(progressTimer); progressTimer = null;
      if (seekFrame != null) cancelFrame?.(seekFrame);
      seekFrame = null;
      emit({ mode: 'auto', phase: state.videoVisible ? 'playing' : 'loading', moving: false,
        status: 'Продолжаем полёт к осени.' });
      // The latest requested wheel position is retained even if metadata arrives later.
      if (op.targetProgress > 0) {
        if (!metadata || !canSeek(seekTime())) return;
        try { if (Math.abs(video.currentTime - seekTime()) > .001) video.currentTime = seekTime(); }
        catch { fail(); return; }
      }
      watchFrame();
      cancel(loadTimer); loadTimer = later(fail, state.videoVisible ? 2000 : 500);
      try { Promise.resolve(video.play()).catch(() => { if (live() && op.mode === 'auto') fail(); }); }
      catch { fail(); }
    };
    op.media = {
      auto,
      wheel(delta) {
        if (!live()) return;
        if (op.mode === 'auto') {
          video.pause(); op.mode = 'scrub';
          op.targetProgress = metadata ? clamp(video.currentTime / video.duration, 0, 1) : 0;
          cancel(progressTimer); progressTimer = null;
          if (!state.videoVisible) { cancel(loadTimer); loadTimer = later(fail, 2000); }
          emit({ mode: 'scrub', phase: state.videoVisible ? 'scrubbing' : 'loading', moving: false });
        }
        if (delta > 0) {
          op.targetProgress = clamp(op.targetProgress + delta / 1800, 0, 1);
          scheduleSeek();
        }
      }
    };
    stopMedia = () => {
      clearTimers(); clearFrames();
      listeners.forEach(([name, fn]) => video.removeEventListener(name, fn));
      video.pause(); video.removeAttribute('src'); video.preload = 'none'; video.load();
      stopMedia = () => {};
    };
    on('error', fail);
    on('loadedmetadata', () => {
      if (!live() || !Number.isFinite(video.duration) || video.duration <= 0) return;
      metadata = true; emit({ duration: video.duration });
      if (op.mode === 'scrub') scheduleSeek(); else if (op.targetProgress > 0) auto();
    });
    for (const event of ['loadeddata', 'canplay', 'progress']) on(event, () => {
      if (!live() || !metadata) return;
      if (op.mode === 'scrub') scheduleSeek();
      else if (op.targetProgress > 0 && video.paused) auto();
    });
    on('seeked', () => {
      if (!live()) return;
      seekInFlight = false;
      if (op.mode !== 'scrub') return;
      if (Math.abs(appliedTime - seekTime()) > .001) applySeek();
      else if (state.videoVisible && Math.abs(state.time - seekTime()) <= .08) {
        cancel(progressTimer); progressTimer = null;
      }
      else if (typeof video.requestVideoFrameCallback !== 'function') paintDisplayed();
      else watchFrame();
    });
    on('ended', () => {
      if (live() && op.mode === 'auto') finish('autumn', state.videoVisible ? 'Перелёт завершён.' : photoFallback);
    });
    for (const name of ['waiting', 'stalled']) on(name, () => {
      if (live()) emit({ moving: false }); // Do not renew the bounded progress deadline.
    });
    if (typeof video.requestVideoFrameCallback !== 'function') {
      const progress = () => {
        if (!live() || op.mode !== 'auto' || video.readyState < 2 || video.currentTime <= 0) return;
        if (state.videoVisible) {
          if (video.currentTime !== lastTime) displayed();
        } else paintDisplayed();
        lastTime = video.currentTime;
      };
      on('playing', progress); on('timeupdate', progress);
    }
    loadTimer = later(fail, op.mode === 'scrub' ? 2000 : 500);
    try {
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.src = src; video.load();
      if (op.mode === 'auto') auto(); else video.pause();
    } catch { fail(); }
  }

  function begin(id, mode = 'still', targetProgress = 0) {
    navigated = true; stopMedia();
    const op = { id, mode, targetProgress, decoded: false, skip: false, failed: false, media: null };
    operation = op;
    emit({ still: current, phase: 'loading', mode, moving: false, videoVisible: false, captionHidden: false,
      error: false, status: 'Подготавливаем фотографию…' });
    Promise.resolve().then(() => decodeImage(id)).then(() => {
      if (operation !== op) return;
      op.decoded = true;
      if (op.mode !== 'still' && !op.skip && allowed()) {
        emit({ status: 'Подготавливаем ролик…' }); load(op);
      } else {
        const status = id === 'winter' ? (src ? 'Готов к пробному перелёту' : missingClip) :
          !src ? missingClip : isMobile() && manifest.mobile_ready !== true ?
            'На телефоне показана фотография: кадрирование ролика ещё не проверено.' : stillStatus();
        finish(id, status);
      }
    }).catch(() => {
      if (operation !== op) return;
      operation = null;
      emit({ still: current, phase: 'idle', mode: 'still', moving: false, videoVisible: false, captionHidden: false,
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
    if (id === 'winter') clipFailed = false;
    if (id === current) {
      operation = null; stopMedia();
      emit({ still: current, phase: 'idle', mode: 'still', progress: current === 'autumn' ? 1 : 0,
        time: 0, moving: false, videoVisible: false, captionHidden: false,
        error: false, status: src ? 'Готов к пробному перелёту' : missingClip });
    } else begin(id);
  };
  emit();
  const firstStill = current;
  Promise.resolve().then(() => decodeImage(firstStill)).catch(() => {
    if (!navigated) emit({ error: true,
      status: 'Фотография не загрузилась. Выберите другой сезон или обновите страницу.' });
  });
  return {
    next({ keyboard = false } = {}) {
      if (operation) {
        if (keyboard || operation.failed || operation.mode === 'auto' && state.phase === 'playing') skip();
        else if (operation.mode === 'scrub') {
          operation.mode = 'auto';
          if (operation.media) operation.media.auto(); else emit({ mode: 'auto' });
        }
        return;
      }
      if (current === 'winter') begin('autumn', keyboard ? 'still' : 'auto');
    },
    wheel(delta) {
      if (!Number.isFinite(delta) || delta === 0 || !allowed() || current !== 'winter') return false;
      if (operation) {
        if (operation.mode === 'still' || operation.failed) return false;
        if (operation.media) operation.media.wheel(delta);
        else {
          operation.mode = 'scrub';
          operation.targetProgress = clamp(operation.targetProgress + Math.max(0, delta) / 1800, 0, 1);
          emit({ mode: 'scrub' });
        }
        return true;
      }
      if (delta < 0) return false;
      begin('autumn', 'scrub', clamp(delta / 1800, 0, 1));
      return true;
    },
    getState: () => snapshot,
    go, skip, reset: () => go('winter')
  };
}
export function bindPilotControls({ player, next, reset, stage, links, document, window }) {
  const instant = (on = true) => document.documentElement?.classList.toggle('is-instant', on);
  next.addEventListener('click', (event) => {
    instant(event.detail === 0);
    player.next({ keyboard: event.detail === 0 });
  });
  reset.addEventListener('click', () => { instant(); player.reset(); });
  stage?.addEventListener('wheel', (event) => {
    const viewport = window.innerHeight || document.documentElement?.clientHeight;
    const needsScroll = viewport && Math.max(stage.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0) > viewport + 1;
    if (needsScroll || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
      event.target?.closest?.('button, a, input, textarea, select, [contenteditable], [data-wheel-native]')) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    if (player.wheel(event.deltaY * unit)) { instant(false); event.preventDefault(); }
  }, { passive: false });
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
  const soundButton = document.querySelector('.pilot-sound');
  const progress = document.querySelector('.pilot-progress');
  const hint = document.querySelector('.pilot-hint__text');
  const mobileNote = document.querySelector('.pilot-mobile-note');
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
  const updateMediaPolicy = () => document.body.classList.toggle('is-photo-only',
    !clipPath(manifest) || motion.matches || phone.matches && manifest.mobile_ready !== true);
  updateMediaPolicy();
  const initial = location.hash === '#autumn' ? 'autumn' : 'winter';
  const sound = bindFlightSound({ button: soundButton, audio: createFlightAudio({ src: 'assets/audio/flight-air.mp3' }) });
  let lastCurrent = initial;
  let lastPhase = 'idle';
  const player = createPilotPlayer({
    video, manifest, initial, decodeImage, onMotionChange: sound.setMoving,
    reducedMotion: () => motion.matches,
    isMobile: () => phone.matches,
    render(state) {
      scenes.forEach((scene, id) => {
        scene.classList.toggle('is-active', id === state.still);
        scene.toggleAttribute('inert', id !== state.current || state.videoVisible);
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
      mobileNote.textContent = state.error ? 'Фотография не загрузилась.' : 'На телефоне — фотографии.';
      stage.dataset.phase = state.phase;
      stage.dataset.mode = state.mode;
      stage.dataset.progress = state.progress.toFixed(3);
      stage.dataset.moving = String(state.moving);
      const modeLabel = state.phase === 'loading' ? 'Подготовка' : state.mode === 'auto' ? 'Летим' :
        state.mode === 'scrub' ? state.moving ? 'Двигаемся' : 'На паузе' : state.current === 'autumn' ? 'Осень' : 'На старте';
      progress.textContent = modeLabel + ' · ' + Math.round(state.progress * 100) + '%';
      hint.textContent = state.current === 'autumn' && state.phase === 'idle' ?
        'Нажмите «Сначала», чтобы повторить полёт.' : state.error ?
        'Нажмите «К осени», чтобы открыть фотографию.' :
        clipPath(manifest) && !motion.matches && (!phone.matches || manifest.mobile_ready === true) ?
        'Крутите колесо вперёд или нажмите «К осени».' : 'Нажмите «К осени», чтобы сменить фотографию.';
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
  bindPilotControls({ player, next, reset, stage, links, document, window });
  motion.addEventListener('change', () => { updateMediaPolicy(); if (motion.matches) player.skip(); });
  phone.addEventListener('change', () => { updateMediaPolicy(); if (phone.matches && manifest.mobile_ready !== true) player.skip(); });
  window.addEventListener('pagehide', () => sound.destroy(), { once: true });
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



export function bindFlightSound({ button, audio }) {
  let enabled = false, moving = false, destroyed = false, intent = 0;
  const label = (failed = false) => {
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = failed ? 'Звук недоступен' : enabled ? 'Звук: вкл.' : 'Звук: выкл.';
  };
  const toggle = () => {
    if (destroyed) return;
    enabled = !enabled;
    const token = ++intent;
    const wanted = enabled;
    audio.setMoving(enabled && moving);
    label();
    // setEnabled is called synchronously inside the explicit click gesture.
    // Its AudioContext resume/play must not be deferred by an import or await.
    let attempt;
    try { attempt = audio.setEnabled(enabled); } catch { attempt = Promise.resolve(false); }
    Promise.resolve(attempt).then((ok) => {
      if (destroyed || token !== intent) return;
      enabled = wanted && Boolean(ok);
      audio.setMoving(enabled && moving);
      label(wanted && !ok);
    }).catch(() => {
      if (destroyed || token !== intent) return;
      enabled = false; audio.setMoving(false); label(true);
    });
  };
  label();
  button.addEventListener('click', toggle);
  return {
    setMoving(value) {
      moving = Boolean(value);
      if (destroyed) return;
      audio.setMoving(enabled && moving);
      if (enabled && moving) {
        const token = intent;
        // Observe the existing movement play promise so later playback failure
        // cannot leave an enabled-looking toggle. This does not replay the clip.
        let attempt;
        try { attempt = audio.setEnabled(true); } catch { attempt = Promise.resolve(false); }
        Promise.resolve(attempt).then((ok) => {
          if (destroyed || token !== intent || !enabled || ok) return;
          enabled = false; audio.setMoving(false); label(true);
        }).catch(() => {
          if (destroyed || token !== intent) return;
          enabled = false; audio.setMoving(false); label(true);
        });
      }
    },
    destroy() {
      destroyed = true; enabled = moving = false; intent++;
      button.removeEventListener('click', toggle); audio.destroy(); label();
    }
  };
}
