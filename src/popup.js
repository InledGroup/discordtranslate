const DEFAULTS = {
  enabled: true,
  autoTranslate: false,
  targetLang: 'es',
  autoDisplayMode: 'below',
  manualDisplayMode: 'below',
};

const PANELS = ['auto', 'manual'];

// Solo los códigos: los nombres se generan en el idioma del navegador con
// Intl.DisplayNames, así no hay que traducir cuarenta listas a mano.
const LANGUAGES = [
  'es',
  'en',
  'pt',
  'fr',
  'de',
  'it',
  'ru',
  'ja',
  'ko',
  'zh-CN',
  'zh-TW',
  'ar',
  'hi',
  'id',
  'tr',
  'pl',
  'nl',
  'sv',
  'uk',
  'vi',
  'th',
  'fa',
  'he',
  'el',
  'cs',
  'ro',
  'hu',
  'fi',
  'da',
  'no',
  'bg',
  'sr',
  'hr',
  'sk',
  'ms',
  'tl',
  'ca',
  'eu',
  'gl',
  'bn',
  'ur',
  'ta',
  'te',
  'ml',
  'sw',
  'af',
  'et',
  'lt',
  'lv',
  'sl',
];

const els = {
  enabled: document.getElementById('enabled'),
  autoTranslate: document.getElementById('autoTranslate'),
  targetLang: document.getElementById('targetLang'),
  autoModes: Array.from(document.querySelectorAll('input[name="autoDisplayMode"]')),
  manualModes: Array.from(document.querySelectorAll('input[name="manualDisplayMode"]')),
  tabs: Array.from(document.querySelectorAll('.tab')),
  panels: {
    auto: document.getElementById('panel-auto'),
    manual: document.getElementById('panel-manual'),
  },
  translateVisible: document.getElementById('translateVisible'),
  undo: document.getElementById('undo'),
  status: document.getElementById('status'),
};

const uiLanguage =
  (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || 'en';

function t(key, fallback) {
  const message = chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(key) : '';
  return message || fallback || key;
}

applyI18n();
fillLanguages();

chrome.storage.sync.get({ ...DEFAULTS, activePanel: 'auto' }, (stored) => {
  paint({ ...DEFAULTS, ...migrate(stored) });
  showPanel(PANELS.includes(stored.activePanel) ? stored.activePanel : 'auto', false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const patch = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key in changes) patch[key] = changes[key].newValue;
  }
  if (Object.keys(patch).length) paint({ ...DEFAULTS, ...migrate({ ...patch }) });
});

function applyI18n() {
  document.documentElement.lang = uiLanguage;
  document.title = t('actionTitle', 'Discord Translate');
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, el.textContent);
  }
}

function fillLanguages() {
  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames([uiLanguage], { type: 'language' });
  } catch {
    displayNames = null;
  }

  for (const code of LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    let label = code;
    try {
      label = (displayNames && displayNames.of(code)) || code;
    } catch {
      label = code;
    }
    option.textContent = label.charAt(0).toUpperCase() + label.slice(1);
    els.targetLang.appendChild(option);
  }
}

/** Versiones anteriores guardaban un solo `displayMode` para todo. */
function migrate(settings) {
  if (!('displayMode' in settings)) return settings;
  const legacy = settings.displayMode === 'replace' ? 'replace' : 'below';
  return {
    ...settings,
    autoDisplayMode: settings.autoDisplayMode || legacy,
    manualDisplayMode: settings.manualDisplayMode || legacy,
  };
}

function paint(settings) {
  els.enabled.checked = !!settings.enabled;
  els.autoTranslate.checked = !!settings.autoTranslate;
  els.targetLang.value = settings.targetLang;
  setRadio(els.autoModes, settings.autoDisplayMode);
  setRadio(els.manualModes, settings.manualDisplayMode);
}

function setRadio(inputs, value) {
  for (const input of inputs) input.checked = input.value === value;
}

function showPanel(name, persist = true) {
  for (const [key, panel] of Object.entries(els.panels)) panel.hidden = key !== name;
  for (const tab of els.tabs) {
    const active = tab.dataset.panel === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  if (persist) chrome.storage.sync.set({ activePanel: name });
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
els.autoTranslate.addEventListener('change', () => save({ autoTranslate: els.autoTranslate.checked }));
els.targetLang.addEventListener('change', () => save({ targetLang: els.targetLang.value }));
for (const input of els.autoModes) {
  input.addEventListener('change', () => {
    if (input.checked) save({ autoDisplayMode: input.value });
  });
}
for (const input of els.manualModes) {
  input.addEventListener('change', () => {
    if (input.checked) save({ manualDisplayMode: input.value });
  });
}

for (const tab of els.tabs) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = els.tabs.indexOf(tab);
    const next = els.tabs[(index + (event.key === 'ArrowRight' ? 1 : els.tabs.length - 1)) % els.tabs.length];
    showPanel(next.dataset.panel);
    next.focus();
  });
}

els.translateVisible.addEventListener('click', () => {
  sendToDiscord('DGX_TRANSLATE_VISIBLE', 'statusTranslatingVisible');
});

els.undo.addEventListener('click', () => {
  sendToDiscord('DGX_UNDO_ALL', 'statusUndone');
});

function sendToDiscord(type, successKey) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab || !tab.id) {
      setStatus(t('statusNoDiscord', 'Abrí Discord en esta pestaña.'));
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type }, () => {
      if (chrome.runtime.lastError) {
        setStatus(t('statusReloadDiscord', 'No se pudo contactar Discord. Recargá la pestaña (F5).'));
        return;
      }
      setStatus(t(successKey, ''));
    });
  });
}

function setStatus(message) {
  els.status.textContent = message;
}
