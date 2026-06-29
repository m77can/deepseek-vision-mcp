export interface UploadFileResponse {
  id?: string;
  file_id?: string;
  filename?: string;
  size?: number;
  status?: string;
}

export interface FileInfo {
  id: string;
  file_id: string;
  status: string;
}

export interface HifToken {
  leim: string;
  dliq: string;
}

export interface VisionCompletionRequest {
  chat_session_id: string;
  parent_message_id?: string | null;
  model_type: string;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  action: string | null;
  preempt: boolean;
}

export interface DeepSeekClientConfig {
  token: string;
  smidV2?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface LoginCallback {
  onLoginRequired: () => Promise<string>;
}
