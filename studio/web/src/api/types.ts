// types.ts: hand-written types mirroring the studio server's JSON (studio/app.js, studio/versions.js, studio/db.js,
// studio/frames/service.js). Kept in sync by hand — there's no shared schema between the Bun server and this app.

export interface VersionOptions {
  wipes: boolean;
  cornerMeter: boolean;
  [key: string]: unknown;
}

export type VersionStatus = 'concept' | 'storyboard' | 'approved' | 'chapters' | 'ready';

// One entry of GET /api/versions.
export interface Version {
  id: string;
  title: string;
  logline: string;
  concept: string;
  options: VersionOptions;
  status: VersionStatus;
  example: boolean;
  created_at: number;
  updated_at: number;
  chapters: number;
}

export interface WalkthroughChapter {
  n: number;
  name: string;
  start: number;
  end: number;
  text: string;
}

// GET /api/versions/<id>: the version's manifest plus what only that route adds.
export interface Manifest {
  id: string;
  title: string;
  logline: string;
  status: VersionStatus;
  example: boolean;
  options: VersionOptions;
  concept: string;
  files: string[];
  scripts: string[];
  walkthrough: WalkthroughChapter[];
  fileRevisions: Record<string, number>;
  storyboardErrors: string[];
  // The chapters (1..9) with a thumbnail strip, each with when it was written (ms since the epoch).
  thumbs?: Record<number, number>;
}

export type JobKind = 'storyboard' | 'shared' | 'chapter' | 'render' | 'thumbs';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface Job {
  id: number;
  kind: JobKind;
  version_id: string;
  params: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  cost_usd: number;
  model: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

// GET /api/jobs/<id>: a single job, with its log (job lists leave the log out).
export interface JobWithLog extends Job {
  log: string;
}

export interface Revision {
  id: number;
  version_id: string;
  path: string;
  // Left out of list responses (GET /api/versions/<id>/history, /revisions); present on GET /api/revisions/<id>.
  content?: string;
  job_id: number | null;
  source: string;
  note: string;
  sha256: string | null;
  created_at: number;
}

export interface Render {
  id: number;
  version_id: string;
  file: string;
  revision_ids: number[];
  snapshot_id: string | null;
  title: string;
  logline: string;
  duration_s: number | null;
  render_s: number | null;
  size_bytes: number | null;
  poster: string | null;
  created_at: number;
  // Its version was deleted and the render kept: it belongs to no version from then on, not even a new one that
  // takes the same id (version_id is only where it came from), and its title and logline are its own.
  detached: boolean;
}

// GET /api/coverage/<versionId>, and the `frames` SSE event's payload (minus versionId).
export interface Coverage {
  total: number;
  ranges: Array<[number, number]>;
  // until (ms since the epoch): when a break that runs out (a timeout, a version that didn't load) is over; none for a
  // chapter's own error, which lasts until its code changes.
  broken: Array<{ chapter: number; error: string; until?: number }>;
  // Each chapter's (1..9) segment key, or null for a chapter not written yet. A frame's ETag names the key it was
  // painted under, so the player can tell a frame of a chapter's older code from a current one.
  segments: Record<number, string | null>;
  // Grows with every coverage the server computes (answers and `frames` events alike): the larger is the newer.
  seq?: number;
}

export interface Health {
  claude: boolean;
  claudeSignedIn: boolean | null;
  ffmpeg: boolean;
  // Whether the studio can paint frames: ok false (with the reason) once its painting browser failed to start (no
  // Chromium-based browser found, a bad CHROME_PATH); it tries again every 30 s. null when the server has no frame
  // service.
  painter: { ok: boolean; reason: string | null } | null;
}

// GET /api/song: the engine's fixed timing plus the lyrics, for the timeline and lyrics track.
export interface Song {
  fps: number;
  frames: number;
  duration: number;
  chapters: Array<[number, number]>;
  lyrics: Array<[number, number, string]>;
}

// GET /api/cache.
export interface CacheInfo {
  usedBytes: number;
  capBytes: number;
  // What the old renders' frame folders (<data>/.studio/frames/) still hold: unused, deleted by Clear cache too.
  legacyBytes: number;
}
