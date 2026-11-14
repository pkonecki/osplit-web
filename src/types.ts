export const STEMS = ["vocals", "piano", "drums", "bass", "other"] as const;
export type Stem = (typeof STEMS)[number];
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
  quality: Quality;
  completedStems: Stem[];
  volumes: Record<Stem, number>;
  mutedStems: Stem[];
  /** Soloed stems. Missing on projects saved before solo existed. */
  soloStems?: Stem[];
  /** Delete the source audio once separation succeeds (saves space). */
  deleteSourceAfterSeparation?: boolean;
  /** The source audio was deleted after separation; re-import to separate. */
  sourceRemoved?: boolean;
  errorMessage: string | null;
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

export const STEM_LABELS: Record<Stem, string> = {
  vocals: "Vocals",
  piano: "Piano",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
};

export function newProject(name: string): Project {
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
    quality: "fp16",
    completedStems: [],
    volumes: { vocals: 1, piano: 1, drums: 1, bass: 1, other: 1 },
    mutedStems: [],
    soloStems: [],
    errorMessage: null,
  };
}
