/**
 * Service worker: única salida a la red.
 *
 * Usa el endpoint público de Google Translate que consume la propia web de
 * translate.google.com. No requiere API key ni cuenta. Como se llama desde el
 * service worker (con host_permissions en el manifest) no hay problemas de CORS.
 *
 * Si el endpoint principal falla (429, 5xx, bloqueo regional), se reintenta con
 * el endpoint "dict-chrome-ex" y luego otra vez con el principal.
 */

const MAX_CHUNK = 1500; // Google corta textos largos en el endpoint gtx
const MAX_CACHE = 400;

const cache = new Map(); // `${target}\u0000${text}` -> { translation, detected }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'DGX_TRANSLATE') return undefined;

  translate(message.text, message.targetLang).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: readableError(error) }),
  );

  return true; // respuesta asíncrona
});

function i18n(key, fallback) {
  const message = chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(key) : '';
  return message || fallback;
}

function readableError(error) {
  const text = String(error && error.message ? error.message : error);
  if (/429/.test(text)) {
    return i18n('errorRateLimited', 'Google Translate rate-limited the requests. Wait a few seconds.');
  }
  if (/Failed to fetch|NetworkError/i.test(text)) {
    return i18n('errorNetwork', 'Could not connect to Google Translate.');
  }
  return text || i18n('errorUnknown', 'Unknown error while translating.');
}

async function translate(rawText, rawTarget) {
  const text = String(rawText || '').trim();
  const targetLang = /^[a-zA-Z]{2}(-[a-zA-Z]{2,4})?$/.test(String(rawTarget || ''))
    ? String(rawTarget)
    : 'es';

  if (!text) return { translation: '', detected: '' };

  const cacheKey = `${targetLang}\u0000${text}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const chunks = splitChunks(text, MAX_CHUNK);
  const translatedChunks = [];
  let detected = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.trim()) {
      translatedChunks.push(chunk);
      continue;
    }
    const part = await translateChunk(chunk, targetLang);
    translatedChunks.push(part.translation);
    if (!detected && part.detected) detected = part.detected;
    if (i < chunks.length - 1) await sleep(120); // no saturar el endpoint
  }

  const result = { translation: translatedChunks.join('').trim(), detected };
  remember(cacheKey, result);
  return result;
}

function remember(key, value) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Parte el texto en trozos razonables respetando párrafos y frases. */
function splitChunks(text, max) {
  const chunks = [];
  let rest = text;

  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;

    const patterns = [/\n/g, /[.!?…]\s/g, /;\s/g, /,\s/g, /\s/g];
    for (const pattern of patterns) {
      let match;
      let lastEnd = -1;
      while ((match = pattern.exec(window)) !== null) {
        lastEnd = match.index + match[0].length;
        if (match[0].length === 0) break;
      }
      if (lastEnd > max * 0.4) {
        cut = lastEnd;
        break;
      }
    }

    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest) chunks.push(rest);
  return chunks;
}

async function translateChunk(text, targetLang) {
  const attempts = [
    () => requestGtx(text, targetLang),
    () => requestDictChromeEx(text, targetLang),
    () => requestGtx(text, targetLang),
  ];

  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await attempts[i]();
    } catch (error) {
      lastError = error;
      await sleep(250 * (i + 1));
    }
  }
  throw lastError;
}

async function requestGtx(text, targetLang) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1` +
    `&q=${encodeURIComponent(text)}`;

  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Google Translate respondió ${response.status}`);

  const data = await response.json();
  const sentences = Array.isArray(data && data.sentences) ? data.sentences : [];
  const translation = sentences.map((sentence) => (sentence && sentence.trans) || '').join('');

  if (!translation && !sentences.length) {
    throw new Error(i18n('errorEmptyResponse', 'Google Translate returned an empty response.'));
  }
  return { translation, detected: (data && data.src) || '' };
}

async function requestDictChromeEx(text, targetLang) {
  const url =
    'https://clients5.google.com/translate_a/t' +
    `?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(targetLang)}` +
    `&q=${encodeURIComponent(text)}`;

  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Google Translate respondió ${response.status}`);

  const data = await response.json();
  let translation = '';
  let detected = '';

  if (Array.isArray(data)) {
    if (typeof data[0] === 'string') {
      translation = data[0];
      detected = typeof data[1] === 'string' ? data[1] : '';
    } else if (Array.isArray(data[0])) {
      translation = data
        .map((part) => (Array.isArray(part) ? part[0] : typeof part === 'string' ? part : ''))
        .join('');
      const first = data[0];
      detected = Array.isArray(first) && typeof first[1] === 'string' ? first[1] : '';
    }
  } else if (typeof data === 'string') {
    translation = data;
  }

  if (!translation) throw new Error(i18n('errorEmptyResponse', 'Google Translate returned an empty response.'));
  return { translation, detected };
}
