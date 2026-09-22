import { expect, test } from "bun:test";
import { addCatalogFiles, catalogTracks, emptyCatalog, exportManifest, FILE_BYTE_LIMIT, identifyFile, parseManifest, rebindFile } from "../src/catalog";

const file = (bytes = "abc", name = "same.wav") => new File([bytes], name);

test("known exact-byte SHA-256 ignores filename and detects changed bytes of the same length", async () => {
  const original = await identifyFile(file());
  expect(original.id).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect((await identifyFile(file("abc", "renamed.mp3"))).id).toBe(original.id);
  expect((await identifyFile(file("abd"))).id).not.toBe(original.id);
});

test("duplicate filenames and even duplicate bytes remain distinct assets; titles, IDs and order roundtrip", async () => {
  const files = [file(), file("abd"), file()];
  const { manifest, bindings } = await addCatalogFiles(emptyCatalog(), new Map(), files);
  expect(new Set(manifest.assets.map(asset => asset.id)).size).toBe(3);
  expect(new Set(manifest.assets.map(asset => asset.revision.id)).size).toBe(2);
  const edited = { ...manifest, assets: [manifest.assets[2]!, { ...manifest.assets[0]!, title: "Edited title" }, manifest.assets[1]!] };
  const imported = parseManifest(exportManifest(edited));
  expect(imported).toEqual(edited);
  expect(exportManifest(edited)).not.toContain("lastModified");
  expect(catalogTracks(imported, bindings, new Set(imported.assets.map(asset => asset.id))).map(track => [track.title, track.file])).toEqual([
    ["same.wav", files[2]], ["Edited title", files[0]], ["same.wav", files[1]],
  ]);
  expect(() => catalogTracks(imported, new Map(), new Set([imported.assets[0]!.id]))).toThrow("missing file");
});

test("filename-derived titles stay nonblank and bounded without changing filename hints", async () => {
  const names = [" ".repeat(200) + ".wav", " ".repeat(200) + "song.mp3", "a".repeat(251) + ".wav"];
  const { manifest } = await addCatalogFiles(emptyCatalog(), new Map(), names.map(name => file("abc", name)));
  expect(manifest.assets.map(asset => asset.title)).toEqual([".wav", "song.mp3", "a".repeat(200)]);
  expect(manifest.assets.map(asset => asset.revision.filename)).toEqual(names);
  expect(parseManifest(exportManifest(manifest))).toEqual(manifest);
});

test("rebind requires matching bytes and size, accepts renamed bytes, never rewrites revision", async () => {
  const { manifest } = await addCatalogFiles(emptyCatalog(), new Map(), [file()]);
  const asset = manifest.assets[0]!;
  const before = exportManifest(manifest);
  await expect(rebindFile(asset, file("abd"))).rejects.toThrow("does not match");
  await expect(rebindFile(asset, file("abcd"))).rejects.toThrow("does not match");
  const renamed = file("abc", "renamed.wav");
  expect(await rebindFile(asset, renamed)).toBe(renamed);
  expect(exportManifest(manifest)).toBe(before);
});

test("untrusted manifests reject malformed structure, unsupported versions, duplicate IDs and invalid revisions", async () => {
  const { manifest } = await addCatalogFiles(emptyCatalog(), new Map(), [file()]);
  const a = manifest.assets[0]!;
  const invalid: unknown[] = [null, [], {}, { ...manifest, version: 2 }, { ...manifest, path: "/music" },
    { ...manifest, assets: [a, a] }, { ...manifest, assets: [{ ...a, id: "entry-1" }] },
    { ...manifest, assets: [{ ...a, title: "" }] }, { ...manifest, assets: [{ ...a, title: "a\nline" }] },
    { ...manifest, assets: [{ ...a, revision: { ...a.revision, id: "sha256:abc" } }] },
    ...[0, -1, 1.5, FILE_BYTE_LIMIT + 1, "3"].map(byteLength => ({ ...manifest, assets: [{ ...a, revision: { ...a.revision, byteLength } }] })),
    { ...manifest, assets: [{ ...a, revision: { ...a.revision, filename: "secret.txt" } }] },
    { ...manifest, assets: [{ ...a, revision: { ...a.revision, locator: "https://example.com" } }] },
    { ...manifest, assets: [a, { ...a, id: crypto.randomUUID(), revision: { ...a.revision, byteLength: 4 } }] },
    { ...manifest, assets: Array.from({ length: 21 }, () => ({ ...a, id: crypto.randomUUID() })) },
    { ...manifest, assets: Array.from({ length: 5 }, () => ({ ...a, id: crypto.randomUUID(), revision: { ...a.revision, byteLength: FILE_BYTE_LIMIT } })) },
  ];
  for (const value of invalid) expect(() => parseManifest(JSON.stringify(value))).toThrow();
  expect(() => parseManifest("{" )).toThrow("valid JSON");
  expect(() => parseManifest(" ".repeat(128 * 1024 + 1))).toThrow("limit");
  expect(parseManifest(exportManifest(emptyCatalog()))).toEqual(emptyCatalog());
});

test("admission checks all limits before reading any bytes and cancellation discards pending work", async () => {
  let reads = 0;
  class CountedFile extends File { override async arrayBuffer() { reads++; return super.arrayBuffer(); } }
  const counted = new CountedFile(["abc"], "safe.wav");
  await expect(addCatalogFiles(emptyCatalog(), new Map(), Array(21).fill(counted))).rejects.toThrow("20 assets");
  await expect(addCatalogFiles(emptyCatalog(), new Map(), [counted, file("", "empty.wav")])).rejects.toThrow("1 byte");
  await expect(addCatalogFiles(emptyCatalog(), new Map(), [counted, file("abc", "bad.txt")])).rejects.toThrow("WAV or MP3");
  expect(reads).toBe(0);
  const large = new CountedFile([new Uint8Array(FILE_BYTE_LIMIT)], "large.wav");
  await expect(addCatalogFiles(emptyCatalog(), new Map(), Array(5).fill(large))).rejects.toThrow("128 MiB");
  expect(reads).toBe(0);
  const controller = new AbortController(); controller.abort();
  await expect(addCatalogFiles(emptyCatalog(), new Map(), [counted], controller.signal)).rejects.toThrow();
  expect(reads).toBe(0);
});

test("leaving during a read discards the result and never reads the next file", async () => {
  let finish!: (bytes: ArrayBuffer) => void;
  let nextReads = 0;
  class HeldFile extends File { override arrayBuffer() { return new Promise<ArrayBuffer>(resolve => { finish = resolve; }); } }
  class NextFile extends File { override async arrayBuffer() { nextReads++; return super.arrayBuffer(); } }
  const manifest = emptyCatalog(); const bindings = new Map<string, File>(); const controller = new AbortController();
  const pending = addCatalogFiles(manifest, bindings, [new HeldFile(["abc"], "first.wav"), new NextFile(["def"], "second.wav")], controller.signal);
  controller.abort(); finish(new TextEncoder().encode("abc").buffer);
  await expect(pending).rejects.toThrow();
  expect(nextReads).toBe(0); expect(bindings.size).toBe(0); expect(manifest.assets).toEqual([]);
});
