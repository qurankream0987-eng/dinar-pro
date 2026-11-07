/**
 * A photo the buyer took or chose to FIND a product. Marked by identity, so the send path
 * uploads it to the buyer's private visual-search namespace, never as a listing photo.
 */
const searchPhotos = new WeakSet<File>();

export function markSearchPhoto(file: File): File {
  searchPhotos.add(file);
  return file;
}

export function isSearchPhoto(file: File): boolean {
  return searchPhotos.has(file);
}

export const DEFAULT_PHOTO_SEARCH_MESSAGE = "دينار، أريد هذا المنتج";
