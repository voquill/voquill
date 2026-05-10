import type {
  DictationContext as SharedDictationContext,
  DictationContextTarget as SharedDictationContextTarget,
  DictationContextTerm as SharedDictationContextTerm,
  DictationIntent,
} from "@voquill/types";

export type DictationContextTerm = SharedDictationContextTerm;

export type DictationContextTarget = SharedDictationContextTarget;

export type DictationContext = SharedDictationContext;

export type AssembleDictationContextInput = {
  intent: DictationIntent;
  language: string;
  terms?: DictationContextTerm[];
  currentApp?: DictationContextTarget | null;
  currentEditor?: DictationContextTarget | null;
  selectedText?: string | null;
  screenContext?: string | null;
  clipboardContext?: string | null;
};

const sanitizeValue = (value: string): string =>
  // oxlint-disable-next-line no-control-regex
  value.replace(/\0/g, "").replace(/\s+/g, " ").trim();

const sanitizeOptionalText = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }

  const sanitizedValue = sanitizeValue(value);
  return sanitizedValue || null;
};

export const assembleDictationContext = ({
  intent,
  language,
  terms = [],
  currentApp = null,
  currentEditor = null,
  selectedText = null,
  screenContext = null,
  clipboardContext = null,
}: AssembleDictationContextInput): DictationContext => {
  const glossaryByKey = new Map<string, string>();
  const replacementMap: Record<string, string> = {};

  for (const term of terms) {
    const sourceValue = sanitizeValue(term.sourceValue);
    if (!sourceValue) {
      continue;
    }

    const glossaryKey = sourceValue.toLowerCase();
    if (!glossaryByKey.has(glossaryKey)) {
      glossaryByKey.set(glossaryKey, sourceValue);
    }

    if (!term.isReplacement) {
      continue;
    }

    const destinationValue = sanitizeValue(term.destinationValue);
    if (!destinationValue) {
      continue;
    }

    replacementMap[sourceValue] = destinationValue;
  }

  return {
    intent,
    language,
    glossaryTerms: [...glossaryByKey.values()],
    replacementMap,
    currentApp,
    currentEditor,
    selectedText: sanitizeOptionalText(selectedText),
    screenContext: sanitizeOptionalText(screenContext),
    clipboardContext: sanitizeOptionalText(clipboardContext),
  };
};
