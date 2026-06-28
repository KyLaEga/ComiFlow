package com.kylaega.comiflow;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean volumeKeysEnabled = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Register JS bridge interface to sync settings state
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setVolumeKeysEnabled(boolean enabled) {
                volumeKeysEnabled = enabled;
            }
        }, "ComiFlowBridge");
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
