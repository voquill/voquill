import { invoke } from "@tauri-apps/api/core";
import { BaseRepo } from "./base.repo";

export type SaveTextFileParams = {
  fileName: string;
  contents: string;
};

export abstract class BaseFileRepo extends BaseRepo {
  /** Asks the user where to save the file. Resolves to false if they cancel. */
  abstract saveTextFile(params: SaveTextFileParams): Promise<boolean>;
}

export class LocalFileRepo extends BaseFileRepo {
  async saveTextFile(params: SaveTextFileParams): Promise<boolean> {
    return invoke<boolean>("save_text_file", params);
  }
}
