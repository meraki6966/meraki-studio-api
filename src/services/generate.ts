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

// Replicate output can be a URL string, an array of strings, or a FileOutput
// object exposing a .url() method (newer client versions). Normalize all shapes.
function extractUrl(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return extractUrl(output[0]);
  if (typeof output === 'object') {
    const o = output as { url?: unknown; href?: string };
    if (typeof o.url === 'function') {
      try {
        const u = (o.url as () => unknown)();
        return typeof u === 'string' ? u : ((u as { href?: string })?.href ?? null);
      } catch {
        return null;
      }
    }
    if (typeof o.url === 'string') return o.url;
    if (typeof o.href === 'string') return o.href;
  }
  return null;
}

// ─── Video Generation ───────────────────────────────────────────────
// Wan 2.1 text-to-video on both providers (Kling access is restricted).
// Primary: Replicate (wavespeedai/wan-2.1-t2v-480p). Fallback: fal.ai (fal-ai/wan-t2v).

export async function generateVideo(input: GenerationInput): Promise<GenerationResult> {
  const aspectRatio = input.aspectRatio ?? '16:9';
  // fal.ai Wan only accepts 9:16 or 16:9; map anything else to 16:9.
  const falAspect = aspectRatio === '9:16' ? '9:16' : '16:9';

  // Primary: Replicate Wan 2.1 (text-to-video, 480p)
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      console.log('[generate] Trying Replicate Wan 2.1 t2v...');
      const output = await replicate.run(
        'wavespeedai/wan-2.1-t2v-480p' as `${string}/${string}`,
        { input: { prompt: input.prompt, aspect_ratio: aspectRatio } }
      );
      const url = extractUrl(output);
      if (url) return { url, provider: 'replicate', duration: input.duration ?? 5 };
      console.warn('[generate] Replicate Wan returned no URL, falling back to fal.ai');
    } catch (err) {
      console.warn('[generate] Replicate Wan failed, falling back to fal.ai:', (err as Error).message);
    }
  }

  // Fallback: fal.ai Wan 2.1 (text-to-video)
  if (process.env.FAL_KEY) {
    try {
      console.log('[generate] Trying fal.ai Wan 2.1 t2v...');
      const result = await fal.subscribe('fal-ai/wan-t2v', {
        input: {
          prompt: input.prompt,
          resolution: '480p',
          aspect_ratio: falAspect,
        },
        pollInterval: 3000,
        timeout: 240000,
      });
      const data = result.data as { video?: { url: string }; url?: string };
      const url = data?.video?.url || data?.url;
      if (url) return { url, provider: 'fal', duration: input.duration ?? 5 };
      throw new Error('fal.ai Wan returned no video URL');
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
      const url = extractUrl(output);
      if (url) return url;
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
