export interface CommandRecord {
  /** Command name (matches frontmatter `name` and filename basename). */
  name: string;
  /** Description from frontmatter — used by composeSystemSections to advertise to the model. */
  description: string;
  /** Optional argument-hint from frontmatter, used by /help (v1.5). */
  argumentHint?: string;
  /** Absolute path to the command's .md file. Body loaded on dispatch. */
  bodyPath: string;
}
