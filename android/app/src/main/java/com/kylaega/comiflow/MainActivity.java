package com.kylaega.comiflow;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean volumeKeysEnabled = false;
    private String pendingFileUri = null;

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
