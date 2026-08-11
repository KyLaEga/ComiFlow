// ComiFlow Android bridge plugin.
//
// Port of the old Capacitor MainActivity.java JavaScript interface to the
// Tauri plugin model. Exposes SAF (Storage Access Framework) file operations
// to the Rust commands in src-tauri/src/lib.rs, which call these methods via
// `run_mobile_plugin`.
//
// Methods are invoked one-by-one by name; each receives an `Invoke`, parses
// its args, does the work on the Activity thread, and resolves with a JSObject
// (or a JSON string) that the Rust side deserializes.

package com.kylaega.comiflow

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.Logger
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject

private const val REQUEST_OPEN_DOCUMENT_TREE = 1001
private const val PREFS_NAME = "ComiFlowPrefs"
private const val PREF_FOLDER_URI = "libraryFolderUri"

@InvokeArg
class FolderArgs {
    var folderUri: String? = null
}

@InvokeArg
class DeleteArgs {
    var uri: String? = null
}

@InvokeArg
class ImportArgs {
    var sourcePath: String? = null
    var destFileName: String? = null
    var folderUri: String? = null
}

@InvokeArg
class ChunkedImportStartArgs {
    var fileName: String? = null
    var totalSize: Long = 0
    var folderUri: String? = null
}

@InvokeArg
class AppendChunkArgs {
    var importId: String? = null
    var base64Data: String? = null
}

@InvokeArg
class SingleIdArgs {
    var importId: String? = null
}

@InvokeArg
class UriArgs {
    var uri: String? = null
}

@InvokeArg
class PageArgs {
    var uri: String? = null
    var pageName: String? = null
}

@InvokeArg
class CoverArgs {
    var uri: String? = null
    var format: String? = null
}

@InvokeArg
class VolumeKeyModeArgs {
    var mode: String? = null // "off" | "single" | "auto"
}

@InvokeArg
class ReaderActiveArgs {
    var active: Boolean = false
}

@TauriPlugin
class ComiFlowBridge(private val activity: Activity) : Plugin(activity) {

    // ── Pending activity-result holders ───────────────────────────────────
    private var pendingFolderInvoke: Invoke? = null

    // ── Chunked import bookkeeping (keyed by importId) ────────────────────
    private val activeImports = HashMap<String, File>()
    private val importDestNames = HashMap<String, String>()
    private val importFolderUris = HashMap<String, String>()

    // ── Читательский кэш (одна открытая книга) ────────────────────────────
    // Удерживает открытый дескриптор активного комикса (ZipFile для CBZ или
    // PdfRenderer для PDF), чтобы перелистывание не переоткрывало файл на
    // каждой странице (на средних устройствах открытие CBZ с тысячами записей
    // занимает сотни миллисекунд — это и был «тормоз» листания). Закрывается
    // при смене файла и по команде releaseReaderFile (вызывается при закрытии
    // читалки).
    private var readerCacheKey: String? = null
    private var readerZip: ZipFile? = null
    private var readerPfd: ParcelFileDescriptor? = null
    private var readerPdf: PdfRenderer? = null

    private fun closeReaderCache() {
        // Порядок важен: PdfRenderer владеет своим дескриптором, PFD закрываем
        // последним (ZipFile работает через /proc/self/fd и свой FD не держит).
        runCatching { readerPdf?.close() }
        runCatching { readerZip?.close() }
        runCatching { readerPfd?.close() }
        readerZip = null
        readerPfd = null
        readerPdf = null
        readerCacheKey = null
    }

    /** Открытый ZipFile для CBZ (кэшируется по URI книги). */
    private fun openReaderZip(uri: Uri): ZipFile? {
        val key = uri.toString()
        if (key == readerCacheKey && readerZip != null) return readerZip
        closeReaderCache()
        val pfd = activity.contentResolver.openFileDescriptor(uri, "r") ?: return null
        val zf = ZipFile(File("/proc/self/fd/${pfd.fd}"))
        readerCacheKey = key
        readerPfd = pfd
        readerZip = zf
        return zf
    }

    /** Открытый PdfRenderer для PDF (кэшируется по URI книги). */
    private fun openReaderPdf(uri: Uri): PdfRenderer? {
        val key = uri.toString()
        if (key == readerCacheKey && readerPdf != null) return readerPdf
        closeReaderCache()
        val pfd = activity.contentResolver.openFileDescriptor(uri, "r") ?: return null
        val renderer = PdfRenderer(pfd)
        readerCacheKey = key
        readerPfd = pfd
        readerPdf = renderer
        return renderer
    }

    // ════════════════════════════════════════════════════════════════════
    // Folder selection (ACTION_OPEN_DOCUMENT_TREE)
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun selectLibraryFolder(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                )
            }
            // Remember the invoke so the activity callback can resolve it.
            pendingFolderInvoke = invoke
            Logger.info("[ComiFlow] selectLibraryFolder: starting picker")
            startActivityForResult(invoke, intent, "onFolderPicked")
        } catch (ex: Exception) {
            val msg = ex.message ?: "Failed to open folder picker"
            Logger.error(msg)
            invoke.reject(msg)
        }
    }

    @ActivityCallback
    fun onFolderPicked(invoke: Invoke, result: ActivityResult) {
        try {
            Logger.info("[ComiFlow] onFolderPicked: resultCode=" + result.resultCode)
            if (result.resultCode != Activity.RESULT_OK) {
                invoke.reject("cancelled")
                return
            }
            val treeUri: Uri = result.data?.data ?: run {
                Logger.error("[ComiFlow] onFolderPicked: no uri in data")
                invoke.reject("no uri")
                return
            }
            Logger.info("[ComiFlow] onFolderPicked: uri=" + treeUri)

            // Persist the URI permission so we keep access across app restarts.
            val takeFlags = (result.data?.flags ?: 0) and
                (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            runCatching {
                activity.contentResolver.takePersistableUriPermission(treeUri, takeFlags)
            }

            // Save into shared preferences (replaces the old SharedPreferences write).
            activity.getSharedPreferences(PREFS_NAME, Activity.MODE_PRIVATE)
                .edit().putString(PREF_FOLDER_URI, treeUri.toString()).apply()

            val ret = JSObject()
            ret.put("uri", treeUri.toString())
            invoke.resolve(ret)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "folder pick failed")
        } finally {
            pendingFolderInvoke = null
        }
    }

    /**
     * Задаёт режим листания кнопками громкости (читает MainActivity):
     *  - "off"    — клавиши громкости не перехватываются (системная громкость);
     *  - "single" — одна страница на одно нажатие (удержание не листает);
     *  - "auto"   — при удержании страницы листаются непрерывно (скорость — на JS).
     */
    @Command
    fun setVolumeKeyMode(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(VolumeKeyModeArgs::class.java)
            val mode = args.mode ?: "off"
            activity.getSharedPreferences(PREFS_NAME, Activity.MODE_PRIVATE)
                .edit().putString("volumeKeyMode", mode).apply()
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "volume key mode failed")
        }
    }

    /**
     * Включает/выключает «читательские» жесты: когда читалка открыта,
     * боковые края экрана исключаются из системной жесты-навигации
     * (свайп от края = «назад»), чтобы свайпы листания страниц работали
     * от самого края. Выход — кнопка «Назад» в HUD или аппаратная клавиша.
     */
    @Command
    fun setReaderActive(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ReaderActiveArgs::class.java)
            (activity as? MainActivity)?.setReaderGesturesActive(args.active)
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "set reader active failed")
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Library listing — recursive SAF traversal
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun listLibraryFiles(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(FolderArgs::class.java)
            val treeUri = Uri.parse(args.folderUri)
            val docId = DocumentsContract.getTreeDocumentId(treeUri)
            val filesArray = JSONArray()
            traverseSaf(treeUri, docId, "", filesArray)
            val ret = JSObject()
            ret.put("files", filesArray.toString())
            invoke.resolve(ret)
        } catch (ex: Exception) {
            Logger.error(ex.message ?: "list failed")
            val ret = JSObject()
            ret.put("files", "[]")
            invoke.resolve(ret)
        }
    }

    private fun traverseSaf(treeUri: Uri, docId: String, currentPath: String, out: JSONArray) {
        try {
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            )
            val cursor = activity.contentResolver.query(childrenUri, projection, null, null, null)
                ?: return
            cursor.use { c ->
                while (c.moveToNext()) {
                    val childDocId = c.getString(0)
                    val displayName = c.getString(1)
                    if (displayName == null || displayName.startsWith(".") || displayName.startsWith("._")) continue

                    val mimeType = c.getString(4)
                    if (mimeType != null && mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
                        val newPath = if (currentPath.isEmpty()) displayName else "$currentPath / $displayName"
                        traverseSaf(treeUri, childDocId, newPath, out)
                        continue
                    }

                    val lower = displayName.lowercase()
                    // Только .cbz/.pdf — совпадает с desktop-фильтром (Rust
                    // file_metadata). Обычные .zip на десктопе не попадают
                    // в библиотеку, чтобы не захламлять её архивами не-комиксов.
                    if (!lower.endsWith(".cbz") && !lower.endsWith(".pdf")) continue

                    val size = c.getLong(2)
                    val lastModified = c.getLong(3)
                    val documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocId)

                    val obj = JSONObject()
                    obj.put("name", displayName)
                    obj.put("uri", documentUri.toString())
                    obj.put("size", size)
                    obj.put("lastModified", lastModified)
                    obj.put("shelfName", currentPath)
                    out.put(obj)
                }
            }
        } catch (ex: Exception) {
            ex.printStackTrace()
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Metadata extraction (PDF / CBZ) with cover
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun getComicMetadataNative(invoke: Invoke) {
        val result = JSONObject()
        try {
            val args = invoke.parseArgs(UriArgs::class.java)
            val uri = Uri.parse(args.uri ?: "")

            var fileName = "temp_comic"
            activity.contentResolver.query(uri, null, null, null, null)?.use { c ->
                val nameIndex = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex != -1 && c.moveToFirst()) fileName = c.getString(nameIndex)
            }

            val lowerName = fileName.lowercase()
            if (lowerName.endsWith(".pdf")) {
                parsePdf(uri, result)
            } else {
                parseCbz(uri, result)
            }
        } catch (ex: Exception) {
            ex.printStackTrace()
            runCatching { result.put("error", ex.message) }
        }
        val ret = JSObject()
        ret.put("metadata", result.toString())
        invoke.resolve(ret)
    }

    private fun parsePdf(uri: Uri, result: JSONObject) {
        val pfd: ParcelFileDescriptor = activity.contentResolver.openFileDescriptor(uri, "r")
            ?: throw Exception("Failed to open file descriptor")
        pfd.use { descriptor ->
            PdfRenderer(descriptor).use { renderer ->
                val pageCount = renderer.pageCount
                var coverBase64 = ""
                if (pageCount > 0) {
                    renderer.openPage(0).use { page ->
                        var width = page.width
                        var height = page.height
                        val maxDim = 480
                        if (width > height) {
                            if (width > maxDim) {
                                height = (height.toDouble() * maxDim / width).toInt()
                                width = maxDim
                            }
                        } else {
                            if (height > maxDim) {
                                width = (width.toDouble() * maxDim / height).toInt()
                                height = maxDim
                            }
                        }
                        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        val baos = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.JPEG, 80, baos)
                        coverBase64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
                        bmp.recycle()
                    }
                }
                result.put("format", "pdf")
                result.put("totalPages", pageCount)
                result.put("coverBase64", coverBase64)

                // Страницы ["1".."N"] + пропорции (w/h) — webtoon-лента
                // резервирует реальную высоту и не «прыгает» при загрузке.
                val pagesArray = JSONArray()
                val ratiosArray = JSONArray()
                for (i in 0 until pageCount) {
                    pagesArray.put((i + 1).toString())
                    runCatching {
                        renderer.openPage(i).use { pg ->
                            ratiosArray.put(pg.width.toFloat() / pg.height.toFloat())
                        }
                    }.getOrElse { ratiosArray.put(JSONObject.NULL) }
                }
                result.put("pages", pagesArray)
                result.put("aspectRatios", ratiosArray)
            }
        }
    }

    private fun parseCbz(uri: Uri, result: JSONObject) {
        // Пары (имя страницы, пропорция w/h) — сортируем вместе, чтобы
        // aspectRatios соответствовал pages после natural-сортировки.
        val pageEntries = ArrayList<Pair<String, Float?>>()
        var coverBytes: ByteArray? = null
        var parsed = false

        // Pass 0: try random-access via /proc/self/fd (much faster when available).
        // NOTE: on Android 15+ (SELinux) readlink(/proc/self/fd/N) is forbidden
        // for untrusted apps, so ZipFile(fdFile) fails here and we fall through
        // to the streaming pass below. That is expected and fine.
        runCatching {
            val pfd = activity.contentResolver.openFileDescriptor(uri, "r") ?: return@runCatching
            pfd.use { descriptor ->
                val fdFile = File("/proc/self/fd/${descriptor.fd}")
                ZipFile(fdFile).use { zf ->
                    val entries = zf.entries()
                    var firstImage: String? = null
                    while (entries.hasMoreElements()) {
                        val ze = entries.nextElement() as ZipEntry
                        val name = ze.getName() ?: continue
                        if (!ze.isDirectory() && isImageFile(name)) {
                            val ratio = runCatching {
                                zf.getInputStream(ze).use { input ->
                                    val header = ByteArray(8192)
                                    val n = input.read(header)
                                    parseImageDimension(header, n)
                                }
                            }.getOrNull()
                            pageEntries.add(name to ratio)
                            val current = firstImage
                            if (current == null || naturalCompare(name, current) < 0) {
                                firstImage = name
                            }
                        }
                    }
                    if (firstImage != null) {
                        zf.getEntry(firstImage)?.let { entry ->
                            zf.getInputStream(entry).use { input ->
                                val baos = ByteArrayOutputStream()
                                val buf = ByteArray(8192)
                                var n = input.read(buf)
                                while (n != -1) { baos.write(buf, 0, n); n = input.read(buf) }
                                coverBytes = baos.toByteArray()
                            }
                        }
                    }
                    parsed = true
                }
            }
        }.onFailure { ex ->
            Logger.error("parseCbz Pass0 failed: ${ex.message}")
        }

        // Fallback: streaming double-pass
        if (!parsed) {
            pageEntries.clear()
            coverBytes = null
            var targetCover: String? = null
            try {
                val input = activity.contentResolver.openInputStream(uri)
                if (input == null) {
                    Logger.error("parseCbz Pass2: openInputStream returned null")
                } else {
                    java.io.BufferedInputStream(input, 65536).use { buffered ->
                        ZipInputStream(buffered).use { zis ->
                            var ze = zis.nextEntry
                            while (ze != null) {
                                val name = ze.getName() ?: ""
                                if (!ze.isDirectory() && isImageFile(name)) {
                                    // Читаем только заголовок записи для пропорций;
                                    // closeEntry ниже дочитает остаток.
                                    val header = ByteArray(8192)
                                    var n = 0
                                    while (n < header.size) {
                                        val r = zis.read(header, n, header.size - n)
                                        if (r == -1) break
                                        n += r
                                    }
                                    pageEntries.add(name to parseImageDimension(header, n))
                                    val current = targetCover
                                    if (current == null || naturalCompare(name, current) < 0) targetCover = name
                                }
                                zis.closeEntry()
                                ze = zis.nextEntry
                            }
                        }
                    }
                }
            } catch (ex: Exception) {
                Logger.error("parseCbz Pass2 failed: ${ex.message}")
            }

            if (targetCover != null) {
                runCatching {
                    val input = activity.contentResolver.openInputStream(uri)
                    if (input != null) {
                        java.io.BufferedInputStream(input, 65536).use { buffered ->
                            ZipInputStream(buffered).use { zis ->
                                var ze = zis.nextEntry
                                while (ze != null) {
                                    if (ze.getName() == targetCover) {
                                        val baos = ByteArrayOutputStream()
                                        val buf = ByteArray(8192)
                                        var n = zis.read(buf)
                                        while (n != -1) { baos.write(buf, 0, n); n = zis.read(buf) }
                                        coverBytes = baos.toByteArray()
                                        zis.closeEntry()
                                        break
                                    }
                                    zis.closeEntry()
                                    ze = zis.nextEntry
                                }
                            }
                        }
                    }
                }.onFailure { ex ->
                    Logger.error("parseCbz cover pass failed: ${ex.message}")
                }
            }
        }

        pageEntries.sortWith(Comparator { a, b -> naturalCompare(a.first, b.first) })
        val pages = ArrayList(pageEntries.map { it.first })
        val ratios = pageEntries.map { it.second }

        var coverBase64 = ""
        coverBytes?.let { bytes ->
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            var width = opts.outWidth
            var height = opts.outHeight
            val maxDim = 480
            var sample = 1
            if (width > maxDim || height > maxDim) {
                val halfH = height / 2
                val halfW = width / 2
                while (halfH / sample >= maxDim && halfW / sample >= maxDim) sample *= 2
            }
            opts.inJustDecodeBounds = false
            opts.inSampleSize = sample
            var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (bmp != null) {
                var tw = bmp.width
                var th = bmp.height
                if (tw > maxDim || th > maxDim) {
                    if (tw > th) {
                        th = (th.toDouble() * maxDim / tw).toInt(); tw = maxDim
                    } else {
                        tw = (tw.toDouble() * maxDim / th).toInt(); th = maxDim
                    }
                    val scaled = Bitmap.createScaledBitmap(bmp, tw, th, true)
                    if (scaled !== bmp) { bmp.recycle(); bmp = scaled }
                }
                val baos = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, baos)
                coverBase64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
                bmp.recycle()
            }
        }

        val pagesArray = JSONArray()
        for (p in pages) pagesArray.put(p)
        val ratiosArray = JSONArray()
        for (r in ratios) ratiosArray.put(r ?: JSONObject.NULL)
        result.put("format", "cbz")
        result.put("pages", pagesArray)
        result.put("aspectRatios", ratiosArray)
        result.put("coverBase64", coverBase64)
    }

    /**
     * Пропорция (ширина/высота) изображения по первым байтам заголовка.
     * Поддерживает PNG и JPEG; для остальных форматов — null (webtoon-лента
     * использует запасной placeholder, лента не «прыгает» при загрузке).
     */
    private fun parseImageDimension(header: ByteArray, len: Int): Float? {
        if (len < 4) return null
        // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR (ширина/высота на смещении 16/20)
        if (len >= 24 &&
            header[0] == 0x89.toByte() && header[1] == 0x50.toByte() &&
            header[2] == 0x4E.toByte() && header[3] == 0x47.toByte()
        ) {
            val w = ((header[16].toInt() and 0xFF) shl 24) or ((header[17].toInt() and 0xFF) shl 16) or
                ((header[18].toInt() and 0xFF) shl 8) or (header[19].toInt() and 0xFF)
            val h = ((header[20].toInt() and 0xFF) shl 24) or ((header[21].toInt() and 0xFF) shl 16) or
                ((header[22].toInt() and 0xFF) shl 8) or (header[23].toInt() and 0xFF)
            if (w > 0 && h > 0) return w.toFloat() / h.toFloat()
        }
        // JPEG: FF D8 ... ищем маркер SOF (C0-CF, кроме C4/C8/CC) — высота/ширина
        if (header[0] == 0xFF.toByte() && header[1] == 0xD8.toByte()) {
            var i = 2
            while (i + 9 < len) {
                if (header[i].toInt() and 0xFF != 0xFF) {
                    i++
                    continue
                }
                val marker = header[i + 1].toInt() and 0xFF
                val isSof = marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
                if (isSof) {
                    val h = ((header[i + 5].toInt() and 0xFF) shl 8) or (header[i + 6].toInt() and 0xFF)
                    val w = ((header[i + 7].toInt() and 0xFF) shl 8) or (header[i + 8].toInt() and 0xFF)
                    if (w > 0 && h > 0) return w.toFloat() / h.toFloat()
                }
                val segLen = ((header[i + 2].toInt() and 0xFF) shl 8) or (header[i + 3].toInt() and 0xFF)
                if (segLen < 2) return null
                i += 2 + segLen
            }
        }
        return null
    }

    private fun isImageFile(filename: String): Boolean {
        val lower = filename.lowercase()
        if (lower.startsWith(".") || lower.contains("__macosx") ||
            lower.contains("thumbs.db") || lower.endsWith("/")) return false
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") ||
            lower.endsWith(".webp") || lower.endsWith(".gif") || lower.endsWith(".bmp") ||
            lower.endsWith(".avif")
    }

    // ── Natural (human) sort: "page2.jpg" < "page10.jpg" ──────────────────
    // На десктопе порядок страниц даёт Rust (core_base::natural_cmp); здесь
    // повторяем ту же логику, чтобы порядок не зависел от платформы.
    private val naturalComparator = Comparator<String> { a, b -> naturalCompare(a, b) }

    private fun naturalCompare(a: String, b: String): Int {
        val partsA = splitNatural(a)
        val partsB = splitNatural(b)
        var i = 0
        while (i < partsA.size && i < partsB.size) {
            val x = partsA[i]
            val y = partsB[i]
            val cmp = if (x[0].isDigit() && y[0].isDigit()) {
                // Числовые куски сравниваем по значению, а не по строкам.
                val xn = x.trimStart('0').toLongOrNull()
                val yn = y.trimStart('0').toLongOrNull()
                when {
                    xn != null && yn != null -> xn.compareTo(yn)
                    xn != null -> -1
                    yn != null -> 1
                    else -> x.compareTo(y, ignoreCase = true)
                }
            } else {
                x.compareTo(y, ignoreCase = true)
            }
            if (cmp != 0) return cmp
            i++
        }
        return a.length.compareTo(b.length)
    }

    private fun splitNatural(s: String): List<String> {
        val parts = ArrayList<String>()
        var i = 0
        while (i < s.length) {
            val start = i
            val isDigit = s[i].isDigit()
            while (i < s.length && s[i].isDigit() == isDigit) i++
            parts.add(s.substring(start, i))
        }
        return parts
    }

    // ════════════════════════════════════════════════════════════════════
    // Single CBZ page extraction (for the reader)
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun getCbzPage(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PageArgs::class.java)
            val uri = Uri.parse(args.uri ?: "")
            val pageName = args.pageName ?: ""
            val base64 = if (readerCacheKey == uri.toString() && readerZip != null) {
                // Кэшированный ZipFile — без переоткрытия архива.
                val entry = readerZip!!.getEntry(pageName)
                if (entry != null) {
                    readerZip!!.getInputStream(entry).use { encodeDataUrl(pageName, readAll(it)) }
                } else null
            } else {
                readZipEntryBase64(uri, pageName)
            }
            if (base64 != null) {
                val ret = JSObject()
                ret.put("data", base64)
                invoke.resolve(ret)
            } else {
                invoke.reject("Страница не найдена в архиве: $pageName")
            }
        } catch (ex: Exception) {
            invoke.reject("getCbzPage failed: ${ex.message}")
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Single PDF page render (for the reader)
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun getPdfPage(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PageArgs::class.java)
            val uri = Uri.parse(args.uri ?: "")
            val pageIndex = (args.pageName ?: "1").toIntOrNull()?.minus(1) ?: 0
            val data = if (readerCacheKey == uri.toString() && readerPdf != null) {
                // Кэшированный PdfRenderer — без переоткрытия документа.
                renderPdfPage(readerPdf!!, pageIndex, 2.0f)
            } else {
                // Холодный путь: свой дескриптор + рендер, затем кэшируем.
                val renderer = openReaderPdf(uri)
                if (renderer != null) renderPdfPage(renderer, pageIndex, 2.0f) else null
            }
            if (data != null) {
                val ret = JSObject()
                ret.put("data", data)
                invoke.resolve(ret)
            } else {
                invoke.reject("Страница не найдена: ${args.pageName}")
            }
        } catch (ex: Exception) {
            invoke.reject("getPdfPage failed: ${ex.message}")
        }
    }

    /** Рендер одной страницы PDF в data-URL (JPEG, качество 85). */
    private fun renderPdfPage(renderer: PdfRenderer, pageIndex: Int, scale: Float): String? {
        if (pageIndex < 0 || pageIndex >= renderer.pageCount) return null
        return renderer.openPage(pageIndex).use { page ->
            val w = (page.width * scale).toInt()
            val h = (page.height * scale).toInt()
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bmp.eraseColor(android.graphics.Color.WHITE)
            val matrix = android.graphics.Matrix()
            matrix.setScale(scale, scale)
            page.render(bmp, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val baos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, baos)
            val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
            bmp.recycle()
            "data:image/jpeg;base64,$base64"
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Cover-only fetch + release (для библиотеки и жизни кэша)
    // ════════════════════════════════════════════════════════════════════

    /**
     * Быстрая обложка «на лету» (без полного разбора метаданных): карточка
     * в окне просмотра библиотеки получает обложку сразу, а не ждёт, пока
     * фоновая очередь дойдёт до неё по порядку. Обложка сжимается до 480px —
     * маленькая data-URL быстро декодируется на средних устройствах.
     */
    @Command
    fun getCover(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CoverArgs::class.java)
            val uri = Uri.parse(args.uri ?: "")
            val format = args.format ?: "cbz"
            val data = if (format == "pdf") {
                val renderer = openReaderPdf(uri)
                if (renderer != null && renderer.pageCount > 0) {
                    val scale = renderer.openPage(0).use { p -> 480.0f / maxOf(p.width, p.height) }
                    renderPdfPage(renderer, 0, scale)
                } else null
            } else {
                val zf = openReaderZip(uri)
                if (zf != null) readCbzCover(zf) else null
            }
            if (data != null) {
                val ret = JSObject()
                ret.put("data", data)
                invoke.resolve(ret)
            } else {
                invoke.reject("cover not found")
            }
        } catch (ex: Exception) {
            invoke.reject("getCover failed: ${ex.message}")
        }
    }

    /** Первая (natural-sort) картинка из открытого CBZ, сжатая до 480px. */
    private fun readCbzCover(zf: ZipFile): String? {
        var first: ZipEntry? = null
        val entries = zf.entries()
        while (entries.hasMoreElements()) {
            val ze = entries.nextElement() as ZipEntry
            if (!ze.isDirectory && isImageFile(ze.getName() ?: "")) {
                if (first == null || naturalCompare(ze.getName(), first.getName()) < 0) first = ze
            }
        }
        val entry = first ?: return null
        val bytes = zf.getInputStream(entry).use { readAll(it) }
        return encodeScaledJpeg(bytes, 480)
    }

    /** Декодирует картинку, уменьшает до maxDim и возвращает JPEG data-URL. */
    private fun encodeScaledJpeg(bytes: ByteArray, maxDim: Int): String {
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: return encodeDataUrl("cover.jpg", bytes)
        val w = bmp.width
        val h = bmp.height
        var nw = w
        var nh = h
        if (w > h && w > maxDim) { nh = h * maxDim / w; nw = maxDim }
        else if (h > maxDim) { nw = w * maxDim / h; nh = maxDim }
        val scaled = if (nw != w || nh != h) {
            Bitmap.createScaledBitmap(bmp, nw, nh, true).also { bmp.recycle() }
        } else bmp
        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, baos)
        if (scaled !== bmp) scaled.recycle()
        val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        return "data:image/jpeg;base64,$b64"
    }

    /** Закрывает кэш читалки (вызывается при закрытии ридера). */
    @Command
    fun releaseReaderFile(invoke: Invoke) {
        closeReaderCache()
        invoke.resolve(JSObject().apply { put("ok", true) })
    }

    /**
     * Прочитать [pageName] из ZIP/CBZ по SAF [uri] и вернуть как data-URL
     * ("data:<mime>;base64,..."). Сначала пытается random-access через
     * /proc/self/fd (быстро), при неудаче — стримингом.
     */
    private fun readZipEntryBase64(uri: Uri, pageName: String): String? {
        // Pass 1: random-access через file descriptor (быстро).
        runCatching {
            val pfd = activity.contentResolver.openFileDescriptor(uri, "r") ?: return@runCatching
            pfd.use { descriptor ->
                val fdFile = File("/proc/self/fd/${descriptor.fd}")
                ZipFile(fdFile).use { zf ->
                    val entry = zf.getEntry(pageName) ?: return@runCatching
                    zf.getInputStream(entry).use { input ->
                        return encodeDataUrl(pageName, readAll(input))
                    }
                }
            }
        }

        // Pass 2: стриминг с поиском нужной записи.
        runCatching {
            val input = activity.contentResolver.openInputStream(uri) ?: return@runCatching
            java.io.BufferedInputStream(input, 65536).use { buffered ->
                ZipInputStream(buffered).use { zis ->
                    var ze = zis.nextEntry
                    while (ze != null) {
                        if (ze.getName() == pageName) {
                            val bytes = readAll(zis)
                            zis.closeEntry()
                            return encodeDataUrl(pageName, bytes)
                        }
                        zis.closeEntry()
                        ze = zis.nextEntry
                    }
                }
            }
        }
        return null
    }

    private fun readAll(input: java.io.InputStream): ByteArray {
        val baos = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var n = input.read(buf)
        while (n != -1) { baos.write(buf, 0, n); n = input.read(buf) }
        return baos.toByteArray()
    }

    private fun encodeDataUrl(pageName: String, bytes: ByteArray): String {
        val lower = pageName.lowercase()
        val mime = when {
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".bmp") -> "image/bmp"
            lower.endsWith(".avif") -> "image/avif"
            else -> "image/jpeg"
        }
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        return "data:$mime;base64,$b64"
    }


    // ════════════════════════════════════════════════════════════════════
    // Import (single-shot + chunked)
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun takePendingFile(invoke: Invoke) {
        // Файл из ACTION_VIEW (см. MainActivity.captureViewIntent). Одноразово:
        // прочитали — сбросили, чтобы повторный вызов не отдавал старый файл.
        val uri = PendingViewFile.uri
        val name = PendingViewFile.name
        PendingViewFile.uri = null
        PendingViewFile.name = null
        invoke.resolve(
            JSObject().apply {
                put("uri", uri ?: JSONObject.NULL)
                put("name", name ?: JSONObject.NULL)
            }
        )
    }

    @Command
    fun importFileToLibrary(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ImportArgs::class.java)
            val folderUri = Uri.parse(args.folderUri ?: "")
            val folder = DocumentFile.fromTreeUri(activity, folderUri) ?: run {
                invoke.reject("folder not found"); return
            }
            val mime = when {
                args.destFileName?.lowercase()?.endsWith(".pdf") == true -> "application/pdf"
                // vnd.comicbook+zip — без маппинга расширений в MimeTypeMap:
                // провайдер НЕ добавит ".zip" к имени (application/zip — добавляет,
                // и импортированный "X.cbz" превращался в "X.cbz.zip").
                else -> "application/vnd.comicbook+zip"
            }
            val newFile = folder.createFile(mime, args.destFileName ?: "file") ?: run {
                invoke.reject("create failed"); return
            }
            // Источник может быть content:// (файл открыт извне через
            // ACTION_VIEW) — такой URI нельзя читать как File, только через
            // ContentResolver. file:// тоже приходит из интентов — срезаем
            // схему. Обычный путь (десктоп-импорт) — FileInputStream.
            val source = args.sourcePath ?: ""
            val sourcePath = when {
                source.startsWith("content://") -> source
                source.startsWith("file://") -> Uri.parse(source).path ?: source
                else -> source
            }
            val input: InputStream = if (sourcePath.startsWith("content://")) {
                activity.contentResolver.openInputStream(Uri.parse(sourcePath)) ?: run {
                    invoke.reject("cannot read source"); return
                }
            } else {
                FileInputStream(File(sourcePath))
            }
            input.use { inputStream ->
                activity.contentResolver.openOutputStream(newFile.uri)?.use { output ->
                    val buf = ByteArray(8192)
                    var n = inputStream.read(buf)
                    while (n != -1) { output.write(buf, 0, n); n = inputStream.read(buf) }
                }
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "import failed")
        }
    }

    @Command
    fun startChunkedImport(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ChunkedImportStartArgs::class.java)
            val importId = "import_${System.currentTimeMillis()}_${UUID.randomUUID().toString().substring(0, 8)}"
            val tempFile = File(activity.cacheDir, "chunk_$importId")
            if (tempFile.createNewFile()) {
                activeImports[importId] = tempFile
                importDestNames[importId] = args.fileName ?: "file"
                importFolderUris[importId] = args.folderUri ?: ""
                invoke.resolve(JSObject().apply { put("importId", importId) })
            } else {
                invoke.reject("create failed")
            }
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "start failed")
        }
    }

    @Command
    fun appendChunk(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(AppendChunkArgs::class.java)
            val tempFile = activeImports[args.importId]
            if (tempFile != null && tempFile.exists()) {
                val data = Base64.decode(args.base64Data ?: "", Base64.DEFAULT)
                FileOutputStream(tempFile, true).use { it.write(data) }
                invoke.resolve(JSObject().apply { put("ok", true) })
            } else {
                invoke.reject("no import")
            }
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "append failed")
        }
    }

    @Command
    fun finishChunkedImport(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SingleIdArgs::class.java)
            val id = args.importId ?: return invoke.reject("no id")
            val tempFile = activeImports.remove(id)
            val destName = importDestNames.remove(id)
            val folderUriStr = importFolderUris.remove(id)
            if (tempFile != null && tempFile.exists() && destName != null && folderUriStr != null) {
                val folder = DocumentFile.fromTreeUri(activity, Uri.parse(folderUriStr))
                if (folder != null) {
                    val mime = when {
                        destName.lowercase().endsWith(".pdf") -> "application/pdf"
                        else -> "application/x-cbz"
                    }
                    val newFile = folder.createFile(mime, destName)
                    if (newFile != null) {
                        FileInputStream(tempFile).use { input ->
                            activity.contentResolver.openOutputStream(newFile.uri)?.use { output ->
                                val buf = ByteArray(8192)
                                var n = input.read(buf)
                                while (n != -1) { output.write(buf, 0, n); n = input.read(buf) }
                            }
                        }
                        tempFile.delete()
                        return invoke.resolve(JSObject().apply { put("ok", true) })
                    }
                }
                tempFile.delete()
            }
            invoke.reject("finish failed")
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "finish failed")
        }
    }

    @Command
    fun cancelChunkedImport(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SingleIdArgs::class.java)
            val id = args.importId ?: return invoke.resolve(JSObject().apply { put("ok", true) })
            activeImports.remove(id)?.let { tempFile ->
                importDestNames.remove(id); importFolderUris.remove(id)
                if (tempFile.exists()) tempFile.delete()
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "cancel failed")
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Misc helpers
    // ════════════════════════════════════════════════════════════════════

    @Command
    fun deleteSAFFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DeleteArgs::class.java)
            val uri = Uri.parse(args.uri ?: "")
            val ok = DocumentsContract.deleteDocument(activity.contentResolver, uri)
            invoke.resolve(JSObject().apply { put("ok", ok) })
        } catch (ex: Exception) {
            invoke.resolve(JSObject().apply { put("ok", false) })
        }
    }

    @Command
    fun clearImportCache(invoke: Invoke) {
        try {
            val cacheDir = activity.cacheDir
            if (cacheDir.isDirectory) {
                cacheDir.listFiles()?.forEach { f ->
                    // open_* — старые копии файлов, chunk_* — незавершённые
                    // чанковые импорты; и те, и другие можно смело чистить.
                    if (f.isFile && (f.name.startsWith("open_") || f.name.startsWith("chunk_"))) f.delete()
                }
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "clear failed")
        }
    }
}
