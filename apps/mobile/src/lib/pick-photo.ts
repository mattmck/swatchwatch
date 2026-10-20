import * as ImagePicker from "expo-image-picker";
import { Alert, Platform } from "react-native";
import { prepareJpeg, type PreparedImage } from "./image-prep";

export type PhotoSource = "camera" | "library";

export class PhotoPermissionError extends Error {
  constructor() {
    super("Camera access is off. Allow it in Settings, or choose a photo instead.");
    this.name = "PhotoPermissionError";
  }
}

/**
 * Take or choose a photo and re-encode it as a JPEG data URL (EXIF/GPS dropped by re-encoding;
 * the server re-encodes again). Resolves null when the user cancels.
 */
export async function pickPreparedPhoto(
  from: PhotoSource,
  options: { maxEdge: number; compress: number },
): Promise<PreparedImage | null> {
  if (from === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new PhotoPermissionError();
  }
  const pickerOptions: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, exif: false };
  const picked = from === "camera" ? await ImagePicker.launchCameraAsync(pickerOptions) : await ImagePicker.launchImageLibraryAsync(pickerOptions);
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return null;
  return prepareJpeg(asset.uri, asset, options);
}

/** Destructive confirm that also works in the web preview (where `Alert.alert` is a no-op). */
export function confirmDestructive(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(Boolean(globalThis.confirm?.(`${title}\n\n${message}`)));
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
