/** Metadata embedded in rendered HTML files for index generation. */
export interface ConvoMeta {
  session_id: string;
  short_id: string;
  project_dir: string;
  model: string;
  start_time: string;
  turn_count: number;
  user_turns: number;
}
