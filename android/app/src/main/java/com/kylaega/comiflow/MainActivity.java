package com.kylaega.comiflow;

import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Intercept volume buttons to prevent system HUD and turn pages
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            triggerVolumeEvent("volume_down");
            return true; // Consume event to prevent system volume display
        } else if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            triggerVolumeEvent("volume_up");
            return true; // Consume event to prevent system volume display
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
