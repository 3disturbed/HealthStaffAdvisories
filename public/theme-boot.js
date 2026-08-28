// Synchronous theme boot — must run in <head> before the body paints so
// dark mode never flashes white. CSP-safe (external classic script).
(function () {
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try { return localStorage.getItem('kelly-theme') || 'auto'; } catch (e) { return 'auto'; }
  }

  function resolve(pref) {
    return pref === 'light' || pref === 'dark' ? pref : (mq.matches ? 'dark' : 'light');
  }

  function apply(pref) {
    var theme = resolve(pref);
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d1622' : '#005eb8');
  }

  // Pages can call this from the Account appearance control.
  window.__kellySetTheme = function (pref) {
    try { localStorage.setItem('kelly-theme', pref); } catch (e) { /* private mode */ }
    apply(pref);
  };
  window.__kellyThemePref = stored;

  document.documentElement.classList.add('js');
  apply(stored());
  mq.addEventListener('change', function () {
    if (stored() === 'auto') apply('auto');
  });
})();
