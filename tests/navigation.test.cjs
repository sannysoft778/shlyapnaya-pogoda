const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'app.js'), 'utf8');
const seasons = ['winter', 'autumn', 'summer', 'spring'];
const flush = () => new Promise(setImmediate);

function element() {
  const classes = new Set();
  const attributes = new Map();
  return Object.assign(new EventTarget(), {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    toggleAttribute: (name, on) => on ? attributes.set(name, '') : attributes.delete(name)
  });
}

function start(layout) {
  const complete = {};
  const scenes = Object.fromEntries(seasons.map((id) => {
    const decoded = id === 'winter' ? Promise.resolve() : new Promise((resolve) => { complete[id] = resolve; });
    const image = { complete: true, naturalWidth: 1672, decode: () => decoded };
    return [id, Object.assign(element(), {
      querySelector: (selector) => selector === '.scene__img' ? image :
        selector === '.scene__copy' ? layout?.copies[id] : { textContent: id }
    })];
  }));
  const links = seasons.map((id) => Object.assign(element(), { hash: '#' + id }));
  const next = element();
  const label = { textContent: 'К осени' };
  const status = layout?.status || element();
  const location = { hash: '' };
  const document = Object.assign(element(), {
    documentElement: layout?.root || element(),
    getElementById: (id) => scenes[id],
    querySelector: (selector) => ({ '.next': next, '.next__label': label, '.status': status, ...layout?.nodes })[selector],
    querySelectorAll: () => links
  });
  runInNewContext(source, {
    document, location, window: layout?.window || element(), ...layout?.context,
    history: { replaceState: (_state, _title, hash) => { location.hash = hash; } }
  }, { filename: 'app.js' });
  const click = (node) => node.dispatchEvent(Object.assign(new Event('click', { cancelable: true }), { button: 0, detail: 1 }));
  return {
    next: () => click(next),
    right: () => document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' })),
    menu: (id) => click(links[seasons.indexOf(id)]),
    ready: async (id) => { complete[id]?.(); await flush(); },
    visible: () => seasons.filter((id) => scenes[id].classList.contains('is-active'))
  };
}

for (const action of ['next', 'right']) {
  test(`repeated ${action} while decoding keeps the next visible season`, async () => {
    const app = start();
    await flush();
    app[action]();
    app[action]();
    assert.deepEqual(app.visible(), ['winter']);
    await app.ready('summer');
    await app.ready('autumn');
    assert.deepEqual(app.visible(), ['autumn']);
  });
}

test('latest menu choice wins when an earlier image decodes later', async () => {
  const app = start();
  await flush();
  app.menu('autumn');
  app.menu('spring');
  await app.ready('spring');
  assert.deepEqual(app.visible(), ['spring']);
  await app.ready('autumn');
  assert.deepEqual(app.visible(), ['spring']);
});

test('next completes winter → autumn → summer → spring → winter', async () => {
  const app = start();
  await flush();
  for (const expected of ['autumn', 'summer', 'spring', 'winter']) {
    app.next();
    await app.ready(expected);
    assert.deepEqual(app.visible(), [expected]);
  }
});

function layoutFixture(large) {
  const variables = new Map();
  const root = { style: {
    getPropertyValue: (name) => variables.get(name) || '',
    setProperty: (name, value) => variables.set(name, value)
  } };
  root.classList = element().classList;
  const stage = { style: { minHeight: '' }, getBoundingClientRect: () => ({ top: 0 }) };
  const header = { getBoundingClientRect: () => ({ bottom: large ? 200 : 60 }) };
  const nav = { getBoundingClientRect: () => ({ height: large ? 100 : 48 }) };
  const title = { getBoundingClientRect: () => ({
    bottom: (large ? 503 : 300) + Math.max(0, parseFloat(variables.get('--title-reserve-top')) - 130 || 0)
  }) };
  const copies = Object.fromEntries(seasons.map((id, index) => [id, {
    getBoundingClientRect: () => ({ height: large ? [200, 320, 190, 300][index] : 100 })
  }]));
  const status = Object.assign(element(), { getBoundingClientRect: () => ({ height: 400 }) });
  const frames = [];
  let resize = () => {};
  return {
    root, copies, status, stage, window: element(),
    nodes: { '.stage': stage, '.title': title, '.site-top': header, '.season-nav': nav },
    context: {
      requestAnimationFrame: (callback) => { frames.push(callback); },
      ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} },
      getComputedStyle: (node) => ({
        bottom: node === nav ? '20px' : Math.max(112, parseFloat(variables.get('--copy-reserve')) || 0) + 'px',
        getPropertyValue: () => '560px'
      })
    },
    resize: () => resize(),
    paint: () => frames.shift()?.()
  };
}

test('layout fits enlarged title, largest caption and navigation, including an error', () => {
  const layout = layoutFixture(true);
  start(layout);
  layout.paint();
  assert.equal(layout.stage.style.minHeight, '1097px');
  layout.status.classList.add('is-error');
  layout.resize();
  layout.paint();
  assert.equal(layout.stage.style.minHeight, '1177px');
});

test('normal captions retain the existing minimum scene height', () => {
  const layout = layoutFixture(false);
  start(layout);
  layout.paint();
  assert.equal(layout.stage.style.minHeight, '560px');
});
