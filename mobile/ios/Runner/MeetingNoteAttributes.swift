import ActivityKit
import Foundation

struct MeetingNoteAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var isPaused: Bool
        /// Recorded audio so far; shown as is while paused.
        var elapsedSeconds: Int
        /// `now - elapsed` when the state was sent, so the timer ticks on its own.
        var timerStart: Date
    }

    var noteId: String
}
