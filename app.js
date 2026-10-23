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
  let target = current;
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
    target = id;
    const token = ++intent;
    if (id === current) return;

    ready(id).then((ok) => {
      if (token !== intent) return;
      if (!ok) {
        target = current;
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

  next.addEventListener('click', (event) => go(step(target), event.detail === 0));

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(step(target), true);
    }
  });

  window.addEventListener('hashchange', () => {
    const id = fromHash();
    if (id) go(id);
  });

  render(current, false);
  root.classList.add('is-ready');
  const initial = current;
  ready(initial).then((ok) => {
    if (!ok && current === initial) {
      status.textContent = 'Кадр не загрузился. Выберите другой сезон или обновите страницу.';
      status.classList.add('is-error');
    }
    order.forEach(ready);
  });
})();
