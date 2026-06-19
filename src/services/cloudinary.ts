import { v2 as cloudinary } from 'cloudinary';
import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export interface UploadResult {
  url: string;
  publicId: string;
  duration?: number;
  width?: number;
  height?: number;
  format: string;
  bytes: number;
}

// Upload from a remote URL (Replicate/fal.ai output)
export async function uploadFromUrl(
  url: string,
  folder = 'meraki-studio',
  resourceType: 'video' | 'image' | 'raw' = 'video'
): Promise<UploadResult> {
  const result = await cloudinary.uploader.upload(url, {
    resource_type: resourceType,
    folder,
    use_filename: true,
    unique_filename: true,
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    duration: result.duration,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
  };
}

// Upload from local file path
export async function uploadFromPath(
  filePath: string,
  folder = 'meraki-studio',
  resourceType: 'video' | 'image' | 'raw' = 'video'
): Promise<UploadResult> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: resourceType,
    folder,
    public_id: basename(filePath, `.${filePath.split('.').pop()}`),
    use_filename: true,
    unique_filename: true,
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    duration: result.duration,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
  };
}

// Generate a thumbnail from a video URL at a specific timestamp
export function generateThumbnailUrl(videoPublicId: string, timeOffset = 1): string {
  return cloudinary.url(videoPublicId, {
    resource_type: 'video',
    transformation: [
      { width: 320, height: 180, crop: 'fill', gravity: 'auto' },
      { quality: 'auto', format: 'jpg', start_offset: String(timeOffset) },
    ],
  });
}

export function isConfigured(): boolean {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}
