import * as pdfjsLib from 'pdfjs-dist';

// Point the worker to the locally copied asset for offline support in PWA
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// Cache to store the currently active PDF document instance
let cachedPdfId: string | null = null;
let cachedPdfDoc: pdfjsLib.PDFDocumentProxy | null = null;

/**
 * Loads and caches the PDF document instance in memory
 */
export async function getPdfDocument(id: string, fileBlob: Blob): Promise<pdfjsLib.PDFDocumentProxy> {
  if (cachedPdfId === id && cachedPdfDoc) {
    return cachedPdfDoc;
  }

  // Clear old cache
  cachedPdfId = null;
  cachedPdfDoc = null;

  const arrayBuffer = await fileBlob.arrayBuffer();
  // Using PDFJS to load document
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  cachedPdfId = id;
  cachedPdfDoc = pdf;
  return pdf;
}

/**
 * Clears current PDF document instance cache when closing reader
 */
export function clearPDFCache() {
  cachedPdfId = null;
  cachedPdfDoc = null;
}

export interface ParsedPDF {
  title: string;
  totalPages: number;
  coverBlob: Blob;
}

/**
 * Parses a PDF file to extract title, total pages, and renders page 1 as cover
 */
export async function parsePDF(file: File | Blob, originalName: string): Promise<ParsedPDF> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  if (pdf.numPages === 0) {
    throw new Error('В PDF документе нет страниц.');
  }

  // Extract cover page (page 1)
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.5 });
  
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) {
    throw new Error('Не удалось создать 2D контекст для отрисовки обложки PDF');
  }

  await page.render({
    canvasContext,
    viewport,
    canvas,
  }).promise;

  const coverBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Не удалось преобразовать обложку PDF в Blob'));
        }
      },
      'image/jpeg',
      0.85
    );
  });

  const title = originalName.replace(/\.[^/.]+$/, "");

  return {
    title,
    totalPages: pdf.numPages,
    coverBlob,
  };
}

/**
 * Renders a specific page of a PDF document onto a canvas and returns it as a JPEG Blob
 */
export async function getPdfPageBlob(
  id: string,
  fileBlob: Blob,
  pageNumber: number
): Promise<Blob> {
  const pdf = await getPdfDocument(id, fileBlob);
  const page = await pdf.getPage(pageNumber);
  
  // Use scale = 2.0 to ensure text inside PDFs stays extremely sharp and crisp
  const viewport = page.getViewport({ scale: 2.0 });
  
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) {
    throw new Error('Не удалось создать 2D контекст для отрисовки страницы PDF');
  }

  await page.render({
    canvasContext,
    viewport,
    canvas,
  }).promise;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error(`Не удалось экспортировать страницу PDF #${pageNumber} в Blob`));
        }
      },
      'image/jpeg',
      0.9
    );
  });
}
