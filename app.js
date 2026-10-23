(() => {
  'use strict';

  const root = document.documentElement;
  const order = ['winter', 'autumn', 'summer', 'spring'];
  const meta = {
    winter: { season: 'Зима', place: 'снежный гребень', next: 'К осени' },
    autumn: { season: 'Осень', place: 'лесная долина', next: 'К лету' },
    summer: { season: 'Лето', place: 'песчаный берег', next: 'К весне' },
    spring: { season: 'Весна', place: 'склон с сакурой', next: 'К зиме' }
  };

  const scenes = new Map(order.map((id) => [id, document.getElementById(id)]));
  const next = document.querySelector('.next');
  const nextLabel = document.querySelector('.next__label');
  const status = document.querySelector('.status');
  const links = [...document.querySelectorAll('.season-nav__link')];
  if ([...scenes.values()].some((el) => !el) || !next || !nextLabel || !status) return;

  // One decode promise per image; the previous scene stays until the next is ready.
  const decoded = new Map();
  const ready = (id) => {
    if (!decoded.has(id)) {
      const img = scenes.get(id).querySelector('.scene__img');
      const loaded = img.complete
        ? Promise.resolve(img.naturalWidth > 0)
        : new Promise((done) => {
            img.addEventListener('load', () => done(true), { once: true });
            img.addEventListener('error', () => done(false), { once: true });
          });
      decoded.set(id, loaded.then(async (ok) => {
        if (!ok) {
          scenes.get(id).classList.add('is-unavailable');
          return false;
        }
        try {
          if (img.decode) await img.decode();
          return img.naturalWidth > 0;
        } catch {
          scenes.get(id).classList.add('is-unavailable');
          return false;
        }
      }));
    }
    return decoded.get(id);
  };

  const fromHash = () => {
    const id = location.hash.slice(1);
    return order.includes(id) ? id : null;
  };
  const step = (id) => order[(order.indexOf(id) + 1) % order.length];

  let current = fromHash() || 'winter';
  let intent = 0;

  const render = (id, announce) => {
    status.classList.remove('is-error');
    scenes.forEach((el, key) => {
      const on = key === id;
      el.classList.toggle('is-active', on);
      el.toggleAttribute('inert', !on);
    });
    links.forEach((a) => {
      if (a.hash === '#' + id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });

    const m = meta[id];
    nextLabel.textContent = m.next;

    if (announce) {
      const title = scenes.get(id).querySelector('.scene__title').textContent;
      status.textContent = m.season + ', ' + m.place + '. ' + title;
    }
  };

  // Latest intent wins: a slow decode never overrides a newer choice.
  const go = (id, instant = false) => {
    if (!order.includes(id)) return;
    const token = ++intent;
    if (id === current) return;

    ready(id).then((ok) => {
      if (token !== intent) return;
      if (!ok) {
        status.textContent = 'Кадр не загрузился. Текущий сезон сохранён. Обновите страницу, чтобы попробовать снова.';
        status.classList.add('is-error');
        return;
      }
      root.classList.toggle('is-instant', instant);
      current = id;
      render(id, true);
      if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
    });
  };

  links.forEach((a) => {
    a.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(a.hash.slice(1), event.detail === 0);
    });
  });

  next.addEventListener('click', (event) => go(step(current), event.detail === 0));

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(step(current), true);
    }
  });

  window.addEventListener('hashchange', () => {
    const id = fromHash();
    if (id) go(id);
  });

  render(current, false);
  root.classList.add('is-ready');

  // Let enlarged text extend the stage while keeping the usual composition.
  const stage = document.querySelector('.stage');
  const title = document.querySelector('.title');
  const header = document.querySelector('.site-top');
  const nav = document.querySelector('.season-nav');
  const copies = [...scenes.values()].map((scene) => scene.querySelector('.scene__copy'));
  if (stage && title && header && nav && copies.every(Boolean) &&
      typeof getComputedStyle === 'function' && typeof requestAnimationFrame === 'function') {
    let pending = false;
    const reserve = (name, value) => {
      const px = Math.ceil(value) + 'px';
      if (root.style.getPropertyValue(name) !== px) root.style.setProperty(name, px);
    };
    const fit = () => {
      const top = stage.getBoundingClientRect().top;
      reserve('--title-reserve-top', header.getBoundingClientRect().bottom - top + 12);
      reserve('--copy-reserve', nav.getBoundingClientRect().height +
        (parseFloat(getComputedStyle(nav).bottom) || 0) + 24);

      const copyHeight = Math.max(...copies.map((copy) => copy.getBoundingClientRect().height),
        status.classList.contains('is-error') ? status.getBoundingClientRect().height : 0);
      const copyBottom = Math.max(...copies.map((copy) => parseFloat(getComputedStyle(copy).bottom) || 0));
      const minimum = parseFloat(getComputedStyle(root).getPropertyValue('--minimum-scene-height')) || 0;
      const height = Math.ceil(Math.max(minimum,
        title.getBoundingClientRect().bottom - top + 48 + copyHeight + copyBottom)) + 'px';
      if (stage.style.minHeight !== height) stage.style.minHeight = height;
    };
    const scheduleFit = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        fit();
      });
    };
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(scheduleFit);
      [title, header, ...copies, nav, status].forEach((node) => observer.observe(node));
    }
    window.addEventListener('resize', scheduleFit);
    document.fonts?.ready?.then(scheduleFit);
    scheduleFit();
  }

  const initial = current;
  ready(initial).then((ok) => {
    if (!ok && current === initial) {
      status.textContent = 'Кадр не загрузился. Выберите другой сезон или обновите страницу.';
      status.classList.add('is-error');
    }
    order.forEach(ready);
  });
})();
