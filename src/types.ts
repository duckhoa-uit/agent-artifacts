export type AppEnv = Env & { ADMIN_TOKEN: string };

export type Scope =
  | "artifact:write"
  | "artifact:read"
  | "artifact:delete"
  | "share:create"
  | "admin:keys";

export interface AuthContext {
  id: string;
  owner: string;
  scopes: Scope[];
}

export interface ArtifactRow {
  id: string;
  api_key_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  r2_key: string;
  source_agent: string | null;
  repo: string | null;
  pr_number: number | null;
  task_id: string | null;
  purpose: string | null;
  created_at: number;
  deleted_at: number | null;
}
