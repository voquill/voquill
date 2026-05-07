import dayjs from "dayjs";
import { invoke } from "@tauri-apps/api/core";
import { Nullable, Term } from "@voquill/types";
import { getTermRepo } from "../repos";
import { produceAppState } from "../store";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { sendPillFlashMessage } from "../utils/overlay.utils";
import { getIntl } from "../i18n/intl";
import { showErrorSnackbar } from "./app.actions";
import { showToast } from "./toast.actions";
import { registerTerms } from "../utils/app.utils";

export const loadDictionary = async (): Promise<void> => {
  const terms = await getTermRepo().listTerms();
  const activeTerms = terms.sort(
    (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
  );

  produceAppState((draft) => {
    registerTerms(draft, terms);
    draft.dictionary.termIds = activeTerms.map((term) => term.id);
  });
};

export const addSelectedTextToDictionary = async (): Promise<void> => {
  try {
    const selectedText = await invoke<Nullable<string>>("get_selected_text");
    const text = selectedText?.trim() ?? "";
    if (!text) {
      const intl = getIntl();
      await showToast({
        message: intl.formatMessage({
          defaultMessage: "No text selected",
        }),
        toastType: "info",
      });
      return;
    }

    const newTerm: Term = {
      id: createId(),
      createdAt: new Date().toISOString(),
      sourceValue: text,
      destinationValue: "",
      isReplacement: false,
    };

    produceAppState((draft) => {
      draft.termById[newTerm.id] = newTerm;
      draft.dictionary.termIds = [newTerm.id, ...draft.dictionary.termIds];
    });

    await getTermRepo().createTerm(newTerm);

    const intl = getIntl();
    sendPillFlashMessage(
      intl.formatMessage(
        { defaultMessage: 'Added "{text}" to dictionary' },
        { text },
      ),
    );
  } catch (error) {
    getLogger().error(`Failed to add selection to dictionary: ${error}`);
    showErrorSnackbar(
      error instanceof Error ? error.message : "Failed to add to dictionary",
    );
  }
};
