export type CandidateKind = "service" | "job";
export type Confidence = "high" | "low";

export interface Source {
  /** Path relative to the import root, with `/` separators. */
  file: string;
  detector: string;
}

/**
 * What a detector learned about one process. Only fields the source file states are set;
 * nothing is defaulted. The writer is the only stage that knows the Flisk manifest layout.
 */
export interface Candidate {
  kind: CandidateKind;
  /** Undefined means the file describes its directory, not a named service (Dockerfile, package.json). */
  name?: string;
  /** Directory the candidate belongs to, relative to the import root ("" is the root). */
  dir: string;
  /** A named candidate that never absorbs anonymous ones (a Compose service with only `image:`). */
  standalone?: boolean;
  image?: string;
  /** Dockerfile path relative to `dir`. */
  dockerfile?: string;
  command?: string;
  /** The port the service listens on inside its container, as stated by the source. */
  port?: number;
  /** HTTP path found in a Compose healthcheck, when it uses an explicit URL. */
  healthCheckPath?: string;
  /** Whether Flisk should expose this service through its Traefik router. */
  exposeViaProxy?: boolean;
  /** Set only when the source plainly names the runtime. */
  language?: "bun" | "node";
  /** Environment variable names. Values are never carried: they may be secrets. */
  envKeys?: string[];
  dependsOn?: string[];
  confidence: Confidence;
  sources: Source[];
}

export interface Skip {
  file: string;
  detector: string;
  reason: string;
  line?: number;
}

export interface ParseResult {
  candidates: Candidate[];
  skips: Skip[];
}

export interface Detector {
  id: string;
  /** Cheap: decides from the relative path alone. */
  claim(relPath: string): boolean;
  parse(absPath: string, relPath: string): ParseResult;
}

export interface ScanResult {
  /** Relative paths, `/` separators, sorted. */
  files: string[];
  notes: string[];
}
