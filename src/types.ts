export type AppEnv = Env;

export const AGENT_SCOPES = ["artifact:write", "artifact:read", "artifact:delete", "share:create"] as const;
export type Scope = (typeof AGENT_SCOPES)[number];
export type Retention = "7d" | "30d" | "retain";

export interface AuthContext {
  id: string;
  owner: string;
  scopes: Scope[];
}

export interface AdminContext {
  actor: string;
  mode: "cloudflare-access" | "break-glass";
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
  retention: Retention;
  expires_at: number | null;
  checksum_status: "verified" | "client_asserted" | "unverified";
}
