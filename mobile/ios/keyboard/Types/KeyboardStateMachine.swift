import Foundation

enum KeyboardLayer { case alpha, numeric, symbol }
enum KeyboardCaseState { case lower, shift, capsLock }

final class KeyboardStateMachine {
    var layer: KeyboardLayer = .alpha
    var caseState: KeyboardCaseState = .lower
    private var lastShiftTapTime: Date?

    func onShiftTap() {
        guard layer == .alpha else { return }
        let now = Date()
        if let last = lastShiftTapTime, now.timeIntervalSince(last) < 0.3, caseState == .shift {
            caseState = .capsLock
            lastShiftTapTime = nil
        } else {
            caseState = caseState == .lower ? .shift : .lower
            lastShiftTapTime = now
        }
    }

    func onCharacterCommit() {
        if caseState == .shift { caseState = .lower }
    }

    func onModeTap() {
        switch layer {
        case .alpha: layer = .numeric
        case .numeric: layer = .symbol
        case .symbol: layer = .alpha
        }
    }
}
