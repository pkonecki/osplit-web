"""Export the Demucs v4 6-stem model (htdemucs_6s) to ONNX for OSplit Web.

The STFT and inverse STFT stay outside the graph (torch's complex STFT does
not export cleanly, and an embedded inverse STFT does not run on ONNX Runtime
Web's WebGPU backend). The app computes them in TypeScript (src/demucs.ts).

The per-segment normalization of both branches also stays outside: its
standard deviation divides by the element count (2.75 M), which overflows
FP16, and sums over millions of values lose precision in FP16 anyway.

Graph, one 7.8 s segment (343,980 samples at 44.1 kHz), fixed shapes:
  inputs   mix   [1, 2, 343980]        stereo waveform segment, normalized
           spec  [1, 4, 2048, 336]     STFT of the segment, channels
                                       L.re L.im R.re R.im, normalized
  outputs  wave  [1, 6, 2, 343980]     time-branch stems, normalized
           specs [1, 6, 4, 2048, 336]  frequency-branch stems, same layout as
                                       `spec`, normalized
Normalized means (v - mean) / (1e-5 + std) over the whole tensor, std with
Bessel's correction; outputs are scaled back with v * std + mean, using the
statistics of the matching input (see `run_segment`).
Stem = wave + inverse STFT of specs. Stem order: drums bass other vocals guitar piano.

Usage (Python 3.11+, CPU is enough):
  pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
  pip install demucs==4.0.1 onnx onnxruntime onnxconverter-common numpy
  python scripts/export-htdemucs.py --out build/htdemucs [--fp16]
"""

import argparse
import hashlib
import math
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from demucs.htdemucs import HTDemucs
from demucs.pretrained import get_model

MODEL_NAME = "htdemucs_6s"
# Signature 5c90dfd2, file 5c90dfd2-34c22ccb.th from dl.fbaipublicfiles.com.
CHECKPOINT_SHA256_PREFIX = "34c22ccb"
SEGMENT = 343_980
NFFT = 4096
HOP = 1024
FRAMES = math.ceil(SEGMENT / HOP)  # 336
BINS = NFFT // 2  # 2048, Nyquist bin dropped
SOURCES = ["drums", "bass", "other", "vocals", "guitar", "piano"]


class Core(torch.nn.Module):
    """HTDemucs.forward between the STFT and the inverse STFT."""

    def __init__(self, model: HTDemucs):
        super().__init__()
        self.m = model

    def forward(self, mix: torch.Tensor, spec: torch.Tensor):
        m = self.m
        x = spec
        B, C, Fq, T = x.shape
        xt = mix

        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)

        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)

        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)

        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        xt = xt.view(B, S, -1, SEGMENT)
        return xt, x


def stats(v: np.ndarray) -> tuple[float, float]:
    v = v.astype(np.float64)
    return float(v.mean()), float(v.std(ddof=1))


def run_segment(run, mix: np.ndarray, spec: np.ndarray):
    """Normalize, run the graph, scale back. mix [1,2,SEGMENT], spec [1,4,BINS,FRAMES]."""
    mt, st = stats(mix)
    mf, sf_ = stats(spec)
    wave, specs = run(((mix - mt) / (1e-5 + st)).astype(np.float32),
                      ((spec - mf) / (1e-5 + sf_)).astype(np.float32))
    return wave.astype(np.float64) * st + mt, specs.astype(np.float64) * sf_ + mf


def load_model() -> HTDemucs:
    bag = get_model(MODEL_NAME)
    assert len(bag.models) == 1
    model = bag.models[0]
    assert isinstance(model, HTDemucs)
    assert list(model.sources) == SOURCES, model.sources
    assert int(model.segment * model.samplerate) == SEGMENT
    assert model.nfft == NFFT and model.cac
    model.eval()
    return model


def check_checkpoint() -> None:
    hub = Path(torch.hub.get_dir()) / "checkpoints"
    files = list(hub.glob("5c90dfd2-*.th"))
    assert files, f"checkpoint not found in {hub}"
    digest = hashlib.sha256(files[0].read_bytes()).hexdigest()
    assert digest.startswith(CHECKPOINT_SHA256_PREFIX), (files[0], digest)
    print(f"checkpoint {files[0].name} sha256 {digest}")


# --- Reference pipeline in NumPy, the one src/demucs.ts mirrors ------------


def hann(n: int) -> np.ndarray:
    # Periodic Hann window, as torch.hann_window.
    return (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float64)


def reflect_pad(x: np.ndarray, left: int, right: int) -> np.ndarray:
    return np.pad(x, [(0, 0)] * (x.ndim - 1) + [(left, right)], mode="reflect")


def spec_np(x: np.ndarray) -> np.ndarray:
    """HTDemucs._spec for x [2, SEGMENT]: complex [2, BINS, FRAMES]."""
    le = FRAMES
    pad = HOP // 2 * 3
    x = reflect_pad(x, pad, pad + le * HOP - x.shape[-1])
    # torch.stft center=True, reflect: another NFFT/2 on both sides.
    x = reflect_pad(x, NFFT // 2, NFFT // 2)
    n_frames = 1 + (x.shape[-1] - NFFT) // HOP
    assert n_frames == le + 4
    win = hann(NFFT)
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = x[:, idx] * win  # [2, n_frames, NFFT]
    z = np.fft.rfft(frames, axis=-1) / math.sqrt(NFFT)  # normalized=True
    z = z.transpose(0, 2, 1)[:, :-1, 2 : 2 + le]
    return z


def ispec_np(z: np.ndarray) -> np.ndarray:
    """HTDemucs._ispec for complex [..., BINS, FRAMES]: [..., SEGMENT]."""
    lead = z.shape[:-2]
    z = z.reshape(-1, BINS, FRAMES)
    z = np.pad(z, [(0, 0), (0, 1), (2, 2)])
    pad = HOP // 2 * 3
    le = HOP * math.ceil(SEGMENT / HOP) + 2 * pad
    n_frames = z.shape[-1]
    win = hann(NFFT)
    frames = np.fft.irfft(z.transpose(0, 2, 1), n=NFFT, axis=-1) * math.sqrt(NFFT)
    frames *= win
    total = NFFT + HOP * (n_frames - 1)
    out = np.zeros((z.shape[0], total))
    wsum = np.zeros(total)
    for i in range(n_frames):
        out[:, i * HOP : i * HOP + NFFT] += frames[:, i]
        wsum[i * HOP : i * HOP + NFFT] += win**2
    start = NFFT // 2  # center=True
    out = out[:, start : start + le] / wsum[start : start + le]
    out = out[:, pad : pad + SEGMENT]
    return out.reshape(*lead, SEGMENT)


def spec_channels(z: np.ndarray) -> np.ndarray:
    """complex [2, BINS, FRAMES] -> float32 [1, 4, BINS, FRAMES]."""
    return np.stack([z.real, z.imag], axis=1).reshape(1, 4, BINS, FRAMES).astype(np.float32)


def separate_np(run, wav: np.ndarray) -> np.ndarray:
    """apply_model(split=True, overlap=0.25, shifts=0) with normalization, as
    demucs.separate does. wav [2, n] float, returns [6, 2, n]."""
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std(ddof=1)
    wav = (wav - mean) / std
    n = wav.shape[-1]
    stride = int(0.75 * SEGMENT)
    weight = np.concatenate(
        [np.arange(1, SEGMENT // 2 + 1), np.arange(SEGMENT - SEGMENT // 2, 0, -1)]
    ).astype(np.float64)
    weight /= weight.max()
    out = np.zeros((6, 2, n))
    wsum = np.zeros(n)
    for offset in range(0, n, stride):
        length = min(n - offset, SEGMENT)
        delta = SEGMENT - length
        start = offset - delta // 2
        seg = np.zeros((2, SEGMENT))
        lo, hi = max(0, start), min(n, start + SEGMENT)
        seg[:, lo - start : hi - start] = wav[:, lo:hi]
        z = spec_np(seg)
        wave, specs = run_segment(run, seg[None].astype(np.float32), spec_channels(z))
        s = specs[0].reshape(6, 2, 2, BINS, FRAMES).astype(np.float64)
        stems = wave[0].astype(np.float64) + ispec_np(s[:, :, 0] + 1j * s[:, :, 1])
        trim = (SEGMENT - length) // 2  # center_trim
        stems = stems[..., trim : trim + length]
        out[..., offset : offset + length] += weight[:length] * stems
        wsum[offset : offset + length] += weight[:length]
    out /= wsum
    return out * std + mean


def snr_db(ref: np.ndarray, est: np.ndarray) -> float:
    return float(10 * np.log10(np.sum(ref**2) / max(np.sum((ref - est) ** 2), 1e-20)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("build/htdemucs"))
    parser.add_argument("--fp16", action="store_true", help="also write the FP16 model")
    parser.add_argument("--audio", type=Path, help="music file (WAV, 44.1 kHz stereo) for the checks")
    parser.add_argument("--fp32-ops", nargs="*", default=[],
                        help="op types kept in FP32 in the FP16 model, e.g. Softmax")
    parser.add_argument("--fixtures", type=Path, help="write reference fixtures here")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(0)
    # The fused attention fast path (aten::_native_multi_head_attention) has
    # no ONNX export; the plain path exports to standard MatMul and Softmax.
    torch.backends.mha.set_fastpath_enabled(False)
    model = load_model()
    check_checkpoint()
    core = Core(model).eval()

    # 1. Export FP32.
    rng = np.random.default_rng(0)
    seg = rng.standard_normal((2, SEGMENT)) * 0.1
    mix = torch.from_numpy(seg[None].astype(np.float32))
    spec = torch.from_numpy(spec_channels(spec_np(seg)))
    fp32_path = args.out / f"{MODEL_NAME}.onnx"
    with torch.no_grad():
        torch.onnx.export(
            core,
            (mix, spec),
            str(fp32_path),
            input_names=["mix", "spec"],
            output_names=["wave", "specs"],
            opset_version=17,
            dynamo=False,
            do_constant_folding=True,
        )
    print(f"wrote {fp32_path} ({fp32_path.stat().st_size / 1e6:.1f} MB)")

    import onnx
    import onnxruntime as ort

    onnx.checker.check_model(str(fp32_path))

    # 2. Our NumPy STFT matches HTDemucs._spec and _ispec.
    with torch.no_grad():
        z_ref = model._spec(mix)[0].numpy()
        z_np = spec_np(seg)
        print(f"STFT max error {np.abs(z_ref - z_np).max():.2e}")
        back = model._ispec(torch.from_numpy(z_np[None]).to(torch.complex64), SEGMENT)[0].numpy()
        print(f"iSTFT vs torch max error {np.abs(back - ispec_np(z_np)).max():.2e}")
        # The Nyquist bin and two edge frames are dropped, so only a band-limited
        # signal comes back exactly, away from the edges.
        n = np.arange(SEGMENT)
        tone = np.stack([np.sin(2 * np.pi * 440 * n / 44100), np.cos(2 * np.pi * 97 * n / 44100)])
        rt = ispec_np(spec_np(tone)) - tone
        print(f"STFT->iSTFT round trip max error (tones, interior) {np.abs(rt[:, NFFT:-NFFT]).max():.2e}")

    # 3. ONNX FP32 vs PyTorch on one segment.
    sess32 = ort.InferenceSession(str(fp32_path), providers=["CPUExecutionProvider"])

    def run32(m, s):
        return sess32.run(None, {"mix": m, "spec": s})

    with torch.no_grad():
        full_ref = model(mix)[0].numpy()
    wave, specs = run_segment(run32, mix.numpy(), spec.numpy())
    s = specs[0].reshape(6, 2, 2, BINS, FRAMES).astype(np.float64)
    full = wave[0] + ispec_np(s[:, :, 0] + 1j * s[:, :, 1])
    print(f"ONNX + NumPy STFT vs HTDemucs.forward: SNR {snr_db(full_ref, full):.1f} dB")

    # 4. Audio for the end-to-end checks.
    if args.audio:
        import soundfile as sf

        wav, sr = sf.read(str(args.audio), dtype="float64", always_2d=True)
        assert sr == 44100, sr
        wav = wav.T[:2]
        if wav.shape[0] == 1:
            wav = np.repeat(wav, 2, axis=0)
    else:
        t = np.arange(int(20 * 44100)) / 44100
        wav = np.stack([np.sin(2 * np.pi * 220 * t), np.sin(2 * np.pi * 330 * t)]) * 0.3
        wav += rng.standard_normal(wav.shape) * 0.02

    from demucs.apply import apply_model

    with torch.no_grad():
        ref = torch.from_numpy(wav.astype(np.float32))
        r = ref.mean(0)
        normed = (ref - r.mean()) / r.std()
        demucs_out = apply_model(get_model(MODEL_NAME), normed[None], split=True,
                                 overlap=0.25, shifts=0, progress=False)[0].numpy()
        demucs_out = demucs_out * r.std().item() + r.mean().item()
    ours32 = separate_np(run32, wav)
    print(f"end to end, ONNX FP32 vs demucs.apply_model: SNR {snr_db(demucs_out, ours32):.1f} dB")

    # 5. FP16.
    if args.fp16:
        # ONNX Runtime's converter handles the graph's existing Cast nodes;
        # onnxconverter_common's leaves mismatched Cast output types.
        from onnxruntime.transformers.float16 import convert_float_to_float16

        m32 = onnx.load(str(fp32_path))
        m16 = convert_float_to_float16(m32, keep_io_types=True,
                                       op_block_list=args.fp32_ops or None)
        fp16_path = args.out / f"{MODEL_NAME}.fp16.onnx"
        onnx.save(m16, str(fp16_path))
        print(f"wrote {fp16_path} ({fp16_path.stat().st_size / 1e6:.1f} MB)")
        sess16 = ort.InferenceSession(str(fp16_path), providers=["CPUExecutionProvider"])

        def run16(m, s):
            return sess16.run(None, {"mix": m, "spec": s})

        ours16 = separate_np(run16, wav)
        assert np.isfinite(ours16).all(), "FP16 output has NaN or Inf"
        for k, name in enumerate(SOURCES):
            print(f"  {name:7s} FP16 vs FP32 SNR {snr_db(ours32[k], ours16[k]):.1f} dB")
        print(f"FP16 vs FP32 SNR (all stems) {snr_db(ours32, ours16):.1f} dB")

    # 6. Fixtures for the TypeScript tests.
    if args.fixtures:
        write_fixtures(args.fixtures)


def write_fixtures(path: Path) -> None:
    """Reference values for src/demucs.test.ts. Signals are closed-form, so
    TypeScript rebuilds them exactly and only a few outputs are stored."""
    import json

    path.mkdir(parents=True, exist_ok=True)
    t = np.arange(SEGMENT)
    sig = np.stack([
        0.5 * np.sin(2 * np.pi * 440 * t / 44100) + 0.25 * np.sin(2 * np.pi * 1234.5 * t / 44100),
        0.4 * np.sin(2 * np.pi * 97 * t / 44100) + 0.3 * np.cos(2 * np.pi * 5000 * t / 44100),
    ])
    zs = spec_np(sig)
    picks = [(c, f, fr) for c in (0, 1) for f in (0, 1, 41, 500, 2047) for fr in (0, 1, 100, 335)]
    data = {
        "signal": "ch0 = 0.5 sin(2π·440 n/44100) + 0.25 sin(2π·1234.5 n/44100); "
                  "ch1 = 0.4 sin(2π·97 n/44100) + 0.3 cos(2π·5000 n/44100)",
        "spec": [[c, f, fr, float(zs[c, f, fr].real), float(zs[c, f, fr].imag)] for c, f, fr in picks],
        "specEnergy": float(np.sum(np.abs(zs) ** 2)),
    }
    # Inverse STFT of a sparse spectrum: a few bins set, so TypeScript can
    # rebuild the input exactly.
    zi = np.zeros((1, BINS, FRAMES), dtype=complex)
    zi[0, 10, 5] = 1 + 0.5j
    zi[0, 300, 100] = -0.25 + 1j
    zi[0, 2047, 335] = 0.75
    xi = ispec_np(zi)[0]
    samples = [0, 1, 1000, 5000, 102400, 200000, 343979]
    data["ispecInput"] = [[10, 5, 1, 0.5], [300, 100, -0.25, 1], [2047, 335, 0.75, 0]]
    data["ispec"] = [[n, float(xi[n])] for n in samples]
    data["ispecEnergy"] = float(np.sum(xi**2))

    # Whole pipeline (normalize, segment, STFT, run, iSTFT, overlap-add, scale
    # back) with a stand-in for the network, so TypeScript can check
    # everything around the model exactly: stem k gets (k+1)/10 of the
    # normalized waveform and (6-k)/10 of the normalized spectrogram.
    def fake(m, sp):
        k = np.arange(6, dtype=np.float32)
        wave = m[:, None] * ((k + 1) / 10)[None, :, None, None]
        specs = sp[:, None] * ((6 - k) / 10)[None, :, None, None, None]
        return wave, specs

    n = int(SEGMENT * 2.3)
    tt = np.arange(n)
    mix = np.stack([
        0.3 * np.sin(2 * np.pi * 220 * tt / 44100) + 0.1,
        0.2 * np.sin(2 * np.pi * 3000 * tt / 44100) * np.sin(2 * np.pi * 0.5 * tt / 44100),
    ])
    out = separate_np(fake, mix)
    sample_at = [0, 1, 5000, 257985, 300000, 515970, 600000, n - 1]
    data["pipeline"] = {
        "length": n,
        "signal": "ch0 = 0.3 sin(2π·220 n/44100) + 0.1; "
                  "ch1 = 0.2 sin(2π·3000 n/44100) · sin(2π·0.5 n/44100)",
        "samples": [[k, c, i, float(out[k, c, i])] for k in range(6) for c in (0, 1) for i in sample_at],
        "energy": [float(np.sum(out[k] ** 2)) for k in range(6)],
    }
    (path / "stft.json").write_text(json.dumps(data, indent=1))
    print(f"wrote {path / 'stft.json'}")


if __name__ == "__main__":
    main()
