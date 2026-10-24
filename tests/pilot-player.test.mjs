import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotPlayer, bindPilotControls } from '../pilot-player.mjs';

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
  currentTime = 0;
  network = [];
  callbacks = new Map();
  serial = 0;
  playResult = Promise.resolve();
  load() { if (this.src) this.network.push(this.src); }
  play() { return this.playResult; }
  pause() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  requestVideoFrameCallback(callback) { const id = ++this.serial; this.callbacks.set(id, callback); return id; }
  cancelVideoFrameCallback(id) { this.callbacks.delete(id); }
  frame(time = .04) {
    this.currentTime = time; this.readyState = 2;
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


function controls(app) {
  const next = new EventTarget(), reset = new EventTarget();
  const document = new EventTarget(), window = new EventTarget();
  window.location = { hash: '' };
  const links = ['winter', 'autumn'].map((id) => Object.assign(new EventTarget(), { hash: '#' + id }));
  bindPilotControls({ player: app.player, next, reset, links, document, window });
  const click = (node, detail = 1, extra = {}) => node.dispatchEvent(Object.assign(
    new Event('click', { cancelable: true }), { button: 0, detail, ...extra }));
  return { next, reset, click, window, links,
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
