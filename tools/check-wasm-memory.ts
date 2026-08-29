import { readFileSync } from "node:fs";

const EXPECTED_PAGES = 256;
const WASM_PAGE_BYTES = 65_536;
const path = process.argv[2];
if (path === undefined) {
  throw new Error("usage: bun tools/check-wasm-memory.ts <module.wasm>");
}

const bytes = new Uint8Array(readFileSync(path));
const memories = readDefinedMemories(bytes);
if (memories.length !== 1) {
  throw new Error(`expected one defined memory, found ${memories.length}`);
}
const memory = memories[0];
if (memory === undefined) {
  throw new Error("missing defined memory");
}
if (memory.shared) {
  throw new Error("Wasm memory must be unshared");
}
if (memory.minimum !== EXPECTED_PAGES || memory.maximum !== EXPECTED_PAGES) {
  throw new Error(
    `expected fixed ${EXPECTED_PAGES}-page memory, got min=${memory.minimum} max=${memory.maximum}`,
  );
}

const module = await WebAssembly.compile(bytes);
const memoryExports = WebAssembly.Module.exports(module).filter(
  (entry) => entry.kind === "memory",
);
if (memoryExports.length !== 1 || memoryExports[0]?.name !== "memory") {
  throw new Error("expected one exported memory named memory");
}

console.log(
  JSON.stringify({
    bytes: EXPECTED_PAGES * WASM_PAGE_BYTES,
    exportedName: memoryExports[0].name,
    maximumPages: memory.maximum,
    minimumPages: memory.minimum,
    shared: memory.shared,
  }),
);

type MemoryLimits = {
  maximum: number | null;
  minimum: number;
  shared: boolean;
};

function readDefinedMemories(moduleBytes: Uint8Array): MemoryLimits[] {
  if (
    moduleBytes[0] !== 0x00 ||
    moduleBytes[1] !== 0x61 ||
    moduleBytes[2] !== 0x73 ||
    moduleBytes[3] !== 0x6d
  ) {
    throw new Error("invalid Wasm magic");
  }

  const memories: MemoryLimits[] = [];
  let offset = 8;
  while (offset < moduleBytes.length) {
    const sectionId = moduleBytes[offset];
    offset += 1;
    const sectionSize = readU32(moduleBytes, offset);
    offset = sectionSize.next;
    const sectionEnd = offset + sectionSize.value;
    if (sectionEnd > moduleBytes.length) {
      throw new Error("truncated Wasm section");
    }
    if (sectionId === 5) {
      const count = readU32(moduleBytes, offset);
      offset = count.next;
      for (let index = 0; index < count.value; index += 1) {
        const flags = readU32(moduleBytes, offset);
        offset = flags.next;
        const minimum = readU32(moduleBytes, offset);
        offset = minimum.next;
        let maximum: number | null = null;
        if ((flags.value & 0x01) !== 0) {
          const parsedMaximum = readU32(moduleBytes, offset);
          offset = parsedMaximum.next;
          maximum = parsedMaximum.value;
        }
        memories.push({
          maximum,
          minimum: minimum.value,
          shared: (flags.value & 0x02) !== 0,
        });
      }
    }
    offset = sectionEnd;
  }
  return memories;
}

function readU32(
  bytes: Uint8Array,
  start: number,
): { next: number; value: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift < 35) {
    const byte = bytes[offset];
    if (byte === undefined) {
      break;
    }
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { next: offset, value: value >>> 0 };
    }
    shift += 7;
  }
  throw new Error("invalid u32 LEB128");
}
