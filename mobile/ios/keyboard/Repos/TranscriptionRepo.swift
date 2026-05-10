import Foundation

class TranscriptionRepo {
    private static let storageKey = "voquill_transcriptions"
    private static let maxEntries = 50

    private let defaults: UserDefaults?
    private let containerUrl: URL?

    init() {
        self.defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        self.containerUrl = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: DictationConstants.appGroupId
        )
    }

    func save(
        text: String,
        rawTranscript: String,
        toneId: String?,
        toneName: String?,
        audioSourceUrl: URL
    ) {
        guard let defaults = defaults, let containerUrl = containerUrl else { return }

        let id = UUID().uuidString
        let audioDir = containerUrl.appendingPathComponent("audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)

        var audioPath: String?
        let destUrl = audioDir.appendingPathComponent("\(id).m4a")
        do {
            try FileManager.default.copyItem(at: audioSourceUrl, to: destUrl)
            audioPath = destUrl.path
        } catch {
            NSLog("[VoquillKB] Failed to copy audio: %@", error.localizedDescription)
        }

        var record: [String: Any] = [
            "id": id,
            "text": text.trimmingCharacters(in: .whitespacesAndNewlines),
            "rawTranscript": rawTranscript,
            "authoritativeTranscript": rawTranscript,
            "isAuthoritative": true,
            "isFinalized": true,
            "dictationIntent": [
                "kind": "dictation",
                "format": "clean"
            ],
            "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let toneId = toneId { record["toneId"] = toneId }
        if let toneName = toneName { record["toneName"] = toneName }
        if let audioPath = audioPath { record["audioPath"] = audioPath }

        var existing = defaults.array(forKey: TranscriptionRepo.storageKey) as? [[String: Any]] ?? []
        existing.insert(record, at: 0)

        if existing.count > TranscriptionRepo.maxEntries {
            let removed = existing.suffix(from: TranscriptionRepo.maxEntries)
            for old in removed {
                if let path = old["audioPath"] as? String {
                    try? FileManager.default.removeItem(atPath: path)
                }
            }
            existing = Array(existing.prefix(TranscriptionRepo.maxEntries))
        }

        defaults.set(existing, forKey: TranscriptionRepo.storageKey)

        CounterRepo().incrementApp()
    }

    func loadAll() -> [[String: Any]] {
        return defaults?.array(forKey: TranscriptionRepo.storageKey) as? [[String: Any]] ?? []
    }
}
