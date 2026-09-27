import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { addCatalogFiles, CATALOG_STORAGE_KEY, emptyCatalog, exportManifest } from "../web/src/catalog";

const LocalFile = File;
GlobalRegistrator.register({ url: "http://localhost/catalog" });
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { CatalogApp } = await import("../web/src/catalog-app");
afterEach(() => { cleanup(); sessionStorage.clear(); });
afterAll(() => GlobalRegistrator.unregister());

test("selection supports label clicks and keyboard input, and stays disabled during admission", async () => {
  const { manifest } = await addCatalogFiles(emptyCatalog(), new Map(), [new LocalFile(["abc"], "first.wav")]);
  sessionStorage.setItem(CATALOG_STORAGE_KEY, exportManifest(manifest));
  const view = render(<CatalogApp />);
  const user = userEvent.setup();
  const checkbox = view.getByRole("checkbox", { name: "Include first.wav" });
  await user.click(view.getByText("01"));
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  expect(view.getByText("0 selected")).toBeTruthy();
  checkbox.focus();
  await user.keyboard("[Space]");
  expect(checkbox.getAttribute("aria-checked")).toBe("true");

  let finish!: (bytes: ArrayBuffer) => void;
  class HeldFile extends LocalFile { override arrayBuffer() { return new Promise<ArrayBuffer>(resolve => { finish = resolve; }); } }
  fireEvent.change(view.getByLabelText("Add catalog files"), { target: { files: [new HeldFile(["def"], "second.wav")] } });
  expect(checkbox.matches(":disabled")).toBe(true);
  await user.click(checkbox);
  await user.keyboard("[Space]");
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  finish(new TextEncoder().encode("def").buffer);
  await waitFor(() => expect(view.getByText("2 selected · 1 need files")).toBeTruthy());
  expect(checkbox.matches(":disabled")).toBe(false);
});

test("reload restores only metadata; invalid import is atomic and exact-byte rebind recovers missing files", async () => {
  const a = new LocalFile(["abc"], "same.wav");
  const b = new LocalFile(["def"], "same.wav");
  const { manifest } = await addCatalogFiles(emptyCatalog(), new Map(), [a, b]);
  sessionStorage.setItem(CATALOG_STORAGE_KEY, exportManifest(manifest));
  const view = render(<CatalogApp />);
  const open = () => view.getByRole("button", { name: "Open selection in player" }) as HTMLButtonElement;
  expect(view.getByText("2 missing files")).toBeTruthy();
  expect(open().disabled).toBe(true);
  fireEvent.change(view.getByLabelText("Import catalog manifest"), { target: { files: [new LocalFile(['{"version":99}'], "bad.json")] } });
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Invalid manifest"));
  expect(sessionStorage.getItem(CATALOG_STORAGE_KEY)).toBe(exportManifest(manifest));
  fireEvent.click(view.getAllByRole("button", { name: "Reselect file" })[0]!);
  fireEvent.change(view.getByLabelText("Reselect matching file"), { target: { files: [b] } });
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("does not match"));
  expect(open().disabled).toBe(true);
  fireEvent.click(view.getAllByRole("button", { name: "Reselect file" })[0]!);
  fireEvent.change(view.getByLabelText("Reselect matching file"), { target: { files: [new LocalFile(["abc"], "renamed.wav")] } });
  await waitFor(() => expect(view.getByText("1 missing file")).toBeTruthy());
  expect(open().disabled).toBe(true);
  await userEvent.setup().click(view.getAllByRole("checkbox")[1]!);
  expect(open().disabled).toBe(false);
  const input = view.getByLabelText("Title for asset 1");
  fireEvent.change(input, { target: { value: "Edited title" } }); fireEvent.blur(input);
  fireEvent.click(view.getByRole("button", { name: "Move Edited title down" }));
  await waitFor(() => expect(sessionStorage.getItem(CATALOG_STORAGE_KEY)).toContain("Edited title"));
  const saved = JSON.parse(sessionStorage.getItem(CATALOG_STORAGE_KEY)!);
  expect(saved.assets.map((asset: { id: string }) => asset.id)).toEqual([manifest.assets[1]!.id, manifest.assets[0]!.id]);
  fireEvent.change(view.getByLabelText("Import catalog manifest"), { target: { files: [new LocalFile([JSON.stringify(saved)], "saved.json")] } });
  await waitFor(() => expect(view.getByText("2 missing files")).toBeTruthy());
  expect(open().disabled).toBe(true);
});
