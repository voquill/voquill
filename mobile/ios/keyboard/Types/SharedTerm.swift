import Foundation

struct SharedTerm {
    let sourceValue: String
    let destinationValue: String
    let isReplacement: Bool

    static func loadFromDefaults(_ defaults: UserDefaults) -> (termIds: [String], termById: [String: SharedTerm]) {
        let termIds = defaults.stringArray(forKey: "voquill_term_ids") ?? []

        var termById = [String: SharedTerm]()
        if let data = defaults.data(forKey: "voquill_term_by_id"),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] {
             for (id, fields) in dict {
                 if let sourceValue = fields["sourceValue"] as? String {
                     let destinationValue = fields["destinationValue"] as? String ?? sourceValue
                     let isReplacement = fields["isReplacement"] as? Bool ?? false
                     termById[id] = SharedTerm(
                         sourceValue: sourceValue,
                         destinationValue: destinationValue,
                         isReplacement: isReplacement
                     )
                 }
             }
         }

        return (termIds, termById)
    }
}
