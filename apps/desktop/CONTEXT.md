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

## Notes

**Note**:
A recorded meeting or an imported transcript, with its AI notes, the user's own notes ("My notes", `personalNotes`) and its transcript. Stored in SQLite whether it is `local` or (later) `cloud`; its storage is fixed when it is created.
_Avoid_: meeting (for the record itself), conversation, chat

**Segment**:
One contiguous piece of a note's audio, one file on disk. Pausing, resuming and Resume on a ready note each start a new segment; the note transcript is its segments' transcripts in order.
_Avoid_: chunk (a chunk is a slice of a segment sent to transcription)

**Meeting capture**:
The microphone recording, mixed with the system audio where the platform allows, that feeds a note's segments. Independent of the dictation recorder, so dictation keeps working while a meeting records.
_Avoid_: recording (ambiguous with dictation)

**System audio**:
What the computer plays (the other people on a call), captured apart from any microphone so a meeting hears them even through headphones. It only ever adds to the microphone's recording; the UI calls it "computer audio".
_Avoid_: loopback, desktop audio

**Note pipeline**:
Where a note's network-bound work runs once the user stops: transcription, AI notes and title, search and Ask. The local pipeline uses the user's transcription and post-processing modes.

## Integrations

**Calendar account**:
A Google account the user linked in Settings so Voquill can read its calendars. Stored on this device only, with its refresh token encrypted in SQLite; linking is per device and does not follow the Voquill account.
_Avoid_: integration (for one account), connection

**Linked calendar**:
A calendar inside a calendar account whose events get reminders. A new account starts with only its primary calendar linked.
_Avoid_: selected calendar, enabled calendar

**Event reminder**:
The card shown at the top right of the screen from one minute before a timed event starts until the user dismisses it or the event ends. All-day, cancelled and declined events never get one. A dismissal is remembered until the event ends, so a restart does not bring the card back.
_Avoid_: notification (the OS has those), alert, toast (the pill has those)

**Wake timer**:
A one-shot timer in Rust that the reminder logic re-arms on every tick. The webview's own timers stop while the main window is hidden, so anything that must run on time there is driven from it.
_Avoid_: interval, heartbeat
