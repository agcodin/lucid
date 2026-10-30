/** What the remote tier can be asked to do. Mirrors Grammarly's generative set. */
export type TransformKind =
  | 'rewrite'      // Clearer version, same meaning.
  | 'shorten'      // Same meaning, fewer words.
  | 'expand'       // More detail, same claim.
  | 'paraphrase'   // Different wording, same meaning.
  | 'tone'         // Same meaning, requested tone.
  | 'simplify'     // Same meaning, plainer vocabulary.
  | 'custom';      // Free-form instruction.

export interface TransformRequest {
  kind: TransformKind;
  /** The span to rewrite. */
  text: string;
  /** Surrounding paragraph, so the rewrite matches its neighbours. Not rewritten. */
  context?: string;
  /** Required for `kind: 'tone'`, e.g. "formal", "friendly", "direct". */
  tone?: string;
  /** Required for `kind: 'custom'`. */
  instruction?: string;
}

export interface TransformVariant {
  text: string;
  /** One short clause on what changed, for the suggestion card. */
  note: string;
}

export interface RemoteProvider {
  /** Human-readable name for the settings panel. */
  readonly name: string;
  /** False when no credential is configured; the UI hides the remote actions. */
  isConfigured(): boolean;
  transform(request: TransformRequest, signal?: AbortSignal): Promise<TransformVariant[]>;
}
