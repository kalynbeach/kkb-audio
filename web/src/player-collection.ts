import type { PlaybackOwner } from "./playback-owner";

export const SESSION_LIMIT = 100;
export type PlayerInitialTrack = { file: File; title?: string };
export type SessionEntry = { id: string; file: File; title: string; duration: number | null; error: string | null };
type CollectionState = { entries: readonly SessionEntry[]; selected: string | null; active: string | null; notice: string };

/** Private file/activation coordinator. PlaybackOwner alone owns preparation and audio resources. */
export class PlayerCollection {
  #state: CollectionState = { entries: [], selected: null, active: null, notice: "" };
  #listeners = new Set<() => void>();
  #nextId = 0;
  #activation = 0;
  #playAfterLoad = false;
  constructor(private readonly owner: PlaybackOwner, initialTracks: readonly PlayerInitialTrack[] = []) {
    if (initialTracks.length) this.#addTracks(initialTracks);
  }
  getState = () => this.#state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(patch: Partial<CollectionState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  add(files: Iterable<File>) {
    this.#addTracks(Array.from(files, file => ({ file })));
  }
  #addTracks(tracks: Iterable<PlayerInitialTrack>) {
    const entries = [...this.#state.entries];
    let added = 0, unsupported = 0, overflow = 0;
    // Admission uses names only, never reads bytes or deduces identity from a name.
    for (const { file, title } of tracks) {
      if (!/\.(wav|mp3)$/i.test(file.name)) { unsupported++; continue; }
      if (entries.length === SESSION_LIMIT) { overflow++; continue; }
      entries.push({ id: `entry-${++this.#nextId}`, file, title: title ?? file.name, duration: null, error: null });
      added++;
    }
    this.#publish({ entries, selected: this.#state.selected ?? entries[0]?.id ?? null,
      notice: `Added ${added}. ${unsupported} unsupported; ${overflow} over the ${SESSION_LIMIT}-file limit. Files stay in picker order; nothing starts playing.` });
  }
  select(id: string) {
    if (this.#state.entries.some(entry => entry.id === id)) this.#publish({ selected: id });
  }
  async activate(id: string, playing = false) {
    const entry = this.#state.entries.find(entry => entry.id === id);
    if (!entry) return;
    const activation = ++this.#activation;
    this.#playAfterLoad = playing;
    this.#publish({ active: id, entries: this.#state.entries.map(item => item.id === id ? { ...item, error: null } : item) });
    await this.owner.load(entry.file);
    if (activation !== this.#activation) return;
    this.captureMetadata();
    this.#playAfterLoad = false;
    if (playing && this.owner.getState().phase === "paused") await this.owner.play();
  }
  captureMetadata = () => {
    const state = this.owner.getState();
    const entry = this.#state.entries.find(item => item.id === this.#state.active);
    if (!entry || state.phase === "loading" || state.phase === "empty") return;
    const duration = state.sourceRate ? state.totalFrames / state.sourceRate : entry.duration;
    if (entry.duration === duration && entry.error === state.error) return;
    this.#publish({ entries: this.#state.entries.map(item => item === entry ? { ...item, duration, error: state.error } : item) });
  };
  async rowPlay(id: string) {
    const state = this.owner.getState();
    if (id !== this.#state.active || state.phase === "error" || state.phase === "empty") return this.activate(id, true);
    if (state.busy) return;
    await (state.phase === "playing" ? this.owner.pause() : this.owner.play());
  }
  move(direction: -1 | 1) {
    const index = this.#state.entries.findIndex(entry => entry.id === this.#state.active);
    const next = index < 0 ? undefined : this.#state.entries[index + direction];
    if (!next) return Promise.resolve();
    const phase = this.owner.getState().phase;
    return this.activate(next.id, phase === "playing" || (phase === "loading" && this.#playAfterLoad));
  }
  close() {
    ++this.#activation;
    this.#playAfterLoad = false;
    this.#publish({ active: null });
    return this.owner.close();
  }
  removeSelected() {
    const id = this.#state.selected;
    const index = this.#state.entries.findIndex(entry => entry.id === id);
    if (index < 0) return Promise.resolve();
    const entries = this.#state.entries.filter(entry => entry.id !== id);
    const closing = id === this.#state.active ? this.close() : Promise.resolve();
    this.#publish({ entries, selected: entries[index]?.id ?? entries[index - 1]?.id ?? null,
      notice: "Removed selected file from this session. Original file unchanged." });
    return closing;
  }
  clear() {
    const closing = this.close();
    this.#publish({ entries: [], selected: null, notice: "Session cleared. Original files unchanged." });
    return closing;
  }
}
