import Replicate from 'replicate';
import { fal } from '@fal-ai/client';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
}

export interface GenerationInput {
  prompt: string;
  duration?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  imageUrl?: string; // for image-to-video
}

export interface GenerationResult {
  url: string;
  provider: 'replicate' | 'fal';
  duration?: number;
}

// ─── Video Generation ───────────────────────────────────────────────

export async function generateVideo(input: GenerationInput): Promise<GenerationResult> {
  // Try Replicate first (Kling 2.1)
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      console.log('[generate] Trying Replicate Kling...');
      const output = await replicate.run(
        'klingai/kling-video:latest' as `${string}/${string}`,
        {
          input: {
            prompt: input.prompt,
            duration: input.duration ?? 5,
            aspect_ratio: input.aspectRatio ?? '16:9',
            ...(input.imageUrl ? { image_url: input.imageUrl, mode: 'image-to-video' } : { mode: 'text-to-video' }),
          },
        }
      );
const url = Array.isArray(output) ? output[0] : output as unknown as string;
      if (url && typeof url === 'string') {
        return { url, provider: 'replicate', duration: input.duration ?? 5 };
      }
    } catch (err) {
      console.warn('[generate] Replicate failed, falling back to fal.ai:', (err as Error).message);
    }
  }

  // Fallback: fal.ai (Kling)
  if (process.env.FAL_KEY) {
    try {
      console.log('[generate] Trying fal.ai Kling...');
      const result = await fal.subscribe('fal-ai/kling-video/v2/standard/text-to-video', {
        input: {
          prompt: input.prompt,
          duration: String(input.duration ?? 5),
          aspect_ratio: input.aspectRatio ?? '16:9',
        },
        pollInterval: 3000,
        timeout: 180000,
      });
      const data = result.data as { video?: { url: string }; url?: string };
      const url = data?.video?.url || data?.url;
      if (url) return { url, provider: 'fal', duration: input.duration ?? 5 };
    } catch (err) {
      console.warn('[generate] fal.ai Kling failed, trying Wan:', (err as Error).message);
    }

    // Last resort: Wan 2.1 on fal.ai
    try {
      const result = await fal.subscribe('fal-ai/wan-ai/wan2.1-t2v-720p', {
        input: { prompt: input.prompt },
        pollInterval: 3000,
        timeout: 240000,
      });
      const data = result.data as { video?: { url: string }; url?: string };
      const url = data?.video?.url || data?.url;
      if (url) return { url, provider: 'fal', duration: input.duration ?? 5 };
    } catch (err) {
      throw new Error(`All generation providers failed: ${(err as Error).message}`);
    }
  }

  throw new Error('No generation API keys configured. Set REPLICATE_API_TOKEN and/or FAL_KEY.');
}

// ─── Image Generation ───────────────────────────────────────────────

export async function generateImage(prompt: string, width = 1920, height = 1080): Promise<string> {
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      const output = await replicate.run(
        'black-forest-labs/flux-schnell' as `${string}/${string}`,
        { input: { prompt, width, height, num_outputs: 1 } }
      );
      const url = Array.isArray(output) ? output[0] : output;
      if (url && typeof url === 'string') return url;
    } catch (err) {
      console.warn('[generate] Replicate image failed, trying fal.ai:', (err as Error).message);
    }
  }

  if (process.env.FAL_KEY) {
    const result = await fal.subscribe('fal-ai/flux/schnell', {
      input: { prompt, image_size: { width, height } },
    });
    const data = result.data as { images?: Array<{ url: string }> };
    const url = data?.images?.[0]?.url;
    if (url) return url;
  }

  throw new Error('No image generation API keys configured.');
}

// ─── Audio Transcription (Whisper) ──────────────────────────────────

export async function transcribeAudio(audioUrl: string): Promise<string> {
  if (process.env.REPLICATE_API_TOKEN) {
    const output = await replicate.run(
      'openai/whisper:latest' as `${string}/${string}`,
      { input: { audio: audioUrl, model: 'large-v3' } }
    );
    const data = output as { transcription?: string; text?: string };
    return data?.transcription || data?.text || '';
  }
  throw new Error('REPLICATE_API_TOKEN required for transcription.');
}
