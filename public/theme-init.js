// Pre-paint theme bootstrap. This runs before React mounts so the page is
// never painted in the wrong theme and the toggle icon always matches.
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
