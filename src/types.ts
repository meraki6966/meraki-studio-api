export interface Project {
  id: string;
  name: string;
  fps: number;
  resolution: { width: number; height: number };
  duration: number;
  tracks: Track[];
  assets: Asset[];
  createdAt: string;
  updatedAt: string;
}

export interface Track {
  id: string;
  type: 'video' | 'audio' | 'overlay';
  name: string;
  clips: Clip[];
}

export interface Clip {
  id: string;
  assetId: string;
  startTime: number;
  duration: number;
  trimIn: number;
  trimOut: number;
  speed: number;
  opacity: number;
  label?: string;
}

export interface Asset {
  id: string;
  type: 'video' | 'audio' | 'image';
  name: string;
  url: string;
  localPath?: string;
  duration?: number;
  width?: number;
  height?: number;
  generatedBy?: 'replicate' | 'fal' | 'upload';
  prompt?: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  errorMessage?: string;
  replicateId?: string;
  falRequestId?: string;
  thumbnailUrl?: string;
  createdAt: string;
}

export interface RenderJob {
  id: string;
  projectId: string;
  status: 'queued' | 'rendering' | 'done' | 'error';
  outputUrl?: string;
  localPath?: string;
  progress?: number;
  errorMessage?: string;
  quality: 'draft' | 'high';
  createdAt: string;
  completedAt?: string;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: number | string;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
