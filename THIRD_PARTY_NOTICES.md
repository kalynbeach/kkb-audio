# MP3 decoder notices

The local MP3 worker uses unmodified Symphonia **0.6.1** (`symphonia`,
`symphonia-core`, `symphonia-bundle-mp3`, `symphonia-metadata`), copyright
2019–2026 The Project Symphonia Developers, under Mozilla Public License 2.0.
The full license is distributed as `MPL-2.0.txt` beside the browser assets
(and `licenses/MPL-2.0.txt` in this repository).

Corresponding covered source, including the exact released source used to
build this executable, is freely available from:

- https://crates.io/crates/symphonia/0.6.1
- https://crates.io/crates/symphonia-core/0.6.1
- https://crates.io/crates/symphonia-bundle-mp3/0.6.1
- https://crates.io/crates/symphonia-metadata/0.6.1
- https://github.com/pdeljanov/Symphonia

No covered dependency source has been modified. Cargo.lock records exact
transitive versions. MP3-only features do not enable unrelated codecs.
This notice adds MP3 attribution; it does not replace other dependencies'
license files or the existing Inter font notice.

## Newly added transitive dependencies (MIT option)

### bytemuck 1.25.2

Source: https://crates.io/crates/bytemuck/1.25.2

```text
MIT License

Copyright (c) 2019 Daniel "Lokathor" Gee.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### lazy_static 1.5.0

Source: https://crates.io/crates/lazy_static/1.5.0

```text
Copyright (c) 2010 The Rust Project Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### regex-lite 0.1.9

Source: https://crates.io/crates/regex-lite/0.1.9

```text
Copyright (c) 2014 The Rust Project Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### smallvec 1.16.1

Source: https://crates.io/crates/smallvec/1.16.1

```text
Copyright (c) 2018 The Servo Project Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## Compact player type and icons

Inter is distributed with `Inter-LICENSE.txt`. The player uses the repository’s
existing TX-02 font asset without changing its use/distribution boundary; license
entitlement has not been verified by this change. Departure Mono by Helena Zhang is distributed
under the SIL Open Font License 1.1 (`DepartureMono-LICENSE.txt`). Regular Phosphor
SVG definitions from `@phosphor-icons/react` 2.1.10 are distributed under MIT
(`Phosphor-LICENSE.txt`). The static phosphor study image is not shipped.

Departure Mono font and OFL source: https://github.com/rektdeckard/departure-mono/tree/75152a3f1e6dacdd248a6c397c97dbf27e33eea0/public/assets
The font is byte-identical to that upstream WOFF2 (SHA256
`5b4fed1daa90708aa9c6ee1190abca9dc22164a1c1def0020386e46b61038cfb`).
The prior prototype notice accidentally copied the website MIT license; the
distributed `DepartureMono-LICENSE.txt` now contains the actual font OFL.

## KKB WebGPU oscilloscope

The experimental Wave Player vendors the P31 phosphor renderer from Kalyn Beach's
`kalynbeach/kkb` repository at commit `a396ec27cf2f1aa57bddb75c04d04cd3ec6d8464`.
Source: `packages/audio/src/oscilloscope` at that revision.

- `renderer/shaders/{trace,fade,composite}.ts` are copied with provenance comments.
- `renderer/pipeline.ts`, `renderer/uniforms.ts`, and `modes/xy.ts` are adapted in
  `web/src/wave-scope` for explicit playback input, bounded resources, failure
  reporting, persistence clearing, and complete disposal.
- The local preset and React observer are authored for this experiment. No
  microphone, oscillator source, or cross-repository runtime dependency is copied.

The source repository and audio package declare no redistribution license. This
same-owner integration is made under Kalyn's explicit direction; this notice does
not grant a public license to the renderer. It preserves source attribution and
does not change the repository's distribution boundary. The source repository's
font licenses do not apply to this renderer.
