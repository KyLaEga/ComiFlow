// ComiFlow MainActivity (Android).
//
// Расширяет сгенерированный TauriActivity:
//  1. Клавиши громкости — перехватываются, когда включена настройка
//     «Листать кнопками громкости» (флаг volumeKeysEnabled хранится в
//     SharedPreferences, его пишет ComiFlowBridge.setVolumeKeysEnabled).
//     Событие уходит в WebView как `nativeVolumeKey` CustomEvent — его
//     слушает Reader.tsx.
//  2. Системная кнопка «назад» — уходит в WebView как `comiflow:backbutton`
//     (слушает App.tsx): закрывает читалку → настройки → режим выбора → выход.
//     Иначе в SPA-приложении «назад» сразу закрывает приложение.

package com.kylaega.comiflow

import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // Кнопка «назад» → React-обработчик (закрывает читалку → настройки →
        // режим выбора → выход). На Android 12+ back приходит через
        // OnBackPressedDispatcher, а не dispatchKeyEvent, поэтому перехват
        // делаем здесь. Без него в SPA «назад» сразу закрывает приложение.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = webView
                if (wv == null) {
                    // WebView ещё не создан — веб-обработчику некуда слать:
                    // отдаём нажатие системе (закрытие приложения).
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    return
                }
                wv.post {
                    wv.evaluateJavascript(
                        "window.dispatchEvent(new Event('comiflow:backbutton'));",
                        null
                    )
                }
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        super.onWebViewCreate(webView)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode

        // ── Клавиши громкости → листание страниц ─────────────────────────
        if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            val prefs = getSharedPreferences("ComiFlowPrefs", MODE_PRIVATE)
            if (prefs.getBoolean("volumeKeysEnabled", false)) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    val key = if (code == KeyEvent.KEYCODE_VOLUME_UP) "volume_up" else "volume_down"
                    webView?.post {
                        webView?.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('nativeVolumeKey',{detail:{key:'$key'}}));",
                            null
                        )
                    }
                }
                return true // не даём системе менять громкость
            }
        }

        return super.dispatchKeyEvent(event)
    }
}
