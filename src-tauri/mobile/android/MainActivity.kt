// ComiFlow MainActivity (Android).
//
// Расширяет сгенерированный TauriActivity:
//  1. Клавиши громкости — перехватываются, когда включён режим листания
//     (строка volumeKeyMode в SharedPreferences: "off"|"single"|"auto", её
//     пишет ComiFlowBridge.setVolumeKeyMode). События уходят в WebView как
//     `nativeVolumeKey` CustomEvent — их слушает Reader.tsx (учитывает
//     repeatCount для автопропрутки при удержании).
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

    /**
     * Исключает боковые края экрана из системной жесты-навигации, пока
     * открыта читалка: свайпы листания страниц работают от самого края,
     * а не перехватываются системным жестом «назад».
     */
    fun setReaderGesturesActive(active: Boolean) {
        val decor = window?.decorView ?: return
        if (active) {
            val w = resources.displayMetrics.widthPixels
            val h = resources.displayMetrics.heightPixels
            val inset = (28 * resources.displayMetrics.density).toInt()
            decor.setSystemGestureExclusionRects(
                listOf(
                    android.graphics.Rect(0, 0, inset, h),      // левый край
                    android.graphics.Rect(w - inset, 0, w, h)   // правый край
                )
            )
        } else {
            decor.setSystemGestureExclusionRects(emptyList())
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode

        // ── Клавиши громкости → листание страниц ─────────────────────────
        // Режим ("off"|"single"|"auto") хранится в SharedPreferences,
        // его пишет ComiFlowBridge.setVolumeKeyMode. В WebView уходит:
        //  - ACTION_DOWN  → { key, repeat: repeatCount } (repeat>0 = удержание);
        //  - ACTION_UP    → { key, repeat: -1 } (отпускание → остановить автопропрутку).
        if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            val prefs = getSharedPreferences("ComiFlowPrefs", MODE_PRIVATE)
            val mode = prefs.getString("volumeKeyMode", "off") ?: "off"
            if (mode != "off") {
                val key = if (code == KeyEvent.KEYCODE_VOLUME_UP) "volume_up" else "volume_down"
                val repeat = if (event.action == KeyEvent.ACTION_DOWN) event.repeatCount else -1
                webView?.post {
                    webView?.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('nativeVolumeKey',{detail:{key:'$key',repeat:$repeat}}));",
                        null
                    )
                }
                return true // не даём системе менять громкость
            }
        }

        return super.dispatchKeyEvent(event)
    }
}
