import Foundation

struct KeyboardBottomRow {
    let mode: KeyboardKeySpec
    let globe: KeyboardKeySpec
    let space: KeyboardKeySpec
    let delete: KeyboardKeySpec
    let enter: KeyboardKeySpec
}

struct KeyboardLayoutSpec {
    let languageCode: String
    let alphaRows: [[KeyboardKeySpec]]
    let numericRows: [[KeyboardKeySpec]]
    let symbolRows: [[KeyboardKeySpec]]
    let shift: KeyboardKeySpec
    let bottomRow: KeyboardBottomRow

    static func from(_ dict: [String: Any]) -> KeyboardLayoutSpec? {
        guard let languageCode = dict["languageCode"] as? String,
              let alphaRaw = dict["alphaRows"] as? [[Any]],
              let numericRaw = dict["numericRows"] as? [[Any]],
              let symbolRaw = dict["symbolRows"] as? [[Any]],
              let shiftDict = dict["shift"] as? [String: Any],
              let shift = KeyboardKeySpec.from(shiftDict),
              let bottomDict = dict["bottomRow"] as? [String: Any],
              let modeSpec = KeyboardKeySpec.from(bottomDict["mode"] as? [String: Any] ?? [:]),
              let globeSpec = KeyboardKeySpec.from(bottomDict["globe"] as? [String: Any] ?? [:]),
              let spaceSpec = KeyboardKeySpec.from(bottomDict["space"] as? [String: Any] ?? [:]),
              let deleteSpec = KeyboardKeySpec.from(bottomDict["delete"] as? [String: Any] ?? [:]),
              let enterSpec = KeyboardKeySpec.from(bottomDict["enter"] as? [String: Any] ?? [:])
        else { return nil }

        return KeyboardLayoutSpec(
            languageCode: languageCode,
            alphaRows: parseRows(alphaRaw),
            numericRows: parseRows(numericRaw),
            symbolRows: parseRows(symbolRaw),
            shift: shift,
            bottomRow: KeyboardBottomRow(
                mode: modeSpec,
                globe: globeSpec,
                space: spaceSpec,
                delete: deleteSpec,
                enter: enterSpec
            )
        )
    }

    private static func parseRows(_ arr: [[Any]]) -> [[KeyboardKeySpec]] {
        arr.compactMap { row in
            let specs = row.compactMap { item -> KeyboardKeySpec? in
                guard let dict = item as? [String: Any] else { return nil }
                return KeyboardKeySpec.from(dict)
            }
            return specs.isEmpty ? nil : specs
        }
    }
}
