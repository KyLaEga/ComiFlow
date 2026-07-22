/**
 * Shared helpers for page/cover image decoding.
 */

/**
 * Convert a base64 string or data-URL into a Blob.
 * Rust returns cover images and pages as full data-URLs
 * ("data:image/webp;base64,AAAA..."), so we must strip the prefix and parse
 * the real MIME type instead of blindly atob()-ing the whole string.
 */
export const base64ToBlob = (value: string, fallbackMime = 'image/jpeg'): Blob => {
  let mime = fallbackMime;
  let data = value;

  // Handle "data:<mime>;base64,<payload>"
  const match = value.match(/^data:([^;]+);base64,(.*)$/s);
  if (match) {
    mime = match[1] || fallbackMime;
    data = match[2];
  }

  const byteCharacters = atob(data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mime });
};
