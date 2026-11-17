<p align="center">
  <img src="icons/icon128.png" width="120" height="120" alt="Discord Translate icon" />
</p>

<h1 align="center">Discord Translate</h1>

<p align="center">
  Translate Discord messages in one right click — free, no API key, no account, no backend.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#known-limits">Known limits</a>
</p>

---

## What it does

- **“Translate message” in Discord’s own right-click menu.** Not the browser menu: the
  real Discord context menu, styled like the rest of its items.
- **Automatic mode** for messages that arrive while you read, and for the history
  that loads as you scroll.
- **Two ways to show the result, configured separately**: below the original
  (bilingual) or replacing it. Automatic translations and menu translations each
  keep their own preference, so flipping the automatic switch never changes how
  your manual translations look.
- **Bulk actions**: translate every visible message at once, or undo all
  translations in the tab.
- **No API keys**: it uses the same public Google Translate endpoint the
  translate.google.com web app uses.
- **Follows your browser language**: English by default, Spanish (Spain) when the
  browser UI is Spanish. Language names in the picker come from `Intl.DisplayNames`.

## Install

The extension is not on the Chrome Web Store; it loads as an unpacked extension.
It takes about a minute.

1. **Download the code.** Clone this repository or download it as a ZIP and unzip it
   somewhere you will keep it.
2. **Open the extensions page.** Go to `chrome://extensions/` in Chrome, Edge,
   Brave, Vivaldi or any other Chromium browser.
3. **Turn on Developer mode** (top-right toggle).
4. **Click “Load unpacked”** and pick the folder that contains `manifest.json`
   (the root of this project, not `src/`).
5. **Reload Discord.** Open or refresh `https://discord.com/app` (F5). Content
   scripts are only injected on load, so an already-open tab will not see the
   extension until you refresh it.
6. **Configure it** by clicking the extension icon: target language, automatic
   translation, and how translations are displayed.

Updates: after pulling new code, press the reload icon on the extension card in
`chrome://extensions/` and refresh the Discord tab.

Works on `discord.com`, `ptb.discord.com` and `canary.discord.com`.

## Usage

| Action | What happens |
| --- | --- |
| Right-click a message → **Translate message** | The translation appears under the original, or replaces it, depending on the *From the menu* settings. |
| Toggle **Automatic translation** | Every new visible message is translated; older ones are translated as they scroll into view. Manual translations are never overwritten. |
| **Translate all visible messages** (popup) | Translates the current channel once, even with automatic mode off. |
| **Undo translations** (popup) | Removes every translation in the tab and restores the original text. Automatic mode will not immediately repaint the messages that were on screen; new messages still get translated. |

In *replace* mode the original text is hidden and shown again as a tooltip on
hover, or automatically while you edit a message.

Settings live in `chrome.storage.sync` and are applied live to the open Discord
tab: changing the language or the display mode does not require a reload.

## How it works

```
manifest.json            MV3, minimal permissions (storage, activeTab)
src/background.js        Service worker: the only network caller (avoids CORS)
src/content.js           Context menu, text extraction, rendering, automatic mode
src/content.css          Styles built on Discord’s own theme variables
src/popup.html/.js/.css  Settings UI
_locales/en|es           Interface strings (chrome.i18n)
icons/                  16/48/128 icons (Lucide “languages” glyph, MIT)
```

- **Context menu.** Discord renders its menus in React, so `chrome.contextMenus`
  is useless here. The content script listens for `contextmenu` in the capture
  phase, remembers the message under the pointer and waits for Discord’s
  `[role="menu"]` to appear; it then clones a real `[role="menuitem"]` so the item
  inherits the hashed classes, icon slot and typography, and inserts it as the
  first entry. Clicking it translates the message and closes the menu with
  `Escape`.
- **Translation.** `GET https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=<lang>&dt=t&dj=1&q=…`
  — the public endpoint behind the Translate web app, no key required. If it
  fails (rate limit or block), it retries with
  `clients5.google.com/translate_a/t?client=dict-chrome-ex` and then the main one
  again.
- **Long messages** are split into ~1500-character chunks on paragraph and
  sentence boundaries and joined back, because that endpoint rejects very long
  input.
- **Text extraction** walks the message’s text nodes, so custom emojis and
  attachments are not sent, and `pre`/`code` blocks are skipped instead of being
  mangled.
- **Performance**: per-message in-memory cache, at most 2 concurrent requests
  with a 120 ms gap between batches. New visible messages are translated
  immediately; `IntersectionObserver` is only used for history that appears while
  scrolling.

## Built with AI, reviewed by a human

This project was written with AI coding agents and then reviewed, tested and
corrected by a human. That is how Inled ships software: the agents do the typing,
a person is accountable for the result. Bugs can still slip through — if you find
one, please open an issue with the Discord tab’s console output.

## Known limits

- It depends on Google’s public endpoint: if Google changes or throttles it
  (HTTP 429), wait a bit or rely less on automatic mode.
- Discord DOM changes (`li[id^="chat-messages-"]`, `[role="menu"]`) require
  selector updates in `src/content.js`.
- It translates message text only — not the composer, embeds or attachments.
- Replace mode hides the original with CSS; an edited message is re-translated
  only when it is translated again.
- For personal use: translations are requested from your browser, and nothing is
  sent anywhere except Google Translate.

## Inspiration

- [HYAIPE/Auto-Translator-for-Discord](https://github.com/HYAIPE/Auto-Translator-for-Discord):
  live translation, per-message cache and concurrency limits.
- [yegetables/discord-translation-plugin](https://github.com/yegetables/discord-translation-plugin):
  bilingual / translation-only modes, skipping code blocks, free Google backend.
- [yuias/discord-message-translator](https://github.com/yuias/discord-message-translator):
  `IntersectionObserver` to translate only what is visible, cache by message ID.
- [Free Discord Translator (VasylDev)](https://vasyldev.com/discord-translator/):
  translation below the message and original text on hover.

What is different here: Discord’s own context menu, no build step and no
dependencies, no API key, and no permission over every website.
