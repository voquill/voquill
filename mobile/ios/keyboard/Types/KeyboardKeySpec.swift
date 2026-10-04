import Foundation

enum KeyboardKeyRole: String {
    case character, shift, delete, space, enter, mode, globe, language, overflow, startStop
    static func from(_ s: String) -> KeyboardKeyRole { KeyboardKeyRole(rawValue: s) ?? .character }
}

struct KeyboardKeySpec {
    let id: String
    let role: KeyboardKeyRole
    let label: String
    let flex: Int
    let value: String?

    static func from(_ dict: [String: Any]) -> KeyboardKeySpec? {
        guard let id = dict["id"] as? String,
              let roleStr = dict["role"] as? String,
              let label = dict["label"] as? String else { return nil }
        return KeyboardKeySpec(
            id: id,
            role: .from(roleStr),
            label: label,
            flex: dict["flex"] as? Int ?? 1,
            value: dict["value"] as? String
        )
    }
}
