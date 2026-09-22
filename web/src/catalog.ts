import type { PlayerInitialTrack } from "./player-collection";

export const CATALOG_LIMIT = 20;
export const FILE_BYTE_LIMIT = 32 * 1024 * 1024;
export const CATALOG_BYTE_LIMIT = 128 * 1024 * 1024;
export const MANIFEST_BYTE_LIMIT = 128 * 1024;
export const CATALOG_STORAGE_KEY = "kkb-wavecatalog-v1";

export type MediaRevision = Readonly<{ id: string; byteLength: number; filename: string }>;
export type CatalogAsset = Readonly<{ id: string; title: string; revision: MediaRevision }>;
/** Array order is playlist order. A revision records bytes; its filename is only a hint. */
export type CatalogManifest = Readonly<{ format: "wavecatalog"; version: 1; assets: readonly CatalogAsset[] }>;
export type FileBindings = ReadonlyMap<string, File>;
export const emptyCatalog = (): CatalogManifest => ({ format: "wavecatalog", version: 1, assets: [] });

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Invalid manifest fields. Import a WaveCatalog v1 JSON manifest.");
  }
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${field} in manifest.`);
  }
  return value;
}
function supportedName(name: string) { return /\.(wav|mp3)$/i.test(name); }

/** Validate untrusted JSON before changing any catalog or session binding. No locators are accepted. */
export function parseManifest(text: string): CatalogManifest {
  if (text.length > MANIFEST_BYTE_LIMIT || new TextEncoder().encode(text).byteLength > MANIFEST_BYTE_LIMIT) {
    throw new Error("Manifest exceeds the 128 KiB limit.");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("This is not valid JSON. Import a WaveCatalog v1 manifest."); }
  const root = record(value, ["format", "version", "assets"]);
  if (root.format !== "wavecatalog" || root.version !== 1) throw new Error("Unsupported manifest. WaveCatalog version 1 is required.");
  if (!Array.isArray(root.assets) || root.assets.length > CATALOG_LIMIT) throw new Error("A catalog can contain at most 20 assets.");
  const ids = new Set<string>();
  const revisionLengths = new Map<string, number>();
  let totalBytes = 0;
  const assets = root.assets.map((value): CatalogAsset => {
    const asset = record(value, ["id", "title", "revision"]);
    const id = boundedText(asset.id, 36, "asset ID");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || ids.has(id)) {
      throw new Error("Asset IDs must be unique UUIDs.");
    }
    ids.add(id);
    const title = boundedText(asset.title, 200, "title");
    const source = record(asset.revision, ["id", "byteLength", "filename"]);
    const revisionId = boundedText(source.id, 71, "revision ID");
    if (!/^sha256:[0-9a-f]{64}$/.test(revisionId)) throw new Error("Revision IDs must be SHA-256 digests.");
    const filename = boundedText(source.filename, 255, "filename");
    if (!supportedName(filename)) throw new Error("Manifest filenames must end in .wav or .mp3.");
    const byteLength = source.byteLength;
    if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > FILE_BYTE_LIMIT) {
      throw new Error("Each file must contain 1 byte to 32 MiB.");
    }
    if (revisionLengths.has(revisionId) && revisionLengths.get(revisionId) !== byteLength) throw new Error("One revision cannot have conflicting byte lengths.");
    revisionLengths.set(revisionId, byteLength);
    totalBytes += byteLength;
    return { id, title, revision: { id: revisionId, byteLength, filename } };
  });
  if (totalBytes > CATALOG_BYTE_LIMIT) throw new Error("Catalog files exceed the 128 MiB total limit.");
  return { format: "wavecatalog", version: 1, assets };
}

export function exportManifest(manifest: CatalogManifest): string {
  return JSON.stringify(parseManifest(JSON.stringify(manifest)), null, 2) + "\n";
}

function validateFile(file: File) {
  boundedText(file.name, 255, "filename");
  if (!supportedName(file.name)) throw new Error(`Choose a WAV or MP3 file: ${file.name}`);
  if (!file.size || file.size > FILE_BYTE_LIMIT) throw new Error(`${file.name} must contain 1 byte to 32 MiB.`);
}

/** Sequential callers hold at most one bounded encoded buffer while computing exact-byte identity. */
export async function identifyFile(file: File, signal?: AbortSignal): Promise<MediaRevision> {
  validateFile(file);
  signal?.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  signal?.throwIfAborted();
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { id: `sha256:${hex}`, byteLength: file.size, filename: file.name };
}

export async function addCatalogFiles(manifest: CatalogManifest, bindings: FileBindings, files: readonly File[], signal?: AbortSignal) {
  if (manifest.assets.length + files.length > CATALOG_LIMIT) throw new Error("Choose fewer files. A catalog can contain at most 20 assets.");
  files.forEach(validateFile);
  const total = manifest.assets.reduce((sum, asset) => sum + asset.revision.byteLength, 0) + files.reduce((sum, file) => sum + file.size, 0);
  if (total > CATALOG_BYTE_LIMIT) throw new Error("Choose fewer files. Catalog files cannot exceed 128 MiB total.");
  const assets = [...manifest.assets];
  const nextBindings = new Map(bindings);
  for (const file of files) {
    const title = boundedText(file.name.trim().slice(0, 200), 200, "title");
    const revision = await identifyFile(file, signal);
    const id = crypto.randomUUID();
    assets.push({ id, title, revision });
    nextBindings.set(id, file);
  }
  return { manifest: { ...manifest, assets }, bindings: nextBindings };
}

export async function rebindFile(asset: CatalogAsset, file: File, signal?: AbortSignal): Promise<File> {
  validateFile(file);
  if (file.size !== asset.revision.byteLength) throw new Error("File does not match this revision. Reselect the original bytes, or add it as a new asset.");
  const revision = await identifyFile(file, signal);
  if (revision.id !== asset.revision.id) throw new Error("File does not match this revision. Reselect the original bytes, or add it as a new asset.");
  return file;
}

export function catalogTracks(manifest: CatalogManifest, bindings: FileBindings, selected: ReadonlySet<string>): PlayerInitialTrack[] {
  return manifest.assets.filter(asset => selected.has(asset.id)).map(asset => {
    const file = bindings.get(asset.id);
    if (!file) throw new Error(`Reselect the missing file for ${asset.title} before opening the selection.`);
    return { file, title: asset.title };
  });
}
