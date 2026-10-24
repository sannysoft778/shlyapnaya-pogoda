const flightLevel = 0.16;
const riseMs = 60;
const fallMs = 100;

/** Separate, opt-in camera audio. Call setMoving for actual camera motion,
 * including wheel-driven playback; repeated true values do not restart it. */
export function createFlightAudio({ src } = {}) {
  let enabled = false, moving = false, destroyed = false;
  let audio, context, source, gain;
  let pauseTimer, volumeTimer, playPromise;
  let revision = 0;
  let envelope = { from: 0, to: 0, start: 0, duration: 0 };
  const now = () => context ? context.currentTime : Date.now() / 1000;
  const levelAt = (time) => {
    const progress = envelope.duration ? Math.max(0, Math.min(1,
      (time - envelope.start) / envelope.duration)) : 1;
    return envelope.from + (envelope.to - envelope.from) * progress;
  };

  function fade(to, durationMs) {
    if (!audio) return;
    clearTimeout(volumeTimer);
    volumeTimer = undefined;
    const time = now();
    const from = levelAt(time);
    envelope = { from, to, start: time, duration: durationMs / 1000 };
    if (gain) {
      // Keep the current envelope level when reversing a fade. AudioParam.value
      // alone is not a reliable measure of an in-flight scheduled ramp.
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(from, time);
      if (durationMs) gain.linearRampToValueAtTime(to, time + envelope.duration);
      else gain.setValueAtTime(to, time);
    } else {
      const step = () => {
        if (!audio) return;
        const time = now();
        audio.volume = Math.max(0, Math.min(1, levelAt(time)));
        const remaining = (envelope.start + envelope.duration - time) * 1000;
        if (remaining > 0) volumeTimer = setTimeout(step, Math.max(1, Math.min(16, Math.ceil(remaining))));
        else volumeTimer = undefined;
      };
      step();
    }
  }

  function stop() {
    clearTimeout(pauseTimer);
    if (!audio) return;
    fade(0, fallMs);
    pauseTimer = setTimeout(() => {
      pauseTimer = undefined;
      if (!audio || (enabled && moving)) return;
      fade(0, 0);
      audio.pause();
    }, fallMs);
  }

  function failed() {
    enabled = false;
    revision++;
    playPromise = undefined;
    clearTimeout(pauseTimer);
    fade(0, 0);
    audio?.pause();
  }

  function makeAudio() {
    const element = new Audio();
    element.preload = 'none';
    element.loop = true;
    element.volume = 0;
    return element;
  }

  function prepare() {
    if (audio) return;
    if (typeof src !== 'string' || !src.trim()) throw new Error('Audio source is missing');
    audio = makeAudio();
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioContext) {
      try {
        context = new AudioContext();
        const node = context.createGain();
        node.gain.value = 0;
        node.connect(context.destination);
        gain = node.gain;
        source = context.createMediaElementSource(audio);
        source.connect(node);
        gainNode = node;
        audio.volume = 1;
      } catch {
        source?.disconnect();
        gainNode?.disconnect();
        Promise.resolve(context?.close()).catch(() => {});
        // An element already claimed by Web Audio cannot return to direct output.
        if (source) audio = makeAudio();
        context = source = gain = gainNode = undefined;
      }
    }
    audio.addEventListener('error', failed);
    // No element, source assignment, load or request exists before explicit enable.
    audio.src = src;
  }
  let gainNode;

  function play(force = false) {
    clearTimeout(pauseTimer);
    pauseTimer = undefined;
    if (playPromise) return playPromise;
    if (!force && !audio.paused && context?.state !== 'suspended') {
      if (moving) fade(flightLevel, riseMs);
      return Promise.resolve(true);
    }
    const element = audio;
    const operation = revision;
    let resume, playback;
    // Attach both outcomes to Promise.all even if either API throws immediately.
    try {
      // Both calls happen inside the enable gesture, before the first await.
      resume = context?.state === 'suspended' ? context.resume() : undefined;
    } catch (error) { resume = Promise.reject(error); }
    try { playback = element.play(); }
    catch (error) { playback = Promise.reject(error); }
    const result = Promise.all([resume, playback]);
    const pending = result.then(() => {
      if (destroyed || !enabled || operation !== revision) {
        if (destroyed || !enabled) element.pause();
        return false;
      }
      if (moving) fade(flightLevel, riseMs);
      else { fade(0, 0); element.pause(); }
      return true;
    }).catch(() => {
      if (!destroyed && operation === revision) failed();
      else if (destroyed || !enabled) element.pause();
      return false;
    }).finally(() => {
      if (playPromise === pending) playPromise = undefined;
    });
    playPromise = pending;
    return pending;
  }

  return {
    setEnabled(value) {
      if (destroyed) return Promise.resolve(false);
      if (!value) {
        enabled = false;
        revision++;
        playPromise = undefined;
        stop();
        return Promise.resolve(false);
      }
      if (enabled) return playPromise || Promise.resolve(true);
      enabled = true;
      revision++;
      try { prepare(); return play(true); }
      catch { failed(); return Promise.resolve(false); }
    },
    setMoving(value) {
      const next = Boolean(value);
      if (destroyed || moving === next) return;
      moving = next;
      if (!enabled || !audio) return;
      if (moving) void play();
      else stop();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      enabled = moving = false;
      revision++;
      clearTimeout(pauseTimer);
      clearTimeout(volumeTimer);
      playPromise = undefined;
      if (audio) {
        audio.removeEventListener('error', failed);
        audio.pause();
        audio.removeAttribute('src');
        audio.preload = 'none';
        audio.load();
      }
      source?.disconnect();
      gainNode?.disconnect();
      Promise.resolve(context?.close()).catch(() => {});
      audio = context = source = gain = gainNode = undefined;
    }
  };
}
