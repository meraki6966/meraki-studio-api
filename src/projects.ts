import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Project, Track, Asset, Clip, RenderJob } from './types.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const PROJECTS_DIR = join(DATA_DIR, 'projects');
const RENDERS_DIR = join(DATA_DIR, 'renders');
const TEMP_DIR = join(DATA_DIR, 'temp');

[PROJECTS_DIR, RENDERS_DIR, TEMP_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// In-memory render jobs (lost on restart — acceptable for now)
const renderJobs = new Map<string, RenderJob>();

export function getRendersDir(): string { return RENDERS_DIR; }
export function getTempDir(): string { return TEMP_DIR; }

export function saveProject(project: Project): void {
  project.updatedAt = new Date().toISOString();
  let maxEnd = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clip.startTime + clip.duration;
      if (end > maxEnd) maxEnd = end;
    }
  }
  project.duration = maxEnd;
  writeFileSync(join(PROJECTS_DIR, `${project.id}.json`), JSON.stringify(project, null, 2));
}

export function loadProject(id: string): Project | null {
  const path = join(PROJECTS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

export function listProjects(): Project[] {
  try {
    return readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf-8')) as Project; }
        catch { return null; }
      })
      .filter(Boolean) as Project[];
  } catch { return []; }
}

export function createProject(
  name: string,
  fps = 30,
  width = 1920,
  height = 1080
): Project {
  const project: Project = {
    id: uuidv4(),
    name,
    fps,
    resolution: { width, height },
    duration: 0,
    tracks: [
      { id: uuidv4(), type: 'video', name: 'Video 1', clips: [] },
      { id: uuidv4(), type: 'audio', name: 'Audio 1', clips: [] },
    ],
    assets: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveProject(project);
  return project;
}

export function addTrack(projectId: string, type: 'video' | 'audio' | 'overlay', name?: string): Track | null {
  const project = loadProject(projectId);
  if (!project) return null;
  const count = project.tracks.filter(t => t.type === type).length + 1;
  const track: Track = {
    id: uuidv4(),
    type,
    name: name || `${type.charAt(0).toUpperCase() + type.slice(1)} ${count}`,
    clips: [],
  };
  project.tracks.push(track);
  saveProject(project);
  return track;
}

export function addAsset(
  projectId: string,
  asset: Omit<Asset, 'id' | 'createdAt'> & { id?: string }
): Asset | null {
  const project = loadProject(projectId);
  if (!project) return null;
  // Honor a caller-provided id so async status updates (processing/ready/error)
  // can target the same asset. Generate one only when none is supplied.
  const newAsset: Asset = { ...asset, id: asset.id ?? uuidv4(), createdAt: new Date().toISOString() };
  project.assets.push(newAsset);
  saveProject(project);
  return newAsset;
}

export function updateAsset(projectId: string, assetId: string, updates: Partial<Asset>): Asset | null {
  const project = loadProject(projectId);
  if (!project) return null;
  const idx = project.assets.findIndex(a => a.id === assetId);
  if (idx === -1) return null;
  project.assets[idx] = { ...project.assets[idx], ...updates };
  saveProject(project);
  return project.assets[idx];
}

export function addClipToTrack(
  projectId: string,
  trackId: string,
  assetId: string,
  startTime: number,
  duration?: number,
  label?: string
): Clip | null {
  const project = loadProject(projectId);
  if (!project) return null;
  const track = project.tracks.find(t => t.id === trackId);
  if (!track) return null;
  const asset = project.assets.find(a => a.id === assetId);
  if (!asset) return null;
  if (asset.status !== 'ready') return null;

  const clipDuration = duration ?? asset.duration ?? 5;
  const clip: Clip = {
    id: uuidv4(),
    assetId,
    startTime,
    duration: clipDuration,
    trimIn: 0,
    trimOut: clipDuration,
    speed: 1.0,
    opacity: 1.0,
    label,
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startTime - b.startTime);
  saveProject(project);
  return clip;
}

export function updateClip(projectId: string, clipId: string, updates: Partial<Clip>): Clip | null {
  const project = loadProject(projectId);
  if (!project) return null;
  for (const track of project.tracks) {
    const idx = track.clips.findIndex(c => c.id === clipId);
    if (idx !== -1) {
      track.clips[idx] = { ...track.clips[idx], ...updates };
      saveProject(project);
      return track.clips[idx];
    }
  }
  return null;
}

export function removeClip(projectId: string, clipId: string): boolean {
  const project = loadProject(projectId);
  if (!project) return false;
  for (const track of project.tracks) {
    const idx = track.clips.findIndex(c => c.id === clipId);
    if (idx !== -1) {
      track.clips.splice(idx, 1);
      saveProject(project);
      return true;
    }
  }
  return false;
}

export function createRenderJob(projectId: string, quality: 'draft' | 'high'): RenderJob {
  const job: RenderJob = {
    id: uuidv4(),
    projectId,
    status: 'queued',
    quality,
    createdAt: new Date().toISOString(),
  };
  renderJobs.set(job.id, job);
  return job;
}

export function updateRenderJob(jobId: string, updates: Partial<RenderJob>): RenderJob | null {
  const job = renderJobs.get(jobId);
  if (!job) return null;
  const updated = { ...job, ...updates };
  renderJobs.set(jobId, updated);
  return updated;
}

export function getRenderJob(jobId: string): RenderJob | null {
  return renderJobs.get(jobId) ?? null;
}
