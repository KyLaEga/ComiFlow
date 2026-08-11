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

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback

// Файл, открытый «извне» через ACTION_VIEW (CBZ/PDF из файлового менеджера
// или другого приложения). Временный грант чтения действует, пока жив
// процесс — JS забирает URI через мост takePendingFile сразу после старта
// (get_pending_file_uri в lib.rs) и сбрасывает его. Топ-уровневый объект,
// чтобы мост читал его без ссылки на Activity-класс.
object PendingViewFile {
    @Volatile var uri: String? = null
    @Volatile var name: String? = null
}

class MainActivity : TauriActivity() {

    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Cold start: файл может прийти ещё до создания WebView — запоминаем.
        captureViewIntent(intent)

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

    // Warm start: приложение уже открыто, файл пришёл повторным интентом
    // (launchMode singleTask → onNewIntent, без пересоздания Activity).
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureViewIntent(intent)
    }

    /** Запомнить файл из ACTION_VIEW (CBZ/PDF) для JS-обработчика. */
    private fun captureViewIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        PendingViewFile.uri = uri.toString()
        PendingViewFile.name = queryDisplayName(uri)
        Log.i("ComiFlowView", "ACTION_VIEW captured: ${PendingViewFile.uri} name=${PendingViewFile.name}")
        // Тёплый старт: WebView уже загружен и init-эффект давно отработал —
        // сообщаем JS, что пришёл файл (холодный старт забирает его сам через
        // get_pending_file_uri при инициализации).
        webView?.post {
            webView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('comiflow:pendingFile'));",
                null
            )
        }
    }

    /** Имя файла из content:// (OpenableColumns.DISPLAY_NAME). */
    private fun queryDisplayName(uri: Uri): String? {
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        // Приложение полностью локальное (нет HTTP-контента) — HTTP-кэш
        // WebView бесполезен, но копит десятки МБ (старый Capacitor-SW
        // оставил после себя ~60 МБ). Чистим при каждом старте.
        webView.clearCache(true)
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
            // Диагностика: режим + событие пишутся в logcat, чтобы по жалобе
            // «листает, хотя выключено» было видно, что реально читает MainActivity.
            Log.i(
                "ComiFlowVol",
                "volume key ${event.action} mode=$mode repeat=${event.repeatCount}"
            )
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
