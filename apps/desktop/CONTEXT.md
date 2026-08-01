# Desktop

The Voquill desktop dictation app (Tauri: Rust native layer + TypeScript/React brain).

## Language

These four terms all describe "what language the user is dictating in", but they are distinct and were previously easy to conflate.

**Primary Dictation Language**:
The user's configured default dictation language. Persisted as `preferredLanguage`; falls back to the system locale when unset. This is what the settings dialog's top selector edits.
_Avoid_: default language, main language

**Active Dictation Language**:
The currently-selected dictation language, sticky across recordings until the user changes it. Persisted as `activeDictationLanguage`, where the sentinel value `primary` means "follow the Primary Dictation Language". This is what the tray language switcher sets.
_Avoid_: current language, selected language

**Dictation Language Override**:
A transient, single-recording language forced by holding an additional-language hotkey. Lives in memory only and resets to null after the recording stops. Takes precedence over the Active Dictation Language.
_Avoid_: temporary language, hotkey language

**Auto Mode**:
The dictation language value `auto`, meaning the transcription engine detects the spoken language itself rather than being told. A selectable language value, not a separate setting.
_Avoid_: auto-detect (as a noun), detection mode
