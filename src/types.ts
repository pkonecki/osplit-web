/** Every stem any model produces, in display order. */
export const ALL_STEMS = [
  "vocals",
  "guitar",
  "piano",
  "drums",
  "bass",
  "other",
] as const;
export type Stem = (typeof ALL_STEMS)[number];

/** Separation models: Spleeter (5 stems, any device) and Demucs v4 (6 stems, WebGPU). */
export type ModelId = "spleeter-5" | "htdemucs-6s";
export const MODEL_IDS: readonly ModelId[] = ["spleeter-5", "htdemucs-6s"];

/** The stems each model produces, in display order. */
export const MODEL_STEMS: Record<ModelId, readonly Stem[]> = {
  "spleeter-5": ["vocals", "piano", "drums", "bass", "other"],
  "htdemucs-6s": ["vocals", "guitar", "piano", "drums", "bass", "other"],
};

/** A project's model; projects saved before the choice existed used Spleeter. */
export function projectModel(project: Pick<Project, "model">): ModelId {
  return project.model ?? "spleeter-5";
}

/** A stem's volume; projects saved before a stem existed have none (full). */
export function stemLevel(project: Pick<Project, "volumes">, stem: Stem): number {
  return project.volumes[stem] ?? 1;
}
/** A mixer row: a stem, or the click track (once the beats are analysed). */
export type Track = Stem | "click";

/** A project's A–B loop in seconds; `enabled` false plays through it. */
export interface ProjectLoop {
  start: number;
  end: number;
  enabled: boolean;
}
export type Quality = "fp16" | "fp32";
export type ProjectStatus =
  | "empty"
  | "ready"
  | "processing"
  | "interrupted"
  | "failed";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceName: string | null;
  status: ProjectStatus;
  taskProgress?: number;
  taskStage?: string;
  /** Separation model. Missing = Spleeter (projects saved before the choice). */
  model?: ModelId;
  /** Spleeter's model files; Demucs has one quality. */
  quality: Quality;
  completedStems: Stem[];
  /** Per-stem volume, 0–1. A missing stem plays at full volume. */
  volumes: Partial<Record<Stem, number>>;
  mutedStems: Stem[];
  /** Soloed rows. Missing on projects saved before solo existed. */
  soloStems?: Track[];
  /** Click track level, 0–1. Missing = DEFAULT_CLICK_VOLUME. */
  clickVolume?: number;
  /** The click is heard (it is muted until turned on). */
  clickOn?: boolean;
  /** Delete the source audio once separation succeeds (saves space). */
  deleteSourceAfterSeparation?: boolean;
  /** The source audio was deleted after separation; re-import to separate. */
  sourceRemoved?: boolean;
  /** Playback speed, 0.5–1.5, keeping the pitch. Missing = 1. */
  speed?: number;
  /** Key shift in semitones, −12…12, keeping the speed. Missing = 0. */
  semitones?: number;
  /** A–B loop; missing when none is set. */
  loop?: ProjectLoop;
  /** Chords and key named as written (original) or as heard with the key shift. Missing = transposed. */
  chordNames?: "original" | "transposed";
  errorMessage: string | null;
}

export type BeatsPerBar = 3 | 4;

/** Corrections the user made to the detected beat grid. */
export interface GridEdits {
  /** Tempo ×2 or ÷2 (beats inserted halfway, or every other one dropped). */
  bpmFactor?: number;
  /** Moves bar starts by this many beats. */
  downbeatShift?: number;
  beatsPerBar?: BeatsPerBar;
  /** An even grid from tap tempo: the tempo, and a tap (track seconds) on a beat. */
  tapped?: { bpm: number; anchor: number };
}

/** Rhythm analysis of a project's stems, stored with the project. */
export interface AnalysisRecord {
  projectId: string;
  /** Bumped when an algorithm changes; older records are analysed again. */
  algorithmVersion: number;
  /** What the beats were found in: the drum stem, or every stem summed. */
  source: "drums" | "mix";
  /** Track length, seconds. */
  duration: number;
  bpm: number;
  bpmConfidence: number;
  /** The other likely octave of the tempo, if any. */
  alternativeBpm: number | null;
  /** Beat times, seconds. */
  beats: Float32Array;
  beatsPerBar: BeatsPerBar;
  firstDownbeatIndex: number;
  edits?: GridEdits;
  // Tonal analysis (M10). Missing on records analysed before it existed.
  /** Tuning offset from A = 440 Hz, in cents (−50…50). */
  tuningCents?: number;
  /** The song's key; null when the harmonic stems are silent. */
  key?: KeyEstimate | null;
  /** Key changes held long enough to matter, in time order (the first is the opening key). */
  modulations?: Modulation[];
  /** Chord timeline, covering the track. */
  chords?: ChordSegment[];
  /** The key the user set, overriding the detected one. */
  keyOverride?: MusicalKey;
}

export type Mode = "major" | "minor";

/** A key: tonic pitch class (0 = C … 11 = B) and mode. */
export interface MusicalKey {
  tonic: number;
  mode: Mode;
}

export interface KeyEstimate extends MusicalKey {
  /** 0–1: how clearly this key stands out. */
  confidence: number;
  /** The second most likely key (often the relative major or minor). */
  alternative: MusicalKey;
}

/** A point from which the music stays in another key. */
export interface Modulation extends MusicalKey {
  /** Seconds. */
  start: number;
}

export type ChordQuality = "maj" | "min";

/** A chord held from `start` to `end` (seconds). */
export interface ChordSegment {
  start: number;
  end: number;
  /** Root pitch class (0 = C), or null for no chord. */
  root: number | null;
  quality: ChordQuality;
  /** Bass pitch class when it is not the root (an inversion: C/E). */
  bass?: number;
}

export interface StoredBlob {
  id: string;
  blob: Blob;
  name: string;
}

export interface ModelRecord {
  key: string;
  blob: Blob;
  storedAt: number;
}

export const DEFAULT_CLICK_VOLUME = 0.8;

export const TRACK_LABELS: Record<Track, string> = {
  vocals: "Vocals",
  guitar: "Guitar",
  piano: "Piano",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
  click: "Click",
};

export const STEM_LABELS: Record<Stem, string> = {
  vocals: "Vocals",
  guitar: "Guitar",
  piano: "Piano",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
};

export function newProject(
  name: string,
  model: ModelId = "spleeter-5",
): Project {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: name.trim() || "Untitled project",
    createdAt: now,
    updatedAt: now,
    sourceName: null,
    status: "empty",
    taskProgress: 0,
    taskStage: "",
    model,
    quality: "fp16",
    completedStems: [],
    volumes: {},
    mutedStems: [],
    soloStems: [],
    errorMessage: null,
  };
}
