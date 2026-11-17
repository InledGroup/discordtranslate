/**
 * Discord Translate — content script.
 *
 * 1. Añade "Traducir mensaje" al menú contextual propio de Discord (el menú de
 *    React, no el del navegador).
 * 2. Traduce con Google Translate vía el service worker (sin API key).
 * 3. Pinta la traducción debajo del mensaje o reemplazando el original.
 * 4. Modo automático: traduce los mensajes visibles a medida que aparecen.
 */
(() => {
  'use strict';

  if (window.__discordTranslateLoaded) return;
  window.__discordTranslateLoaded = true;

  const DEFAULTS = {
    enabled: true,
    autoTranslate: false,
    targetLang: 'es',
    // Ajustes independientes: una cosa es cómo se ve lo que traduce el modo
    // automático y otra lo que traduces a mano desde el menú.
    autoDisplayMode: 'below', // 'below' | 'replace'
    manualDisplayMode: 'below', // 'below' | 'replace'
  };

  const MSG_SELECTOR = 'li[id^="chat-messages-"], [data-list-item-id^="chat-messages___"]';
  const CONTENT_SELECTOR = '[id^="message-content-"]';
  const MAX_TEXT_LENGTH = 12000;
  const MENU_ICON_PATH =
    'M12.87 15.07l-2.54-2.51.03-.03a17.5 17.5 0 0 0 3.98-6.56H17V4h-5V2h-2v2H5v2h8.5a15.7 15.7 0 0 1-3.3 5.06A15.6 15.6 0 0 1 7.6 7.6H5.6a17.6 17.6 0 0 0 3.5 5.35L3.5 18.5 5 20l5.5-5.5 2.5 2.5.87-1.93zM18.5 11h-2l-4.5 12h2l1.12-3h4.75L21 23h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 18h-3.24z';

  function t(key, fallback) {
    const message = chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(key) : '';
    return message || fallback || key;
  }

  const settings = { ...DEFAULTS };
  const translationCache = new Map(); // clave mensaje+texto -> { translation, detected }
  const inflight = new Map(); // clave -> promesa
  let observed = new WeakSet(); // mensajes ya procesados por el modo automático

  const queue = [];
  let activeJobs = 0;
  let intersectionObserver = null;

  init();

  function init() {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      Object.assign(settings, sanitize(stored));
      onSettingsChanged({ initial: true });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      let touched = false;
      for (const key of Object.keys(DEFAULTS)) {
        if (!(key in changes)) continue;
        settings[key] = changes[key].newValue;
        touched = true;
      }
      if (!touched) return;
      Object.assign(settings, sanitize(settings));
      onSettingsChanged({});
    });

    watchContextMenu();
    watchFocusForEditing();
    watchMessages();

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message) return undefined;
      if (message.type === 'DGX_TRANSLATE_VISIBLE') {
        translateVisibleMessages();
        sendResponse({ ok: true });
      } else if (message.type === 'DGX_UNDO_ALL') {
        sendResponse({ ok: true, removed: undoTranslations() });
      }
      return undefined;
    });
  }

  function sanitize(source) {
    const next = { ...DEFAULTS, ...source };
    next.enabled = !!next.enabled;
    next.autoTranslate = !!next.autoTranslate;
    // Versiones anteriores tenían un único `displayMode`: lo usamos como valor
    // inicial de los dos ajustes nuevos, pero solo si no existen todavía (si no,
    // los valores por defecto ya los taparían).
    const legacy = source && source.displayMode === 'replace' ? 'replace' : 'below';
    next.autoDisplayMode = (source.autoDisplayMode ?? legacy) === 'replace' ? 'replace' : 'below';
    next.manualDisplayMode = (source.manualDisplayMode ?? legacy) === 'replace' ? 'replace' : 'below';
    delete next.displayMode;
    next.targetLang = /^[a-zA-Z]{2}(-[a-zA-Z]{2,4})?$/.test(String(next.targetLang))
      ? String(next.targetLang)
      : 'es';
    return next;
  }

  function onSettingsChanged({ initial }) {
    refreshDisplayMode();

    if (!settings.enabled) {
      removeAllTranslations();
      observed = new WeakSet(); // al reactivar, volver a traducir lo visible
      return;
    }

    if (initial || settings.autoTranslate) scanForMessages();
  }

  /* ------------------------------------------------------------------ *
   * 1. Menú contextual de Discord
   * ------------------------------------------------------------------ */

  function watchContextMenu() {
    document.addEventListener(
      'contextmenu',
      (event) => {
        if (!settings.enabled) return;
        const messageEl = closestMessage(event.target);
        if (!messageEl) return;
        waitForMenu(messageEl);
      },
      true, // captura: nos adelantamos a los listeners de Discord
    );
  }

  function closestMessage(target) {
    const element = target instanceof Element ? target : target && target.parentElement;
    if (!element) return null;
    const messageEl = element.closest(MSG_SELECTOR);
    if (!messageEl) return null;
    if (!getContentEl(messageEl)) return null;
    return messageEl;
  }

  /**
   * Id (snowflake) del mensaje a partir del id del `li`, que puede ser
   * `chat-messages-<canal>-<mensaje>` o `chat-messages___<canal>___<mensaje>`.
   */
  function getMessageId(messageEl) {
    const raw = messageEl.id || messageEl.getAttribute('data-list-item-id') || '';
    const parts = raw.split(/___|-/).filter(Boolean);
    const last = parts[parts.length - 1] || '';
    return /^\d{5,}$/.test(last) ? last : '';
  }

  /**
   * El contenido real del mensaje. Ojo: las respuestas incluyen una vista previa
   * del mensaje citado que también lleva un `[id^="message-content-"]` (con el id
   * del mensaje citado) y aparece antes en el DOM, así que hay que buscar por el
   * id propio del mensaje en lugar de quedarse con el primero que aparezca.
   */
  function getContentEl(messageEl) {
    const candidates = Array.from(messageEl.querySelectorAll(CONTENT_SELECTOR));
    if (!candidates.length) return null;

    const ownId = getMessageId(messageEl);
    if (ownId) {
      const exact = candidates.find((el) => el.id === `message-content-${ownId}`);
      if (exact) return exact;
    }

    const isPreview = (el) =>
      !!el.closest('[class*="repliedTextPreview"], [class*="repliedMessage"], [class*="threadMessageAccessory"]');
    return candidates.find((el) => !isPreview(el)) || candidates[candidates.length - 1];
  }

  function waitForMenu(messageEl) {
    const startedAt = Date.now();
    let timer = 0;

    const tick = () => {
      if (Date.now() - startedAt > 4000) {
        clearInterval(timer);
        return;
      }
      const menu = findMenuToDecorate();
      if (!menu) return;
      clearInterval(timer);
      addTranslateItem(menu, messageEl);
    };

    tick();
    timer = window.setInterval(tick, 60);
  }

  function findMenuToDecorate() {
    const menus = document.querySelectorAll('[role="menu"]');
    for (let i = menus.length - 1; i >= 0; i--) {
      const menu = menus[i];
      if (menu.querySelector('.dgx-menu-item')) continue;
      const rect = menu.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 20) continue;
      return menu;
    }
    return null;
  }

  function addTranslateItem(menu, messageEl) {
    // Clonamos un ítem real para heredar toda su estructura y clases hasheadas
    // (contenedor de icono, de etiqueta, tipografía) y que se vea idéntico.
    const sample = findRealMenuItem(menu);
    const item = buildTranslateItem(sample);

    const run = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      translateMessage(messageEl, { manual: true });
    };

    item.addEventListener('click', run);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') run(event);
    });

    placeMenuItem(menu, item, sample);
  }

  function buildTranslateItem(sample) {
    const text = t('menuTranslate', 'Translate message');
    const item = sample ? sample.cloneNode(true) : document.createElement('div');

    item.removeAttribute('id');
    item.removeAttribute('aria-haspopup');
    item.removeAttribute('aria-expanded');
    item.removeAttribute('aria-controls');
    item.removeAttribute('aria-label');
    item.removeAttribute('data-list-item-id');
    item.removeAttribute('data-marquee-active');
    item.removeAttribute('data-menu-item');
    item.classList.add('dgx-menu-item');
    if (sample) item.dataset.dgxNative = '1';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-label', text);
    item.tabIndex = -1; // que Discord no lo enfoque solo al abrir el menú

    // Fuera el chevron de submenú (el clon podría venir de "Añadir reacción").
    if (sample) {
      for (const caret of Array.from(item.querySelectorAll('[class*="caret_"]'))) {
        const holder = caret.closest('[class*="iconContainer"]');
        if (holder && holder !== item) holder.remove();
        else caret.remove();
      }
    }

    const label = item.querySelector('[class*="text_"]') || item.querySelector('[class*="label_"]');
    if (label) {
      label.textContent = text;
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      item.appendChild(span);
    }

    const leftHolder = item.querySelector('[class*="iconContainerLeft"]');
    let icon = leftHolder ? leftHolder.querySelector('svg') : null;
    if (!icon) {
      icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      if (leftHolder) leftHolder.replaceChildren(icon);
      else item.prepend(icon);
    }
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '24');
    icon.innerHTML = `<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="${MENU_ICON_PATH}"/>`;

    return item;
  }

  function placeMenuItem(menu, item, sample) {
    // Discord envuelve cada ítem en un <div> dentro de un [role="group"].
    const wrapper = sample && sample.parentElement;
    const group = wrapper && wrapper.parentElement;

    if (wrapper && group && group.getAttribute('role') === 'group') {
      const slot = document.createElement('div');
      slot.appendChild(item);
      group.insertBefore(slot, wrapper);
      return;
    }
    if (sample && wrapper && wrapper !== menu) {
      wrapper.parentElement.insertBefore(item, wrapper);
      return;
    }
    if (sample) {
      menu.insertBefore(item, sample);
      return;
    }
    (menu.querySelector('[role="group"]') || menu).appendChild(item);
  }

  function findRealMenuItem(menu) {
    let fallback = null;
    for (const candidate of menu.querySelectorAll('[role="menuitem"]')) {
      if (candidate.classList.contains('dgx-menu-item')) continue;
      if (!candidate.textContent.trim()) continue;
      const rect = candidate.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;
      if (candidate.querySelector('[class*="iconContainerLeft"]')) return candidate;
      if (!fallback) fallback = candidate;
    }
    return fallback;
  }

  function closeMenu() {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
  }

  /* ------------------------------------------------------------------ *
   * 2. Modo automático
   * ------------------------------------------------------------------ */

  function watchMessages() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(() => {
        scheduled = false;
        scanForMessages();
      }, 300);
    });

    const start = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  function getIntersectionObserver() {
    if (intersectionObserver) return intersectionObserver;
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          intersectionObserver.unobserve(entry.target);
          translateMessage(entry.target).catch(() => {});
        }
      },
      { root: null, rootMargin: '300px 0px' },
    );
    return intersectionObserver;
  }

  function scanForMessages() {
    if (!settings.enabled || !settings.autoTranslate) return;

    const messages = document.querySelectorAll(MSG_SELECTOR);
    const observer = getIntersectionObserver();

    for (const messageEl of messages) {
      if (observed.has(messageEl)) continue;
      if (!getContentEl(messageEl)) continue;
      observed.add(messageEl);
      // Los mensajes ya visibles se traducen al instante; el resto (historial
      // que aparece al hacer scroll) se deja al IntersectionObserver.
      if (isNearViewport(messageEl)) translateMessage(messageEl).catch(() => {});
      else observer.observe(messageEl);
    }
  }

  function isNearViewport(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return false; // todavía sin layout
    return rect.bottom > -400 && rect.top < window.innerHeight + 400;
  }

  function translateVisibleMessages() {
    // Acción masiva: usa el modo de visualización "manual" y sin spinner en
    // cada mensaje (el popup ya muestra el estado).
    for (const messageEl of document.querySelectorAll(MSG_SELECTOR)) {
      if (!isNearViewport(messageEl)) continue;
      translateMessage(messageEl, { mode: 'manual' }).catch(() => {});
    }
  }

  /**
   * Quita todas las traducciones de la pantalla. Los mensajes ya visibles se
   * marcan como procesados para que el modo automático no los vuelva a pintar
   * justo después (los mensajes nuevos sí se siguen traduciendo).
   */
  function undoTranslations() {
    let removed = 0;
    for (const messageEl of document.querySelectorAll(MSG_SELECTOR)) {
      observed.add(messageEl);
      if (getContentEl(messageEl)) removed += messageEl.querySelectorAll('.dgx-tr').length;
    }
    removeAllTranslations();
    return removed;
  }

  /** Deja de esconder el original si Discord mete un editor dentro del mensaje. */
  function watchFocusForEditing() {
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const hidden = target.closest('.dgx-orig-hidden');
        if (hidden) hidden.classList.remove('dgx-orig-hidden');
      },
      true,
    );
  }

  /* ------------------------------------------------------------------ *
   * 3. Traducción y render
   * ------------------------------------------------------------------ */

  function extractText(contentEl) {
    let out = '';
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('pre, code')) return NodeFilter.FILTER_REJECT; // código fuera
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue;
      if (out && !/\s$/.test(out) && !/^\s/.test(value)) out += ' ';
      out += value;
      node = walker.nextNode();
    }

    return out
      .replace(/\u200b/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  }

  async function translateMessage(messageEl, { manual = false, mode = null } = {}) {
    if (!settings.enabled && !manual) return;
    const displayMode = mode || (manual ? 'manual' : 'auto');

    const contentEl = getContentEl(messageEl);
    if (!contentEl) return;

    const text = extractText(contentEl);
    if (!text) {
      if (manual) renderError(contentEl, t('errorNoText', 'This message has no text to translate.'));
      return;
    }

    const cacheKey = `${contentEl.id}\u0000${text}`;
    let entry = translationCache.get(cacheKey);

    if (!entry && !manual) {
      // En automático no repetimos el trabajo ya hecho para este texto.
      const previous = inflight.get(cacheKey);
      if (previous) entry = await previous.catch(() => null);
    }

    if (manual && !entry) showLoading(contentEl);

    if (!entry) {
      const job = enqueue(() => requestTranslation(text)).then((result) => {
        translationCache.set(cacheKey, result);
        trimCache(translationCache, 500);
        return result;
      });

      inflight.set(cacheKey, job);
      try {
        entry = await job;
      } catch (error) {
        if (manual) renderError(contentEl, error.message || t('errorTranslateFailed', 'Could not translate.'));
        return;
      } finally {
        inflight.delete(cacheKey);
      }
    }

    const translation = String(entry.translation || '').trim();

    if (!manual) {
      // Lo que el usuario tradujo a mano manda: el automático no lo reemplaza.
      const existing = document.getElementById(`dgx-tr-${contentEl.id}`);
      if (existing && existing.dataset.dgxMode === 'manual') return;
      if (!translation) return;
      if (normalize(translation) === normalize(text)) return; // ya estaba en el idioma destino
    }

    renderTranslation(contentEl, translation || '(sin cambios)', text, displayMode);
  }

  function requestTranslation(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'DGX_TRANSLATE', text, targetLang: settings.targetLang },
        (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) return reject(new Error(lastError.message));
          if (!response || !response.ok) {
            return reject(new Error((response && response.error) || t('errorTranslateFailed', 'Could not translate.')));
          }
          resolve({ translation: response.translation, detected: response.detected });
        },
      );
    });
  }

  function enqueue(job) {
    return new Promise((resolve, reject) => {
      queue.push({ job, resolve, reject });
      pump();
    });
  }

  function pump() {
    const MAX_CONCURRENT = 2;
    while (activeJobs < MAX_CONCURRENT && queue.length) {
      const { job, resolve, reject } = queue.shift();
      activeJobs++;
      job()
        .then(resolve, reject)
        .finally(() => {
          activeJobs--;
          window.setTimeout(pump, 120);
        });
    }
  }

  function ensureNode(contentEl) {
    const id = `dgx-tr-${contentEl.id}`;
    let node = document.getElementById(id);

    if (!node) {
      node = document.createElement('div');
      node.id = id;
      node.className = 'dgx-tr';
      node.dataset.dgxFor = contentEl.id;
      node.setAttribute('role', 'note');
      node.dataset.dgxState = 'done';
      contentEl.insertAdjacentElement('afterend', node);
    } else if (!node.isConnected) {
      contentEl.insertAdjacentElement('afterend', node);
    } else if (node.previousElementSibling !== contentEl) {
      contentEl.insertAdjacentElement('afterend', node);
    }

    return node;
  }

  function showLoading(contentEl) {
    const node = ensureNode(contentEl);
    node.dataset.dgxState = 'loading';
    node.className = 'dgx-tr dgx-tr--loading';
    node.replaceChildren(document.createTextNode(t('stateTranslating', 'Translating…')));
  }

  function renderError(contentEl, message) {
    const node = ensureNode(contentEl);
    node.dataset.dgxState = 'error';
    node.className = 'dgx-tr dgx-tr--error';
    node.replaceChildren(document.createTextNode(message));
    contentEl.classList.remove('dgx-orig-hidden');
  }

  function renderTranslation(contentEl, translation, originalText, mode) {
    const node = ensureNode(contentEl);
    node.dataset.dgxState = 'done';
    node.dataset.dgxMode = mode;
    node.className = 'dgx-tr';
    node.title = originalText.length > 800 ? `${originalText.slice(0, 800)}…` : originalText;
    node.replaceChildren();

    const textSpan = document.createElement('span');
    textSpan.className = 'dgx-tr__text';
    textSpan.textContent = translation;
    node.appendChild(textSpan);

    applyDisplayMode(node, contentEl);
  }

  function applyDisplayMode(node, contentEl) {
    const preference =
      node.dataset.dgxMode === 'manual' ? settings.manualDisplayMode : settings.autoDisplayMode;
    const replace = preference === 'replace';
    node.classList.toggle('dgx-tr--replace', replace);
    node.classList.toggle('dgx-tr--below', !replace);
    contentEl.classList.toggle('dgx-orig-hidden', replace);

    const existingLabel = node.querySelector('.dgx-tr__label');
    if (replace) {
      if (existingLabel) existingLabel.remove();
      return;
    }
    if (node.dataset.dgxState !== 'done') return;

    const labelText = `🌐 ${settings.targetLang.toUpperCase().slice(0, 2)}`;
    if (existingLabel) {
      existingLabel.textContent = labelText;
    } else {
      const label = document.createElement('span');
      label.className = 'dgx-tr__label';
      label.textContent = labelText;
      node.prepend(label);
    }
  }

  function refreshDisplayMode() {
    const nodes = document.querySelectorAll('.dgx-tr[data-dgx-for]');
    for (const node of nodes) {
      const contentEl = document.getElementById(node.dataset.dgxFor);
      if (!contentEl) continue;
      const preference =
        node.dataset.dgxMode === 'manual' ? settings.manualDisplayMode : settings.autoDisplayMode;
      if (node.dataset.dgxState === 'done') applyDisplayMode(node, contentEl);
      else if (preference !== 'replace') contentEl.classList.remove('dgx-orig-hidden');
    }
  }

  function removeAllTranslations() {
    for (const node of document.querySelectorAll('.dgx-tr')) node.remove();
    for (const el of document.querySelectorAll('.dgx-orig-hidden')) el.classList.remove('dgx-orig-hidden');
  }

  function normalize(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function trimCache(map, max) {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
})();
