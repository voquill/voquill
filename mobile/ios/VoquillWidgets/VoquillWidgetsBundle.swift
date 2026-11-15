import SwiftUI
import WidgetKit

@main
struct VoquillWidgetsBundle: WidgetBundle {
    var body: some Widget {
        DictationLiveActivity()
        MeetingNoteLiveActivity()
    }
}
