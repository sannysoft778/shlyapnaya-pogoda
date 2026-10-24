import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotPlayer, bindPilotControls, bindFlightSound } from '../pilot-player.mjs';

const flush = () => new Promise(setImmediate);
const enabled = { enabled: true, src: 'assets/transitions/winter-autumn.mp4', mobile_ready: false };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock() {
  let now = 0, serial = 0;
  const tasks = new Map();
  return {
    setTimeout(fn, delay) { const id = ++serial; tasks.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; tasks.delete(due[0]); due[1].fn();
      }
      now = end;
    }
  };
}

class VideoFixture extends EventTarget {
  src = '';
  preload = 'none';
  readyState = 0;
  time = 0;
  duration = NaN;
  paused = true;
  seeking = false;
  seeks = [];
  ranges = null;
  get seekable() {
    const ranges = this.ranges ?? (Number.isFinite(this.duration) ? [[0, this.duration]] : []);
    return { length: ranges.length, start: (index) => ranges[index][0], end: (index) => ranges[index][1] };
  }
  get currentTime() { return this.time; }
  set currentTime(value) { this.time = value; this.seeking = true; this.seeks.push(value); }
  network = [];
  callbacks = new Map();
  serial = 0;
  playResult = Promise.resolve();
  load() { if (this.src) this.network.push(this.src); }
  play() { this.paused = false; return this.playResult; }
  pause() { this.paused = true; }
  metadata(duration = 4) { this.duration = duration; this.readyState = 1; this.emit('loadedmetadata'); }
  seeked() { this.seeking = false; this.emit('seeked'); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  requestVideoFrameCallback(callback) { const id = ++this.serial; this.callbacks.set(id, callback); return id; }
  cancelVideoFrameCallback(id) { this.callbacks.delete(id); }
  frame(time = .04) {
    this.time = time; this.readyState = 2;
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    callbacks.forEach((callback) => callback(0, { mediaTime: time, presentedFrames: 1 }));
  }
  emit(name) { this.dispatchEvent(new Event(name)); }
}

function start(options = {}) {
  const video = new VideoFixture();
  if (options.noFrameCallback) video.requestVideoFrameCallback = undefined;
  const time = clock();
  const target = options.target || deferred();
  const frames = [];
  let snapshot;
  const player = createPilotPlayer({
    video,
    manifest: enabled,
    decodeImage: (id) => id === 'autumn' ? target.promise : Promise.resolve(),
    render: (state) => { snapshot = state; },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame() {},
    ...options
  });
  return { player, video, time, target, state: () => snapshot, paint: () => frames.splice(0).forEach((fn) => fn()) };
}

test('disabled manifest switches photos without requesting an absent movie', async () => {
  const app = start({ manifest: { enabled: false, src: null, mobile_ready: false } });
  assert.match(app.state().status, /Ролик ещё не подключён/);
  app.player.next();
  assert.equal(app.state().still, 'winter');
  app.target.resolve(); await flush();
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.state().videoVisible, false);
  assert.deepEqual(app.video.network, []);
});

test('source remains through decode and media events until a real presented frame', async () => {
  const app = start();
  app.player.next();
  assert.deepEqual(app.video.network, []);
  app.target.resolve(); await flush();
  assert.deepEqual(app.video.network, ['assets/transitions/winter-autumn.mp4']);
  app.video.emit('loadeddata'); app.video.emit('playing');
  assert.equal(app.state().still, 'winter');
  assert.equal(app.state().videoVisible, false);
  app.video.frame();
  assert.equal(app.state().current, 'winter');
  assert.equal(app.state().still, 'autumn');
  assert.equal(app.state().phase, 'playing');
  assert.equal(app.state().videoVisible, true);
  assert.equal(app.state().captionHidden, true);
  assert.equal(app.state().nextLabel, 'Пропустить');
  app.video.emit('ended');
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.state().videoVisible, false);
  assert.equal(app.state().captionHidden, false);
  assert.equal(app.video.src, '');
});

test('rapid Next during loading keeps one winter-to-autumn request', async () => {
  const app = start();
  app.player.next(); app.player.next();
  app.target.resolve(); await flush();
  app.player.next();
  assert.equal(app.state().still, 'winter');
  assert.equal(app.state().phase, 'loading');
  assert.deepEqual(app.video.network, ['assets/transitions/winter-autumn.mp4']);
  app.video.frame(); app.player.next();
  assert.equal(app.state().current, 'autumn');
  app.player.next();
  assert.equal(app.state().current, 'autumn');
});

for (const failure of ['error', 'rejected', 'load-timeout', 'stall']) {
  test(`${failure} settles to the decoded autumn photo`, async () => {
    const app = start();
    if (failure === 'rejected') app.video.playResult = Promise.reject(new Error('Autoplay denied'));
    app.player.next(); app.target.resolve(); await flush();
    if (failure === 'error') app.video.emit('error');
    if (failure === 'load-timeout') { app.time.tick(499); assert.equal(app.state().still, 'winter'); app.time.tick(1); }
    if (failure === 'stall') { app.video.frame(); app.video.emit('waiting'); app.time.tick(2000); }
    await flush();
    assert.equal(app.state().phase, 'idle');
    assert.equal(app.state().current, 'autumn');
    assert.equal(app.state().videoVisible, false);
    assert.match(app.state().status, /фото/);
  });
}

test('brief waiting recovers and moving frames renew the stall deadline', async () => {
  const app = start();
  app.player.next(); app.target.resolve(); await flush(); app.video.frame();
  app.video.emit('waiting'); app.time.tick(1500); app.video.frame(.5); app.time.tick(1500);
  assert.equal(app.state().phase, 'playing');
  app.video.emit('ended');
  assert.equal(app.state().current, 'autumn');
});

for (const options of [{ reducedMotion: () => true }, { isMobile: () => true }]) {
  test(`motion policy ${Object.keys(options)[0]} uses only the target still`, async () => {
    const app = start(options);
    app.player.next(); app.target.resolve(); await flush();
    assert.equal(app.state().current, 'autumn');
    assert.deepEqual(app.video.network, []);
  });
}

test('verified mobile crop permits a video', async () => {
  const app = start({ isMobile: () => true, manifest: { ...enabled, mobile_ready: true } });
  app.player.next(); app.target.resolve(); await flush(); app.video.frame();
  assert.equal(app.state().phase, 'playing');
  app.player.skip();
});

for (const action of ['menu', 'keyboard']) {
  test(`${action} navigation goes directly to a still`, async () => {
    const app = start();
    if (action === 'menu') app.player.go('autumn');
    else app.player.next({ keyboard: true });
    app.target.resolve(); await flush();
    assert.equal(app.state().current, 'autumn');
    assert.deepEqual(app.video.network, []);
  });
}

test('direct navigation cancels loading and late decode cannot replace the newer season', async () => {
  const app = start();
  app.player.next(); assert.equal(app.state().phase, 'loading'); app.player.go('winter'); await flush();
  app.target.resolve(); await flush();
  assert.equal(app.state().current, 'winter');
  assert.deepEqual(app.video.network, []);
});

test('Escape/skip during loading waits for the target but never starts video', async () => {
  const app = start();
  app.player.next(); app.player.skip();
  assert.equal(app.state().still, 'winter');
  app.target.resolve(); await flush();
  assert.equal(app.state().current, 'autumn');
  assert.deepEqual(app.video.network, []);
});

test('reset cancels active video and explicitly allows replay from winter', async () => {
  const app = start();
  app.player.next(); app.target.resolve(); await flush(); app.video.frame();
  const lateFrame = [...app.video.callbacks.values()][0];
  app.player.reset(); await flush();
  assert.equal(app.state().current, 'winter');
  assert.equal(app.state().videoVisible, false);
  lateFrame?.(0, { presentedFrames: 2, mediaTime: .5 }); app.video.emit('ended');
  assert.equal(app.state().current, 'winter');
  app.player.next(); await flush(); app.video.frame();
  assert.equal(app.state().phase, 'playing');
  app.player.skip();
});

test('failed target photo preserves the source and does not attempt video', async () => {
  const app = start();
  app.player.next(); app.target.reject(new Error('Image unavailable')); await flush();
  assert.equal(app.state().current, 'winter');
  assert.equal(app.state().still, 'winter');
  assert.equal(app.state().phase, 'idle');
  assert.equal(app.state().error, true);
  assert.deepEqual(app.video.network, []);
});

for (const src of [null, '', 'https://example.com/clip.mp4', '//example.com/clip.mp4', '../clip.mp4', '/clip.mp4']) {
  test(`invalid clip path ${JSON.stringify(src)} uses photos without network requests`, async () => {
    const app = start({ manifest: { enabled: true, src } });
    app.player.next(); app.target.resolve(); await flush();
    assert.equal(app.state().current, 'autumn');
    assert.deepEqual(app.video.network, []);
  });
}

test('older browsers wait for rendered progress instead of exposing loadeddata', async () => {
  const app = start({ noFrameCallback: true });
  app.player.next(); app.target.resolve(); await flush();
  app.video.readyState = 2; app.video.emit('loadeddata'); app.paint(); app.paint();
  assert.equal(app.state().still, 'winter');
  app.video.currentTime = .1; app.video.emit('timeupdate'); app.paint();
  assert.equal(app.state().still, 'winter');
  app.paint();
  assert.equal(app.state().phase, 'playing');
  assert.equal(app.state().still, 'autumn');
  app.player.skip();
});


test('repeated waiting events cannot postpone the bounded stall fallback', async () => {
  const app = start();
  app.player.next(); app.target.resolve(); await flush(); app.video.frame();
  app.time.tick(1000); app.video.emit('waiting');
  app.time.tick(700); app.video.emit('stalled');
  app.time.tick(300);
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.state().phase, 'idle');
});

test('a silent frozen video falls back without needing a stalled event', async () => {
  const app = start();
  app.player.next(); app.target.resolve(); await flush(); app.video.frame();
  app.time.tick(2000);
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.state().videoVisible, false);
});


function controls(app, layout = {}) {
  const next = new EventTarget(), reset = new EventTarget(), stage = new EventTarget();
  stage.clientHeight = 900;
  stage.scrollHeight = layout.stageHeight ?? 900;
  const document = new EventTarget(), window = new EventTarget();
  window.location = { hash: '' };
  window.innerHeight = layout.viewport ?? 900;
  if (layout.documentHeight) document.documentElement = { scrollHeight: layout.documentHeight, classList: { toggle() {} } };
  const links = ['winter', 'autumn'].map((id) => Object.assign(new EventTarget(), { hash: '#' + id }));
  bindPilotControls({ player: app.player, next, reset, stage, links, document, window });
  const click = (node, detail = 1, extra = {}) => node.dispatchEvent(Object.assign(
    new Event('click', { cancelable: true }), { button: 0, detail, ...extra }));
  return { next, reset, click, window, links,
    wheel: (deltaY, extra = {}) => stage.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }),
      { deltaY, deltaX: 0, deltaMode: 0, ...extra })),
    key: (key) => document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key })) };
}

test('keyboard click and ArrowRight select a still through the actual controls', async () => {
  for (const action of ['click', 'arrow']) {
    const app = start(); const ui = controls(app);
    if (action === 'click') ui.click(ui.next, 0); else ui.key('ArrowRight');
    app.target.resolve(); await flush();
    assert.equal(app.state().current, 'autumn');
    assert.deepEqual(app.video.network, []);
  }
});

test('Escape skips video while explicit reset returns to winter', async () => {
  const app = start(); const ui = controls(app);
  ui.click(ui.next); app.target.resolve(); await flush(); app.video.frame();
  assert.equal(app.state().phase, 'playing');
  ui.key('Escape');
  assert.equal(app.state().current, 'autumn');
  ui.click(ui.reset); await flush();
  assert.equal(app.state().current, 'winter');
});

test('menu and hash navigation are immediate still changes and modified clicks keep browser behavior', async () => {
  const app = start(); const ui = controls(app);
  assert.equal(ui.click(ui.links[1], 1, { ctrlKey: true }), true);
  assert.equal(app.state().phase, 'idle');
  assert.equal(ui.click(ui.links[1]), false);
  app.target.resolve(); await flush();
  assert.equal(app.state().current, 'autumn');
  assert.deepEqual(app.video.network, []);
  ui.window.location.hash = '#winter'; ui.window.dispatchEvent(new Event('hashchange')); await flush();
  assert.equal(app.state().current, 'winter');
});

test('ended before any displayed frame is reported as a photo fallback', async () => {
  const app = start();
  app.player.next(); app.target.resolve(); await flush();
  app.video.emit('ended');
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.state().videoVisible, false);
  assert.match(app.state().status, /фото/);
});

test('ArrowLeft never navigates backwards from autumn', async () => {
  const app = start(); const ui = controls(app);
  ui.click(ui.links[1]); app.target.resolve(); await flush();
  ui.key('ArrowLeft'); await flush();
  assert.equal(app.state().current, 'autumn');
  assert.deepEqual(app.video.network, []);
});

test('failed initial photograph has an honest visible error state', async () => {
  const app = start({ decodeImage: () => Promise.reject(new Error('Initial photo unavailable')) });
  await flush();
  assert.equal(app.state().phase, 'idle');
  assert.equal(app.state().current, 'winter');
  assert.equal(app.state().error, true);
  assert.match(app.state().status, /Фотография не загрузилась/);
  assert.deepEqual(app.video.network, []);
});

test('late initial photograph failure cannot overwrite a newly selected autumn', async () => {
  const winter = deferred(); winter.promise.catch(() => {});
  const app = start({ decodeImage: (id) => id === 'winter' ? winter.promise : Promise.resolve() });
  app.player.go('autumn'); await flush();
  winter.reject(new Error('Initial photo unavailable')); await flush();
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.state().error, false);
});


test('public progress is a read-only snapshot of the displayed mode', async () => {
  const app = start();
  assert.equal(typeof app.player.getState, 'function');
  const state = app.player.getState();
  assert.equal(state.mode, 'still'); assert.equal(state.progress, 0);
  assert.equal(Object.isFrozen(state), true);
  assert.throws(() => { state.progress = 1; }, TypeError);
});

test('wheel retains initial deltas, seeks paused video and stops without further input', async () => {
  const moving = [];
  const app = start({ onMotionChange: (value) => moving.push(value) });
  assert.equal(typeof app.player.wheel, 'function');
  assert.equal(app.player.wheel(120), true); app.player.wheel(240);
  assert.equal(app.state().still, 'winter');
  app.target.resolve(); await flush();
  assert.equal(app.video.paused, true);
  app.video.metadata(); app.paint();
  assert.ok(Math.abs(app.video.currentTime - .8) < .0001);
  assert.equal(app.state().still, 'winter');
  app.video.seeked(); app.video.frame(.8);
  assert.equal(app.state().mode, 'scrub');
  assert.equal(app.state().phase, 'scrubbing');
  assert.equal(app.state().progress, .2);
  assert.equal(app.state().nextLabel, 'Продолжить полёт');
  app.time.tick(120);
  assert.equal(app.state().moving, false);
  assert.equal(moving.at(-1), false);
  app.time.tick(5000); app.paint();
  assert.equal(app.state().phase, 'scrubbing');
  assert.equal(app.video.currentTime, .8);
  assert.equal(app.video.paused, true);
  assert.equal(app.video.seeks.length, 1);
});

test('seeking keeps only the latest accumulated wheel target', async () => {
  const app = start();
  app.player.wheel(120); app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  app.player.wheel(240); app.paint(); app.player.wheel(360); app.paint();
  assert.equal(app.video.seeks.length, 1);
  app.video.seeked();
  assert.equal(app.video.seeks.length, 2);
  assert.ok(Math.abs(app.video.seeks[1] - 1.6) < .0001);
  app.video.seeked(); app.video.frame(1.6);
  assert.equal(app.state().progress, .4);
  assert.equal(app.video.paused, true);
});

test('wheel to auto to wheel preserves the current position and only advances forward', async () => {
  const app = start();
  app.player.wheel(120); app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  app.video.seeked(); app.video.frame(4 / 15); app.time.tick(120);
  app.player.next();
  assert.equal(app.video.paused, false); assert.equal(app.state().mode, 'auto');
  app.video.frame(1.2);
  app.player.wheel(120); app.paint();
  assert.equal(app.video.paused, true); assert.equal(app.state().mode, 'scrub');
  assert.ok(Math.abs(app.video.currentTime - (1.2 + 4 / 15)) < .0001);
  const position = app.video.currentTime;
  app.player.wheel(-500); app.paint();
  assert.equal(app.video.currentTime, position);
  app.video.seeked(); app.video.frame(position);
  app.player.next(); assert.equal(app.video.paused, false);
  app.player.next(); assert.equal(app.state().current, 'autumn');
});

test('wheel while auto loading changes intent to scrub without calling play', async () => {
  const app = start();
  app.player.next(); app.player.wheel(240);
  app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  assert.equal(app.video.paused, true);
  assert.ok(Math.abs(app.video.currentTime - 8 / 15) < .0001);
});

test('scrub timeout leaves winter and the next explicit button can show the photo', async () => {
  const app = start();
  app.player.wheel(120); app.target.resolve(); await flush();
  app.time.tick(1999); assert.equal(app.state().phase, 'loading');
  app.time.tick(1);
  assert.equal(app.state().current, 'winter'); assert.equal(app.state().still, 'winter');
  assert.equal(app.state().error, true); assert.equal(app.state().moving, false);
  assert.match(app.state().status, /не загрузился/);
  app.player.next(); await flush();
  assert.equal(app.state().current, 'autumn');
  assert.equal(app.video.network.length, 1);
});

test('seeked before the final displayed frame never settles autumn by itself', async () => {
  const app = start();
  app.player.wheel(2000); app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  app.video.seeked();
  assert.equal(app.state().current, 'winter');
  app.video.frame(4);
  assert.equal(app.state().current, 'autumn'); assert.equal(app.state().progress, 1);
});

test('reset cancels pending scrub seeks and late media results', async () => {
  const moving = [];
  const app = start({ onMotionChange: (value) => moving.push(value) });
  app.player.wheel(120); app.target.resolve(); await flush(); app.video.metadata();
  app.player.reset(); app.paint(); app.video.seeked(); app.video.frame(.3);
  assert.equal(app.state().current, 'winter'); assert.equal(app.state().videoVisible, false);
  assert.equal(app.state().mode, 'still'); assert.equal(moving.at(-1), false);
});

for (const policy of [
  { manifest: { enabled: false, src: null } }, { isMobile: () => true }, { reducedMotion: () => true }
]) {
  test(`wheel leaves native scrolling under ${Object.keys(policy)[0]} and button still works`, async () => {
    const app = start(policy);
    assert.equal(app.player.wheel(120), false);
    assert.equal(app.state().current, 'winter'); assert.deepEqual(app.video.network, []);
    app.player.next(); app.target.resolve(); await flush();
    assert.equal(app.state().current, 'autumn'); assert.deepEqual(app.video.network, []);
  });
}

test('stage wheel intercepts vertical flight input but preserves pinch and horizontal scrolling', async () => {
  const app = start(); const ui = controls(app);
  assert.equal(ui.wheel(120, { ctrlKey: true }), true);
  assert.equal(ui.wheel(20, { deltaX: 120 }), true);
  assert.equal(ui.wheel(-120), true);
  assert.equal(app.state().phase, 'idle');
  assert.equal(ui.wheel(120), false);
  app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  assert.ok(app.video.currentTime > 0);
});

test('motion callback follows displayed playback, waiting, recovery and cancellation', async () => {
  const motion = [];
  const app = start({ onMotionChange: (moving) => motion.push(moving) });
  assert.deepEqual(motion, [false]);
  app.player.next(); app.target.resolve(); await flush();
  assert.deepEqual(motion, [false]);
  app.video.frame(.2); assert.equal(motion.at(-1), true);
  app.video.emit('waiting'); assert.equal(motion.at(-1), false);
  app.video.frame(.4); assert.equal(motion.at(-1), true);
  app.player.reset(); await flush(); assert.equal(motion.at(-1), false);
});


function soundButton() {
  const attributes = new Map();
  return Object.assign(new EventTarget(), { textContent: '',
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) });
}

test('sound stays off until an explicit click and follows camera motion after enabling', async () => {
  const button = soundButton();
  const values = { enabled: false, moving: false };
  let insideClick = false, enabledInsideClick = false;
  const audio = { setEnabled(value) { enabledInsideClick = insideClick; values.enabled = value; return Promise.resolve(value); },
    setMoving(value) { values.moving = value; }, destroy() {} };
  const sound = bindFlightSound({ button, audio });
  sound.setMoving(true);
  assert.equal(values.enabled, false); assert.equal(values.moving, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  insideClick = true; button.dispatchEvent(new Event('click')); insideClick = false;
  assert.equal(enabledInsideClick, true);
  await flush();
  assert.equal(values.enabled, true); assert.equal(values.moving, true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  sound.setMoving(false); assert.equal(values.moving, false);
  button.dispatchEvent(new Event('click')); await flush();
  assert.equal(values.enabled, false); assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('late sound enable cannot override a newer off click', async () => {
  const pending = deferred(); const button = soundButton();
  const values = { enabled: false, moving: false };
  const audio = { setEnabled(value) { values.enabled = value; return value ? pending.promise : Promise.resolve(false); },
    setMoving(value) { values.moving = value; }, destroy() {} };
  const sound = bindFlightSound({ button, audio });
  sound.setMoving(true); button.dispatchEvent(new Event('click')); button.dispatchEvent(new Event('click'));
  pending.resolve(true); await flush();
  assert.equal(values.enabled, false); assert.equal(values.moving, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('a rejected sound enable reports off and never blocks flight controls', async () => {
  const button = soundButton();
  const sound = bindFlightSound({ button, audio: { setEnabled: () => Promise.reject(new Error('Not allowed')),
    setMoving() {}, destroy() {} } });
  button.dispatchEvent(new Event('click')); await flush();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.textContent, /недоступен/);
  sound.destroy();
});


for (const layout of [{ stageHeight: 1200 }, { documentHeight: 1200 }]) {
  test(`wheel leaves native scrolling when ${Object.keys(layout)[0]} exceeds the viewport`, () => {
    const app = start(); const ui = controls(app, layout);
    assert.equal(ui.wheel(120), true);
    assert.equal(app.state().phase, 'idle');
    assert.deepEqual(app.video.network, []);
  });
}

test('a displayed frame before seeked cannot launch another concurrent native seek', async () => {
  const app = start();
  app.player.wheel(120); app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  app.video.frame(4 / 15);
  assert.equal(app.video.seeking, true);
  app.player.wheel(240); app.paint();
  assert.equal(app.video.seeks.length, 1);
  app.video.seeked();
  assert.equal(app.video.seeks.length, 2);
  assert.ok(Math.abs(app.video.currentTime - .8) < .0001);
});

test('the first fast wheel frame reports motion then becomes quiet without another input', async () => {
  const motion = [];
  const app = start({ onMotionChange: (value) => motion.push(value) });
  app.player.wheel(120); app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  app.video.seeked(); app.video.frame(4 / 15);
  assert.equal(motion.at(-1), true);
  app.time.tick(120);
  assert.equal(motion.at(-1), false);
  assert.equal(app.video.paused, true);
});

test('a late first scrub frame emits motion only when a new frame is actually displayed', async () => {
  const motion = [];
  const app = start({ onMotionChange: (value) => motion.push(value) });
  app.player.wheel(120); app.time.tick(300);
  app.target.resolve(); await flush(); app.video.metadata(); app.paint(); app.video.seeked();
  assert.deepEqual(motion, [false]);
  app.video.frame(4 / 15);
  assert.equal(motion.at(-1), true);
  app.time.tick(120); assert.equal(motion.at(-1), false);
});


test('a later movement play rejection updates the enabled sound toggle back to off', async () => {
  const button = soundButton();
  let enabled = false, moving = false, playback;
  const audio = {
    setEnabled(value) {
      if (!value) { enabled = false; return Promise.resolve(false); }
      if (enabled) return playback || Promise.resolve(true);
      enabled = true; return Promise.resolve(true);
    },
    setMoving(value) {
      moving = value;
      if (value && enabled) playback = Promise.resolve().then(() => { enabled = false; return false; });
    },
    destroy() {}
  };
  const sound = bindFlightSound({ button, audio });
  button.dispatchEvent(new Event('click')); await flush();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  sound.setMoving(true); await flush();
  assert.equal(enabled, false); assert.equal(moving, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.textContent, /недоступен/);
});


test('initial wheel waits for a seekable range and preserves the latest requested position', async () => {
  const app = start(); app.video.ranges = [];
  app.player.wheel(120); app.target.resolve(); await flush(); app.video.metadata(); app.paint();
  assert.deepEqual(app.video.seeks, []);
  app.player.wheel(240); app.paint();
  assert.equal(app.state().still, 'winter');
  app.video.ranges = [[0, 4]]; app.video.readyState = 2; app.video.emit('progress'); app.paint();
  assert.equal(app.video.seeks.length, 1);
  assert.ok(Math.abs(app.video.currentTime - .8) < .0001);
  app.video.seeked(); app.video.frame(.8);
  assert.equal(app.state().phase, 'scrubbing'); assert.equal(app.state().progress, .2);
});
