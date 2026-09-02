import { isPcmStreamConfig } from "./pcm-protocol";
import {
  FixedPcmProducer,
  PCM_WORKER_FAILURE_CODE,
} from "./pcm-worker-pool";

type InitializeMessage = {
  type: "initialize";
  config: unknown;
  port: MessagePort;
};

declare const self: {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
};

let producer: FixedPcmProducer | undefined;

self.onmessage = (event: MessageEvent<unknown>) => {
  const value = event.data as Partial<InitializeMessage> | { type?: unknown } | null;
  if (value?.type === "activate") {
    producer?.activate();
    return;
  }
  if (
    producer !== undefined ||
    value === null ||
    value.type !== "initialize" ||
    !("config" in value) ||
    !isPcmStreamConfig(value.config) ||
    !("port" in value) ||
    !(value.port instanceof MessagePort)
  ) {
    self.postMessage({ type: "worker-failed", code: PCM_WORKER_FAILURE_CODE });
    return;
  }

  const config = value.config;
  const port = value.port;
  producer = new FixedPcmProducer(
    config,
    (block) => {
      port.postMessage(block, [block.buffer]);
    },
    (code) => {
      self.postMessage({ type: "worker-failed", code });
    },
  );
  port.onmessage = (message: MessageEvent<unknown>) => {
    producer?.acceptAdmissionResult(message.data);
  };
  port.start();
  producer.prefill(config.slotCount);
  self.postMessage({
    type: "worker-ready",
    slotCount: config.slotCount,
    ...producer.snapshot(),
  });
};
