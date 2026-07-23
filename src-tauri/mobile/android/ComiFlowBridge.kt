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

@TauriPlugin
class ComiFlowBridge(private val activity: Activity) : Plugin(activity) {

    // ── Pending activity-result holders ───────────────────────────────────
    private var pendingFolderInvoke: Invoke? = null

    // ── Chunked import bookkeeping (keyed by importId) ────────────────────
    private val activeImports = HashMap<String, File>()
    private val importDestNames = HashMap<String, String>()
    private val importFolderUris = HashMap<String, String>()

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
            if (result.resultCode != Activity.RESULT_OK) {
                invoke.reject("cancelled")
                return
            }
            val treeUri: Uri = result.data?.data ?: run {
                invoke.reject("no uri")
                return
            }

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

    @Command
    fun getLibraryFolderUri(invoke: Invoke) {
        val uri = activity.getSharedPreferences(PREFS_NAME, Activity.MODE_PRIVATE)
            .getString(PREF_FOLDER_URI, null)
        val ret = JSObject()
        ret.put("uri", uri ?: JSONObject.NULL)
        invoke.resolve(ret)
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
                    if (!lower.endsWith(".cbz") && !lower.endsWith(".zip") && !lower.endsWith(".pdf")) continue

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
                        val maxDim = 640
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
            }
        }
    }

    private fun parseCbz(uri: Uri, result: JSONObject) {
        val pages = ArrayList<String>()
        var coverBytes: ByteArray? = null
        var parsed = false

        // Pass 0: try random-access via /proc/self/fd (much faster when available)
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
                            pages.add(name)
                            if (firstImage == null || name.compareTo(firstImage!!, ignoreCase = true) < 0) {
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
        }

        // Fallback: streaming double-pass
        if (!parsed) {
            pages.clear()
            coverBytes = null
            var targetCover: String? = null
            ZipInputStream(activity.contentResolver.openInputStream(uri).let { java.io.BufferedInputStream(it, 65536) }).use { zis ->
                var ze = zis.nextEntry
                while (ze != null) {
                    val name = ze.getName() ?: ""
                    if (!ze.isDirectory() && isImageFile(name)) {
                        pages.add(name)
                        if (targetCover == null || name.compareTo(targetCover!!, ignoreCase = true) < 0) targetCover = name
                    }
                    zis.closeEntry()
                    ze = zis.nextEntry
                }
            }
            if (targetCover != null) {
                ZipInputStream(activity.contentResolver.openInputStream(uri).let { java.io.BufferedInputStream(it, 65536) }).use { zis ->
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

        pages.sortWith(Comparator { a, b -> a.compareTo(b, ignoreCase = true) })

        var coverBase64 = ""
        coverBytes?.let { bytes ->
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            var width = opts.outWidth
            var height = opts.outHeight
            val maxDim = 640
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
        result.put("format", "cbz")
        result.put("pages", pagesArray)
        result.put("coverBase64", coverBase64)
    }

    private fun isImageFile(filename: String): Boolean {
        val lower = filename.lowercase()
        if (lower.startsWith(".") || lower.contains("__macosx") ||
            lower.contains("thumbs.db") || lower.endsWith("/")) return false
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") ||
            lower.endsWith(".webp") || lower.endsWith(".gif") || lower.endsWith(".bmp") ||
            lower.endsWith(".avif")
    }

    // ════════════════════════════════════════════════════════════════════
    // Import (single-shot + chunked)
    // ════════════════════════════════════════════════════════════════════

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
                else -> "application/zip"
            }
            val newFile = folder.createFile(mime, args.destFileName ?: "file") ?: run {
                invoke.reject("create failed"); return
            }
            FileInputStream(File(args.sourcePath ?: "")).use { input ->
                activity.contentResolver.openOutputStream(newFile.uri)?.use { output ->
                    val buf = ByteArray(8192)
                    var n = input.read(buf)
                    while (n != -1) { output.write(buf, 0, n); n = input.read(buf) }
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
    fun copyContentUriToCache(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(UriArgs::class.java)
            val uri = Uri.parse(args.uri ?: "")
            var fileName = "temp_comic.cbz"
            activity.contentResolver.query(uri, null, null, null, null)?.use { c ->
                val nameIndex = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex != -1 && c.moveToFirst()) fileName = c.getString(nameIndex)
            }
            fileName = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_")
            val tempFile = File(activity.cacheDir, "open_${System.currentTimeMillis()}_$fileName")
            activity.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(tempFile).use { output ->
                    val buf = ByteArray(8192)
                    var n = input.read(buf)
                    while (n != -1) { output.write(buf, 0, n); n = input.read(buf) }
                }
            } ?: run { invoke.reject("open failed"); return }
            invoke.resolve(JSObject().apply { put("path", tempFile.absolutePath) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "copy failed")
        }
    }

    @Command
    fun clearImportCache(invoke: Invoke) {
        try {
            val cacheDir = activity.cacheDir
            if (cacheDir.isDirectory) {
                cacheDir.listFiles()?.forEach { f ->
                    if (f.name.startsWith("open_") && f.isFile) f.delete()
                }
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "clear failed")
        }
    }
}
