---
title: Post-Processing
description: How Voquill uses AI to clean up your transcriptions.
---

After your speech is transcribed, Voquill runs a post-processing step that uses a large language model to clean up the raw text.

## How It Works

1. You record audio and it gets transcribed to raw text (via local Whisper or the Groq API).
2. The raw transcript is combined with your active [style](/guides/styles/) prompt and any [dictionary](/guides/dictionary/) glossary terms.
3. This combined prompt is sent to a language model that rewrites the text according to your style.
4. The cleaned-up result is what you see (and what gets pasted if auto-paste is enabled).

Both the raw transcript and the post-processed version are saved, so you can always see the original.

## Post-Processing Modes

Post-processing follows the same mode as your transcription setting:

- **Local** — Not currently supported for post-processing. Raw transcripts are returned as-is.
- **API** — Uses your Groq API key to call a language model directly.
- **Cloud** — Routes through Voquill's cloud service.

## Disabling Post-Processing

If you prefer raw transcriptions without any AI cleanup, select the **Verbatim** style, which returns exactly what you said with no editing. You can also disable post-processing entirely in settings.
