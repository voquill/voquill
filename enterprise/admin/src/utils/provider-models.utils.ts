const SPEACHES_MODELS = [
  "Systran/faster-whisper-tiny",
  "Systran/faster-whisper-tiny.en",
  "Systran/faster-whisper-base",
  "Systran/faster-whisper-base.en",
  "Systran/faster-whisper-small",
  "Systran/faster-whisper-small.en",
  "Systran/faster-whisper-medium",
  "Systran/faster-whisper-medium.en",
  "Systran/faster-whisper-large-v2",
  "Systran/faster-whisper-large-v3",
  "Systran/faster-distil-whisper-small.en",
  "Systran/faster-distil-whisper-medium.en",
  "Systran/faster-distil-whisper-large-v2",
  "Systran/faster-distil-whisper-large-v3",
  "istupakov/parakeet-tdt-0.6b-v3-onnx",
];

const OLLAMA_MODELS = [
  "llama3.2:1b",
  "llama3.2:3b",
  "llama3.1:8b",
  "llama3.1:70b",
  "llama3.3:70b",
  "gemma3:1b",
  "gemma3:4b",
  "gemma3:12b",
  "gemma3:27b",
  "qwen3:0.6b",
  "qwen3:1.7b",
  "qwen3:4b",
  "qwen3:8b",
  "qwen3:14b",
  "qwen3:32b",
  "phi4:14b",
  "mistral:7b",
];

const OPENAI_LLM_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"];

const GROQ_LLM_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-guard-4-12b",
  "moonshotai/kimi-k2-instruct-0905",
];

const GROQ_STT_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

export function getSttProviderModels(provider: string): string[] | null {
  switch (provider) {
    case "speaches":
      return SPEACHES_MODELS;
    case "groq":
      return GROQ_STT_MODELS;
    default:
      return null;
  }
}

export function getLlmProviderModels(provider: string): string[] | null {
  switch (provider) {
    case "ollama":
      return OLLAMA_MODELS;
    case "openai":
      return OPENAI_LLM_MODELS;
    case "groq":
      return GROQ_LLM_MODELS;
    case "synthetic-ai":
    case "open-router":
      return null;
    default:
      return null;
  }
}
