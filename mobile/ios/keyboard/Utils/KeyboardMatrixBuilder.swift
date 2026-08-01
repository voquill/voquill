import UIKit

final class KeyboardMatrixBuilder {
    private static let kShiftButtonTag = 0x5348_4946  // "SHIF"
    private let onKeyTap: (KeyboardKeySpec) -> Void

    init(onKeyTap: @escaping (KeyboardKeySpec) -> Void) {
        self.onKeyTap = onKeyTap
    }

    func buildMatrix(layout: KeyboardLayoutSpec, state: KeyboardStateMachine, isDark: Bool) -> UIView {
        let container = UIStackView()
        container.axis = .vertical
        container.distribution = .fillEqually
        container.spacing = 6
        container.layoutMargins = UIEdgeInsets(top: 8, left: 4, bottom: 4, right: 4)
        container.isLayoutMarginsRelativeArrangement = true

        let rows = rowsForState(layout: layout, state: state)
        for row in rows {
            let rowView = buildRow(keys: row, state: state, isDark: isDark)
            container.addArrangedSubview(rowView)
        }

        let bottomRowView = buildBottomRow(bottomRow: layout.bottomRow, state: state, isDark: isDark)
        container.addArrangedSubview(bottomRowView)

        return container
    }

    func updateShiftKey(in matrixView: UIView, state: KeyboardStateMachine) {
        matrixView.subviews.forEach { rowView in
            (rowView as? UIStackView)?.arrangedSubviews.forEach { keyView in
                if keyView.tag == KeyboardMatrixBuilder.kShiftButtonTag {
                    (keyView as? UIButton)?.setTitle(shiftLabel(state), for: .normal)
                }
            }
        }
    }

    private func rowsForState(layout: KeyboardLayoutSpec, state: KeyboardStateMachine) -> [[KeyboardKeySpec]] {
        switch state.layer {
        case .alpha: return layout.alphaRows
        case .numeric: return layout.numericRows
        case .symbol: return layout.symbolRows
        }
    }

    private func buildRow(keys: [KeyboardKeySpec], state: KeyboardStateMachine, isDark: Bool) -> UIView {
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.distribution = .fill
        stack.spacing = 6

        let totalFlex = keys.reduce(0) { $0 + $1.flex }
        let n = CGFloat(keys.count)

        for key in keys {
            let btn = makeKeyButton(key: key, state: state, isDark: isDark)
            stack.addArrangedSubview(btn)
            // Account for inter-key spacing so widths don't over-constrain the stack
            let spacingShare = stack.spacing * (n - 1) * CGFloat(key.flex) / CGFloat(totalFlex)
            btn.widthAnchor.constraint(
                equalTo: stack.widthAnchor,
                multiplier: CGFloat(key.flex) / CGFloat(totalFlex),
                constant: -spacingShare
            ).isActive = true
        }
        return stack
    }

    private func buildBottomRow(bottomRow: KeyboardBottomRow, state: KeyboardStateMachine, isDark: Bool) -> UIView {
        let keys = [bottomRow.mode, bottomRow.globe, bottomRow.space, bottomRow.delete, bottomRow.enter]
        return buildRow(keys: keys, state: state, isDark: isDark)
    }

    private func makeKeyButton(key: KeyboardKeySpec, state: KeyboardStateMachine, isDark: Bool) -> UIButton {
        let btn = UIButton(type: .custom)
        btn.translatesAutoresizingMaskIntoConstraints = false

        var label = key.label
        if key.role == .character {
            label = state.caseState != .lower ? key.label.uppercased() : key.label.lowercased()
        } else if key.role == .shift {
            label = shiftLabel(state)
            btn.tag = KeyboardMatrixBuilder.kShiftButtonTag
        } else if key.role == .mode {
            label = modeLabel(state)
        }
        btn.setTitle(label, for: .normal)
        btn.titleLabel?.font = .systemFont(ofSize: 16, weight: .regular)

        let isFunctional = [KeyboardKeyRole.delete, .shift, .mode, .globe, .enter].contains(key.role)
        btn.backgroundColor = isDark
            ? (isFunctional ? UIColor(white: 0.35, alpha: 1) : UIColor(white: 0.18, alpha: 1))
            : (isFunctional ? UIColor(white: 0.73, alpha: 1) : .white)
        btn.setTitleColor(isDark ? .white : .black, for: .normal)
        btn.layer.cornerRadius = 5
        btn.layer.shadowColor = UIColor.black.cgColor
        btn.layer.shadowOffset = CGSize(width: 0, height: 1)
        btn.layer.shadowOpacity = 0.3
        btn.layer.shadowRadius = 0
        btn.clipsToBounds = false

        let keySpec = key
        btn.addAction(UIAction { [weak self] _ in self?.onKeyTap(keySpec) }, for: .touchUpInside)

        return btn
    }

    private func shiftLabel(_ state: KeyboardStateMachine) -> String {
        switch state.caseState {
        case .lower: return "⇧"
        case .shift: return "⬆"
        case .capsLock: return "⇪"
        }
    }

    private func modeLabel(_ state: KeyboardStateMachine) -> String {
        switch state.layer {
        case .alpha: return "123"
        case .numeric: return "#+="
        case .symbol: return "ABC"
        }
    }
}
