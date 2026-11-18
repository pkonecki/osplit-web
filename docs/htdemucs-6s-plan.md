# Plan: add the Demucs v4 6-stem model (`htdemucs_6s`)

Status: proposal, not started.

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

**Conclusion:** Demucs is worth adding as the high-quality option, best on
WebGPU in FP16. Keep Spleeter as the fast, low-memory option and for a proper
piano stem, rather than replacing it.

## Step 0 – Convert the model (main risk, do first)

1. Write `scripts/export-htdemucs.py`, pinned to `demucs==4.0.1` and the
   `htdemucs_6s` checkpoint (verify its hash).
   - Keep the STFT and inverse STFT out of the ONNX graph: torch's complex STFT
     does not export cleanly (the approach demucs.onnx uses).
   - Graph inputs: waveform `[1,2,343980]` and the spectrogram with real and
     imaginary parts as separate channels `[1,4,2048,336]`.
   - Graph outputs: waveform branch `[1,6,2,343980]` and spectral branch
     `[1,6,4,2048,336]`.
   - Opset 17 or later, fixed shapes.
2. Compare ONNX Runtime with PyTorch on the same segment; error below about
   1e-4.
3. Export a few small reference cases (input, STFT, outputs, final stems) into
   `src/__fixtures__/demucs/` to test the TypeScript port against.
4. Precision (see "Why Demucs, and what it costs"):
   - Export FP32 as the reference.
   - **FP16 is the target for WebGPU**: FP16 weights with FP32 inputs and
     outputs (`keep_io_types`). Transformer layers can overflow in FP16 (watch
     softmax and layer norm; keep those in FP32 if needed). Ship it only if its
     SDR on a few MUSDB tracks is within about 0.1 dB of FP32.
   - **Int8 as an option for WASM only**: dynamic quantization
     (`onnxruntime.quantization.quantize_dynamic`, per-channel weights) to
     roughly halve the download. Accept it only if it stays within about
     0.3 dB of FP32 and is not slower than FP32 on WASM. Do not offer it on
     WebGPU (no int8 kernels there).
   - Record each variant's file size, SDR and per-segment time in this
     document.
5. Quick browser test with ONNX Runtime Web 1.31, on WebGPU and WASM, before
   any app work: unsupported operators or memory blow-ups show up here.
   Measure for each variant: time per 7.8 s segment, and peak memory for one
   segment (`measureUserAgentSpecificMemory()` on the cross-origin-isolated
   build). A segment much slower than real time on WASM is expected; note it,
   it decides the default model (Open decision 2).

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
    size.
  - `modelKey` and `loadModel` take a model plus a file name.
  - Demucs file: `htdemucs_6s/htdemucs_6s.onnx` (plus `.fp16.onnx` if Step 0
    approves FP16).
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

- `src/view/detail.ts`: model picker, "Spleeter · 5 stems" or "Demucs v4 ·
  6 stems (best on WebGPU)", each with its download size. Quality buttons show
  only what the selected model offers. Changing the model saves the project,
  like the quality switch in `src/main.ts`.
- `src/memory.ts`: model file size and runtime factor per model, from the
  registry, plus a per-model working-memory term for one segment (activations
  do not scale with file size, so a quantized file does not mean less of
  them). Measure Demucs in Chromium (60 s and 5 min tracks, FP16 on WebGPU
  and FP32/int8 on WASM), as was done for Spleeter. Attention over the 7.8 s
  segment is the main extra cost.
- WASM is far slower: label progress "Separating on CPU – this may take
  several minutes". Consider making Demucs the default only with WebGPU.
- The picker hint notes the 6-stem piano stem is weak (the Demucs authors say
  so).

## Step 5 – Build, CI, docs, licence

- `vite.config.ts`: widen the dev-server model path pattern to allow
  `htdemucs_6s/…`. The model list and packaging already scan subfolders.
- `.github/workflows/ci.yml`: replace the "5 models per quality" check with a
  per-model check (5 + 5 Spleeter, plus the Demucs file or files).
- Add `models/LICENSE-DEMUCS` (MIT, Meta); store the ONNX files in Git LFS.
- README: new download and build sizes, the model choice, speed without
  WebGPU.
- e2e: separate a short clip (one segment) with Demucs: six FLAC stems of the
  right length, a guitar row in the mixer, and switching back to Spleeter
  removes the guitar stem. Check the CI time budget (WASM in headless Chromium
  is slow).

## Milestones

| #   | Milestone                                                              | Risk     |
| --- | ---------------------------------------------------------------------- | -------- |
| M8a | Export script, check against PyTorch, browser test (Step 0)            | **High** |
| M8b | Model registry, flexible stems, separator interface (Steps 1–2)        | Low      |
| M8c | Demucs engine and its tests (Step 3)                                   | Medium   |
| M8d | Model picker, memory numbers, docs, CI, e2e (Steps 4–5)                | Low      |

M8b can run alongside M8a; it changes nothing for users.

## Open decisions

1. **Precision for Demucs:** proposed: FP16 on WebGPU if it matches FP32
   (Step 0); FP32 or int8 on WASM, whichever is faster at acceptable quality.
   Int8 is not worth offering on WebGPU.
2. **Default model** for new projects: Spleeter, Demucs, or Demucs only with
   WebGPU? Proposed: Demucs only with WebGPU, Spleeter otherwise, given the
   5–20× compute cost on WASM. Confirm with the Step 0 timings.
3. **Hosting:** Demucs adds roughly 85 MB (FP16) to 170 MB (FP32), plus about
   42 MB if an int8 file is shipped (measure at export), to the repo, Docker
   image and GitHub Pages. Acceptable, or an optional download from a
   separate host?

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
3. Recover from running out of memory: WebGPU `device.lost` and allocation
   errors → fall back to WASM; WASM `RangeError` and ONNX Runtime allocator
   errors; on a worker crash, suggest a shorter track or the Spleeter model.
4. Choose the default model from weak hints (WebGPU available,
   `hardwareConcurrency`, `navigator.userAgentData.mobile`) together with
   `deviceMemory`, never from a memory number alone.
