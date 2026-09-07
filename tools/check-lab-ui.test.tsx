import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LabRequest, LabResult } from "../web/src/lab-model.ts";

GlobalRegistrator.register({ url: "http://localhost/lab.html" });
Object.defineProperty(document, "fonts", {
  value: { ready: Promise.resolve() },
});

// Canvas pixels are checked in the browser; these tests exercise React and worker ownership.
mock.module("../web/src/lab-canvas.ts", () => ({
  drawOverview() {},
  drawScope() {},
  frameAt: () => 0,
  miniature: () => "",
}));

type Reply =
  | { type: "rendered"; result: LabResult }
  | { type: "failed"; request: number; message: string };

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  requests: LabRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<Reply>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    ControlledWorker.instances.push(this);
  }
  postMessage(request: LabRequest) {
    this.requests.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
  reply(request: LabRequest) {
    // No DSP is reproduced here. The Wasm suite checks samples; only the reply revision matters.
    const result: LabResult = {
      request: request.request,
      partition: request.config.partition,
      renderMs: 1,
      operations: [],
      traces: [],
      observation: [],
      comparison: request.compare ? 0 : null,
    };
    this.onmessage?.(
      new MessageEvent("message", { data: { type: "rendered", result } }),
    );
    return result;
  }
  fail(request: LabRequest) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "failed",
          request: request.request,
          message: "Engine rejected the render",
        },
      }),
    );
  }
}

Object.defineProperty(globalThis, "Worker", {
  value: ControlledWorker,
  configurable: true,
});

const { StrictMode } = await import("react");
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { useLab } = await import("../web/src/use-lab.ts");
const { LabApp } = await import("../web/src/lab-app.tsx");

afterEach(() => {
  cleanup();
  ControlledWorker.instances = [];
  localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

async function workerAt(index = 0) {
  await waitFor(() =>
    expect(ControlledWorker.instances[index]?.requests.length).toBeGreaterThan(
      0,
    ),
  );
  return ControlledWorker.instances[index];
}

async function requestAt(worker: ControlledWorker, index: number) {
  await waitFor(() => expect(worker.requests).toHaveLength(index + 1));
  return worker.requests[index];
}

describe("React lab worker lifecycle", () => {
  test("edits invalidate replies immediately and debounce the latest configuration", async () => {
    const { result } = renderHook(useLab);
    const worker = await workerAt();
    const original = worker.requests[0];
    act(() => {
      worker.reply(original);
    });
    const accepted = result.current.state.result;

    act(() => {
      result.current.actions.setSource("frequencyA", 440);
      result.current.actions.setSource("frequencyB", 660);
      worker.reply(original);
    });
    expect(result.current.state.renderStatus).toBe("pending");
    expect(result.current.state.result).toBe(accepted);
    const latest = await requestAt(worker, 1);
    expect(latest.config.frequencyA).toBe(440);
    expect(latest.config.frequencyB).toBe(660);
    expect(latest.request).toBeGreaterThan(original.request);
    let rendered: LabResult | null = null;
    act(() => {
      rendered = worker.reply(latest);
    });
    expect(result.current.state.renderStatus).toBe("ready");
    expect(result.current.state.result).toBe(rendered);
  });

  test("dragging rejects an outstanding comparison and renders the released position", async () => {
    const { result } = renderHook(useLab);
    const worker = await workerAt();
    act(() => {
      result.current.actions.loadLesson(1);
    });
    const lessonRequest = await requestAt(worker, 1);
    act(() => {
      worker.reply(lessonRequest);
      result.current.actions.compare();
    });
    const comparison = await requestAt(worker, 2);
    expect(comparison.compare).toBe(true);
    const accepted = result.current.state.result;

    act(() => {
      result.current.actions.beginDrag(1);
      result.current.actions.moveMarker(1, 30000, true);
      worker.reply(comparison);
    });
    expect(result.current.state.renderStatus).toBe("dragging");
    expect(result.current.state.comparing).toBe(false);
    expect(result.current.state.result).toBe(accepted);
    expect(worker.requests).toHaveLength(3);
    act(() => {
      result.current.actions.endDrag();
    });
    const released = await requestAt(worker, 3);
    expect(released.config.events[0].frame).toBe(30000);
    expect(released.compare).toBe(false);
    act(() => {
      worker.reply(released);
    });
    expect(result.current.state.renderStatus).toBe("ready");
  });

  test("StrictMode leaves one worker and unmount cancels its pending render", async () => {
    const { result, unmount } = renderHook(useLab, { wrapper: StrictMode });
    const worker = await workerAt();
    expect(ControlledWorker.instances).toHaveLength(1);
    expect(worker.requests).toHaveLength(1);
    act(() => {
      result.current.actions.setSource("frequencyA", 440);
    });
    const snapshot = result.current.state;
    unmount();
    expect(worker.terminated).toBe(true);
    act(() => {
      worker.reply(worker.requests[0]);
      worker.onerror?.();
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(worker.requests).toHaveLength(1);
    expect(result.current.state).toBe(snapshot);
  });

  test.each(["message", "error"] as const)(
    "a worker %s failure can be retried with Reset",
    async (failure) => {
      const { result } = renderHook(useLab);
      const failed = await workerAt();
      act(() => {
        if (failure === "message") failed.fail(failed.requests[0]);
        else failed.onerror?.();
      });
      expect(result.current.state.renderStatus).toBe("failed");
      expect(result.current.state.renderError).toBeTruthy();
      expect(failed.terminated).toBe(true);

      act(() => {
        result.current.actions.loadLesson(result.current.state.lesson);
      });
      const replacement = await workerAt(1);
      act(() => {
        replacement.reply(replacement.requests[0]);
        failed.onerror?.();
      });
      expect(result.current.state.renderStatus).toBe("ready");
      expect(result.current.state.renderError).toBeNull();
      expect(replacement.terminated).toBe(false);
    },
  );

  test("page restoration recreates the worker with the current experiment", async () => {
    const { result } = renderHook(useLab);
    const original = await workerAt();
    act(() => {
      result.current.actions.setSource("frequencyA", 880);
    });
    const edited = await requestAt(original, 1);
    act(() => {
      original.reply(edited);
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(original.terminated).toBe(true);

    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => {
      window.dispatchEvent(restored);
    });
    const replacement = await workerAt(1);
    expect(replacement.requests[0].config).toEqual(edited.config);
    expect(result.current.state.renderStatus).toBe("pending");
    act(() => {
      original.reply(edited);
    });
    expect(result.current.state.renderStatus).toBe("pending");
    act(() => {
      replacement.reply(replacement.requests[0]);
    });
    expect(result.current.state.renderStatus).toBe("ready");
  });
});

describe("React lab event editor", () => {
  test("negative drafts remain editable and commit on Enter or blur", async () => {
    const user = userEvent.setup();
    const view = render(<LabApp />);
    const worker = await workerAt();
    await user.click(view.getByRole("button", { name: "Gain set" }));
    await requestAt(worker, 1);
    const value = view.getByRole("spinbutton", {
      name: "Value",
    }) as HTMLInputElement;
    await user.clear(value);
    await user.type(value, "-0.35");
    expect(value.value).toBe("-0.35");
    await act(() => new Promise((resolve) => setTimeout(resolve, 130)));
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].config.events[0].value).toBe(0.1);
    await user.keyboard("{Enter}");
    expect((await requestAt(worker, 2)).config.events[0].value).toBe(-0.35);

    await user.clear(value);
    await user.type(value, "-0.6");
    await user.tab();
    expect((await requestAt(worker, 3)).config.events[0].value).toBe(-0.6);
  });

  test("selecting another event retains selector focus and resets its numeric drafts", async () => {
    const user = userEvent.setup();
    const view = render(<LabApp />);
    await workerAt();
    await user.click(view.getByRole("button", { name: "Gain set" }));
    await user.click(view.getByRole("button", { name: "Gain set" }));
    const selector = view.getByRole("combobox", {
      name: "Selected event",
    }) as HTMLSelectElement;
    const oldValue = view.getByRole("spinbutton", {
      name: "Value",
    }) as HTMLInputElement;
    fireEvent.change(oldValue, { target: { value: "-0.6" } });
    selector.focus();
    fireEvent.change(selector, { target: { value: "2" } });
    expect(view.getByRole("combobox", { name: "Selected event" })).toBe(
      selector,
    );
    expect(document.activeElement).toBe(selector);
    expect(selector.value).toBe("2");
    const selectedValue = view.getByRole("spinbutton", {
      name: "Value",
    }) as HTMLInputElement;
    expect(selectedValue.value).toBe("0.1");
    expect(selectedValue).not.toBe(oldValue);
  });
});
