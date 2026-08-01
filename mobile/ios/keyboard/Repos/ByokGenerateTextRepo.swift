import Foundation

class ByokGenerateTextRepo: BaseGenerateTextRepo {
    private let apiKey: String
    private let provider: String
    private let apiUrl: String
    private let model: String

    init(apiKey: String, provider: String, baseUrl: String?, modelOverride: String? = nil) {
        self.apiKey = apiKey
        self.provider = provider
        switch provider {
        case "groq":
            self.apiUrl = "https://api.groq.com/openai/v1/chat/completions"
            self.model = modelOverride ?? "llama-3.3-70b-versatile"
        case "deepseek":
            self.apiUrl = "https://api.deepseek.com/chat/completions"
            self.model = modelOverride ?? "deepseek-v4-flash"
        case "openRouter":
            self.apiUrl = "https://openrouter.ai/api/v1/chat/completions"
            self.model = modelOverride ?? "openai/gpt-4o-mini"
        case "openaiCompatible":
            let base = (baseUrl ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            self.apiUrl = "\(base)/chat/completions"
            self.model = modelOverride ?? "gpt-4o-mini"
        case "cerebras":
            self.apiUrl = "https://api.cerebras.ai/v1/chat/completions"
            self.model = modelOverride ?? "llama-3.3-70b"
        case "ollama":
            let base = (baseUrl ?? "http://localhost:11434").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            self.apiUrl = "\(base)/v1/chat/completions"
            self.model = modelOverride ?? "llama3"
        case "gemini":
            self.apiUrl = "" // handled in generateGemini
            self.model = modelOverride ?? "gemini-2.0-flash"
        case "claude":
            self.apiUrl = "https://api.anthropic.com/v1/messages"
            self.model = modelOverride ?? "claude-sonnet-4-20250514"
        case "azure":
            let base = (baseUrl ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let m = modelOverride ?? "gpt-4o-mini"
            self.apiUrl = "\(base)/openai/deployments/\(m)/chat/completions?api-version=2024-08-01-preview"
            self.model = m
        default:
            self.apiUrl = "https://api.openai.com/v1/chat/completions"
            self.model = modelOverride ?? "gpt-4o-mini"
        }
    }

    override func generateText(system: String?, prompt: String, jsonResponse: [String: Any]? = nil) async throws -> String {
        switch provider {
        case "gemini":
            return try await generateGemini(system: system, prompt: prompt, jsonResponse: jsonResponse != nil)
        case "claude":
            return try await generateClaude(system: system, prompt: prompt)
        case "azure":
            return try await generateAzureOpenAI(system: system, prompt: prompt, jsonResponse: jsonResponse != nil)
        default:
            return try await generateOpenAICompatible(system: system, prompt: prompt, jsonResponse: jsonResponse != nil)
        }
    }

    // MARK: - OpenAI-compatible (OpenAI, Groq, DeepSeek, OpenRouter, Cerebras, Ollama, OpenAI-Compatible)

    private func generateOpenAICompatible(system: String?, prompt: String, jsonResponse: Bool) async throws -> String {
        guard let url = URL(string: apiUrl) else {
            throw ApiError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var messages: [[String: Any]] = []
        if let system = system {
            messages.append(["role": "system", "content": system])
        }
        messages.append(["role": "user", "content": prompt])

        var payload: [String: Any] = [
            "model": model,
            "messages": messages,
        ]

        if jsonResponse {
            payload["response_format"] = ["type": "json_object"]
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            let responseBody = String(data: data, encoding: .utf8) ?? ""
            throw ApiError.httpError(statusCode, responseBody)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw ApiError.parseError
        }

        return content
    }

    // MARK: - Gemini

    private func generateGemini(system: String?, prompt: String, jsonResponse: Bool) async throws -> String {
        let urlString = "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent?key=\(apiKey)"
        guard let url = URL(string: urlString) else {
            throw ApiError.invalidURL
        }

        var payload: [String: Any] = [
            "contents": [[
                "parts": [["text": prompt]]
            ]]
        ]

        if let system = system {
            payload["system_instruction"] = ["parts": [["text": system]]]
        }

        if jsonResponse {
            payload["generationConfig"] = ["responseMimeType": "application/json"]
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            let responseBody = String(data: data, encoding: .utf8) ?? ""
            throw ApiError.httpError(statusCode, responseBody)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let candidates = json["candidates"] as? [[String: Any]],
              let first = candidates.first,
              let content = first["content"] as? [String: Any],
              let parts = content["parts"] as? [[String: Any]],
              let text = parts.first?["text"] as? String else {
            throw ApiError.parseError
        }

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Claude (Anthropic)

    private func generateClaude(system: String?, prompt: String) async throws -> String {
        guard let url = URL(string: apiUrl) else {
            throw ApiError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var payload: [String: Any] = [
            "model": model,
            "max_tokens": 4096,
            "messages": [["role": "user", "content": prompt]],
        ]

        if let system = system {
            payload["system"] = system
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            let responseBody = String(data: data, encoding: .utf8) ?? ""
            throw ApiError.httpError(statusCode, responseBody)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]],
              let first = content.first,
              let text = first["text"] as? String else {
            throw ApiError.parseError
        }

        return text
    }

    // MARK: - Azure OpenAI

    private func generateAzureOpenAI(system: String?, prompt: String, jsonResponse: Bool) async throws -> String {
        guard let url = URL(string: apiUrl) else {
            throw ApiError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var messages: [[String: Any]] = []
        if let system = system {
            messages.append(["role": "system", "content": system])
        }
        messages.append(["role": "user", "content": prompt])

        var payload: [String: Any] = [
            "messages": messages,
        ]

        if jsonResponse {
            payload["response_format"] = ["type": "json_object"]
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            let responseBody = String(data: data, encoding: .utf8) ?? ""
            throw ApiError.httpError(statusCode, responseBody)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw ApiError.parseError
        }

        return content
    }
}
