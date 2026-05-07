# Agent Progress Log

## 2026-02-27: Voice-to-Text Empty Transcription Bug Fix

### Problem
User reported that voice-to-text is not generating any words when speaking into the microphone.

### Root Cause Analysis
1. **Silent failure in `stop_recording` command** (`apps/desktop/src-tauri/src/commands.rs:865-899`)
   - When `stop_recording` was called with no active recording, it returned `{ samples: [], sample_rate: 0 }` instead of an error
   - This silent failure propagated through the system with no user-visible error message

2. **Silent handling in `BatchTranscriptionSession`** (`apps/desktop/src/sessions/batch-transcription-session.ts:27-34`)
   - When sample rate was 0 or samples were empty, it just logged a warning and returned `rawTranscript: null`
   - No error was shown to the user

### Changes Made

#### 1. `apps/desktop/src-tauri/src/commands.rs`
- Changed `stop_recording` to return an error instead of empty response when no recording is active
- Added warning log when recording stops with empty samples
- Improved error messages for better debugging

```rust
// Before: Silent failure
if not_recording {
    return Ok(StopRecordingResponse {
        samples: Vec::new(),
        sample_rate: 0,
    });
}

// After: Proper error
if not_recording {
    eprintln!("[recording] error: stop_recording called but no recording is active");
    return Err("No recording is active. Please start a recording first.".to_string());
}
```

#### 2. `apps/desktop/src/sessions/batch-transcription-session.ts`
- Added user-visible error snackbar when audio capture fails
- Changed log level from `warning` to `error` for empty audio cases
- Added specific error messages for different failure modes

```typescript
// Before: Silent warning
getLogger().warning(`Batch session: skipping transcription...`);
return { rawTranscript: null, metadata: {}, warnings: [] };

// After: User-visible error
getLogger().error(`Batch session: cannot transcribe - ${reason}...`);
showErrorSnackbar("No audio was captured. Please check your microphone...");
return { rawTranscript: null, metadata: {}, warnings: ["Recording produced no usable audio"] };
```

### Status: IN PROGRESS
- [x] Fix silent failure when stop_recording is called with no active recording
- [x] Add user-visible error when audio capture produces empty samples
- [x] Add logging for audio capture diagnostics
- [ ] Verify TypeScript types compile
- [ ] Test the fix with actual microphone

### Remaining Work
1. Run TypeScript type check to verify changes compile
2. User needs to rebuild and test with actual microphone
3. May need additional diagnostics if issue persists after these fixes

### Potential Further Issues to Investigate
If the fix doesn't resolve the issue, the problem could be:
1. **Microphone device selection** - Audio device enumeration may be selecting wrong device
2. **Audio stream not capturing** - Stream is created but no data flows through
3. **Whisper model issues** - Model not loaded or not transcribing correctly

### Key Files Modified
- `apps/desktop/src-tauri/src/commands.rs`
- `apps/desktop/src/sessions/batch-transcription-session.ts`

### Key Files Reviewed (Not Modified)
- `apps/desktop/src-tauri/src/platform/audio.rs` - Audio capture implementation
- `apps/desktop/src-tauri/src/platform/whisper.rs` - Whisper transcription
- `apps/desktop/src-tauri/src/platform/linux/audio.rs` - Linux audio device naming
- `apps/desktop/src/components/root/RootSideEffects.ts` - Recording flow orchestration
- `apps/desktop/src/actions/transcribe.actions.ts` - Transcription actions