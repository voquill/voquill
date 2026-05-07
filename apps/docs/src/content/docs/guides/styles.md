---
title: Styles
description: Customize how Voquill cleans up your transcriptions with styles.
---

Styles (also called tones) control how Voquill's AI post-processes your raw transcription. After speech is converted to text, a language model rewrites it according to the active style's prompt.

## Built-in Styles

Voquill ships with several built-in styles:

- **Polished** — Natural, well-written text that preserves your voice and word choices. Fixes grammar, punctuation, and formatting while removing filler words and false starts.
- **Verbatim** — Exactly what you said with no editing or cleanup.
- **Email** — Professional email formatting with a greeting, body, and sign-off.
- **Chat** — Casual and concise, like you're typing in a chat app.
- **Formal** — Polished and professional register suitable for documents and correspondence.

## Enabling and Disabling Styles

You can choose which styles are available to you. Open the **Styles** page and click **Add Style** to toggle built-in and custom styles on or off. At least one style must remain enabled.

## Switching Styles

Select your active style from the main screen, or right-click the Voquill tray icon and use the **Style** submenu for quick access. The active style is applied to all subsequent transcriptions.

You can also set up hotkeys in **Settings > Shortcuts** to cycle between your enabled styles while dictating.

## Custom Styles

You can create your own styles with a custom prompt. When writing a prompt, use the `{transcript}` placeholder to indicate where the raw transcription should be inserted.

For example:

```
Rewrite the following transcript as bullet points:

{transcript}
```

Custom styles are stored locally and can be edited or deleted at any time.
