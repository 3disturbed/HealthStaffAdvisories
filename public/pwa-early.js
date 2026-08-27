// Loaded synchronously in <head> on every page, before the module scripts.
// Chrome can fire beforeinstallprompt before deferred modules execute; if
// nothing is listening at that moment the event is lost for the whole page
// visit, and the install button never appears.
window.__kellyInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window.__kellyInstallPrompt = e;
  window.dispatchEvent(new Event('kelly-installable'));
});
window.addEventListener('appinstalled', function () {
  window.__kellyInstallPrompt = null;
  window.dispatchEvent(new Event('kelly-installed'));
});
