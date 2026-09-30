import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getTempDir } from '../projects.js';

// ─── Narration (ElevenLabs Text-to-Speech) ───────────────────────────
// Uses Adam's Professional Voice Clone ("Adam Meraki Voice") by default,
// so any project script can be narrated in his own voice without a
// manual recording pass. Falls back to a caller-supplied voiceId for
// other cloned or premade voices (e.g. narrating as a different speaker).

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface NarrationInput {
  text: string;
  voiceId?: string;
  modelId?: string;
}

export interface NarrationResult {
  localPath: string;
  voiceId: string;
  modelId: string;
  bytes: number;
}

export function isConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

export function defaultVoiceId(): string | undefined {
  return process.env.ELEVENLABS_DEFAULT_VOICE_ID;
}

// Generates narration audio and writes it to a local temp file. The
// caller (tools.ts) is responsible for uploading it to Cloudinary, same
// pattern as generated video/image assets.
export async function generateNarration(input: NarrationInput): Promise<NarrationResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not configured. Set it in Railway env vars to enable narration.');
  }

  const voiceId = input.voiceId || defaultVoiceId();
  if (!voiceId) {
    throw new Error(
      'No voiceId provided and ELEVENLABS_DEFAULT_VOICE_ID is not set. ' +
      'Pass a voiceId explicitly, or set ELEVENLABS_DEFAULT_VOICE_ID in Railway env vars.'
    );
  }

  const modelId = input.modelId || 'eleven_multilingual_v2';

  const response = await fetch(`${ELEVENLABS_API_URL}/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: input.text,
      model_id: modelId,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs narration request failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const tempDir = getTempDir();
  await mkdir(tempDir, { recursive: true });
  const localPath = join(tempDir, `narration-${Date.now()}.mp3`);
  await writeFile(localPath, buffer);

  return { localPath, voiceId, modelId, bytes: buffer.byteLength };
}
