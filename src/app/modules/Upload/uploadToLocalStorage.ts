/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from '../../../config';

export interface LocalUploadResponse {
  Location: string;
  public_id: string;
}

const ASSETS_ROOT_DIR = path.join(process.cwd(), 'assets');

/**
 * Sanitize model/folder name to prevent directory traversal
 */
export const sanitizeModelName = (model?: string): string => {
  if (!model || typeof model !== 'string') {
    return 'general';
  }
  const sanitized = model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return sanitized || 'general';
};

/**
 * Resolves the base URL for constructing accessible public URLs
 */
const getBaseServerUrl = (customBaseUrl?: string): string => {
  if (customBaseUrl) return customBaseUrl.replace(/\/+$/, '');
  if (config.base_url_server) return config.base_url_server.replace(/\/+$/, '');
  return `http://localhost:${config.port || 5171}`;
};

/**
 * Upload a single file to local device storage under assets/<model>/
 */
export const uploadToLocalStorage = async (
  file: Express.Multer.File,
  modelName?: string,
  customBaseUrl?: string,
): Promise<LocalUploadResponse> => {
  try {
    if (!file || !file.buffer) {
      throw new Error('No file provided or empty file buffer');
    }

    const model = sanitizeModelName(modelName);
    const targetDir = path.join(ASSETS_ROOT_DIR, model);

    // Ensure the model directory exists
    await fs.promises.mkdir(targetDir, { recursive: true });

    // Generate safe unique filename
    const originalExt = path.extname(file.originalname || '') || '.bin';
    const baseName = path
      .basename(file.originalname || 'file', originalExt)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const filename = `${baseName}-${Date.now()}-${randomSuffix}${originalExt}`;

    const filePath = path.join(targetDir, filename);

    // Save buffer to local device storage
    await fs.promises.writeFile(filePath, file.buffer);

    const baseUrl = getBaseServerUrl(customBaseUrl);
    const publicUrl = `${baseUrl}/assets/${model}/${filename}`;
    const publicId = `${model}/${filename}`;

    return {
      Location: publicUrl,
      public_id: publicId,
    };
  } catch (error) {
    console.error('Error saving file to device storage:', error);
    throw error;
  }
};

/**
 * Upload multiple files to local device storage under assets/<model>/
 */
export const uploadMultipleToLocalStorage = async (
  files: Express.Multer.File[],
  modelName?: string,
  customBaseUrl?: string,
): Promise<LocalUploadResponse[]> => {
  if (!files || files.length === 0) {
    return [];
  }

  const results: LocalUploadResponse[] = [];
  for (const file of files) {
    const uploaded = await uploadToLocalStorage(file, modelName, customBaseUrl);
    results.push(uploaded);
  }

  return results;
};

/**
 * Safely delete a file from local storage given its URL or relative path
 */
export const deleteFromLocalStorage = async (
  fileUrlOrPath: string,
): Promise<boolean> => {
  try {
    if (!fileUrlOrPath || typeof fileUrlOrPath !== 'string') {
      return false;
    }

    // Extract relative path after /assets/
    let relativePath = fileUrlOrPath;
    if (fileUrlOrPath.includes('/assets/')) {
      relativePath = fileUrlOrPath.split('/assets/')[1];
    } else if (fileUrlOrPath.startsWith('assets/')) {
      relativePath = fileUrlOrPath.replace(/^assets\//, '');
    }

    // Strip any URL query parameters or hash
    relativePath = relativePath.split('?')[0].split('#')[0];

    // Normalize and resolve absolute target path
    const resolvedPath = path.resolve(ASSETS_ROOT_DIR, relativePath);

    // Path traversal check: resolved path must be inside ASSETS_ROOT_DIR
    const normalizedAssetsRoot = path.resolve(ASSETS_ROOT_DIR);
    if (!resolvedPath.startsWith(normalizedAssetsRoot)) {
      console.warn(
        `Attempted unsafe file deletion outside assets root: ${fileUrlOrPath}`,
      );
      return false;
    }

    if (fs.existsSync(resolvedPath)) {
      await fs.promises.unlink(resolvedPath);
      console.log(`Deleted device file: ${resolvedPath}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error deleting file from device storage:', error);
    return false;
  }
};

/**
 * Safely delete multiple files from local storage
 */
export const deleteMultipleFromLocalStorage = async (
  fileUrlsOrPaths: string[],
): Promise<boolean[]> => {
  if (!Array.isArray(fileUrlsOrPaths)) {
    return [];
  }

  const results = await Promise.all(
    fileUrlsOrPaths.map(urlOrPath => deleteFromLocalStorage(urlOrPath)),
  );
  return results;
};
