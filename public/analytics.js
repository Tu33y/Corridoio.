(function () {
  const measurementId = 'G-Z2FQ48N1Y9';
  const consentKey = 'corridoio.analyticsConsent.v1';
  const root = document.getElementById('consent-root');
  let consent = null;
  let preferencesOpen = false;

  function readConsent() {
    try {
      const saved = window.localStorage.getItem(consentKey);
      return saved === 'accepted' || saved === 'rejected' ? saved : null;
    } catch (error) {
      console.error('Unable to read analytics consent', error);
      return null;
    }
  }

  function saveConsent(value) {
    consent = value;
    try {
      window.localStorage.setItem(consentKey, value);
    } catch (error) {
      console.error('Unable to save analytics consent', error);
    }
  }

  function updateGoogleConsent(analyticsStorage) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('consent', 'update', {
      analytics_storage: analyticsStorage,
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
  }

  function clearAnalyticsCookies() {
    const cookieNames = document.cookie
      .split(';')
      .map(function (cookie) { return cookie.trim().split('=')[0]; })
      .filter(function (name) {
        return name === '_ga' || name === '_gid' || name.indexOf('_ga_') === 0 ||
          name.indexOf('_gat') === 0 || name.indexOf('_gac_') === 0;
      });
    const hostParts = window.location.hostname.split('.');
    const domains = [window.location.hostname];
    if (hostParts.length > 1) domains.push('.' + hostParts.slice(-2).join('.'));

    cookieNames.forEach(function (name) {
      document.cookie = name + '=; Max-Age=0; path=/; SameSite=Lax';
      domains.forEach(function (domain) {
        document.cookie = name + '=; Max-Age=0; path=/; domain=' + domain + '; SameSite=Lax';
      });
    });
  }

  function loadAnalytics() {
    if (window.__corridoioAnalyticsLoaded) {
      updateGoogleConsent('granted');
      return;
    }
    window.__corridoioAnalyticsLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () {
      window.dataLayer.push(arguments);
    };
    window.gtag('consent', 'default', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    updateGoogleConsent('granted');
    window.gtag('js', new Date());
    window.gtag('config', measurementId, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
    script.onerror = function () {
      window.__corridoioAnalyticsLoaded = false;
      console.error('Unable to load Google Analytics');
    };
    document.head.appendChild(script);
  }

  function setConsent(value) {
    saveConsent(value);
    preferencesOpen = false;
    if (value === 'accepted') {
      loadAnalytics();
    } else {
      updateGoogleConsent('denied');
      clearAnalyticsCookies();
    }
    render();
  }

  function render() {
    if (!root) return;
    if (consent && !preferencesOpen) {
      root.innerHTML = '<button class="privacy-settings" type="button" data-action="open" aria-label="Apri le preferenze privacy">Preferenze privacy</button>';
      return;
    }

    root.innerHTML = '<section class="consent-panel" role="dialog" aria-modal="false" aria-labelledby="consent-title" aria-describedby="consent-description">' +
      '<h2 id="consent-title">La tua privacy</h2>' +
      '<p id="consent-description">Corridoio usa Google Analytics per capire come viene utilizzato il sito e migliorarlo. I dati analitici vengono inviati solo se acconsenti. Puoi cambiare scelta in qualsiasi momento dalle preferenze privacy.</p>' +
      '<div class="consent-actions">' +
      '<button class="consent-reject" type="button" data-action="reject">Rifiuta</button>' +
      '<button class="consent-accept" type="button" data-action="accept">Accetta analytics</button>' +
      (consent ? '<button class="consent-close" type="button" data-action="close">Chiudi</button>' : '') +
      '</div></section>';
  }

  if (root) {
    root.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'accept') setConsent('accepted');
      if (button.dataset.action === 'reject') setConsent('rejected');
      if (button.dataset.action === 'open') {
        preferencesOpen = true;
        render();
      }
      if (button.dataset.action === 'close') {
        preferencesOpen = false;
        render();
      }
    });
  }

  consent = readConsent();
  if (consent === 'accepted') loadAnalytics();
  render();
})();
