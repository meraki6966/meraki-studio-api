import { v4 as uuidv4 } from 'uuid';
import type { ToolDefinition, ToolCallResult } from './types.js';
import {
  createProject, loadProject, listProjects, saveProject,
  addTrack, addAsset, updateAsset, addClipToTrack,
  updateClip, removeClip, createRenderJob, updateRenderJob,
  getRenderJob, getRendersDir, getTempDir,
} from './projects.js';
import { generateVideo, generateImage, transcribeAudio } from './services/generate.js';
import { uploadFromUrl, uploadFromPath, generateThumbnailUrl, isConfigured as cloudinaryConfigured } from './services/cloudinary.js';
import { renderProject, checkFFmpeg } from './services/ffmpeg.js';
import { join } from 'path';

// ─── In-progress generation tracking ───────────────────────────────
const pendingGenerations = new Map<string, {
  projectId: string;
  assetId: string;
  promise: Promise<void>;
}>();

// ─── Tool Definitions ───────────────────────────────────────────────

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'create_project',
    description: 'Create a new video project. Returns the project ID needed for all other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name (e.g. "VeloxSync Demo v1")' },
        fps: { type: 'number', description: 'Frames per second. Default: 30' },
        width: { type: 'number', description: 'Output width in pixels. Default: 1920' },
        height: { type: 'number', description: 'Output height in pixels. Default: 1080' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all existing video projects.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_timeline',
    description: 'Get the full current state of a project: tracks, clips, assets, and duration.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'generate_video_clip',
    description: 'Generate a video clip using AI (Replicate Kling + fal.ai fallback). Returns an assetId immediately — use check_asset_status to poll until ready, then add_clip_to_track.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project ID' },
        prompt: { type: 'string', description: 'Text description of the video to generate' },
        duration: { type: 'number', description: 'Duration in seconds (3-10). Default: 5' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Aspect ratio. Default: 16:9' },
        imageUrl: { type: 'string', description: 'Optional: source image URL for image-to-video generation' },
        name: { type: 'string', description: 'Optional label for this clip asset' },
      },
      required: ['projectId', 'prompt'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generate a still image using AI (Flux Schnell). Returns an assetId — use check_asset_status to poll until ready.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project ID' },
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        width: { type: 'number', description: 'Image width. Default: 1920' },
        height: { type: 'number', description: 'Image height. Default: 1080' },
        name: { type: 'string', description: 'Optional label for this image asset' },
      },
      required: ['projectId', 'prompt'],
    },
  },
  {
    name: 'check_asset_status',
    description: 'Check the status of a generated asset. Returns "pending", "processing", "ready", or "error". Poll every 5-10 seconds until ready.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project ID' },
        assetId: { type: 'string', description: 'The asset ID returned by generate_video_clip or generate_image' },
      },
      required: ['projectId', 'assetId'],
    },
  },
  {
    name: 'upload_asset_from_url',
    description: 'Import an existing video, audio, or image into the project from a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        url: { type: 'string', description: 'Public URL to the media file' },
        type: { type: 'string', enum: ['video', 'audio', 'image'] },
        name: { type: 'string', description: 'Display name for this asset' },
      },
      required: ['projectId', 'url', 'type', 'name'],
    },
  },
  {
    name: 'add_clip_to_track',
    description: 'Place a ready asset onto a timeline track at a specific start time.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        trackId: { type: 'string', description: 'Track ID (get from get_timeline)' },
        assetId: { type: 'string', description: 'Asset ID (must be status: ready)' },
        startTime: { type: 'number', description: 'Start position on timeline in seconds' },
        duration: { type: 'number', description: 'Override clip duration in seconds (optional)' },
        label: { type: 'string', description: 'Optional label for this clip' },
      },
      required: ['projectId', 'trackId', 'assetId', 'startTime'],
    },
  },
  {
    name: 'trim_clip',
    description: 'Trim the in/out points of an existing clip on the timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        clipId: { type: 'string' },
        trimIn: { type: 'number', description: 'New trim-in point in seconds' },
        trimOut: { type: 'number', description: 'New trim-out point in seconds' },
      },
      required: ['projectId', 'clipId'],
    },
  },
  {
    name: 'move_clip',
    description: 'Move a clip to a different start time on the timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        clipId: { type: 'string' },
        startTime: { type: 'number', description: 'New start time in seconds' },
      },
      required: ['projectId', 'clipId', 'startTime'],
    },
  },
  {
    name: 'set_clip_speed',
    description: 'Change the playback speed of a clip (0.5 = half speed, 2.0 = double speed).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        clipId: { type: 'string' },
        speed: { type: 'number', description: 'Playback speed multiplier. 1.0 = normal.' },
      },
      required: ['projectId', 'clipId', 'speed'],
    },
  },
  {
    name: 'remove_clip',
    description: 'Remove a clip from the timeline. Does not delete the source asset.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        clipId: { type: 'string' },
      },
      required: ['projectId', 'clipId'],
    },
  },
  {
    name: 'add_track',
    description: 'Add a new video, audio, or overlay track to the project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        type: { type: 'string', enum: ['video', 'audio', 'overlay'] },
        name: { type: 'string', description: 'Optional track name' },
      },
      required: ['projectId', 'type'],
    },
  },
  {
    name: 'list_assets',
    description: 'List all assets in a project with their status and URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'transcribe_clip',
    description: 'Transcribe the audio/speech from a clip using Whisper. Returns the transcript text.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        assetId: { type: 'string' },
      },
      required: ['projectId', 'assetId'],
    },
  },
  {
    name: 'render_project',
    description: 'Render the project timeline to a final MP4 file. Returns a render job ID. Use check_render_status to poll for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        quality: { type: 'string', enum: ['draft', 'high'], description: 'draft = fast/smaller, high = best quality. Default: draft' },
        outputName: { type: 'string', description: 'Optional output filename (no extension)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'check_render_status',
    description: 'Check the status of a render job. Returns status, progress, and output URL when done.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'studio_status',
    description: 'Check what services are configured and available (FFmpeg, Cloudinary, Replicate, fal.ai).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────

function ok(data: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    switch (name) {

      case 'create_project': {
        const project = createProject(
          String(args.name),
          args.fps ? Number(args.fps) : 30,
          args.width ? Number(args.width) : 1920,
          args.height ? Number(args.height) : 1080
        );
        return ok({ success: true, project });
      }

      case 'list_projects': {
        const projects = listProjects().map(p => ({
          id: p.id, name: p.name, duration: p.duration,
          trackCount: p.tracks.length, assetCount: p.assets.length,
          updatedAt: p.updatedAt,
        }));
        return ok({ projects });
      }

      case 'get_timeline': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);
        return ok(project);
      }

      case 'generate_video_clip': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);

        const assetId = uuidv4();
        const asset = addAsset(String(args.projectId), {
          id: assetId,
          type: 'video',
          name: String(args.name || args.prompt).slice(0, 60),
          url: '',
          status: 'pending',
          generatedBy: 'replicate',
          prompt: String(args.prompt),
          createdAt: new Date().toISOString(),
        } as any);

        if (!asset) return err('Failed to create asset placeholder');

        // Start async generation
        const generationPromise = (async () => {
          try {
            updateAsset(String(args.projectId), assetId, { status: 'processing' });
            const result = await generateVideo({
              prompt: String(args.prompt),
              duration: args.duration ? Number(args.duration) : 5,
              aspectRatio: (args.aspectRatio as '16:9' | '9:16' | '1:1') || '16:9',
              imageUrl: args.imageUrl ? String(args.imageUrl) : undefined,
            });

            let finalUrl = result.url;
            let thumbnailUrl: string | undefined;

            // Upload to Cloudinary if configured
            if (cloudinaryConfigured()) {
              const uploaded = await uploadFromUrl(result.url, `meraki-studio/${args.projectId}`, 'video');
              finalUrl = uploaded.url;
              thumbnailUrl = generateThumbnailUrl(uploaded.publicId);
              updateAsset(String(args.projectId), assetId, {
                url: finalUrl,
                duration: uploaded.duration || Number(args.duration || 5),
                width: uploaded.width,
                height: uploaded.height,
                thumbnailUrl,
                generatedBy: result.provider,
                status: 'ready',
              });
            } else {
              updateAsset(String(args.projectId), assetId, {
                url: finalUrl,
                duration: Number(args.duration || 5),
                generatedBy: result.provider,
                status: 'ready',
              });
            }
          } catch (error) {
            updateAsset(String(args.projectId), assetId, {
              status: 'error',
              errorMessage: (error as Error).message,
            });
          } finally {
            pendingGenerations.delete(assetId);
          }
        })();

        pendingGenerations.set(assetId, {
          projectId: String(args.projectId),
          assetId,
          promise: generationPromise,
        });

        return ok({
          success: true,
          assetId,
          status: 'pending',
          message: 'Video generation started. Use check_asset_status to poll until ready (usually 30-120 seconds), then use add_clip_to_track.',
        });
      }

      case 'generate_image': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);

        const assetId = uuidv4();
        addAsset(String(args.projectId), {
          id: assetId,
          type: 'image',
          name: String(args.name || args.prompt).slice(0, 60),
          url: '',
          status: 'pending',
          generatedBy: 'replicate',
          prompt: String(args.prompt),
          createdAt: new Date().toISOString(),
        } as any);

        const generationPromise = (async () => {
          try {
            updateAsset(String(args.projectId), assetId, { status: 'processing' });
            const imageUrl = await generateImage(
              String(args.prompt),
              args.width ? Number(args.width) : 1920,
              args.height ? Number(args.height) : 1080
            );

            let finalUrl = imageUrl;
            if (cloudinaryConfigured()) {
              const uploaded = await uploadFromUrl(imageUrl, `meraki-studio/${args.projectId}`, 'image');
              finalUrl = uploaded.url;
            }

            updateAsset(String(args.projectId), assetId, {
              url: finalUrl,
              width: args.width ? Number(args.width) : 1920,
              height: args.height ? Number(args.height) : 1080,
              status: 'ready',
            });
          } catch (error) {
            updateAsset(String(args.projectId), assetId, {
              status: 'error',
              errorMessage: (error as Error).message,
            });
          } finally {
            pendingGenerations.delete(assetId);
          }
        })();

        pendingGenerations.set(assetId, { projectId: String(args.projectId), assetId, promise: generationPromise });
        return ok({ success: true, assetId, status: 'pending', message: 'Image generation started. Poll with check_asset_status.' });
      }

      case 'check_asset_status': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);
        const asset = project.assets.find(a => a.id === String(args.assetId));
        if (!asset) return err(`Asset ${args.assetId} not found`);
        return ok({
          assetId: asset.id, name: asset.name, status: asset.status,
          url: asset.url || null, duration: asset.duration, thumbnailUrl: asset.thumbnailUrl,
          errorMessage: asset.errorMessage,
          readyToUse: asset.status === 'ready',
        });
      }

      case 'upload_asset_from_url': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);

        const type = String(args.type) as 'video' | 'audio' | 'image';
        let finalUrl = String(args.url);
        let duration: number | undefined;
        let width: number | undefined;
        let height: number | undefined;

        if (cloudinaryConfigured()) {
          const resourceType = type === 'audio' ? 'video' : type; // Cloudinary uses 'video' for audio
          const uploaded = await uploadFromUrl(finalUrl, `meraki-studio/${args.projectId}`, resourceType as any);
          finalUrl = uploaded.url;
          duration = uploaded.duration;
          width = uploaded.width;
          height = uploaded.height;
        }

        const asset = addAsset(String(args.projectId), {
          type,
          name: String(args.name),
          url: finalUrl,
          duration,
          width,
          height,
          status: 'ready',
          generatedBy: 'upload',
        } as any);

        return ok({ success: true, asset });
      }

      case 'add_clip_to_track': {
        const clip = addClipToTrack(
          String(args.projectId),
          String(args.trackId),
          String(args.assetId),
          Number(args.startTime),
          args.duration ? Number(args.duration) : undefined,
          args.label ? String(args.label) : undefined
        );
        if (!clip) return err('Failed to add clip. Check that the asset is status:ready and trackId/assetId are correct.');
        return ok({ success: true, clip });
      }

      case 'trim_clip': {
        const updates: Record<string, number> = {};
        if (args.trimIn !== undefined) updates.trimIn = Number(args.trimIn);
        if (args.trimOut !== undefined) updates.trimOut = Number(args.trimOut);
        const clip = updateClip(String(args.projectId), String(args.clipId), updates);
        if (!clip) return err(`Clip ${args.clipId} not found`);
        return ok({ success: true, clip });
      }

      case 'move_clip': {
        const clip = updateClip(String(args.projectId), String(args.clipId), { startTime: Number(args.startTime) });
        if (!clip) return err(`Clip ${args.clipId} not found`);
        return ok({ success: true, clip });
      }

      case 'set_clip_speed': {
        const clip = updateClip(String(args.projectId), String(args.clipId), { speed: Number(args.speed) });
        if (!clip) return err(`Clip ${args.clipId} not found`);
        return ok({ success: true, clip });
      }

      case 'remove_clip': {
        const removed = removeClip(String(args.projectId), String(args.clipId));
        if (!removed) return err(`Clip ${args.clipId} not found`);
        return ok({ success: true, message: 'Clip removed from timeline.' });
      }

      case 'add_track': {
        const track = addTrack(
          String(args.projectId),
          String(args.type) as 'video' | 'audio' | 'overlay',
          args.name ? String(args.name) : undefined
        );
        if (!track) return err(`Project ${args.projectId} not found`);
        return ok({ success: true, track });
      }

      case 'list_assets': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);
        return ok({ assets: project.assets });
      }

      case 'transcribe_clip': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);
        const asset = project.assets.find(a => a.id === String(args.assetId));
        if (!asset) return err(`Asset ${args.assetId} not found`);
        if (!asset.url) return err('Asset has no URL to transcribe');
        const transcript = await transcribeAudio(asset.url);
        return ok({ success: true, transcript, assetId: asset.id, assetName: asset.name });
      }

      case 'render_project': {
        const project = loadProject(String(args.projectId));
        if (!project) return err(`Project ${args.projectId} not found`);

        const ffmpegAvailable = await checkFFmpeg();
        if (!ffmpegAvailable) return err('FFmpeg is not installed. Install FFmpeg to render projects.');

        const job = createRenderJob(
          String(args.projectId),
          (args.quality as 'draft' | 'high') || 'draft'
        );

        // Start async render
        (async () => {
          updateRenderJob(job.id, { status: 'rendering', progress: 0 });
          try {
            const outputPath = await renderProject(
              project,
              {
                quality: job.quality,
                outputDir: getRendersDir(),
                outputName: args.outputName ? String(args.outputName) : undefined,
              },
              (msg) => console.log(`[render:${job.id}] ${msg}`)
            );

            let outputUrl = outputPath;
            if (cloudinaryConfigured()) {
              const uploaded = await uploadFromPath(outputPath, 'meraki-studio/renders', 'video');
              outputUrl = uploaded.url;
            }

            updateRenderJob(job.id, {
              status: 'done',
              outputUrl,
              localPath: outputPath,
              progress: 100,
              completedAt: new Date().toISOString(),
            });
          } catch (error) {
            updateRenderJob(job.id, {
              status: 'error',
              errorMessage: (error as Error).message,
            });
          }
        })();

        return ok({
          success: true,
          jobId: job.id,
          message: 'Render started. Use check_render_status to poll for completion.',
        });
      }

      case 'check_render_status': {
        const job = getRenderJob(String(args.jobId));
        if (!job) return err(`Render job ${args.jobId} not found`);
        return ok(job);
      }

      case 'studio_status': {
        const ffmpeg = await checkFFmpeg();
        return ok({
          ffmpeg: { available: ffmpeg, note: ffmpeg ? 'Ready to render' : 'Install FFmpeg to enable rendering' },
          cloudinary: { configured: cloudinaryConfigured(), note: cloudinaryConfigured() ? 'Assets will be uploaded to Cloudinary' : 'Set CLOUDINARY_* env vars for persistent asset storage' },
          replicate: { configured: !!process.env.REPLICATE_API_TOKEN },
          fal: { configured: !!process.env.FAL_KEY },
          generation: {
            available: !!(process.env.REPLICATE_API_TOKEN || process.env.FAL_KEY),
            strategy: process.env.REPLICATE_API_TOKEN ? 'Replicate primary, fal.ai fallback' : process.env.FAL_KEY ? 'fal.ai only' : 'No generation keys configured',
          },
          projects: { count: listProjects().length },
        });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return err(`Tool execution failed: ${(error as Error).message}`);
  }
}
