import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowLeft, Download, FolderPlus, Upload, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { WavePlayerApp } from "./wave-player-app";
import type { PlayerInitialTrack } from "./player-collection";
import { addCatalogFiles, CATALOG_LIMIT, CATALOG_STORAGE_KEY, catalogTracks, emptyCatalog, exportManifest, MANIFEST_BYTE_LIMIT, parseManifest, rebindFile, type CatalogAsset, type CatalogManifest, type FileBindings } from "./catalog";

function restoreCatalog(): { manifest: CatalogManifest; notice: string } {
  try {
    const saved = sessionStorage.getItem(CATALOG_STORAGE_KEY);
    return saved ? { manifest: parseManifest(saved), notice: "Catalog restored. Reselect local files to verify their bytes before playback." }
      : { manifest: emptyCatalog(), notice: "" };
  } catch {
    return { manifest: emptyCatalog(), notice: "Saved catalog could not be read. Import your exported manifest to recover it." };
  }
}
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

export function CatalogApp() {
  const [restored] = useState(restoreCatalog);
  const [manifest, setManifest] = useState(restored.manifest);
  const [bindings, setBindings] = useState<FileBindings>(() => new Map());
  const [selected, setSelected] = useState(() => new Set(manifest.assets.map(asset => asset.id)));
  const [notice, setNotice] = useState(restored.notice);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tracks, setTracks] = useState<PlayerInitialTrack[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const rebindInput = useRef<HTMLInputElement>(null);
  const rebindTarget = useRef<CatalogAsset | null>(null);
  const job = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const playerHeading = useRef<HTMLHeadingElement>(null);
  const returning = useRef(false);

  useEffect(() => () => { job.current?.abort(); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(CATALOG_STORAGE_KEY, exportManifest(manifest)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [manifest]);
  useEffect(() => {
    if (tracks) playerHeading.current?.focus();
    else if (returning.current) { heading.current?.focus(); returning.current = false; }
  }, [tracks]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setBusy(true); setError(""); setNotice("");
    try { await action(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not read the file. Try selecting it again."); }
    finally { if (!controller.signal.aborted) { job.current = null; setBusy(false); } }
  }
  function move(id: string, direction: -1 | 1) {
    const assets = [...manifest.assets];
    const index = assets.findIndex(asset => asset.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= assets.length) return;
    [assets[index], assets[target]] = [assets[target]!, assets[index]!];
    setManifest({ ...manifest, assets });
    setNotice(`Moved ${assets[target]!.title} to position ${target + 1}.`);
  }
  function remove(id: string) {
    setManifest({ ...manifest, assets: manifest.assets.filter(asset => asset.id !== id) });
    setBindings(current => { const next = new Map(current); next.delete(id); return next; });
    setSelected(current => { const next = new Set(current); next.delete(id); return next; });
    setNotice("Asset removed from this catalog. Original file unchanged.");
    heading.current?.focus();
  }
  function download() {
    let text: string;
    try { text = exportManifest(manifest); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not export the manifest."); return; }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "wavecatalog-v1.json";
    link.click();
    // Keep the URL alive until the browser has accepted the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Manifest exported. It contains titles, order and identities, but no audio or file access.");
  }
  const selectedAssets = manifest.assets.filter(asset => selected.has(asset.id));
  const missingSelected = selectedAssets.filter(asset => !bindings.has(asset.id)).length;
  const missingCount = manifest.assets.filter(asset => !bindings.has(asset.id)).length;

  if (tracks) return <div className="player-route catalog-player">
    <header className="catalog-player-heading"><Button variant="outline" onClick={() => { returning.current = true; setTracks(null); }}><ArrowLeft aria-hidden="true" />Back to catalog</Button>
      <div><h1 ref={playerHeading} tabIndex={-1}>Catalog selection</h1><p>{tracks.length} tracks in playlist order. Press Play to begin. Returning stops playback.</p></div>
    </header>
    <WavePlayerApp initialTracks={tracks} />
  </div>;

  return <main className="catalog-page">
    <header className="catalog-heading"><h1 ref={heading} tabIndex={-1}>WaveCatalog <span>v0</span></h1>
      <p>Arrange a small local playlist. Keep its identity when the files move.</p>
    </header>
    <p className="catalog-local-note">Titles and order stay in this tab. Audio files stay in memory only. After a reload or import, reselect matching files. Export a manifest to keep the catalog after closing the tab.</p>
    <input ref={fileInput} type="file" hidden multiple accept=".wav,.mp3" aria-label="Add catalog files" onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
      if (files.length) void run(async signal => {
        const result = await addCatalogFiles(manifest, bindings, files, signal);
        signal.throwIfAborted(); setManifest(result.manifest); setBindings(result.bindings);
        setSelected(current => new Set([...current, ...result.manifest.assets.filter(asset => !manifest.assets.some(old => old.id === asset.id)).map(asset => asset.id)]));
        setNotice(`Added ${files.length} ${files.length === 1 ? "file" : "files"}. Exact bytes verified. Nothing is playing.`);
      });
    }} />
    <input ref={importInput} type="file" hidden accept=".json,application/json" aria-label="Import catalog manifest" onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
      if (file) void run(async signal => {
        if (file.size > MANIFEST_BYTE_LIMIT) throw new Error("Manifest exceeds the 128 KiB limit.");
        const next = parseManifest(await file.text()); signal.throwIfAborted();
        setManifest(next); setBindings(new Map()); setSelected(new Set(next.assets.map(asset => asset.id)));
        setNotice(`Imported ${next.assets.length} assets. Reselect files to verify their bytes. Import replaces this tab's catalog.`);
      });
    }} />
    <input ref={rebindInput} type="file" hidden accept=".wav,.mp3" aria-label="Reselect matching file" onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
      const asset = rebindTarget.current; rebindTarget.current = null;
      if (file && asset) void run(async signal => {
        const bound = await rebindFile(asset, file, signal); signal.throwIfAborted();
        setBindings(current => new Map(current).set(asset.id, bound));
        setNotice(`Verified ${asset.title}. Its exact bytes match, even if the filename changed.`);
      });
    }} />
    <fieldset className="catalog-controls" disabled={busy}>
      <legend className="sr-only">Catalog actions</legend>
      <Button onClick={() => fileInput.current?.click()} disabled={manifest.assets.length === CATALOG_LIMIT}><FolderPlus aria-hidden="true" />Add files</Button>
      <Button variant="outline" onClick={download} disabled={!manifest.assets.length}><Download aria-hidden="true" />Export manifest</Button>
      <Button variant="outline" onClick={() => importInput.current?.click()}><Upload aria-hidden="true" />Import manifest</Button>
      <span>Import replaces the catalog.</span>
    </fieldset>
    <div className="catalog-feedback" aria-live="polite"><p role="status">{busy ? "Reading selected bytes and checking SHA-256…" : notice || "WAV / MP3 · Up to 20 files · 32 MiB each · 128 MiB total"}</p>
      {error ? <p role="alert">{error}</p> : null}
      {storageError ? <p role="alert">This browser could not save catalog metadata in the tab. Export a manifest before reloading.</p> : null}
    </div>
    <fieldset className="catalog-playlist" disabled={busy}>
      <legend className="sr-only">Playlist</legend>
      <div className="catalog-list-heading"><h2>Playlist <span>{manifest.assets.length} / {CATALOG_LIMIT}</span></h2><span>{missingCount ? `${missingCount} missing ${missingCount === 1 ? "file" : "files"}` : manifest.assets.length ? "All files bound for this session" : "No files selected"}</span></div>
      {manifest.assets.length ? <ol className="catalog-list">{manifest.assets.map((asset, index) => <li key={asset.id} className="catalog-row">
        <div className="catalog-select"><Checkbox nativeButton render={<button />} id={`include-${asset.id}`} checked={selected.has(asset.id)} disabled={busy} aria-label={`Include ${asset.title}`} onCheckedChange={checked => {
          setSelected(current => { const next = new Set(current); if (checked) next.add(asset.id); else next.delete(asset.id); return next; });
        }} /><label htmlFor={`include-${asset.id}`}>{String(index + 1).padStart(2, "0")}</label></div>
        <div className="catalog-identity"><label htmlFor={`title-${asset.id}`} className="sr-only">Title for asset {index + 1}</label>
          <Input id={`title-${asset.id}`} key={`${asset.id}-${asset.title}`} defaultValue={asset.title} maxLength={200} onBlur={event => {
            const title = event.currentTarget.value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
            if (title && title !== asset.title) setManifest({ ...manifest, assets: manifest.assets.map(item => item.id === asset.id ? { ...item, title } : item) });
            else event.currentTarget.value = asset.title;
          }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <p className="catalog-file-hint">{asset.revision.filename} <span>· {sizeLabel(asset.revision.byteLength)}</span></p>
          <details className="catalog-details"><summary>Identity <span>{asset.id.slice(0, 8)}</span></summary><dl>
            <dt>Asset ID</dt><dd>{asset.id}</dd><dt>Revision</dt><dd>{asset.revision.id}</dd><dt>Session file</dt><dd>{bindings.get(asset.id)?.name ?? "Missing. Reselect matching bytes."}</dd>
          </dl></details>
        </div>
        <div className="catalog-binding"><span>{bindings.has(asset.id) ? "File bound" : "Missing file"}</span>
          <Button variant="outline" size="sm" onClick={() => { rebindTarget.current = asset; rebindInput.current?.click(); }}>{bindings.has(asset.id) ? "Rebind file" : "Reselect file"}</Button>
        </div>
        <div className="catalog-row-actions"><Button variant="ghost" size="icon" aria-label={`Move ${asset.title} up`} disabled={index === 0} onClick={() => move(asset.id, -1)}><ArrowUp aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon" aria-label={`Move ${asset.title} down`} disabled={index === manifest.assets.length - 1} onClick={() => move(asset.id, 1)}><ArrowDown aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon" aria-label={`Remove ${asset.title}`} onClick={() => remove(asset.id)}><X aria-hidden="true" /></Button>
        </div>
      </li>)}</ol> : <div className="catalog-empty"><h3>Your first playlist starts here.</h3><p>Add a few WAV or MP3 files, or import a saved manifest. Files with the same name remain separate assets.</p><Button variant="outline" onClick={() => fileInput.current?.click()}>Choose local files</Button></div>}
      <div className="catalog-open"><div><p>{selectedAssets.length} selected{missingSelected ? ` · ${missingSelected} need files` : ""}</p><span>Opens in playlist order, paused.</span></div>
        <Button disabled={!selectedAssets.length || missingSelected > 0} onClick={() => { setError(""); setTracks(catalogTracks(manifest, bindings, selected)); }}>Open selection in player</Button>
      </div>
    </fieldset>
    <details className="catalog-limits"><summary>Local catalog details</summary><p>Asset IDs belong to this catalog. SHA-256 identifies the exact encoded file bytes, including metadata. Renaming a file does not change its revision. Changing any bytes requires a new asset in this v0. No files, paths or access permissions are stored in the manifest.</p><p>File admission checks the WAV/MP3 extension and size. The existing player validates audio when a track opens; its Settings describe supported encodings, rates and duration limits. This experiment does not scan folders, upload files or cache decoded audio.</p></details>
  </main>;
}
