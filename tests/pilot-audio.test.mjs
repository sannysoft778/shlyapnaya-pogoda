import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightAudio } from '../pilot-audio.mjs';

const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Browser media is the external boundary: no decoder or speaker exists in Node.
function browser(t, { webAudio = true, play, resume } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const media = [], contexts = [];
  const replace = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  };
  replace('Audio', class extends EventTarget {
    constructor() { super(); media.push(this); }
    src = ''; volume = 1; paused = true; preload = 'auto'; currentTime = 12;
    playCalls = 0; pauseCalls = 0; loadCalls = 0;
    play() { this.playCalls++; this.paused = false; return play?.(this) ?? Promise.resolve(); }
    pause() { this.pauseCalls++; this.paused = true; }
    load() { this.loadCalls++; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  });
  replace('AudioContext', webAudio ? class {
    constructor() { contexts.push(this); }
    state = 'suspended'; destination = {}; closed = false; disconnected = 0;
    changes = [];
    get currentTime() { return Date.now() / 1000; }
    resume() { this.state = 'running'; return resume?.() ?? Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createGain() {
      return { gain: {
        value: 0,
        cancelScheduledValues: (at) => this.changes.push(['cancel', at]),
        setValueAtTime: (value, at) => this.changes.push(['set', value, at]),
        linearRampToValueAtTime: (value, at) => this.changes.push(['ramp', value, at])
      }, connect() {}, disconnect: () => this.disconnected++ };
    }
    createMediaElementSource() {
      return { connect() {}, disconnect: () => this.disconnected++ };
    }
  } : undefined);
  replace('webkitAudioContext', undefined);
  const controller = createFlightAudio({ src: 'assets/audio/flight-air.mp3' });
  t.after(() => controller.destroy());
  return { controller, media, contexts, tick: (ms) => t.mock.timers.tick(ms) };
}

test('no media is created or requested before an explicit sound enable', async (t) => {
  const app = browser(t);
  app.controller.setMoving(true);
  app.controller.setMoving(false);
  assert.equal(await app.controller.setEnabled(false), false);
  assert.equal(app.media.length, 0);
  assert.equal(app.contexts.length, 0);
  assert.equal(await app.controller.setEnabled(true), true);
  assert.equal(app.media[0].src, 'assets/audio/flight-air.mp3');
  assert.equal(app.media[0].loop, true);
  assert.equal(app.media[0].paused, true);
});

test('wheel bursts hold one playback position and interrupt fades without a gain jump', async (t) => {
  const app = browser(t);
  await app.controller.setEnabled(true);
  const audio = app.media[0], context = app.contexts[0];
  app.controller.setMoving(true);
  await flush();
  app.controller.setMoving(true);
  app.controller.setMoving(true);
  assert.equal(audio.playCalls, 2);
  assert.deepEqual(context.changes.at(-1), ['ramp', 0.16, 0.06]);
  app.tick(30);
  app.controller.setMoving(false);
  assert.deepEqual(context.changes.at(-2), ['set', 0.08, 0.03]);
  app.tick(50);
  app.controller.setMoving(true);
  await flush();
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.currentTime, 12);
  assert.ok(Math.abs(context.changes.at(-2)[1] - 0.04) < 1e-9);
  app.tick(70);
  assert.equal(audio.paused, false);
  app.controller.setMoving(false);
  app.tick(99);
  assert.equal(audio.paused, false);
  app.tick(1);
  assert.equal(audio.paused, true);
});

test('a denied play returns false and can be retried by another explicit enable', async (t) => {
  let denied = true;
  const app = browser(t, { play: () => denied ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve() });
  app.controller.setMoving(true);
  assert.equal(await app.controller.setEnabled(true), false);
  assert.equal(app.media[0].paused, true);
  app.controller.setMoving(false);
  app.controller.setMoving(true);
  assert.equal(app.media[0].playCalls, 1);
  denied = false;
  assert.equal(await app.controller.setEnabled(true), true);
  assert.equal(app.media[0].paused, false);
});

test('disable during a pending play never enables or leaves background audio running', async (t) => {
  const pending = deferred();
  const app = browser(t, { play: () => pending.promise });
  app.controller.setMoving(true);
  const enabling = app.controller.setEnabled(true);
  assert.equal(await app.controller.setEnabled(false), false);
  app.tick(100);
  pending.resolve();
  assert.equal(await enabling, false);
  assert.equal(app.media[0].paused, true);
});

test('destroy releases its media and nodes and a late play cannot revive it', async (t) => {
  const pending = deferred();
  const app = browser(t, { play: () => pending.promise });
  const enabling = app.controller.setEnabled(true);
  app.controller.destroy();
  pending.resolve();
  assert.equal(await enabling, false);
  assert.equal(app.media[0].paused, true);
  assert.equal(app.media[0].src, '');
  assert.equal(app.contexts[0].closed, true);
  assert.equal(app.contexts[0].disconnected, 2);
  assert.equal(await app.controller.setEnabled(true), false);
  app.controller.setMoving(true);
  assert.equal(app.media[0].playCalls, 1);
});

test('without Web Audio, volume still fades and pauses after camera movement stops', async (t) => {
  const app = browser(t, { webAudio: false });
  app.controller.setMoving(true);
  assert.equal(await app.controller.setEnabled(true), true);
  const audio = app.media[0];
  assert.equal(audio.volume, 0);
  app.tick(32);
  assert.ok(audio.volume > 0 && audio.volume < 0.16);
  app.tick(32);
  assert.equal(audio.volume, 0.16);
  app.controller.setMoving(false);
  app.tick(48);
  assert.ok(audio.volume > 0 && audio.volume < 0.16);
  app.tick(52);
  assert.equal(audio.volume, 0);
  assert.equal(audio.paused, true);
});

test('a suspended audio context rejection returns false without leaking a playing element', async (t) => {
  const app = browser(t, { resume: () => Promise.reject(new Error('context blocked')) });
  app.controller.setMoving(true);
  assert.equal(await app.controller.setEnabled(true), false);
  assert.equal(app.media[0].paused, true);
});

test('a synchronous play failure also consumes a rejected context resume', async (t) => {
  const app = browser(t, {
    resume: () => Promise.reject(new Error('context blocked')),
    play: () => { throw new Error('play blocked'); }
  });
  assert.equal(await app.controller.setEnabled(true), false);
  await flush();
  assert.equal(app.media[0].paused, true);
});

test('re-enabling while stopped ends an unfinished fade with paused media', async (t) => {
  const app = browser(t);
  app.controller.setMoving(true);
  await app.controller.setEnabled(true);
  app.tick(60);
  app.controller.setMoving(false);
  await app.controller.setEnabled(false);
  app.tick(20);
  assert.equal(await app.controller.setEnabled(true), true);
  assert.equal(app.media[0].paused, true);
});
