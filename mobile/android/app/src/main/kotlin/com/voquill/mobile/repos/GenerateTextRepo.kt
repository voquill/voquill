package com.voquill.mobile.repos

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

abstract class BaseGenerateTextRepo {
    abstract fun generateTextSync(system: String?, prompt: String, jsonResponse: Boolean = false): String?
}

// MARK: - Cloud Implementation

class CloudGenerateTextRepo(
    private val config: RepoConfig,
) : BaseGenerateTextRepo() {

    override fun generateTextSync(system: String?, prompt: String, jsonResponse: Boolean): String? {
        return try {
            val args = JSONObject().apply {
                put("prompt", prompt)
                if (system != null) put("system", system)
                if (jsonResponse) put("jsonResponse", buildPostProcessingJsonSchema())
            }

            val result = invokeHandlerSync(
                config = config,
                name = "ai/generateText",
                args = args,
            ) ?: return null

            result.optString("text", "")
        } catch (e: Exception) {
            Log.w(TAG, "Cloud generate failed: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "CloudGenerateTextRepo"

        fun buildPostProcessingJsonSchema(): JSONObject {
            return JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("processedTranscription", JSONObject().apply {
                        put("type", "string")
                    })
                })
                put("required", JSONArray().apply {
                    put("processedTranscription")
                })
                put("additionalProperties", false)
            }
        }
    }
}

// MARK: - BYOK Implementation

class ByokGenerateTextRepo(
    private val apiKey: String,
    private val provider: String,
    baseUrl: String?,
    modelOverride: String?,
) : BaseGenerateTextRepo() {

    private val apiUrl: String
    private val model: String

    init {
        when (provider) {
            "groq" -> {
                apiUrl = "https://api.groq.com/openai/v1/chat/completions"
                model = modelOverride ?: "llama-3.3-70b-versatile"
            }
            "deepseek" -> {
                apiUrl = "https://api.deepseek.com/chat/completions"
                model = modelOverride ?: "deepseek-v4-flash"
            }
            "openRouter" -> {
                apiUrl = "https://openrouter.ai/api/v1/chat/completions"
                model = modelOverride ?: "openai/gpt-4o-mini"
            }
            "openaiCompatible" -> {
                val base = (baseUrl ?: "").trimEnd('/')
                apiUrl = "$base/chat/completions"
                model = modelOverride ?: "gpt-4o-mini"
            }
            "cerebras" -> {
                apiUrl = "https://api.cerebras.ai/v1/chat/completions"
                model = modelOverride ?: "llama-3.3-70b"
            }
            "ollama" -> {
                val base = (baseUrl ?: "http://localhost:11434").trimEnd('/')
                apiUrl = "$base/v1/chat/completions"
                model = modelOverride ?: "llama3"
            }
            "gemini" -> {
                apiUrl = "" // handled in generateGemini
                model = modelOverride ?: "gemini-2.0-flash"
            }
            "claude" -> {
                apiUrl = "https://api.anthropic.com/v1/messages"
                model = modelOverride ?: "claude-sonnet-4-20250514"
            }
            "azure" -> {
                val base = (baseUrl ?: "").trimEnd('/')
                val m = modelOverride ?: "gpt-4o-mini"
                apiUrl = "$base/openai/deployments/$m/chat/completions?api-version=2024-08-01-preview"
                model = m
            }
            else -> {
                apiUrl = "https://api.openai.com/v1/chat/completions"
                model = modelOverride ?: "gpt-4o-mini"
            }
        }
    }

    override fun generateTextSync(system: String?, prompt: String, jsonResponse: Boolean): String? {
        return when (provider) {
            "gemini" -> generateGemini(system, prompt, jsonResponse)
            "claude" -> generateClaude(system, prompt)
            "azure" -> generateAzureOpenAI(system, prompt, jsonResponse)
            else -> generateOpenAICompatible(system, prompt, jsonResponse)
        }
    }

    private fun generateOpenAICompatible(system: String?, prompt: String, jsonResponse: Boolean): String? {
        return try {
            val messages = JSONArray()
            if (!system.isNullOrBlank()) {
                messages.put(JSONObject().apply {
                    put("role", "system")
                    put("content", system)
                })
            }
            messages.put(JSONObject().apply {
                put("role", "user")
                put("content", prompt)
            })

            val payload = JSONObject().apply {
                put("model", model)
                put("messages", messages)
                if (jsonResponse) {
                    put("response_format", JSONObject().apply {
                        put("type", "json_object")
                    })
                }
            }

            val response = postJsonSync(
                urlString = apiUrl,
                payload = payload,
                authorization = "Bearer $apiKey",
            ) ?: return null

            if (response.status !in 200..299) {
                Log.w(TAG, "BYOK generate: HTTP ${response.status} ${response.body.take(200)}")
                return null
            }

            val json = JSONObject(response.body)
            val choices = json.optJSONArray("choices") ?: return null
            val first = choices.optJSONObject(0) ?: return null
            val message = first.optJSONObject("message") ?: return null
            message.optString("content", "")
        } catch (e: Exception) {
            Log.w(TAG, "BYOK generate failed: ${e.message}")
            null
        }
    }

    private fun generateGemini(system: String?, prompt: String, jsonResponse: Boolean): String? {
        return try {
            val payload = JSONObject().apply {
                if (!system.isNullOrBlank()) {
                    put("system_instruction", JSONObject().apply {
                        put("parts", JSONArray().apply {
                            put(JSONObject().apply { put("text", system) })
                        })
                    })
                }
                put("contents", JSONArray().apply {
                    put(JSONObject().apply {
                        put("parts", JSONArray().apply {
                            put(JSONObject().apply { put("text", prompt) })
                        })
                    })
                })
                if (jsonResponse) {
                    put("generationConfig", JSONObject().apply {
                        put("responseMimeType", "application/json")
                    })
                }
            }

            val urlString = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey"
            val response = postJsonSync(urlString = urlString, payload = payload) ?: return null

            if (response.status !in 200..299) {
                Log.w(TAG, "Gemini generate: HTTP ${response.status} ${response.body.take(200)}")
                return null
            }

            val json = JSONObject(response.body)
            val candidates = json.optJSONArray("candidates") ?: return null
            val content = candidates.optJSONObject(0)?.optJSONObject("content") ?: return null
            val parts = content.optJSONArray("parts") ?: return null
            parts.optJSONObject(0)?.optString("text", "")?.trim()
        } catch (e: Exception) {
            Log.w(TAG, "Gemini generate failed: ${e.message}")
            null
        }
    }

    private fun generateClaude(system: String?, prompt: String): String? {
        return try {
            val payload = JSONObject().apply {
                put("model", model)
                put("max_tokens", 4096)
                if (!system.isNullOrBlank()) put("system", system)
                put("messages", JSONArray().apply {
                    put(JSONObject().apply {
                        put("role", "user")
                        put("content", prompt)
                    })
                })
            }

            val response = postJsonSync(
                urlString = apiUrl,
                payload = payload,
                extraHeaders = mapOf(
                    "x-api-key" to apiKey,
                    "anthropic-version" to "2023-06-01",
                ),
            ) ?: return null

            if (response.status !in 200..299) {
                Log.w(TAG, "Claude generate: HTTP ${response.status} ${response.body.take(200)}")
                return null
            }

            val json = JSONObject(response.body)
            val content = json.optJSONArray("content") ?: return null
            val first = content.optJSONObject(0) ?: return null
            first.optString("text", "")
        } catch (e: Exception) {
            Log.w(TAG, "Claude generate failed: ${e.message}")
            null
        }
    }

    private fun generateAzureOpenAI(system: String?, prompt: String, jsonResponse: Boolean): String? {
        return try {
            val messages = JSONArray()
            if (!system.isNullOrBlank()) {
                messages.put(JSONObject().apply {
                    put("role", "system")
                    put("content", system)
                })
            }
            messages.put(JSONObject().apply {
                put("role", "user")
                put("content", prompt)
            })

            val payload = JSONObject().apply {
                put("messages", messages)
                if (jsonResponse) {
                    put("response_format", JSONObject().apply {
                        put("type", "json_object")
                    })
                }
            }

            val response = postJsonSync(
                urlString = apiUrl,
                payload = payload,
                extraHeaders = mapOf("api-key" to apiKey),
            ) ?: return null

            if (response.status !in 200..299) {
                Log.w(TAG, "Azure OpenAI generate: HTTP ${response.status} ${response.body.take(200)}")
                return null
            }

            val json = JSONObject(response.body)
            val choices = json.optJSONArray("choices") ?: return null
            val first = choices.optJSONObject(0) ?: return null
            val message = first.optJSONObject("message") ?: return null
            message.optString("content", "")
        } catch (e: Exception) {
            Log.w(TAG, "Azure OpenAI generate failed: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "ByokGenerateTextRepo"
    }
}
