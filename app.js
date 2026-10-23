'use strict';

document.documentElement.classList.add('js');

document.addEventListener('DOMContentLoaded', function () {
  var scenes = document.getElementById('scenes');
  var seasons = Array.prototype.slice.call(scenes.querySelectorAll('.season'));
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.route a'));
  var status = document.getElementById('season-status');
  var ids = seasons.map(function (season) { return season.id; });
  var current = -1;

  function indexFromHash(hash) {
    return ids.indexOf((hash || '').replace('#', ''));
  }

  function show(index, options) {
    var opts = options || {};
    var nextIndex = (index + seasons.length) % seasons.length;
    if (nextIndex === current) return;
    current = nextIndex;

    seasons.forEach(function (season, i) {
      var active = i === current;
      season.classList.toggle('is-active', active);
      season.inert = !active;
    });

    navLinks.forEach(function (link, i) {
      if (i === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });

    var season = seasons[current];

    if (opts.updateUrl && window.history.replaceState) {
      window.history.replaceState(null, '', '#' + season.id);
    }

    if (opts.announce) {
      status.textContent = season.querySelector('.card__name').textContent + ', ' +
        season.querySelector('.card__count').textContent + '. ' +
        season.querySelector('h2').textContent;
    }

    if (opts.focusNext) {
      var heading = season.querySelector('h2');
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest('.route a, .next');
    if (!link) return;
    var index = indexFromHash(link.hash);
    if (index < 0) return;
    event.preventDefault();
    show(index, {
      announce: true,
      updateUrl: true,
      focusNext: link.classList.contains('next')
    });
  });

  window.addEventListener('hashchange', function () {
    var index = indexFromHash(window.location.hash);
    if (index >= 0) show(index, { announce: true });
  });

  var start = indexFromHash(window.location.hash);
  show(start < 0 ? 0 : start);

  // Переходы включаются только после первой отрисовки, чтобы старт был без мигания
  window.requestAnimationFrame(function () {
    window.requestAnimationFrame(function () {
      scenes.classList.add('is-ready');
    });
  });
});
