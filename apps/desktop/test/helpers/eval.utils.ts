import { expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  BaseGenerateTextRepo,
  GroqGenerateTextRepo,
  OpenAIGenerateTextRepo,
} from "../../src/repos/generate-text.repo";
import {
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  PostProcessingPromptInput,
  PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
  PROCESSED_TRANSCRIPTION_SCHEMA,
} from "../../src/utils/prompt.utils";
import {
  getDefaultSystemTones,
  StyleToneConfig,
  ToneConfig,
} from "../../src/utils/tone.utils";
import { getGroqApiKey, getOpenAIApiKey } from "./env.utils";

export type Eval = string;

const EVAL_RESULT_SCHEMA = z.object({
  score: z.number().min(0).max(10),
  reason: z.string(),
});

const EVAL_RESULT_JSON_SCHEMA =
  zodToJsonSchema(EVAL_RESULT_SCHEMA, "Schema").definitions?.Schema ?? {};

export function getOpenAIGentextRepo(model = "gpt-5.4"): BaseGenerateTextRepo {
  const apiKey = getOpenAIApiKey();
  return new OpenAIGenerateTextRepo(apiKey, model);
}

export function getGroqGentextRepo(
  model = "openai/gpt-oss-120b",
): BaseGenerateTextRepo {
  const apiKey = getGroqApiKey();
  return new GroqGenerateTextRepo(apiKey, model);
}

export async function runEval({
  originalText,
  finalText,
  evals,
}: {
  originalText: string;
  finalText: string;
  evals: Eval[];
}): Promise<void> {
  originalText = originalText.trim();
  finalText = finalText.trim();

  const repo = getGroqGentextRepo();

  // for (const e of evals) {
  const promises = evals.map(async (e) => {
    const criteria = e;
    const output = await repo.generateText({
      system:
        "You are an evaluator. Score the final text based on the given criteria. Return a score between 0 and 10 and a reason for your score. Evaluate only if the statement in criteria is true in the final text. Don't judge quality generally.",
      prompt: [
        `Original text: ${originalText}`,
        `Final text: ${finalText}`,
        `Criteria: ${criteria}`,
      ].join("\n\n"),
      jsonResponse: {
        name: "eval_result",
        description: "Evaluation score and reason",
        schema: EVAL_RESULT_JSON_SCHEMA,
      },
    });

    const result = EVAL_RESULT_SCHEMA.parse(JSON.parse(output.text));

    console.log(`Eval Result for criteria "${criteria}":`, result);
    expect(
      result.score,
      [
        `Eval failed for "${criteria}"`,
        `Reason: ${result.reason}`,
        `Original: ${originalText}`,
        `Final: ${finalText}`,
      ].join("\n"),
    ).toBeGreaterThanOrEqual(5);
  });

  await Promise.all(promises);
}

export const postProcess = async ({
  tone,
  transcription,
  language = "en",
  userName = "Thomas Gundan",
  repo,
}: {
  tone: ToneConfig;
  transcription: string;
  language?: string;
  userName?: string;
  repo?: BaseGenerateTextRepo;
}): Promise<string> => {
  const promptInput: PostProcessingPromptInput = {
    transcript: transcription,
    dictationLanguage: language,
    tone,
    userName,
  };
  const ppSystem = buildSystemPostProcessingTonePrompt(promptInput);
  const ppPrompt = buildPostProcessingPrompt(promptInput);

  const output = await (repo ?? getGroqGentextRepo()).generateText({
    system: ppSystem,
    prompt: ppPrompt,
    jsonResponse: {
      name: "transcription_cleaning",
      description: "JSON response with the processed transcription",
      schema: PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
    },
  });

  const parsed = PROCESSED_TRANSCRIPTION_SCHEMA.parse(JSON.parse(output.text));
  return parsed.result;
};

export const toneFromPrompt = (promptTemplate: string): StyleToneConfig => ({
  kind: "style",
  stylePrompt: promptTemplate,
});

export const getWritingStyle = (style: string): StyleToneConfig => {
  const tones = getDefaultSystemTones();
  const tone = tones.find((t) => t.id === style);
  if (!tone) {
    throw new Error(`Writing style '${style}' not found`);
  }

  return { kind: "style", stylePrompt: tone.promptTemplate };
};
