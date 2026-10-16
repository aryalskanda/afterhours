// Photos and files picked for a task's prompt, read as base64 to upload to the machine. Photos are
// re-encoded as JPEG (iPhones keep HEIC, which Claude can't read).

import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { Platform } from 'react-native'

export interface Picked {
  name: string
  /** Bytes. */
  size: number
  base64: string
  mime: string | null
  /** Something an Image can show, for photos. */
  preview: string | null
}

/** Biggest attachment a machine takes (the engine refuses more). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

const bytesOf = (base64: string) => Math.floor((base64.length * 3) / 4)

/** Up to five photos from the library; nothing when you cancel. */
export async function pickPhotos(): Promise<Picked[]> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 5, quality: 0.85, base64: true, exif: false })
  if (r.canceled) return []
  return r.assets
    .filter(a => a.base64)
    .map((a, i) => ({
      name: (a.fileName ?? `photo-${i + 1}.jpg`).replace(/\.(heic|heif)$/i, '.jpg'),
      size: a.fileSize ?? bytesOf(a.base64!),
      base64: a.base64!,
      mime: a.mimeType ?? 'image/jpeg',
      preview: a.uri,
    }))
}

async function readAsBase64(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  // In a browser the picker hands over a data URL.
  if (asset.uri.startsWith('data:')) return asset.uri.slice(asset.uri.indexOf(',') + 1)
  if (Platform.OS === 'web' && asset.file) {
    const buf = new Uint8Array(await asset.file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(binary)
  }
  return new File(asset.uri).base64()
}

/** Any files; nothing when you cancel. */
export async function pickFiles(): Promise<Picked[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (r.canceled) return []
  const out: Picked[] = []
  for (const a of r.assets) {
    const base64 = await readAsBase64(a)
    out.push({ name: a.name, size: a.size ?? bytesOf(base64), base64, mime: a.mimeType ?? null, preview: a.mimeType?.startsWith('image/') ? a.uri : null })
  }
  return out
}

/** "2.4 MB", "830 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
