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
                startActivityForResult(intent, REQUEST_CODE_OPEN_DOCUMENT_TREE);
            }

            @JavascriptInterface
            public String getLibraryFolderUri() {
                SharedPreferences prefs = getSharedPreferences("ComiFlowPrefs", MODE_PRIVATE);
                return prefs.getString("libraryFolderUri", null);
            }

            @JavascriptInterface
            public String listLibraryFiles(String treeUriStr) {
                try {
                    Uri treeUri = Uri.parse(treeUriStr);
                    String docId = DocumentsContract.getTreeDocumentId(treeUri);
                    Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
                    
                    JSONArray filesArray = new JSONArray();
                    
                    String[] projection = new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_SIZE,
                        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                        DocumentsContract.Document.COLUMN_MIME_TYPE
                    };
                    
                    Cursor cursor = getContentResolver().query(childrenUri, projection, null, null, null);
                    if (cursor != null) {
                        while (cursor.moveToNext()) {
                            String mimeType = cursor.getString(4);
                            if (mimeType != null && mimeType.equals(DocumentsContract.Document.MIME_TYPE_DIR)) {
                                continue; // Skip directories
                            }
                            
                            String displayName = cursor.getString(1);
                            if (displayName == null) continue;
                            
                            String lowerName = displayName.toLowerCase();
                            if (!lowerName.endsWith(".cbz") && !lowerName.endsWith(".zip") && !lowerName.endsWith(".pdf")) {
                                continue; // Only include supported formats
                            }
                            
                            if (displayName.startsWith(".") || displayName.startsWith("._")) {
                                continue; // Skip dotfiles
                            }
                            
                            String childDocId = cursor.getString(0);
                            long size = cursor.getLong(2);
                            long lastModified = cursor.getLong(3);
                            Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocId);
                            
                            JSONObject fileObj = new JSONObject();
                            fileObj.put("name", displayName);
                            fileObj.put("uri", documentUri.toString());
                            fileObj.put("size", size);
                            fileObj.put("lastModified", lastModified);
                            filesArray.put(fileObj);
                        }
                        cursor.close();
                    }
                    return filesArray.toString();
                } catch (Exception e) {
                    e.printStackTrace();
                    return "[]";
                }
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
                            java.io.OutputStream os = getContentResolver().openOutputStream(newFile.getUri());
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
                    android.database.Cursor cursor = getContentResolver().query(uri, null, null, null, null);
                    if (cursor != null) {
                        int nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        if (nameIndex != -1 && cursor.moveToFirst()) {
                            fileName = cursor.getString(nameIndex);
                        }
                        cursor.close();
                    }
                    
                    // Clean filename to prevent traversal issues
                    fileName = fileName.replaceAll("[^a-zA-Z0-9._-]", "_");
                    
                    java.io.File tempFile = new java.io.File(getCacheDir(), "open_" + System.currentTimeMillis() + "_" + fileName);
                    java.io.InputStream is = getContentResolver().openInputStream(uri);
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
                    java.io.File cacheDir = getCacheDir();
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
