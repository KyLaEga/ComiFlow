/**
 * Resizes and compresses an image Blob to a maximum dimension using WebP
 * to minimize IndexedDB storage requirements and prevent user data bloat.
 */
export async function resizeCover(blob: Blob, maxDimension = 640): Promise<Blob> {
  // If the blob is extremely small already (e.g. < 80KB), just save it as is
  if (blob.size < 80 * 1024) {
    return blob;
  }

  const imageBlob = blob.type ? blob : new Blob([blob], { type: 'image/jpeg' });

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(imageBlob);
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      
      let { width, height } = img;
      if (width <= 0 || height <= 0) {
        resolve(blob); // fallback if dimensions are invalid
        return;
      }
      
      // Calculate new dimensions keeping aspect ratio
      if (width > height) {
        if (width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        }
      } else {
        if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(blob); // fallback
        return;
      }
      
      // Draw image onto canvas (downscaling with high quality smoothing)
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      
      // Convert to compressed WebP blob
      canvas.toBlob(
        (resizedBlob) => {
          if (resizedBlob && resizedBlob.size < blob.size) {
            resolve(resizedBlob);
          } else {
            resolve(blob); // fallback if compression made it larger
          }
        },
        'image/webp',
        0.80 // Quality
      );
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(blob); // fallback to original if image fails to load
    };
    
    img.src = url;
  });
}
