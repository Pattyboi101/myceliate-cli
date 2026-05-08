/**
 * UI store types for spore-aware state.
 * Phase 21: ActiveSporeState used by InputBox for dynamic border colour.
 * Full zustand/reactive store deferred to v1.4 — state is currently held in
 * index.ts AppState and threaded as props.
 */

export interface ActiveSporeState {
  name: string;
  accent_color: string;
}
