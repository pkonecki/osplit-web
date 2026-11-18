# Plan: practice tools and music analysis (M8–M10)

This plan adds three milestones to OSplit, after M7. They bring OSplit closer to
practice apps such as Moises, while keeping OSplit's rules:

- everything runs on the device, with no processing server and no proxy;
- the app keeps working offline once installed;
- both playback engines keep working (`BufferEngine`, which is sample-accurate,
  and `MediaEngine`, which streams for long tracks on low-memory devices);
- the static site still deploys under the strict CSP (`script-src 'self'
  'wasm-unsafe-eval'`, `worker-src 'self' blob:`).

| Milestone | Theme | New ML model? | Depends on |
| --- | --- | --- | --- |
| **M8** | Speed, key shift, A–B loop | No (DSP only) | — |
| **M9** | Tempo, beat grid, click track | No (DSP only) | M8 (loop snapping, rate-aware clock) |
| **M10** | Key and chord detection | No (DSP only; an ML upgrade is optional later) | M9 (beat-synchronous chroma) |

Each milestone ships as its own pull request, or a short series of them, with
unit tests, Playwright coverage and README updates, as M6 and M7 did.

---

## Current architecture (what the plan builds on)

- `src/player.ts` owns one `PlaybackEngine` per open project and an
  `AudioContext` shared across projects. It calls `engine.tick()` and the UI
  tick every 250 ms.
- `src/player/engine.ts` is the engine interface: `time`, `play`, `pause`,
  `seek`, `setGain`, `channels`, `tick`, `release`.
- `BufferEngine` gives each stem an `AudioBufferSourceNode` and a `GainNode`,
  and connects each gain straight to `destination`. All sources start at the
  same audio-clock time.
- `MediaEngine` uses one `<audio>` element per stem, routed through a
  `MediaElementAudioSourceNode` and a `GainNode` to `destination`. Each tick
  corrects drift against the first element.
- `src/mixing.ts` has `stemVolume`, the single rule that playback and export
  both use.
- `src/export.ts` decodes the stems with `decodeStem` and mixes them with
  `mixStems` before encoding FLAC or WAV.
- `src/storage.ts` is IndexedDB with an append-only `MIGRATIONS` list (two
  migrations so far: base stores, then `peaks`).
- `Project` (`src/types.ts`) gains optional fields without a migration, as
  `soloStems` did.
- `src/audio-core.ts` already provides `fftInPlace`, Hann windows and
  `SAMPLE_RATE = 44_100`. Stems are 44.1 kHz stereo.
- `src/view/waveforms.ts` draws per-stem canvases with playheads and
  click-to-seek (`waveformSeekTime`).
- Keyboard shortcuts live in `handleKeyDown` (`src/main.ts`).

---

## M8 — Practice tools: speed, key shift, A–B loop

> **Status: implemented.** The spike chose **Signalsmith Stretch 1.3.2**
> (MIT). In headless Chromium it shifted a 440 Hz tone to within about 1 Hz
> from −12 to +7 semitones, added 120 ms of latency, used about 3.5% of one
> core for stereo, and ran in `OfflineAudioContext`. Under the CSP it works
> only with `moduleUrl` pointing at the bundled asset: its default `blob:`
> worklet URL is blocked, which was confirmed. Listening tests on real music
> remain to be done.

### Goals

1. **Speed (tempo)** from 50% to 150%, in 5% steps (fine steps with the
   keyboard), without changing pitch.
2. **Key shift** from −12 to +12 semitones, without changing tempo.
3. **A–B loop**: repeat a region seamlessly, set by dragging on the waveforms
   or with A/B buttons and keys.
4. Each project remembers its speed, key and loop.
5. Optionally, export the mix with speed and key applied.

### Audio design

#### Signal graph

Today each stem's gain goes straight to `destination`. M8 adds a shared
**master bus**:

```
stem source ─► stem GainNode ─┐
stem source ─► stem GainNode ─┼─► busInput (GainNode) ─► PitchShifter (AudioWorklet) ─► destination
   …                          ┘
```

The click track (M9) will later join `destination` directly and skip the pitch
shifter.

#### How speed and key combine

A node in the Web Audio graph produces exactly as many frames as it receives,
so a worklet cannot "play faster" by itself. Tempo therefore changes **at the
source**, and pitch is corrected on the bus:

| Engine | Tempo | Pitch correction on the bus |
| --- | --- | --- |
| `BufferEngine` | `source.playbackRate = speed`, which also shifts pitch by `12·log2(speed)` | `transpose = semitones − 12·log2(speed)` |
| `MediaEngine` | `audio.playbackRate = speed` with `preservesPitch = true`, so the browser keeps pitch (supported in all current engines) | `transpose = semitones` |

Put this in a pure function, `busTranspose(engineKind, speed, semitones)` in
`src/practice.ts`, and unit-test it.

At speed = 1 and semitones = 0 the shifter is **bypassed**: disconnected and
replaced with a direct connection. Normal playback then stays bit-identical to
today and costs no CPU.

#### Choosing the pitch shifter (spike, 1–2 days)

Evaluate in this order:

1. **Signalsmith Stretch** (MIT, ships a Web Audio / WASM build). It supports
   live-input pitch shifting with good quality on polyphonic material.
2. **Our own phase vocoder** in an AudioWorklet (STFT 2048 / hop 512, phase
   locking, peak-based). It needs no dependency but takes more work to make
   it sound good.
3. SoundTouch ports are **not** recommended: they are LGPL and give lower
   quality for large shifts.

Acceptance criteria for the spike:

- latency under 100 ms;
- under 15% of one core on a mid-range laptop for a stereo bus;
- no audible artefacts at ±2 semitones on a test mix;
- loads from `'self'` under the current CSP: the worklet module is bundled
  through Vite `new URL("./pitch-worklet.ts", import.meta.url)`, and the WASM
  is inlined or served from `assets/`;
- works in `OfflineAudioContext`, for export.

Record the decision in the PR description and credit the library in the
README's credits section if one is used.

#### Latency compensation

The shifter adds latency, which makes the displayed position, the playheads
and (in M9) the click lag behind the audio. `BufferEngine.time()` subtracts
`shifterLatency × speed` while the shifter is active. The latency comes from
the library, or from the worklet via a `port` message.

#### Engine interface changes (`src/player/engine.ts`)

```ts
interface PlaybackEngine {
  // existing members …
  setRate(speed: number): void;                 // 0.5–1.5
  setLoop(loop: LoopRegion | null): void;       // seconds, in track time
  /** The node the stem gains feed; player.ts inserts the bus after it. */
  readonly output: AudioNode;
}

interface LoopRegion { start: number; end: number }  // end − start ≥ 0.25 s
```

`player.ts` owns the bus and the shifter, so both engines share them. It
creates them once with the `AudioContext` and reconnects them on project
switch.

#### BufferEngine changes

- **Rate**: `setRate` sets `playbackRate` on every running source at the same
  `context.currentTime` with `setValueAtTime`, so they stay aligned. The clock
  becomes piecewise: keep `(offset, startedAt, rate)` and re-anchor whenever
  the rate changes:
  `position = offset + (currentTime − startedAt) × rate`.
- **Loop**: use `source.loop = true`, `loopStart`, and `loopEnd` on every
  source. This is sample-accurate and gapless, and all stems wrap at the same
  sample. `time()` wraps the position:
  if `pos > loopEnd`, `pos = loopStart + (pos − loopStart) mod (loopEnd − loopStart)`.
  Put this in a pure function, `wrapPosition`, with tests.
- Setting a loop while the playhead is past `loopEnd` seeks to `loopStart`.
  Clearing the loop leaves the sources running, with `loop = false`.
- The `onended` handler is ignored while looping, since sources do not end.

#### MediaEngine changes

- **Rate**: set `playbackRate` and `preservesPitch = true` (plus the
  `webkitPreservesPitch` fallback) on every element. Drift correction already
  compares `currentTime` values, so it still works.
- **Loop**: elements cannot loop a sub-range natively. While a loop is active,
  run a fast checker (`requestAnimationFrame`, or a 20 ms interval when the
  page is hidden). When the reference passes `loopEnd − 0.02 × rate`, seek
  every element to `loopStart`.
  - Expect a short gap of about 20–60 ms. Document it in the README as a
    limitation of streaming playback.
  - To soften the jump, apply a 10 ms gain ramp down and up on the bus.

#### Media Session

`updateMediaSession` passes `playbackRate: speed` to `setPositionState`.

### Data model

Add to `Project` (all optional, so no migration is needed):

```ts
/** Playback speed, 0.5–1.5. Missing = 1. */
speed?: number;
/** Key shift in semitones, −12…12. Missing = 0. */
semitones?: number;
/** A–B loop in seconds; `enabled` false keeps the markers but plays through. */
loop?: { start: number; end: number; enabled: boolean };
```

`src/practice.ts` adds:

- the accessors `projectSpeed(project)` and `projectSemitones(project)`;
- clamping;
- `wrapPosition`;
- `busTranspose`;
- `formatSpeed` / `formatSemitones` (for example "85%", "+2 st").

Saving follows the existing volume path: `saveProject` is debounced while a
slider is dragged.

### UI (`src/view/mixer.ts`, new `src/view/practice.ts`)

A **practice bar** sits under the player row:

- **Speed**: a slider (50–150%) with a value readout, −/+ buttons (5%), and a
  reset button that appears when the speed is not 100%.
- **Key**: −/+ buttons with a readout ("Original", "+2", "−3"), and a reset.
  M10 replaces the readout with a key name ("A minor → B minor").
- **Loop**:
  - "Set A" and "Set B" buttons set the loop start and end at the playhead;
  - a "Loop" toggle;
  - a "Clear" button;
  - a readout ("0:42.3 – 0:58.9").
- **Loop region on waveforms**: a translucent band over all stem rows, plus
  two draggable handles.
  - Dragging across empty waveform creates a region. A single click still
    seeks, as today; drag means a pointer move of more than 4 px.
  - Pointer Events handle mouse and touch the same way. Handles are at least
    24 px wide for touch.
  - Handles are focusable `role="slider"` elements, so the arrow keys move
    them by 0.1 s (1 s with Shift).

Keyboard shortcuts (added to `handleKeyDown` and to the shortcuts help):

| Key | Action |
| --- | --- |
| `[` / `]` | Set loop start / end at the playhead |
| `L` | Toggle loop |
| `Shift+L` | Clear loop |
| `-` / `=` | Speed −5% / +5% |
| `,` / `.` | Key −1 / +1 semitone |
| `0` | Reset speed and key |

### Export with speed and key (optional, last task of M8)

The mixer gets an "Apply speed and key to exports" checkbox, off by default.
When it is on, `mixFile` renders through an `OfflineAudioContext`:

- one `AudioBufferSource` per active stem, with the stem's gain and
  `playbackRate = speed`;
- the same shifter worklet with the same transpose;
- the length is `duration / speed` plus the shifter latency, and the latency
  is trimmed from the start;
- if a loop is enabled, export only the loop region (offer this as a separate
  "Export loop" button).

Memory: offline rendering keeps every decoded stem plus the output in memory.
Reuse `decodedPlaybackBytes` and `isLongForDevice`, and warn before starting
on long tracks.

Stem exports stay untouched. Only the mix gets processed.

### Tests

- **Unit**:
  - `busTranspose`, `wrapPosition`, the clamping helpers and formatting;
  - the BufferEngine clock math across rate changes. Extract it into a pure
    `PlaybackClock` class so it can be tested without Web Audio.
- **Playwright** (`e2e/app.spec.ts`):
  - set the speed to 50%, play for 2 s, and check that the position advanced
    about 1 s (±0.3 s);
  - set a 1 s loop and play for 3 s, and check that the position stays inside
    the loop;
  - check that speed, key and loop survive a reload;
  - run the same checks with the media engine forced. Add a test hook, such as
    a `?engine=media` debug query parameter, that `playbackEngineFor` honours.
- **CSP**: `e2e/csp.spec.ts` must still pass with the worklet loaded. That is
  the reason to bundle it instead of using a `blob:` worklet.

### Task breakdown

1. Spike and choose the pitch shifter (decision recorded).
2. `src/practice.ts` (pure helpers) and `PlaybackClock`, with tests.
3. Master bus, shifter insertion and bypass in `player.ts`. Add the `output`
   node to both engines.
4. `setRate` on both engines, rate-aware `time()`, Media Session rate.
5. `setLoop` on both engines, with wrap logic and the media-engine checker.
6. Project fields and persistence.
7. Practice bar UI and shortcuts.
8. Loop band and handles on the waveforms.
9. (Optional) Processed mix export and loop export.
10. README: practice tools, the loop gap in streaming playback, credits.

### Risks

| Risk | Mitigation |
| --- | --- |
| Shifter quality is poor on full mixes | The spike criteria. The spike can still pick our own vocoder or a different library before UI work starts. |
| CPU on phones | Bypass at neutral settings. Measure on a mid-range Android device, and offer a low-quality shifter mode if needed. |
| Loop gap with `MediaEngine` | Documented. The gain ramp hides clicks. Most tracks use `BufferEngine` anyway. |
| Latency makes the playhead visibly late | Latency compensation in `time()`. |

---

## M9 — Tempo, beat grid and click track

### Goals

1. Detect **BPM** and a **beat grid**, with an estimate of downbeats (bar
   starts).
2. Show beats and bar numbers on the waveforms. Snap loop handles to beats or
   bars. Add "loop 1 / 2 / 4 bars" from the playhead.
3. A **click track**:
   - follows the detected beats, including tempo drift in live recordings;
   - accents downbeats;
   - has its own volume, mute and solo row, like the stems;
   - follows speed and loop;
   - can be exported.
4. Let the user correct the analysis: ×2 / ÷2 BPM, shift the downbeat, choose
   beats per bar (3 or 4), and tap tempo as a last resort.
5. A **count-in** of one bar before playback, or before each loop pass
   (optional, small once the click exists).

### Where analysis runs

There is a new **`src/analysis.worker.ts`**, with message types added to
`src/messages.ts`:

```ts
type AnalysisRequest =
  | { type: "analyze"; id: string; projectId: string; tasks: ("beats" | "tonal")[];
      stems: Partial<Record<Stem, Float32Array>> /* mono, 22 050 Hz */ }
  | { type: "cancel"; id: string };
type AnalysisResponse =
  | { type: "progress"; id: string; stage: string; progress: number }
  | { type: "complete"; id: string; result: AnalysisResult }
  | { type: "error"; id: string; message: string }
  | { type: "cancelled"; id: string };
```

- **Inputs**: the main thread decodes the needed stems with `decodeStem`,
  downmixes them to mono and resamples to 22 050 Hz with a 2:1 decimation
  after a low-pass filter. It then transfers the buffers to the worker. For a
  5-minute track this is about 26 MB per stem.
- **When it runs**: automatically right after separation succeeds
  (`separateProject` → `completeSeparation` → queue analysis). For older
  projects, an "Analyze" button runs it. Analysis is cancellable and shows
  progress in the existing progress card under the stage "Analyzing rhythm".
- **Analysis failure never fails the project.** On error, keep the stems, show
  a dismissible message, and offer a retry.

### Algorithms (pure TypeScript, in `src/analysis/`)

Each step is a pure function over `Float32Array` that can be unit-tested
without a browser.

1. **Onset strength envelope** (`onset.ts`):
   - STFT with window 1024 and hop 256 at 22 050 Hz, which gives about
     11.6 ms frames. Reuse `fftInPlace` and `makeHannWindow` from
     `audio-core.ts`.
   - Log-compress the magnitudes: `log(1 + 100·|X|)`.
   - Spectral flux, half-wave rectified and summed over bins. Weight the low
     band (< 200 Hz) and the high band (> 5 kHz) separately, then combine.
   - Remove the local mean (a 0.5 s moving average) and normalise.
   - **Source signal**: the drum stem when it carries energy, otherwise the
     sum of all stems. Also compute a bass-stem envelope, which the downbeat
     step uses.
2. **Global tempo** (`tempo.ts`):
   - autocorrelation of the onset envelope over lags for 50–220 BPM;
   - weighted by a log-Gaussian tempo prior centred on 120 BPM (σ = 1
     octave);
   - also score the comb sum of 2× and 0.5× lags, then pick the best peak and
     refine it with parabolic interpolation;
   - output: `bpm`, a `confidence` between 0 and 1 (peak height over the
     median), and the next best octave candidate.
3. **Beat tracking** (`beats.ts`):
   - dynamic programming as in Ellis 2007, "Beat tracking by dynamic
     programming": score = onset strength + α · log-Gaussian penalty on the
     deviation of each inter-beat interval from the global period;
   - α ≈ 100, tuned on test signals;
   - this follows tempo drift in live recordings;
   - output: beat times in seconds.
4. **Downbeats and metre** (`downbeats.ts`):
   - for beats per bar `n ∈ {3, 4}` and each phase `p < n`, add up the
     bass-onset strength and low-frequency energy on beats with
     `(i − p) mod n = 0`;
   - pick the `(n, p)` with the highest normalised score, defaulting to 4/4
     unless 3/4 wins clearly (more than 15%);
   - output: `beatsPerBar` and `firstDownbeatIndex`.
5. **Tap tempo** (UI only): the median of the last 4–8 tap intervals. It
   replaces the grid with an even grid at that BPM, anchored on the nearest
   strong onset.

A future upgrade path is a small ONNX beat and downbeat network (a
Beat-This-style CRNN under a compatible licence), which would reuse the ONNX
Runtime already in the inference worker. It is out of scope for M9; the DSP
pipeline above is the baseline it would have to beat.

### Data model and storage

There is a new IndexedDB store, through **migration 3**:

```ts
// 3: rhythm and tonal analysis, one record per project, keyed by project id.
(db) => { db.createObjectStore(ANALYSIS, { keyPath: "projectId" }); },
```

```ts
interface AnalysisRecord {
  projectId: string;
  /** Bumped when an algorithm changes; older records are recomputed. */
  algorithmVersion: number;
  /** Stem set the analysis used (drums, or mix), for display and invalidation. */
  source: "drums" | "mix";
  bpm: number;
  bpmConfidence: number;
  beats: Float32Array;          // seconds
  beatsPerBar: 3 | 4;
  firstDownbeatIndex: number;
  /** User edits on top of the detected grid. */
  userEdits?: { bpmFactor?: 0.5 | 2; downbeatShift?: number; beatsPerBar?: 3 | 4;
                tappedBpm?: number };
  // M10 adds tonal fields here.
}
```

- `deleteProject` also deletes the analysis record. Extend
  `projectStemRange`-style cleanup and its storage test.
- `replaceSource` and `completeSeparation` delete any existing analysis, so
  new stems get a new analysis.
- In `src/analysis/grid.ts`, the pure function
  `effectiveGrid(record) → { beats, downbeats, bpm }` applies `userEdits`. It
  halves or doubles by dropping every other beat or inserting midpoints, then
  shifts the downbeat phase. Everything downstream (UI, click, snapping)
  consumes only `effectiveGrid`.

### Click track

Click samples come from a pure function in `src/analysis/click.ts`:

- an accent click (1.5 kHz) and a normal click (1 kHz), each 30 ms with an
  exponential decay;
- generated once as `AudioBuffer`s.

**Playback scheduling** is a standard look-ahead scheduler in a new
`src/player/click.ts`:

- every 25 ms, schedule each click whose track time falls within the next
  120 ms;
- convert track time to context time:
  `when = now + (beatTime − position) / speed`, plus the shifter latency
  compensation from M8, since the click skips the shifter;
- **loop**: when the look-ahead window crosses `loopEnd`, map beats after the
  wrap back from `loopStart`;
- on seek, pause, rate or loop change, cancel the scheduled clicks by keeping
  their nodes and calling `stop(0)`, then reschedule;
- the click goes through its own `GainNode` straight to `destination`;
- with `MediaEngine`, scheduling follows the reference element's
  `currentTime`, so the click can be up to about 30 ms off. Document this; the
  buffer engine is sample-tight.

In the **mixer**, "Click" appears as a pseudo-stem row after the real stems.
It has volume, mute and solo, and is muted by default. Extend `stemVolume` and
the mute and solo logic in `mixing.ts` to accept `Stem | "click"`, so the solo
rule stays a single function. In `Project`, `volumes.click` and the mute and
solo lists are optional. The click row draws beat ticks instead of a waveform.

**Export**:

- "Export all (zip)" adds `<name>-click.<format>`, rendered offline from
  `effectiveGrid`;
- the mix includes the click when it is audible in the mixer;
- the click stays aligned when M8's "apply speed and key" option is on,
  because it is rendered at the processed rate without pitch shifting.

**Count-in** (optional): a project toggle with the values Off, 1 bar, or
1 bar before every loop pass.

- On play, `player.ts` starts the click one bar early: the count-in clicks are
  scheduled and the stems start at the bar's end.
- With a loop, the count-in replays at each wrap. This needs a short pause at
  the loop end, implemented by stopping and restarting the sources rather
  than native looping. It is acceptable for this practice mode.

### UI

- **Tempo chip** in the practice bar, for example "♩ 120 BPM", or "♩ 120 → 102"
  at 85% speed. Clicking it opens a small panel with:
  - ×2 and ÷2;
  - beats per bar (3 or 4);
  - "Downbeat ◀ ▶" (shift by one beat);
  - "Tap tempo";
  - "Re-analyze";
  - the confidence, shown as "Low confidence — check the grid" when it is
    below 0.3.
- **Beat grid**: thin tick lines on every waveform canvas, stronger on
  downbeats, with bar numbers in a 14 px ruler above the stem list.
  - Draw them in `waveforms.ts` into a separate overlay canvas, so peaks do
    not need redrawing.
  - Hide beat ticks when they are closer than 3 px apart, and keep only
    downbeats.
- **Snapping**: loop handles snap to the nearest beat. Hold Alt to snap to
  bars, or Shift to disable snapping. Snap only when a grid exists and its
  confidence is at least 0.3.
- **Quick loops**: "1 bar", "2 bars" and "4 bars" buttons create a loop from
  the bar containing the playhead.
- New shortcuts:

| Key | Action |
| --- | --- |
| `C` | Toggle click |
| `T` | Tap tempo (while the tempo panel is open) |
| `B` | Loop the current bar; press again to double the length |

### Tests

**Unit, on synthetic signals** (no copyrighted audio in the repo):

- a click and noise-burst generator at 90, 120, 128 and 174 BPM: detected BPM
  within ±1 BPM, and beat F-measure ≥ 0.9 at a ±70 ms tolerance;
- a drifting tempo (120 → 126 BPM over 60 s): beats follow within ±70 ms;
- octave check: a 70 BPM signal with strong eighth notes reports 70 or 140,
  and the alternative candidate holds the other;
- 3/4 against 4/4 with an accented bass on the downbeat: metre and phase are
  correct;
- `effectiveGrid` edits, look-ahead scheduling maths (including the loop wrap
  and speed ≠ 1), and the click-render length.

**Storage**: migration 3 from version 2 databases (fake-indexeddb), analysis
deletion together with the project, and invalidation on re-separation.

**Playwright**:

- make the e2e clip rhythmic: add a 120 BPM kick pattern to the deterministic
  generator in `e2e/helpers.ts`;
- check that the tempo chip shows 119–121 after separation, that toggling the
  click doesn't throw, that "1 bar" creates a loop of about 2 s, and that the
  zip contains the click file.

### Task breakdown

1. Analysis worker scaffold, messages, and the main-thread queueing, progress
   and cancel path.
2. `onset.ts`, `tempo.ts`, `beats.ts` and `downbeats.ts`, with synthetic-signal
   tests.
3. Migration 3, `AnalysisRecord`, lifecycle and invalidation, storage tests.
4. `effectiveGrid` and user edits.
5. Beat grid overlay, ruler and tempo chip panel.
6. Snapping and quick-loop buttons.
7. Click scheduler, click mixer row, mixing-rule extension.
8. Click in exports.
9. (Optional) Count-in.
10. README: analysis, accuracy expectations, click timing with streaming
    playback.

### Risks

| Risk | Mitigation |
| --- | --- |
| Octave errors (half or double tempo) | ×2 and ÷2 are one click away. The prior is centred on 120. The alternative candidate is shown. |
| Rubato or tempo-free music | Low confidence disables snapping and shows a hint. Tap tempo remains. |
| Wrong downbeat | Downbeat ◀ ▶ shift, stored as a user edit. |
| Analysis time on phones | Mono 22 kHz input. Target under 3 s for a 4-minute track on a mid-range laptop and under 10 s on a phone. Measure before release. |

---

## M10 — Key and chord detection

### Goals

1. Detect the song's **key** (24 major and minor keys), with a confidence and
   the second-best candidate (often the relative key).
2. Detect a **chord timeline** (major, minor and no-chord at first; 7ths and
   sus later), aligned to beats.
3. Show the current and next chord large, plus a chord lane under the bar
   ruler. Clicking a chord seeks to it.
4. Make M8's key shift **name-aware**: "A minor → B minor (+2)", with chords
   shown transposed.
5. Export a chord sheet as text, and optionally as a `.lab` file.

### Pipeline (pure TypeScript, in `src/analysis/`, running in the analysis worker)

1. **Harmonic input**: piano + bass + other stems, with vocals added at a low
   weight (0.3) for melody-heavy songs. Drums are excluded. This is a real
   advantage of having stems: percussion is the main source of noise in
   chroma features.
2. **Tuning estimate** (`tuning.ts`): find spectral peaks across the track,
   then take the circular mean of their deviation from the 12-TET grid at
   A = 440 Hz. This gives an offset in cents within ±50, applied when mapping
   bins to pitch classes. Songs tuned to A = 432 Hz or slightly off then still
   work.
3. **Chroma** (`chroma.ts`):
   - STFT with window 4096 and hop 1024 at 22 050 Hz (5.4 Hz resolution);
   - log-magnitude, with each bin in 55 Hz–4 kHz mapped to its pitch class
     using a triangular weight in semitone distance;
   - a separate **bass chroma** from the bass stem only, over 30–250 Hz, for
     roots and inversions;
   - then **beat-synchronous averaging**: the median of chroma frames between
     consecutive beats from M9 `effectiveGrid`. Without a grid, fall back to
     fixed 0.5 s frames;
   - L2-normalise each vector.
4. **Key** (`key.ts`):
   - sum the beat chroma over the track, then compute its correlation with
     key profiles (Temperley/Kostka-Payne; keep Krumhansl-Kessler as a
     fallback option) rotated through the 12 tonics, for major and minor;
   - output: tonic, mode, a confidence based on the margin over the second
     best, and the second-best key;
   - also compute a windowed local key over about 30 s windows, to flag
     modulations. Show it only if a modulation is held for 16 bars or more.
5. **Chords** (`chords.ts`):
   - **Emissions**: cosine similarity between each beat chroma and 25 binary
     templates (12 major, 12 minor, 1 "N"), with the root template weighted by
     the bass chroma (+0.2 when the bass root matches);
   - **Smoothing**: Viterbi over beats, with a self-transition probability
     around 0.8. Transitions are biased slightly towards chords in the
     detected key (diatonic +0.05). This avoids flicker;
   - then merge consecutive equal labels into segments
     `{ start, end, root, quality, bass? }`;
   - **Slash chords** (optional): when the bass chroma's strongest pitch class
     is a chord tone other than the root for the whole segment, label it as a
     slash chord (C/E).
6. **Spelling** (`spelling.ts`): a pure function that names pitch classes for
   a key, with sharps or flats from its key signature ("F#" in D major, "Gb"
   in Db major). Transposition re-spells for the shifted key.

The optional upgrade path, out of scope, is an ONNX chord recognition model
(for example a CRNN with a larger vocabulary) under a compatible licence,
behind a "Detailed chords" setting so the download is opt-in. The template
pipeline stays as the default and the fallback.

### Data model

Raise `algorithmVersion` and extend `AnalysisRecord`:

```ts
tuningCents: number;
key: { tonic: number /* 0 = C */; mode: "major" | "minor"; confidence: number;
       alternative: { tonic: number; mode: "major" | "minor" } };
modulations?: { start: number; tonic: number; mode: "major" | "minor" }[];
chords: { start: number; end: number; root: number | null /* null = N */;
          quality: "maj" | "min"; bass?: number }[];
userEdits?: { /* M9 fields */ keyOverride?: { tonic: number; mode: "major" | "minor" } };
```

Existing M9 records are recomputed only for the tonal part when
`algorithmVersion` is older. Rhythm fields and user edits are kept.

### UI

- **Key chip** in the practice bar: "A minor", or "A minor → B minor (+2)" when
  shifted. The key ± buttons from M8 show the target key name in their
  tooltips. Clicking the chip opens:
  - the alternative key;
  - "Set key…" (override);
  - "Show as: original / transposed".
- **Chord display**: a large "now" chord with the "next" chord and a countdown
  in beats ("→ F in 2"), above the stem list. It updates from `onTick`. For a
  smooth feel it uses `requestAnimationFrame` while playing.
- **Chord lane**: a horizontal strip aligned with the waveforms and the bar
  ruler, with one labelled box per segment. Clicking a box seeks to it.
  Double-clicking it loops the segment, which reuses M8's loop. Labels are
  hidden when the box is too narrow, and appear on hover or focus.
- **Accessibility**: the "now" chord region is `aria-live="off"` by default,
  to avoid announcing every beat. The setting "Announce chord changes" turns
  it to `polite`.
- **Chord sheet export**: "Export chords (.txt)" gives bar-aligned lines of 4
  bars, for example `| Am  | F   | C   | G   |`, using the displayed
  transposition. "Export .lab" gives `start end label` lines, the MIREX
  format, for people who use DAW or analysis tools.

### Tests

**Unit, on synthetic signals**:

- **Tuning**: a sine set detuned by +20 cents returns 20 ± 3.
- **Key**: harmonised scales and I–IV–V–I cadences synthesised with sawtooth
  triads in several keys (C major, A minor, F# major, Eb minor) are detected
  correctly. Relative-key confusion is allowed only as the alternative.
- **Chords**: synthetic progressions (I–V–vi–IV in G; ii–V–I in Bb; a minor
  blues) at 100 BPM, with beat times passed in. Expect segment-level accuracy
  of at least 90% on root and major/minor, and no segment shorter than one
  beat.
- **Bass inversion**: C/E is detected when the bass stem holds E.
- `spelling.ts` for every key, and transposition re-spelling.
- Formatting of the chord-sheet and `.lab` exports.

**Playwright**: give the e2e clip generator a simple I–V–vi–IV pad in C under
the kick pattern. Check that the key chip shows "C major" (or "A minor" as the
alternative), that the chord lane renders boxes, and that the "+2" key shift
relabels it to "D major".

**Manual listening checklist** before release: about 10 varied songs the
maintainer owns, recording detected against reference key and chords. These
are not committed.

### Task breakdown

1. `tuning.ts` and `chroma.ts` (beat-synchronous), with tests.
2. `key.ts` (global and local), with tests.
3. `chords.ts` (templates, bass weighting, Viterbi, merge), with tests.
4. `spelling.ts`, transposition helpers.
5. Record extension, version bump, partial recompute.
6. Key chip, name-aware key shift.
7. Now/next chord display and chord lane (seek, loop segment).
8. Chord sheet and `.lab` export.
9. README: what is detected, accuracy expectations, why stems help.

### Risks

| Risk | Mitigation |
| --- | --- |
| Major and minor triads only feel limited | Clear wording ("simplified chords"). Vocabulary growth (7, sus, dim) is a follow-up behind the same Viterbi. The ONNX upgrade path exists. |
| Relative key confusion | Show the alternative. The user override is stored. |
| No beat grid (rubato) | Fixed-frame fallback, with heavier Viterbi smoothing. |
| Modal or atonal music | Low confidence is shown. The key chip says "Key unclear". |

---

## Cross-cutting concerns

- **Performance budget**:
  - M8 adds no CPU at neutral settings;
  - the shifter uses under 15% of one core;
  - analysis (rhythm and tonal) on a 4-minute track takes under 5 s on a
    mid-range laptop and under 15 s on a mid-range phone;
  - analysis input buffers are transferred to the worker, never copied, and
    released after use.
- **Offline**: no new network dependencies. Any WASM, such as the pitch
  shifter, is bundled and precached by the service worker like the other
  `assets/`.
- **CSP**: the worklet and worker are same-origin modules. Re-run
  `e2e/csp.spec.ts` against the Docker image for every milestone.
- **Storage**: analysis records are small (beats and chords are a few KB).
  Peaks and analysis are both deleted with the project.
- **Backward compatibility**: every new `Project` field is optional. Only
  M9 adds an IndexedDB migration (appended, never edited). Old projects get
  analysis on demand.
- **Accessibility**: every new control has a label and a keyboard path. Loop
  handles are sliders. Shortcuts are listed in the in-app help.
- **Documentation**: each milestone updates `README.md` and
  `public/README-web.html` with the features and their limitations: the loop
  gap and click timing with streaming playback, and analysis accuracy.

## Suggested order and size

| Milestone | Rough size | Ship criteria |
| --- | --- | --- |
| M8 | ~2 weeks (including the shifter spike) | Speed, key and loop work on both engines, persist across reloads, pass the CSP test, and use no CPU at neutral settings |
| M9 | ~2 weeks | BPM within ±1 on the synthetic suite. Grid, snapping, click and click export work. Migration 3 is tested. |
| M10 | ~1.5–2 weeks | Synthetic key and chord accuracy targets are met. The chord lane, name-aware key shift and chord sheet export work. |
