import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, extname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createWriteStream } from 'fs';
import https from 'https';
import http from 'http';
import type { Project } from '../types.js';

const execFileAsync = promisify(execFile);

export interface RenderOptions {
  quality: 'draft' | 'high';
  outputDir: string;
  outputName?: string;
}

// Download a URL to a local path
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location!, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', err => {
      file.close();
      reject(err);
    });
  });
}

// Detect ffmpeg availability
export async function checkFFmpeg(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

// Get video duration using ffprobe
export async function getVideoDuration(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function renderProject(
  project: Project,
  options: RenderOptions,
  onProgress?: (msg: string) => void
): Promise<string> {
  const available = await checkFFmpeg();
  if (!available) throw new Error('FFmpeg is not installed or not in PATH.');

  if (!existsSync(options.outputDir)) mkdirSync(options.outputDir, { recursive: true });

  const tempDir = join(options.outputDir, `temp_${project.id}`);
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const outputPath = join(options.outputDir, `${options.outputName || project.id}_render.mp4`);
  const crf = options.quality === 'draft' ? '28' : '18';
  const preset = options.quality === 'draft' ? 'veryfast' : 'slow';

  // Collect all video clips (from first video track)
  const videoTrack = project.tracks.find(t => t.type === 'video');
  const audioTrack = project.tracks.find(t => t.type === 'audio');

  if (!videoTrack || videoTrack.clips.length === 0) {
    throw new Error('Project has no video clips to render.');
  }

  onProgress?.('Downloading assets...');

  // Download all referenced assets
  const localPaths: Record<string, string> = {};
  const allClips = project.tracks.flatMap(t => t.clips);
  const uniqueAssetIds = [...new Set(allClips.map(c => c.assetId))];

  for (const assetId of uniqueAssetIds) {
    const asset = project.assets.find(a => a.id === assetId);
    if (!asset || !asset.url) continue;
    const ext = extname(asset.url.split('?')[0]) || (asset.type === 'video' ? '.mp4' : asset.type === 'audio' ? '.mp3' : '.jpg');
    const localPath = join(tempDir, `${assetId}${ext}`);
    if (!existsSync(localPath)) {
      onProgress?.(`Downloading ${asset.name}...`);
      await downloadFile(asset.url, localPath);
    }
    localPaths[assetId] = localPath;
  }

  onProgress?.('Building FFmpeg command...');

  // Sort video clips by startTime
  const sortedVideoClips = [...videoTrack.clips].sort((a, b) => a.startTime - b.startTime);
  const sortedAudioClips = audioTrack ? [...audioTrack.clips].sort((a, b) => a.startTime - b.startTime) : [];

  // Build inputs array
  const inputs: string[] = [];
  const filterParts: string[] = [];
  const videoLabels: string[] = [];

  for (let i = 0; i < sortedVideoClips.length; i++) {
    const clip = sortedVideoClips[i];
    const localPath = localPaths[clip.assetId];
    if (!localPath) continue;

    inputs.push('-i', localPath);
    const idx = inputs.filter(x => x === '-i').length - 1;

    const W = project.resolution.width;
    const H = project.resolution.height;

    // Speed: setpts divides timestamps, so 2.0 plays twice as fast and
    // 0.5 at half speed. Previously clip.speed was stored by set_clip_speed
    // but never applied here, so that tool silently did nothing.
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const setpts = speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${speed}`;

    // Fit: sources within ~6% of the project aspect ratio (e.g. 832x480 AI
    // clips in a 16:9 project) are scaled to cover and center-cropped, so
    // they fill the frame instead of getting thin black pillarbox bars.
    // Anything further off (vertical phone footage, square images) is
    // letterboxed so nothing important gets cropped away.
    const asset = project.assets.find(a => a.id === clip.assetId);
    const srcW = (asset as any)?.width as number | undefined;
    const srcH = (asset as any)?.height as number | undefined;
    const targetAR = W / H;
    const nearTarget = srcW && srcH ? Math.abs(srcW / srcH - targetAR) / targetAR < 0.06 : false;
    const fit = nearTarget
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;

    // setsar/fps/format normalize every segment so concat never fails on
    // mismatched sample aspect ratio or frame rate (screen recordings are
    // 60fps, AI clips 16fps, the project is usually 30fps).
    const trimFilter = `[${idx}:v]trim=${clip.trimIn}:${clip.trimOut},${setpts},${fit},setsar=1,fps=${project.fps || 30},format=yuv420p[v${i}]`;
    filterParts.push(trimFilter);
    videoLabels.push(`[v${i}]`);
  }

  // Concat all video clips
  filterParts.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[video_out]`);

  const ffmpegArgs: string[] = [...inputs];

  // Add audio inputs
  let audioLabel: string | null = null;
  if (sortedAudioClips.length > 0) {
    for (let i = 0; i < sortedAudioClips.length; i++) {
      const clip = sortedAudioClips[i];
      const localPath = localPaths[clip.assetId];
      if (!localPath) continue;
      const inputIdx = inputs.filter(x => x === '-i').length;
      inputs.push('-i', localPath);
      ffmpegArgs.push('-i', localPath);
      filterParts.push(`[${inputIdx}:a]atrim=0:${project.duration},adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)},asetpts=PTS-STARTPTS[a${i}]`);
    }

    if (sortedAudioClips.length === 1) {
      filterParts.push(`[a0]anull[audio_out]`);
    } else {
      const aLabels = sortedAudioClips.map((_, i) => `[a${i}]`).join('');
      // normalize=0: by default amix scales every input by 1/N for as long
      // as the inputs are "active", and adelay'd clips count as active from
      // t=0, so five back-to-back narration clips each came out at a fraction
      // of their real loudness. Timeline clips are placed sequentially, so a
      // straight sum is what we want.
      filterParts.push(`${aLabels}amix=inputs=${sortedAudioClips.length}:duration=longest:normalize=0[audio_out]`);
    }
    audioLabel = '[audio_out]';
  }

  onProgress?.('Rendering...');

  // Build final ffmpeg command
  const filterComplex = filterParts.join('; ');

  const cmdArgs = [
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[video_out]',
    ...(audioLabel ? ['-map', audioLabel] : []),
    '-c:v', 'libx264',
    '-crf', crf,
    '-preset', preset,
    '-pix_fmt', 'yuv420p',
    ...(audioLabel ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  await execFileAsync('ffmpeg', cmdArgs, { maxBuffer: 50 * 1024 * 1024 });

  onProgress?.('Render complete!');
  return outputPath;
}
