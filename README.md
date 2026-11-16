# Discord Translate

Extensión de Chrome (Manifest V3) que traduce mensajes de **Discord Web** usando
**Google Translate sin API key**, sin cuenta y sin backend propio.

- **Botón en el menú de clic derecho de Discord**: `Traducir mensaje`.
- **Modo automático**: traduce los mensajes a medida que aparecen y el historial
  cuando hacés scroll.
- **Dos formas de mostrar el resultado**, configurables por separado para la
  traducción automática y para la del menú: debajo del original (bilingüe) o
  reemplazando el texto original.
- **Sin API keys**: usa el endpoint público que consume translate.google.com.
- **UI en el idioma del navegador**: los textos del popup y del menú usan
  `chrome.i18n` (hoy español e inglés; el resto cae a inglés) y la lista de
  idiomas se muestra con los nombres que el navegador usa para cada idioma.

## Instalación (modo desarrollador)

1. Descargá o cloná esta carpeta.
2. Abrí `chrome://extensions/` y activá **Modo de desarrollador**.
3. **Cargar descomprimida** → elegí la carpeta del proyecto (donde está
   `manifest.json`).
4. Abrí o recargá `https://discord.com/app` (F5). Sin recargar, el content
   script no está inyectado.
5. Hacé clic en el icono de la extensión para configurar idioma, modo y
   traducción automática. El popup tiene dos pestañas (**Automática** y
   **Desde el menú**) y una sección final con las acciones masivas.

Funciona en `discord.com`, `ptb.discord.com` y `canary.discord.com`.

## Uso

- **Manual**: clic derecho sobre cualquier mensaje → **Traducir mensaje**. La
  traducción aparece con una etiqueta `🌐 ES` y una barra a la izquierda.
- **Automático**: activá *Traducción automática* en el popup. Se traducen los
  mensajes visibles al entrar al canal y los nuevos al llegar. Los mensajes que
  ya están en el idioma destino no se duplican.
- **Reemplazar el original**: el texto original se oculta y queda la traducción.
  Pasando el mouse por encima se ve el original en el tooltip. Si abrís el editor
  de un mensaje, el original se muestra de nuevo automáticamente.
- **Traducir todos los mensajes visibles**: botón del popup para procesar el
  canal actual de una vez, aunque el automático esté apagado.
- **Deshacer traducciones**: quita todas las traducciones de la pestaña y deja
  los mensajes como estaban. En modo automático, los mensajes que ya estaban en
  pantalla no se vuelven a traducir hasta que cambies de canal o recargues; los
  nuevos sí.

El popup separa los ajustes en dos pestañas: **Automática** (interruptor de
traducción automática y cómo se muestran esas traducciones) y **Desde el menú**
(cómo se muestran las que lanzás a mano). Cada una guarda su propio modo, así que
activar o desactivar el automático no cambia el resultado del menú.

Los ajustes se guardan en `chrome.storage.sync` y se aplican en caliente sobre la
pestaña abierta (no hace falta recargar para cambiar idioma o modo).

## Cómo funciona

```
manifest.json          MV3, permisos mínimos (storage, activeTab)
src/background.js      Service worker: única salida a la red (evita CORS)
src/content.js         Menú contextual, extracción de texto, render, automático
src/content.css        Estilos con variables de tema de Discord
src/popup.html/.js/.css  Configuración
_locales/en|es         Textos de la interfaz (chrome.i18n)
icons/                 Iconos 16/48/128 (glifo Lucide "languages", MIT)
```

- **Menú contextual**: Discord dibuja sus propios menús en React, así que el
  `contextMenus` del navegador no sirve. El content script escucha
  `contextmenu` en fase de captura, recuerda el mensaje apuntado y espera a que
  aparezca el `[role="menu"]` de Discord para insertar el ítem con el mismo
  estilo. Al hacer clic se traduce y se cierra el menú con `Escape`.
- **Traducción**: `GET https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=<idioma>&dt=t&dj=1&q=...`
  (el endpoint público de la web de Translate). No requiere clave. Si falla por
  límite de peticiones o bloqueo, se reintenta con
  `clients5.google.com/translate_a/t?client=dict-chrome-ex` y de nuevo con el
  principal.
- **Textos largos**: se parten en trozos de ~1500 caracteres respetando párrafos
  y frases, y se unen de nuevo (Google rechaza textos muy largos en ese
  endpoint).
- **Extracción**: se recorren los nodos de texto del contenido del mensaje, así
  los emojis personalizados y los adjuntos no se envían, y los bloques de código
  (`pre`/`code`) se ignoran en lugar de traducirse.
- **Rendimiento**: caché en memoria por mensaje+texto, cola con máximo 2
  peticiones concurrentes y 120 ms entre tandas. El modo automático traduce los
  mensajes nuevos visibles al instante y usa `IntersectionObserver` solo para el
  historial que aparece al hacer scroll (de ahí la inspiración en extensiones
  existentes).

## Inspiración

Estas extensiones ya resuelven partes del problema y aportaron ideas:

- [HYAIPE/Auto-Translator-for-Discord](https://github.com/HYAIPE/Auto-Translator-for-Discord):
  traducción en vivo, caché por mensaje y límite de concurrencia.
- [yegetables/discord-translation-plugin](https://github.com/yegetables/discord-translation-plugin):
  modos bilingüe / solo traducción, excluir bloques de código y Google gratis
  como backend por defecto.
- [yuias/discord-message-translator](https://github.com/yuias/discord-message-translator):
  `IntersectionObserver` para traducir solo lo visible y caché por ID de mensaje.
- [Free Discord Translator (VasylDev)](https://vasyldev.com/discord-translator/):
  traducción debajo del mensaje y acceso al original al pasar el mouse.

Diferencias de esta implementación: menú contextual propio de Discord, sin
build ni dependencias, sin API key y sin permisos sobre todas las webs.

## Límites conocidos

- Depende del endpoint público de Google Translate: si Google lo cambia o limita
  el tráfico (HTTP 429), hay que esperar o usar menos mensajes automáticos.
- Si Discord cambia el DOM (`li[id^="chat-messages-"]`, `[role="menu"]`), hay que
  ajustar los selectores en `src/content.js`.
- No traduce el cuadro de escritura ni los embeds/adjuntos, solo el texto del
  mensaje.
- El modo reemplazo oculta el original con CSS; un cambio de texto por edición se
  refleja recién cuando el mensaje se vuelve a traducir.
- Uso personal: la traducción se pide desde tu navegador, no se envía nada a
  terceros más allá de Google Translate.
