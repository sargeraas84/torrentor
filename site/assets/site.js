(function () {
  'use strict';

  /* ---------- burger morph + full-screen overlay ---------- */
  var burger = document.querySelector('.burger');
  var overlay = document.querySelector('.overlay');
  if (burger && overlay) {
    function close() {
      burger.setAttribute('aria-expanded', 'false');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }
    burger.addEventListener('click', function () {
      var open = burger.getAttribute('aria-expanded') !== 'true';
      burger.setAttribute('aria-expanded', String(open));
      overlay.classList.toggle('open', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    overlay.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });
  }

  /* ---------- scroll reveals (IntersectionObserver, transform/opacity only) ---------- */
  var rvs = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window && rvs.length) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add('in');
            io.unobserve(en.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    rvs.forEach(function (el) { io.observe(el); });
  } else {
    rvs.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- stream bars fill on reveal (parallel-search card) ---------- */
  function runStream() {
    var fills = document.querySelectorAll('.stream .bar i');
    fills.forEach(function (f, i) {
      setTimeout(function () { f.classList.add('fill'); }, 350 + i * 420);
    });
  }
  if (document.querySelector('.stream')) {
    if ('IntersectionObserver' in window) {
      var streamCard = document.querySelector('.stream');
      var so = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) { runStream(); so.disconnect(); }
          });
        },
        { threshold: 0.35 }
      );
      so.observe(streamCard);
    } else {
      runStream();
    }
  }

  /* ---------- copy-to-clipboard on command rows ---------- */
  document.querySelectorAll('.cmd .cpy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.closest('.cmd').querySelector('code');
      var text = code ? code.textContent : '';
      function done() {
        btn.textContent = 'copied';
        btn.classList.add('ok');
        setTimeout(function () {
          btn.textContent = 'copy';
          btn.classList.remove('ok');
        }, 1800);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        done();
      }
    });
  });

  /* ---------- docs scrollspy ---------- */
  var spyLinks = document.querySelectorAll('.docs-nav a');
  if (spyLinks.length) {
    var sections = [];
    spyLinks.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if (el) sections.push({ id: id, el: el });
    });
    var active = spyLinks[0];
    function setActive(id) {
      spyLinks.forEach(function (a) {
        a.classList.toggle('on', a.getAttribute('href') === '#' + id);
      });
    }
    if ('IntersectionObserver' in window) {
      var spy = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) setActive(en.target.id);
          });
        },
        { rootMargin: '-20% 0px -70% 0px' }
      );
      sections.forEach(function (s) { spy.observe(s.el); });
    }
  }
})();