# Plan: add the Demucs v4 6-stem model (`htdemucs_6s`)

Status: proposal, not started.

## Decisions

- **One Demucs variant: `htdemucs_6s` in FP16.** No FP32 and no int8 file.
- **Demucs runs on WebGPU only.** Without WebGPU, the app keeps using Spleeter,
  which stays the model for slow devices.
- **The UI shows whether WebGPU is available** and says that Demucs is slower
  than Spleeter.

## Where the app stands today

- **Fixed set of five stems.** The app ships five separate Spleeter ONNX
  models, one per stem, each in FP16 and FP32
  (`models/fp16|fp32/<stem>.onnx`). `STEMS` is a single constant
  (`src/types.ts`). `completeSeparation` stores every stem in `STEMS`
  (`src/storage.ts`). Volumes are a `Record<Stem, number>` with all stems
  required.
- **Built around Spleeter.** `src/stft.ts` feeds magnitude spectrograms to the
  models; a softmax over their outputs gives masks, and overlap-add rebuilds
  the audio. The worker (`src/inference.worker.ts`) runs five sessions per
  segment.
- **Demucs works differently:**
  - One network outputs all six stems: drums, bass, other, vocals, guitar,
    piano.
  - It is hybrid: one branch works on the waveform, the other on a complex
    spectrogram (n_fft 4096, hop 1024); the two outputs are summed.
  - Segments are about 7.8 s (343,980 samples) with 25% overlap and weighted
    overlap-add.
  - The whole track is normalized by its mean and standard deviation first,
    and the stems are scaled back afterwards.
  - It returns audio directly, with no masks, so the stems do not sum exactly
    to the input.

So this is a second separation engine beside the current one, not just more
model files.

## Why Demucs, and what it costs

Figures below are published or typical numbers, not measurements in this app.
Step 0 and Step 4 replace them with measured ones.

- **Quality.** On MUSDB18-HQ, htdemucs (4-stem) reaches about 9 dB average SDR
  against about 5.9 dB for Spleeter: an audible drop in bleed and in "watery"
  artifacts. `htdemucs_6s` scores close to it on the four shared stems; its
  guitar stem is usable, its piano stem weak (the authors say so). Piano users
  may still prefer Spleeter, which keeps it as a separate model.
- **Quantization keeps that lead.** FP16 is close to lossless; careful int8
  usually costs about 0.1–0.3 dB, and Meta's own quantized Demucs releases
  (`mdx_q`, `mdx_extra_q`) lost almost nothing. A quantized Demucs is still far
  ahead of Spleeter.
- **Weights: about the same size as today.** htdemucs has roughly 42 M
  parameters (`htdemucs_6s` is in the same range; measure at export):

  | Precision | Demucs (one file, approx.) | Spleeter (5 files, today) |
  | --------- | -------------------------- | ------------------------- |
  | FP32      | ~170 MB                    | ~197 MB                   |
  | FP16      | ~85 MB                     | ~98 MB                    |
  | Int8      | ~42 MB                     | –                         |

  FP16 Demucs already matches the FP16 Spleeter set, so quantizing further is
  not needed to match memory.
- **Activations are the real memory cost.** Quantization shrinks only the
  weights. The transformer's cross-attention over the 7.8 s segment needs more
  working memory per segment than Spleeter's U-Nets, so peak memory can exceed
  Spleeter even at equal file size. The `MODEL_FILE_BYTES × MODEL_RUNTIME_FACTOR`
  estimate in `src/memory.ts` does not carry over; measure it (Step 4).
- **Compute: much heavier.** Expect several times Spleeter's work per second
  of audio (roughly 5–20×). Fine on WebGPU; on the WASM fallback (browsers or
  devices without WebGPU) a full track can take minutes instead of seconds.
- **Int8 runs poorly on WebGPU.** ONNX Runtime Web's WebGPU backend has weak
  int8 support: dynamically quantized operators (`MatMulInteger`,
  `ConvInteger`) are missing or fall back to the CPU, which loses the speed
  WebGPU brings. Weight-only 4-bit `MatMulNBits` exists but covers only the
  transformer's matmuls, not the convolutions that hold most of the weights.
  So FP16 is the practical WebGPU precision, and int8 is mainly a way to shrink
  the download for WASM.

**Conclusion:** add Demucs as the high-quality option, in FP16 on WebGPU
only (see Decisions). Keep Spleeter as the fast, low-memory option for devices
without WebGPU, and for a proper piano stem.

## Step 0 – Convert the model (main risk, do first)

We export and convert the model ourselves, from the official checkpoint, with
a script in this repo. Ready-made community ONNX files exist (below), but they
are self-published and unaudited. Their export choices also differ: STFT
inside or outside the graph, segment length, and FP16 weights versus FP16
compute. A reproducible export that matches our TypeScript pipeline is easier
to trust and test. Use them as references and as a benchmark, not as the
shipped file.

**Existing exports to learn from** (found November 2026, claims from their
model cards, not verified):

| Repo | What it is | Useful lesson |
| --- | --- | --- |
| [StemSplitio/htdemucs-6s-onnx](https://huggingface.co/StemSplitio/htdemucs-6s-onnx) (mirrors: adowu, Acapellas) | 6-stem, FP32 and `htdemucs_6s_fp16weights.onnx` | "FP16 weights": stored in FP16, computed in FP32. Smaller download, little runtime memory saving. |
| [kramp/htdemucs-6s-webgpu-onnx](https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx) | 6-stem, iSTFT inside the graph | A `ConstantOfShape` in the embedded inverse STFT does not run on ORT Web's WebGPU backend. Keeping the STFT outside avoids it. |
| [monteslu/htdemucs-ft-webgpu](https://huggingface.co/monteslu/htdemucs-ft-webgpu), [monteslu/htdemucs-web-onnx](https://huggingface.co/monteslu/htdemucs-web-onnx) | 4-stem, built for ORT Web on WebGPU, mixed precision | Many Hub exports fail to load on WebGPU; the legacy `torch.onnx.export` (TorchScript, opset 17) works, while the dynamo exporter gave NaNs on WebGPU. |
| [Andremi/audioweb-models](https://huggingface.co/Andremi/audioweb-models) | 6-stem FP16-weight files at 7.8 s and 3.9 s segments | A shorter segment is an option for low-memory devices. |
| [demucs-onnx](https://pypi.org/project/demucs-onnx/) (PyPI) | Export tool for htdemucs, htdemucs_ft, htdemucs_6s | Reference export code. |
| [timcsy/demucs-web](https://github.com/timcsy/demucs-web) | npm package, WebGPU and WASM, ~172 MB model | Needs cross-origin isolation, as our nginx build has. |

1. Write `scripts/export-htdemucs.py`, pinned to `demucs==4.0.1` and the
   `htdemucs_6s` checkpoint (verify its hash).
   - Keep the STFT and inverse STFT out of the ONNX graph: torch's complex STFT
     does not export cleanly (the approach demucs.onnx uses).
   - Graph inputs: waveform `[1,2,343980]` and the spectrogram with real and
     imaginary parts as separate channels `[1,4,2048,336]`.
   - Graph outputs: waveform branch `[1,6,2,343980]` and spectral branch
     `[1,6,4,2048,336]`.
   - Legacy `torch.onnx.export` (TorchScript, `dynamo=False`), opset 17,
     fixed shapes. The dynamo exporter is reported to give NaNs on WebGPU.
2. Compare ONNX Runtime with PyTorch on the same segment; error below about
   1e-4.
3. Export a few small reference cases (input, STFT, outputs, final stems) into
   `src/__fixtures__/demucs/` to test the TypeScript port against.
4. Precision: **FP16 only.**
   - Convert with `onnxconverter_common.float16` and FP32 inputs and outputs
     (`keep_io_types`). Transformer layers can overflow in FP16 (watch softmax
     and layer norm; keep those in FP32 with the converter's block list if
     needed).
   - Try true FP16 compute first (less GPU memory, faster). If it fails the
     quality check even with a block list, fall back to FP16 weights with FP32
     compute, the "fp16weights" approach: same download size, more runtime
     memory.
   - The FP32 export is a development reference only, never shipped. The FP16
     file must stay within about 0.1 dB SDR of it on a few MUSDB tracks.
   - Record the file size, SDR and per-segment time in this document.
5. Quick browser test with ONNX Runtime Web 1.31 on WebGPU, before any app
   work: unsupported operators or memory blow-ups show up here. Measure time
   per 7.8 s segment and peak memory for one segment
   (`measureUserAgentSpecificMemory()` on the cross-origin-isolated build), and
   time a 5-minute track against Spleeter on the same machine for the "slower"
   hint (Step 4). Run StemSplitio's `htdemucs_6s_fp16weights.onnx` through the
   same test as a benchmark for our file's size, speed and output.

**Gate:** if the browser test fails, stop or change the export before going
further.

## Step 1 – Models and stems as data, not constants

- `src/types.ts`:
  - `ModelId = "spleeter-5" | "htdemucs-6s"`.
  - `ALL_STEMS` = vocals, drums, bass, guitar, piano, other (also the display
    order); add `guitar` to `STEM_LABELS`.
  - `MODEL_STEMS: Record<ModelId, readonly Stem[]>`.
  - `volumes` becomes `Partial<Record<Stem, number>>`, read as
    `volumes[stem] ?? 1` (old projects have no guitar volume).
- `Project.model?: ModelId`; missing means Spleeter, so no IndexedDB migration.
- `src/models.ts`:
  - A model registry: model id → files, qualities offered, stems, approximate
    size, and whether it needs WebGPU.
  - `modelKey` and `loadModel` take a model plus a file name.
  - Demucs: one file, `htdemucs_6s/htdemucs_6s.fp16.onnx`, a single quality
    and `requiresWebGpu: true`. Spleeter keeps its FP16 and FP32 files.
- `completeSeparation`:
  - Store the stems the worker returns, not `STEMS`.
  - First delete the project's existing stems and peaks in the same
    transaction, so switching from Demucs back to Spleeter leaves no stale
    guitar stem.
- Replace uses of `STEMS` with `ALL_STEMS.filter(completedStems)` or the
  model's stems: mixer (`src/view/mixer.ts`), export (`src/export.ts`). The
  player and waveforms already loop over `completedStems`.
- `src/messages.ts`: `separate` carries `model` as well as `quality`; `stems`
  and `peaks` become `Partial<Record<Stem, …>>`.

## Step 2 – Two engines behind one interface

- `src/inference.worker.ts` keeps the common parts: WebGPU/WASM choice and
  fallback, cancellation, progress, FLAC encoding, waveform peaks.
- No WASM fallback for Demucs: if WebGPU session creation or inference fails
  (including `device.lost`), stop with an error that offers to separate with
  Spleeter instead. Spleeter keeps today's WebGPU → WASM retry.
- Model-specific code moves behind a `Separator` interface (`load`,
  `run(samples, onSamples)`, `release`):
  - `src/separators/spleeter.ts`: today's code, moved unchanged.
  - `src/separators/demucs.ts`: the new engine.
- `src/progress.ts` already takes a model count; Demucs has one download.

## Step 3 – Demucs pipeline in TypeScript (`src/demucs.ts`)

1. **Normalize:** mean and standard deviation of the mono mix over the whole
   track; work on `(x − mean) / std`.
2. **Segment:** 343,980 samples, step 75% of that, zero padding at the ends
   (as `apply_model` with `split=True, overlap=0.25, shifts=0`).
3. **STFT per segment, matching Demucs exactly:** reflect padding, centered
   Hann window, scaled by 1/√n_fft; drop the Nyquist bin; trim frame padding as
   `_spec` does; real and imaginary parts as channels. Reuse `fftInPlace` from
   `src/audio-core.ts`.
4. **Run the model**, apply the inverse STFT (`_ispec`) to the spectral output,
   add the waveform output.
5. **Overlap-add** with Demucs's triangular weight and a running weight sum.
   Emit each stem's samples once final, as `OverlapAddSynthesizer` does, so
   memory stays bounded.
6. **Scale back:** multiply by `std`, add `mean`.
7. **Tests:** against the Step 0 references (STFT, inverse STFT, overlap
   weights, one full segment), plus STFT → inverse STFT round trip.

## Step 4 – UI and memory estimate

- **WebGPU detection on the main thread.** New `src/gpu.ts` with
  `detectWebGpu(): Promise<boolean>` (`navigator.gpu?.requestAdapter()`,
  cached). The worker's `preferredProvider` stays as it is; the main thread
  needs its own answer to build the picker before any separation. The worker
  reports the provider it actually used in its progress messages, so a
  WebGPU failure at run time shows up in the UI too.
- **WebGPU status in `src/view/detail.ts`**, near the model picker:
  - available: "WebGPU: available", so the user knows separation runs on the
    GPU;
  - not available: "WebGPU: not available – separation runs on the CPU", and
    Demucs is unavailable.
- **Model picker:**
  - "Spleeter · 5 stems · fast", with its FP16/FP32 quality buttons.
  - "Demucs v4 · 6 stems · better quality, slower", single quality, so no
    quality buttons. Its hint says separation takes longer than with Spleeter
    (with the measured ratio from Step 0, e.g. "about N× longer"), and that its
    piano stem is weak (the Demucs authors say so).
  - Without WebGPU, the Demucs option is shown disabled with "Needs WebGPU",
    rather than hidden, so users learn that a better model exists.
  - Each option shows its download size. Changing the model saves the project,
    like the quality switch in `src/main.ts`.
  - Default for new projects: Demucs with WebGPU, Spleeter without. A project
    saved with Demucs, opened later on a device without WebGPU, keeps its
    stems; only a new separation must use Spleeter.
- **Progress:** while Demucs runs, show "Separating with Demucs – this takes
  longer than Spleeter" so a slow bar does not look stuck.
- `src/memory.ts`: model file size and runtime factor per model, from the
  registry, plus a per-model working-memory term for one segment (activations
  do not scale with file size). Measure Demucs FP16 on WebGPU in Chromium
  (60 s and 5 min tracks), as was done for Spleeter. Attention over the 7.8 s
  segment is the main extra cost.

## Step 5 – Build, CI, docs, licence

- `vite.config.ts`: widen the dev-server model path pattern to allow
  `htdemucs_6s/…`. The model list and packaging already scan subfolders.
- `.github/workflows/ci.yml`: replace the "5 models per quality" check with a
  per-model check (5 + 5 Spleeter, plus the one Demucs FP16 file).
- Add `models/LICENSE-DEMUCS` (MIT, Meta); store the Demucs file in Git LFS
  with the Spleeter models (decided).
- README: new download and build sizes, the model choice, Demucs needs
  WebGPU and is slower than Spleeter.
- e2e:
  - Headless Chromium in CI has no WebGPU adapter, so the picker shows
    "WebGPU: not available", Demucs is disabled with "Needs WebGPU", and
    Spleeter is the default. Test that.
  - Stub `detectWebGpu` to true to test the "available" status, the "slower"
    hint and the Demucs default, without running the model.
  - A real Demucs separation (six FLAC stems, a guitar row in the mixer,
    switching back to Spleeter removes the guitar stem) needs a WebGPU-capable
    runner; run it manually or on such a runner, not in the default CI.

## Milestones

| #   | Milestone                                                              | Risk     |
| --- | ---------------------------------------------------------------------- | -------- |
| M8a | Export script, check against PyTorch, browser test (Step 0)            | **High** |
| M8b | Model registry, flexible stems, separator interface (Steps 1–2)        | Low      |
| M8c | Demucs engine and its tests (Step 3)                                   | Medium   |
| M8d | Model picker, memory numbers, docs, CI, e2e (Steps 4–5)                | Low      |

M8b can run alongside M8a; it changes nothing for users.

## Open decisions

1. **If FP16 fails the Step 0 check** (overflow that keeping a few layers in
   FP32 does not fix): ship FP32 on WebGPU instead (~170 MB), or drop Demucs?

## Appendix: available memory in browsers

Browsers do not expose free or total system RAM (fingerprinting risk). What
exists:

| API | Gives | Support | Limits |
| --- | --- | --- | --- |
| `navigator.deviceMemory` | Approximate total RAM, power of two, 0.25–8 GB | Chromium (also `Sec-CH-Device-Memory`) | Capped at 8; not free memory. Already used in `src/memory.ts`. |
| `performance.measureUserAgentSpecificMemory()` | Memory this page uses | Chromium, `crossOriginIsolated` only | Usage, not headroom; async, waits for GC. Works on the nginx build, not GitHub Pages. |
| `performance.memory` | JS heap size and limit | Chromium, non-standard, deprecated | JS heap only; coarse unless isolated. |
| WebGPU `adapter.limits` | Largest buffer allowed | WebGPU browsers | API caps, not VRAM. |
| `navigator.storage.estimate()` | Storage quota | All | Disk, not RAM. |
| Compute Pressure API | Pressure level | Chromium | CPU only. |

Firefox and Safari expose nothing. Probing by allocating until `RangeError`
finds only the address-space limit, and mobile OSes often kill the tab first;
not recommended.

Consequences for this plan:

1. Keep the estimate-plus-`deviceMemory` warning; never warn when unknown.
2. Calibrate Demucs memory once in development with
   `measureUserAgentSpecificMemory()` or the Chrome task manager.
3. Recover from running out of memory: for Spleeter, WebGPU `device.lost` and
   allocation errors → fall back to WASM; for Demucs, stop and offer Spleeter
   (no WASM fallback). On WASM `RangeError`, ONNX Runtime allocator errors or
   a worker crash, suggest a shorter track or the Spleeter model.
4. The default model follows WebGPU availability (Step 4), never a memory
   number alone; `deviceMemory` only drives the long-track warning.
