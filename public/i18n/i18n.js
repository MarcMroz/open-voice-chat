(() => {
  const SUPPORTED_LANGUAGES = ['tr', 'en', 'es'];
  const DEFAULT_LANGUAGE = 'tr';
  const cache = {};

  const getNestedValue = (obj, path) => path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);

  const interpolate = (text, params = {}) =>
    text.replace(/\{(\w+)\}/g, (_, key) => (params[key] !== undefined ? params[key] : `{${key}}`));

  const detectBrowserLanguage = () => {
    const browserLanguage = (navigator.language || '').toLowerCase();
    if (browserLanguage.startsWith('en')) return 'en';
    if (browserLanguage.startsWith('es')) return 'es';
    if (browserLanguage.startsWith('tr')) return 'tr';
    return DEFAULT_LANGUAGE;
  };

  const getSavedLanguage = () => {
    const saved = localStorage.getItem('ovc-lang');
    return SUPPORTED_LANGUAGES.includes(saved) ? saved : detectBrowserLanguage();
  };

  const api = {
    language: getSavedLanguage(),
    strings: {},
    fallbackStrings: {},

    async init() {
      this.fallbackStrings = await this.load(DEFAULT_LANGUAGE);
      this.strings = this.language === DEFAULT_LANGUAGE ? this.fallbackStrings : await this.load(this.language);
      return this.language;
    },

    async load(language) {
      if (cache[language]) return cache[language];
      const response = await fetch(`/i18n/${language}.json`);
      cache[language] = await response.json();
      return cache[language];
    },

    async setLanguage(language) {
      if (!SUPPORTED_LANGUAGES.includes(language)) return this.language;
      this.language = language;
      localStorage.setItem('ovc-lang', language);
      this.strings = language === DEFAULT_LANGUAGE ? this.fallbackStrings : await this.load(language);
      return this.language;
    },

    t(key, params = {}) {
      const value = getNestedValue(this.strings, key) ?? getNestedValue(this.fallbackStrings, key) ?? key;
      return interpolate(value, params);
    }
  };

  window.i18n = api;
})();
