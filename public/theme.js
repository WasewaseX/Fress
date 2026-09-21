// Set the real theme before first paint so the UI and the theme button always agree.
// Kept as a plain file (not inline) so the app can run a strict script-src 'self' CSP.
(function () {
  try {
    var stored = localStorage.getItem('fress.theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
