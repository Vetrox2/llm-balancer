import { encodeBase64 } from './base64.ts';
import type { ImagePart } from '../types.ts';

/** Base64 and MIME type for image parts. The fallback chain resends the same bytes, so each image is encoded once. */
export class ImageEncoder {
  private static readonly FALLBACK_MIME_TYPE = 'image/png';
  private static readonly SIGNATURES: ReadonlyArray<
    { mimeType: string; bytes: number[]; offset: number }
  > = [
    { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
    { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
    { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 },
    { mimeType: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  ];

  private readonly encoded = new WeakMap<Uint8Array, string>();

  base64(bytes: Uint8Array): string {
    let encoded = this.encoded.get(bytes);
    if (encoded === undefined) {
      encoded = encodeBase64(bytes);
      this.encoded.set(bytes, encoded);
    }
    return encoded;
  }

  mimeType({ data, mimeType }: ImagePart): string {
    if (mimeType) return mimeType;
    const match = ImageEncoder.SIGNATURES.find(({ bytes, offset }) =>
      bytes.every((byte, i) => data[offset + i] === byte)
    );
    return match?.mimeType ?? ImageEncoder.FALLBACK_MIME_TYPE;
  }
}
