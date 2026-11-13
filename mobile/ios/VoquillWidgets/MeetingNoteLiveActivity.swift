import ActivityKit
import SwiftUI
import WidgetKit

struct MeetingNoteLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MeetingNoteAttributes.self) { context in
            MeetingNoteLockScreenView(state: context.state)
                .widgetURL(noteURL(context.attributes.noteId))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        MeetingNoteLogo(size: 24)
                        Text(title(context.state)).font(.headline)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    MeetingNoteElapsed(state: context.state)
                        .font(.headline.monospacedDigit())
                }
            } compactLeading: {
                MeetingNoteLogo(size: 16)
            } compactTrailing: {
                MeetingNoteElapsed(state: context.state)
                    .font(.caption.monospacedDigit())
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: context.state.isPaused ? "pause.fill" : "waveform")
                    .font(.system(size: 12))
            }
            .widgetURL(noteURL(context.attributes.noteId))
        }
    }
}

private func noteURL(_ noteId: String) -> URL {
    URL(string: "voquill://note?id=\(noteId)")!
}

private func title(_ state: MeetingNoteAttributes.ContentState) -> String {
    state.isPaused ? "Notes paused" : "Taking notes"
}

private struct MeetingNoteLogo: View {
    let size: CGFloat

    var body: some View {
        Image("VoquillLogo")
            .renderingMode(.template)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .foregroundColor(.primary)
            .clipShape(RoundedRectangle(cornerRadius: size / 4))
    }
}

/// Ticks on its own while recording; frozen while paused.
private struct MeetingNoteElapsed: View {
    let state: MeetingNoteAttributes.ContentState

    var body: some View {
        if state.isPaused {
            Text(formatElapsed(state.elapsedSeconds)).foregroundColor(.secondary)
        } else {
            Text(state.timerStart, style: .timer).multilineTextAlignment(.trailing)
        }
    }

    private func formatElapsed(_ seconds: Int) -> String {
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

private struct MeetingNoteLockScreenView: View {
    let state: MeetingNoteAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            MeetingNoteLogo(size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title(state)).font(.headline)
                Text(state.isPaused ? "Tap to resume" : "Recording your meeting")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            MeetingNoteElapsed(state: state)
                .font(.title3.monospacedDigit())
                .frame(maxWidth: 96, alignment: .trailing)
        }
        .padding()
    }
}
