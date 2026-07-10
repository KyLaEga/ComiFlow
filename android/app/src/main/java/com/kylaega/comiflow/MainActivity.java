package com.kylaega.comiflow;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.database.Cursor;
import org.json.JSONArray;
import org.json.JSONObject;
import android.app.Activity;
import androidx.documentfile.provider.DocumentFile;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipEntry;
import java.util.Collections;
import java.util.ArrayList;
import java.util.Comparator;

public class MainActivity extends BridgeActivity {
    private boolean volumeKeysEnabled = false;
    private String pendingFileUri = null;
    private static final int REQUEST_CODE_OPEN_DOCUMENT_TREE = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Check if app was launched via file association intent
        Intent intent = getIntent();
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            android.net.Uri data = intent.getData();
            if (data != null) {
                pendingFileUri = data.toString();
            }
        }

        // Register JS bridge interface to sync settings and open intent files
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setVolumeKeysEnabled(boolean enabled) {
                volumeKeysEnabled = enabled;
            }

            @JavascriptInterface
            public String getPendingFileUri() {
                String uri = pendingFileUri;
                pendingFileUri = null; // Clear once read
                return uri;
            }

            @JavascriptInterface
            public void selectLibraryFolder() {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                MainActivity.this.startActivityForResult(intent, REQUEST_CODE_OPEN_DOCUMENT_TREE);
            }

            @JavascriptInterface
            public String getLibraryFolderUri() {
                SharedPreferences prefs = MainActivity.this.getSharedPreferences("ComiFlowPrefs", MODE_PRIVATE);
                return prefs.getString("libraryFolderUri", null);
            }

            private void traverseDirectorySaf(Uri treeUri, String docId, String currentPath, JSONArray filesArray) {
                try {
                    Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
                    String[] projection = new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_SIZE,
                        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                        DocumentsContract.Document.COLUMN_MIME_TYPE
                    };
                    Cursor cursor = MainActivity.this.getContentResolver().query(childrenUri, projection, null, null, null);
                    if (cursor != null) {
                        while (cursor.moveToNext()) {
                            String childDocId = cursor.getString(0);
                            String displayName = cursor.getString(1);
                            if (displayName == null || displayName.startsWith(".") || displayName.startsWith("._")) continue;
                            
                            String mimeType = cursor.getString(4);
                            if (mimeType != null && mimeType.equals(DocumentsContract.Document.MIME_TYPE_DIR)) {
                                String newPath = currentPath.isEmpty() ? displayName : currentPath + " / " + displayName;
                                traverseDirectorySaf(treeUri, childDocId, newPath, filesArray);
                                continue;
                            }
                            
                            String lowerName = displayName.toLowerCase();
                            if (!lowerName.endsWith(".cbz") && !lowerName.endsWith(".zip") && !lowerName.endsWith(".pdf")) {
                                continue;
                            }
                            
                            long size = cursor.getLong(2);
                            long lastModified = cursor.getLong(3);
                            Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocId);
                            
                            JSONObject fileObj = new JSONObject();
                            fileObj.put("name", displayName);
                            fileObj.put("uri", documentUri.toString());
                            fileObj.put("size", size);
                            fileObj.put("lastModified", lastModified);
                            fileObj.put("shelfName", currentPath); // Track folder path
                            filesArray.put(fileObj);
                        }
                        cursor.close();
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }

            @JavascriptInterface
            public String listLibraryFiles(String treeUriStr) {
                try {
                    Uri treeUri = Uri.parse(treeUriStr);
                    String docId = DocumentsContract.getTreeDocumentId(treeUri);
                    JSONArray filesArray = new JSONArray();
                    traverseDirectorySaf(treeUri, docId, "", filesArray);
                    return filesArray.toString();
                } catch (Exception e) {
                    e.printStackTrace();
                    return "[]";
                }
            }

            private final java.util.Map<String, java.io.File> activeImports = new java.util.HashMap<>();
            private final java.util.Map<String, String> importDestNames = new java.util.HashMap<>();
            private final java.util.Map<String, String> importFolderUris = new java.util.HashMap<>();

            @JavascriptInterface
            public String startChunkedImport(String fileName, long totalSize, String folderUriStr) {
                try {
                    String importId = "import_" + System.currentTimeMillis() + "_" + java.util.UUID.randomUUID().toString().substring(0, 8);
                    java.io.File tempFile = new java.io.File(MainActivity.this.getCacheDir(), "chunk_" + importId);
                    if (tempFile.createNewFile()) {
                        activeImports.put(importId, tempFile);
                        importDestNames.put(importId, fileName);
                        importFolderUris.put(importId, folderUriStr);
                        return importId;
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
                return null;
            }

            @JavascriptInterface
            public boolean appendChunk(String importId, String base64Data) {
                try {
                    java.io.File tempFile = activeImports.get(importId);
                    if (tempFile != null && tempFile.exists()) {
                        byte[] data = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
                        java.io.FileOutputStream fos = new java.io.FileOutputStream(tempFile, true);
                        fos.write(data);
                        fos.close();
                        return true;
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
                return false;
            }

            @JavascriptInterface
            public boolean finishChunkedImport(String importId) {
                try {
                    java.io.File tempFile = activeImports.remove(importId);
                    String destFileName = importDestNames.remove(importId);
                    String folderUriStr = importFolderUris.remove(importId);
                    
                    if (tempFile != null && tempFile.exists() && destFileName != null && folderUriStr != null) {
                        Uri folderUri = Uri.parse(folderUriStr);
                        DocumentFile folder = DocumentFile.fromTreeUri(MainActivity.this, folderUri);
                        if (folder != null) {
                            String mimeType = "application/octet-stream";
                            String lower = destFileName.toLowerCase();
                            if (lower.endsWith(".pdf")) mimeType = "application/pdf";
                            else if (lower.endsWith(".cbz") || lower.endsWith(".zip")) mimeType = "application/x-cbz";
                            
                            DocumentFile newFile = folder.createFile(mimeType, destFileName);
                            if (newFile != null) {
                                java.io.InputStream is = new java.io.FileInputStream(tempFile);
                                java.io.OutputStream os = MainActivity.this.getContentResolver().openOutputStream(newFile.getUri());
                                byte[] buffer = new byte[8192];
                                int read;
                                while ((read = is.read(buffer)) != -1) {
                                    os.write(buffer, 0, read);
                                }
                                is.close();
                                os.close();
                                tempFile.delete();
                                return true;
                            }
                        }
                        tempFile.delete();
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
                return false;
            }

            @JavascriptInterface
            public void cancelChunkedImport(String importId) {
                try {
                    java.io.File tempFile = activeImports.remove(importId);
                    importDestNames.remove(importId);
                    importFolderUris.remove(importId);
                    if (tempFile != null && tempFile.exists()) {
                        tempFile.delete();
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }

            private boolean isImageFile(String filename) {
                String lower = filename.toLowerCase();
                if (lower.startsWith(".") || lower.contains("__macosx") || lower.contains("thumbs.db") || lower.endsWith("/")) {
                    return false;
                }
                return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || 
                       lower.endsWith(".webp") || lower.endsWith(".gif") || lower.endsWith(".bmp") || lower.endsWith(".avif");
            }

            @JavascriptInterface
            public String getComicMetadataNative(String uriString) {
                JSONObject result = new JSONObject();
                try {
                    Uri uri = Uri.parse(uriString);
                    String fileName = "temp_comic";
                    Cursor cursor = MainActivity.this.getContentResolver().query(uri, null, null, null, null);
                    if (cursor != null) {
                        int nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        if (nameIndex != -1 && cursor.moveToFirst()) {
                            fileName = cursor.getString(nameIndex);
                        }
                        cursor.close();
                    }

                    String lowerName = fileName.toLowerCase();
                    if (lowerName.endsWith(".pdf")) {
                        // PDF Parsing
                        ParcelFileDescriptor pfd = MainActivity.this.getContentResolver().openFileDescriptor(uri, "r");
                        if (pfd == null) throw new Exception("Failed to open file descriptor");
                        PdfRenderer renderer = new PdfRenderer(pfd);
                        int pageCount = renderer.getPageCount();
                        
                        String coverBase64 = "";
                        if (pageCount > 0) {
                            PdfRenderer.Page page = renderer.openPage(0);
                            int width = page.getWidth();
                            int height = page.getHeight();
                            int maxDimension = 640;
                            if (width > height) {
                                if (width > maxDimension) {
                                    height = (int) (((double) height * maxDimension) / width);
                                    width = maxDimension;
                                }
                            } else {
                                if (height > maxDimension) {
                                    width = (int) (((double) width * maxDimension) / height);
                                    height = maxDimension;
                                }
                            }
                            
                            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            
                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, baos);
                            coverBase64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                            
                            bitmap.recycle();
                            page.close();
                        }
                        renderer.close();
                        pfd.close();

                        result.put("format", "pdf");
                        result.put("totalPages", pageCount);
                        result.put("coverBase64", coverBase64);
                    } else {
                        // CBZ/ZIP Parsing
                        ZipInputStream zis = new ZipInputStream(MainActivity.this.getContentResolver().openInputStream(uri));
                        ZipEntry ze;
                        ArrayList<String> pages = new ArrayList<>();
                        byte[] tempCoverBytes = null;
                        String firstImagePath = null;

                        while ((ze = zis.getNextEntry()) != null) {
                            String name = ze.getName();
                            if (!ze.isDirectory() && isImageFile(name)) {
                                pages.add(name);
                                if (firstImagePath == null || name.compareToIgnoreCase(firstImagePath) < 0) {
                                    firstImagePath = name;
                                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                    byte[] buffer = new byte[8192];
                                    int len;
                                    while ((len = zis.read(buffer)) != -1) {
                                        baos.write(buffer, 0, len);
                                    }
                                    tempCoverBytes = baos.toByteArray();
                                }
                            }
                            zis.closeEntry();
                        }
                        zis.close();

                        // Sort pages alphabetically
                        Collections.sort(pages, new Comparator<String>() {
                            @Override
                            public int compare(String s1, String s2) {
                                return s1.compareToIgnoreCase(s2);
                            }
                        });

                        String coverBase64 = "";
                        if (tempCoverBytes != null) {
                            BitmapFactory.Options options = new BitmapFactory.Options();
                            options.inJustDecodeBounds = true;
                            BitmapFactory.decodeByteArray(tempCoverBytes, 0, tempCoverBytes.length, options);
                            
                            int width = options.outWidth;
                            int height = options.outHeight;
                            int maxDimension = 640;
                            
                            int inSampleSize = 1;
                            if (width > maxDimension || height > maxDimension) {
                                final int halfHeight = height / 2;
                                final int halfWidth = width / 2;
                                while ((halfHeight / inSampleSize) >= maxDimension && (halfWidth / inSampleSize) >= maxDimension) {
                                    inSampleSize *= 2;
                                }
                            }
                            
                            options.inJustDecodeBounds = false;
                            options.inSampleSize = inSampleSize;
                            Bitmap bitmap = BitmapFactory.decodeByteArray(tempCoverBytes, 0, tempCoverBytes.length, options);
                            
                            if (bitmap != null) {
                                int targetWidth = bitmap.getWidth();
                                int targetHeight = bitmap.getHeight();
                                if (targetWidth > maxDimension || targetHeight > maxDimension) {
                                    if (targetWidth > targetHeight) {
                                        targetHeight = (int) (((double) targetHeight * maxDimension) / targetWidth);
                                        targetWidth = maxDimension;
                                    } else {
                                        targetWidth = (int) (((double) targetWidth * maxDimension) / targetHeight);
                                        targetHeight = maxDimension;
                                    }
                                    Bitmap scaledBitmap = Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true);
                                    if (scaledBitmap != bitmap) {
                                        bitmap.recycle();
                                        bitmap = scaledBitmap;
                                    }
                                }
                                
                                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                bitmap.compress(Bitmap.CompressFormat.JPEG, 80, baos);
                                coverBase64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                                bitmap.recycle();
                            }
                        }

                        JSONArray pagesArray = new JSONArray();
                        for (String page : pages) {
                            pagesArray.put(page);
                        }

                        result.put("format", "cbz");
                        result.put("pages", pagesArray);
                        result.put("coverBase64", coverBase64);
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                    try {
                        result.put("error", e.getMessage());
                    } catch (Exception ignored) {}
                }
                return result.toString();
            }

            @JavascriptInterface
            public boolean importFileToLibrary(String sourcePath, String destFileName, String folderUriStr) {
                try {
                    Uri folderUri = Uri.parse(folderUriStr);
                    DocumentFile folder = DocumentFile.fromTreeUri(MainActivity.this, folderUri);
                    if (folder != null) {
                        DocumentFile newFile = folder.createFile("application/zip", destFileName);
                        if (newFile != null) {
                            java.io.InputStream is = new java.io.FileInputStream(sourcePath);
                            java.io.OutputStream os = MainActivity.this.getContentResolver().openOutputStream(newFile.getUri());
                            byte[] buffer = new byte[8192];
                            int read;
                            while ((read = is.read(buffer)) != -1) {
                                os.write(buffer, 0, read);
                            }
                            is.close();
                            os.close();
                            return true;
                        }
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
                return false;
            }

            @JavascriptInterface
            public String copyContentUriToCache(String uriString) {
                try {
                    android.net.Uri uri = android.net.Uri.parse(uriString);
                    
                    // Resolve original display name using ContentResolver
                    String fileName = "temp_comic.cbz";
                    android.database.Cursor cursor = MainActivity.this.getContentResolver().query(uri, null, null, null, null);
                    if (cursor != null) {
                        int nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        if (nameIndex != -1 && cursor.moveToFirst()) {
                            fileName = cursor.getString(nameIndex);
                        }
                        cursor.close();
                    }
                    
                    // Clean filename to prevent traversal issues
                    fileName = fileName.replaceAll("[^a-zA-Z0-9._-]", "_");
                    
                    java.io.File tempFile = new java.io.File(MainActivity.this.getCacheDir(), "open_" + System.currentTimeMillis() + "_" + fileName);
                    java.io.InputStream is = MainActivity.this.getContentResolver().openInputStream(uri);
                    java.io.FileOutputStream os = new java.io.FileOutputStream(tempFile);
                    
                    byte[] buffer = new byte[8192];
                    int bytesRead;
                    while ((bytesRead = is.read(buffer)) != -1) {
                        os.write(buffer, 0, bytesRead);
                    }
                    
                    is.close();
                    os.close();
                    
                    return tempFile.getAbsolutePath();
                } catch (Exception e) {
                    e.printStackTrace();
                    return null;
                }
            }

            @JavascriptInterface
            public void clearImportCache() {
                try {
                    // Delete all "open_*" files in cache dir
                    java.io.File cacheDir = MainActivity.this.getCacheDir();
                    if (cacheDir != null && cacheDir.isDirectory()) {
                        java.io.File[] files = cacheDir.listFiles();
                        if (files != null) {
                            for (java.io.File file : files) {
                                if (file.getName().startsWith("open_") && file.isFile()) {
                                    file.delete();
                                }
                            }
                        }
                        
                        // Also delete Capacitor file_picker cache
                        java.io.File filePickerDir = new java.io.File(cacheDir, "file_picker");
                        if (filePickerDir.exists() && filePickerDir.isDirectory()) {
                            java.io.File[] pickerFiles = filePickerDir.listFiles();
                            if (pickerFiles != null) {
                                for (java.io.File file : pickerFiles) {
                                    if (file.isFile()) {
                                        file.delete();
                                    }
                                }
                            }
                        }
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }, "ComiFlowBridge");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            android.net.Uri data = intent.getData();
            if (data != null) {
                sendUriToWebView(data.toString());
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CODE_OPEN_DOCUMENT_TREE && resultCode == Activity.RESULT_OK) {
            if (data != null && data.getData() != null) {
                Uri uri = data.getData();
                
                // Take persistable permission
                final int takeFlags = data.getFlags()
                        & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                getContentResolver().takePersistableUriPermission(uri, takeFlags);
                
                // Save URI
                SharedPreferences prefs = getSharedPreferences("ComiFlowPrefs", MODE_PRIVATE);
                prefs.edit().putString("libraryFolderUri", uri.toString()).apply();
                
                // Notify JS
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('libraryFolderSelected', { detail: { uri: '" + uri.toString() + "' } }));",
                        null
                    );
                }
            }
        }
    }

    private void sendUriToWebView(final String uri) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('nativeOpenFile', { detail: { uri: '" + uri + "' } }));",
                        null
                    );
                }
            }
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Intercept volume buttons to prevent system HUD and turn pages only if enabled
        if (volumeKeysEnabled) {
            if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
                triggerVolumeEvent("volume_down");
                return true; // Consume event to prevent system volume display
            } else if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
                triggerVolumeEvent("volume_up");
                return true; // Consume event to prevent system volume display
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    private void triggerVolumeEvent(final String button) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                // Dispatch event to the web app
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('nativeVolumeKey', { detail: { key: '" + button + "' } }));",
                        null
                    );
                }
            }
        });
    }
}
