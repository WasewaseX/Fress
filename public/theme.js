// Set the real theme AND language before first paint so the UI, the theme
// button and the text direction always agree.
// Kept as a plain file (not inline) so the app can run a strict script-src 'self' CSP.
(function () {
  try {
    var stored = localStorage.getItem('fress.theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;

    // Language/direction bootstrap: a stored non-English language used to
    // render its entire first paint as LTR-English-shaped (dir flipped only
    // after React's effect ran), so Persian users saw an RTL flash on every
    // load. The i18n provider still owns runtime switches; this only seeds
    // the pre-paint state from the same storage key.
    var storedLang = localStorage.getItem('fress.lang');
    if (storedLang === 'fa') {
      document.documentElement.lang = 'fa';
      document.documentElement.dir = 'rtl';
    } else {
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
    }

    // theme-color used to be created only by applyTheme() after React
    // mounted; give the first paint the correct meta too.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', theme === 'dark' ? '#090d16' : '#f3f0e8');
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
