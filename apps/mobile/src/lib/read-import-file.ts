/**
 * Pick a CSV with the OS document picker and read it as text (`expo-document-picker`, the file is
 * copied to the cache by the picker; `expo-file-system` reads it). The copy is deleted right after
 * reading. The text is never logged.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { IMPORT_PICKER_TYPES, checkImportFile, stripBom, utf8ByteLength } from "./polish-import";

export interface PickedImportFile {
  name: string;
  text: string;
}

/** Returns null when the user cancelled; throws an Error with a user-facing message on a bad file. */
export async function pickImportFile(): Promise<PickedImportFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: Platform.OS === "android" ? "*/*" : IMPORT_PICKER_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  const early = checkImportFile({ name: asset.name, size: asset.size ?? 1 });
  if (early) throw new Error(early);

  let text: string;
  try {
    if (Platform.OS === "web" && asset.file) text = await asset.file.text();
    else text = await new File(asset.uri).text();
  } catch {
    throw new Error("Couldn't read that file. Is it a text CSV?");
  } finally {
    if (Platform.OS !== "web") {
      try {
        new File(asset.uri).delete();
      } catch {
        // The OS clears the cache directory eventually.
      }
    }
  }
  text = stripBom(text);
  const problem = checkImportFile({ name: asset.name, size: utf8ByteLength(text) });
  if (problem) throw new Error(problem);
  return { name: asset.name, text };
}
