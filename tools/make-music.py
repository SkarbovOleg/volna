"""Синтезирует музыкальную подложку для рекламных роликов.

    python tools/make-music.py 32 ad/music-short.wav
    python tools/make-music.py 62 ad/music-long.wav
"""
import sys
import wave

import numpy as np

SR = 44100
BPM = 100
BEAT = 60.0 / BPM
BAR = BEAT * 4


def note(freq, dur, amp=0.2, attack=0.01, release=0.25, harmonics=(1.0, 0.35, 0.12)):
    n = int(SR * dur)
    t = np.arange(n) / SR
    wave_ = np.zeros(n)
    for i, h in enumerate(harmonics, start=1):
        wave_ += h * np.sin(2 * np.pi * freq * i * t + 0.15 * i)
    env = np.minimum(1.0, t / attack) * np.minimum(1.0, (dur - t) / release).clip(0, 1)
    return wave_ * env * amp


def pluck(freq, dur, amp=0.12):
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.exp(-t * 9)
    return (np.sin(2 * np.pi * freq * t) + 0.4 * np.sin(4 * np.pi * freq * t)) * env * amp


def kick(amp=0.55):
    n = int(SR * 0.28)
    t = np.arange(n) / SR
    f = 120 * np.exp(-t * 22) + 46
    env = np.exp(-t * 9)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env * amp


def hat(amp=0.09, dur=0.05):
    n = int(SR * dur)
    noise = np.random.default_rng(7).normal(0, 1, n)
    env = np.exp(-np.arange(n) / (SR * 0.012))
    return noise * env * amp


def chord_freqs(name, octave=0):
    base = {"Am": [220.0, 261.63, 329.63], "F": [174.61, 220.0, 261.63],
            "C": [261.63, 329.63, 392.0], "G": [196.0, 246.94, 293.66]}
    return [f * (2 ** octave) for f in base[name]]


def build(seconds):
    total = int(SR * seconds) + SR
    left = np.zeros(total)
    right = np.zeros(total)
    rng = np.random.default_rng(3)

    progression = ["Am", "F", "C", "G"]
    bars = int(np.ceil(seconds / BAR)) + 1

    for bar in range(bars):
        start = int(bar * BAR * SR)
        if start >= total:
            break
        chord = progression[bar % len(progression)]

        # подложка
        for i, freq in enumerate(chord_freqs(chord)):
            pad = note(freq, BAR * 1.02, amp=0.075, attack=0.35, release=0.5)
            place(left, start, pad * (0.9 if i % 2 else 1.0))
            place(right, start, pad * (1.0 if i % 2 else 0.9))

        # бас на 1 и 3
        for beat in (0, 2):
            bass = note(chord_freqs(chord, -2)[0], BEAT * 1.4, amp=0.16, attack=0.005, release=0.2,
                        harmonics=(1.0, 0.2))
            place(left, start + int(beat * BEAT * SR), bass)
            place(right, start + int(beat * BEAT * SR), bass)

        # бочка на каждую долю, хэт на слабые
        for beat in range(4):
            place(left, start + int(beat * BEAT * SR), kick(0.45))
            place(right, start + int(beat * BEAT * SR), kick(0.45))
            place(left, start + int((beat + 0.5) * BEAT * SR), hat(0.07))
            place(right, start + int((beat + 0.5) * BEAT * SR), hat(0.05))

        # арпеджио 16-ми
        arp = chord_freqs(chord, 1)
        for step in range(8):
            freq = arp[step % len(arp)] * (2 if step == 7 else 1)
            p = pluck(freq, 0.22, 0.09)
            pan = 0.5 + 0.25 * np.sin(step)
            place(left, start + int(step * BEAT / 2 * SR), p * (1 - pan))
            place(right, start + int(step * BEAT / 2 * SR), p * pan)

    mix = np.stack([left[: int(SR * seconds)], right[: int(SR * seconds)]], axis=1)
    fade = int(SR * 0.8)
    mix[:fade] *= np.linspace(0, 1, fade)[:, None]
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    peak = np.max(np.abs(mix)) or 1.0
    return mix / peak * 0.9


def place(track, start, chunk):
    end = min(len(track), start + len(chunk))
    if end <= start:
        return
    track[start:end] += chunk[: end - start]


def save(path, data):
    pcm = (data * 32767).astype(np.int16)
    with wave.open(path, "wb") as fh:
        fh.setnchannels(2)
        fh.setsampwidth(2)
        fh.setframerate(SR)
        fh.writeframes(pcm.tobytes())


if __name__ == "__main__":
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 32
    out = sys.argv[2] if len(sys.argv) > 2 else "music.wav"
    save(out, build(seconds))
    print("готово:", out, seconds, "сек")
