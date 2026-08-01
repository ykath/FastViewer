package com.fastviewer.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.KeyEvent;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.util.Consumer;
import androidx.documentfile.provider.DocumentFile;
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter;
import androidx.window.layout.DisplayFeature;
import androidx.window.layout.FoldingFeature;
import androidx.window.layout.WindowInfoTracker;
import androidx.window.layout.WindowLayoutInfo;

import com.github.junrar.Archive;
import com.github.junrar.exception.RarException;
import com.github.junrar.rarfile.FileHeader;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

@CapacitorPlugin(name = "FastViewerFiles")
public class FastViewerFilesPlugin extends Plugin {
    private static final Set<String> VIEWABLE_EXTENSIONS = new HashSet<String>() {{
        add("md");
        add("markdown");
        add("mdown");
        add("html");
        add("htm");
        add("xhtml");
    }};
    private static final Set<String> ARCHIVE_EXTENSIONS = new HashSet<String>() {{
        add("zip");
        add("rar");
    }};
    private static final int MAX_ARCHIVE_ENTRIES = 1000;
    private static final int MAX_ARCHIVE_DEPTH = 20;
    private static final long MAX_ARCHIVE_ENTRY_SIZE = 20L * 1024L * 1024L;
    private static final long MAX_ARCHIVE_EXPANDED_SIZE = 200L * 1024L * 1024L;
    private static final long MAX_ARCHIVE_RATIO = 100L;
    private static final int FILE_CHUNK_SIZE = 256 * 1024;
    private static final long MAX_OPEN_FILE_SIZE = 100L * 1024L * 1024L;
    private static final int MAX_RESOURCE_FILES = 500;
    private static final long MAX_RESOURCE_TOTAL_SIZE = 100L * 1024L * 1024L;
    private static final int MAX_OPEN_QUEUE_ENTRIES = 20;
    private static final long MAX_OPEN_QUEUE_SIZE = 300L * 1024L * 1024L;
    private static final long MAX_SHARE_CACHE_SIZE = 100L * 1024L * 1024L;
    private static final long LOW_STORAGE_THRESHOLD = 500L * 1024L * 1024L;
    private static final String OPEN_QUEUE_PREFERENCES = "lightpage-open-queue";
    private static final String OPEN_QUEUE_KEY = "requests";
    private static final String REQUEST_ID_EXTRA = "com.fastviewer.app.OPEN_REQUEST_ID";

    private static Intent initialIntent;
    private static FastViewerFilesPlugin activePlugin;
    private static boolean volumePageEnabled;
    private static volatile boolean selectionActionsEnabled;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Object queueLock = new Object();
    private WindowInfoTrackerCallbackAdapter windowInfoTracker;
    private Consumer<WindowLayoutInfo> windowLayoutListener;

    public static void setInitialIntent(Intent intent) {
        initialIntent = intent;
    }

    public static void handleNewIntent(Intent intent) {
        if (activePlugin != null) {
            activePlugin.enqueueIntent(intent);
        } else {
            initialIntent = intent;
        }
    }

    public static boolean handleVolumeKey(int keyCode, int action) {
        if (!volumePageEnabled || activePlugin == null || action != KeyEvent.ACTION_DOWN) return false;
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) return false;
        JSObject event = new JSObject();
        event.put("direction", keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "previous" : "next");
        activePlugin.notifyListeners("volumePage", event, true);
        return true;
    }

    public static boolean areSelectionActionsEnabled() {
        return selectionActionsEnabled;
    }

    @Override
    public void load() {
        activePlugin = this;
        windowInfoTracker = new WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(getContext()));
        windowLayoutListener = this::emitWindowLayout;
        windowInfoTracker.addWindowLayoutInfoListener(
            getActivity(),
            ContextCompat.getMainExecutor(getContext()),
            windowLayoutListener
        );
        ioExecutor.execute(() -> {
            cleanupOldShareFiles(new File(getContext().getCacheDir(), "share"));
            cleanupTransientOpenFiles();
            Intent intent = initialIntent;
            initialIntent = null;
            if (intent != null) enqueueIntentInBackground(intent);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (activePlugin == this) {
            activePlugin = null;
        }
        if (windowInfoTracker != null && windowLayoutListener != null) {
            windowInfoTracker.removeWindowLayoutInfoListener(windowLayoutListener);
        }
        ioExecutor.shutdownNow();
        selectionActionsEnabled = false;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        ioExecutor.execute(() -> getLaunchFileInBackground(call));
    }

    @PluginMethod
    public void getPendingOpenRequests(PluginCall call) {
        ioExecutor.execute(() -> {
            JSObject result = new JSObject();
            result.put("requests", readOpenQueue());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setVolumePageEnabled(PluginCall call) {
        volumePageEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void setSelectionActionsEnabled(PluginCall call) {
        selectionActionsEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void prepareShareCache(PluginCall call) {
        ioExecutor.execute(() -> {
            File directory = new File(getContext().getCacheDir(), "share");
            cleanupOldShareFiles(directory);
            long expectedBytes = Math.max(0L, call.getLong("expectedBytes", 0L));
            trimDirectoryToSize(directory, Math.max(0L, MAX_SHARE_CACHE_SIZE - expectedBytes));
            JSObject result = new JSObject();
            result.put("availableBytes", Math.max(0L, MAX_SHARE_CACHE_SIZE - directorySize(directory)));
            call.resolve(result);
        });
    }

    private void emitWindowLayout(WindowLayoutInfo layoutInfo) {
        JSArray features = new JSArray();
        for (DisplayFeature feature : layoutInfo.getDisplayFeatures()) {
            if (!(feature instanceof FoldingFeature)) continue;
            FoldingFeature fold = (FoldingFeature) feature;
            JSObject item = new JSObject();
            item.put("left", fold.getBounds().left);
            item.put("top", fold.getBounds().top);
            item.put("right", fold.getBounds().right);
            item.put("bottom", fold.getBounds().bottom);
            item.put("separating", fold.isSeparating());
            item.put("orientation", fold.getOrientation() == FoldingFeature.Orientation.VERTICAL ? "vertical" : "horizontal");
            features.put(item);
        }
        JSObject event = new JSObject();
        event.put("features", features);
        notifyListeners("layoutChanged", event, true);
    }

    @PluginMethod
    public void resolveOpenRequest(PluginCall call) {
        ioExecutor.execute(() -> resolveOpenRequestInBackground(call));
    }

    @PluginMethod
    public void acknowledgeOpenRequest(PluginCall call) {
        ioExecutor.execute(() -> finishOpenRequest(call, true));
    }

    @PluginMethod
    public void discardOpenRequest(PluginCall call) {
        ioExecutor.execute(() -> finishOpenRequest(call, true));
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
            "text/markdown", "text/html", "application/xhtml+xml",
            "application/zip", "application/x-zip-compressed",
            "application/vnd.rar", "application/x-rar-compressed"
        });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("文件选择已取消");
            return;
        }
        Uri uri = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // 私有缓存副本不依赖后续 URI 权限。
        }
        ioExecutor.execute(() -> resolvePickedFile(call, uri));
    }

    private void resolvePickedFile(PluginCall call, Uri uri) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            String fileName = resolveFileName(resolver, uri);
            long size = resolveFileSize(resolver, uri);
            String mimeType = resolver.getType(uri);
            if (isArchive(fileName, mimeType)) {
                File archiveFile = copyUriToCache(resolver, uri, fileName);
                call.resolve(createArchiveResult(archiveFile, fileName, mimeType, size, uri.toString()));
                return;
            }
            if (!isViewableFile(fileName)) {
                call.resolve(createUnsupportedFileResult(fileName));
                return;
            }
            File cachedFile = copyUriToCache(resolver, uri, fileName);
            call.resolve(createResult(uri, fileName, mimeType, size, cachedFile.getAbsolutePath()));
        } catch (Exception exception) {
            call.reject("文件读取失败：" + exception.getMessage(), exception);
        }
    }

    private void getLaunchFileInBackground(PluginCall call) {
        Intent intent = initialIntent != null ? initialIntent : getActivity().getIntent();
        Uri uri = resolveIntentUri(intent);

        if (uri == null) {
            JSObject result = new JSObject();
            result.put("hasFile", false);
            call.resolve(result);
            return;
        }

        try {
            ContentResolver resolver = getContext().getContentResolver();
            String fileName = resolveFileName(resolver, uri);
            long size = resolveFileSize(resolver, uri);
            String mimeType = resolver.getType(uri);

            if (isArchive(fileName, mimeType)) {
                File archiveFile = copyUriToCache(resolver, uri, fileName);
                call.resolve(createArchiveResult(archiveFile, fileName, mimeType, size, uri.toString()));
                return;
            }
            if (!isViewableFile(fileName)) {
                call.resolve(createUnsupportedFileResult(fileName));
                return;
            }

            File cachedFile = copyUriToCache(resolver, uri, fileName);
            call.resolve(createResult(uri, fileName, mimeType, size, cachedFile.getAbsolutePath()));
        } catch (SecurityException exception) {
            JSObject result = new JSObject();
            result.put("hasFile", false);
            result.put("error", "文件访问权限已失效，请重新选择文件。");
            result.put("errorCode", "PERMISSION_EXPIRED");
            call.resolve(result);
        } catch (FileNotFoundException exception) {
            JSObject result = new JSObject();
            result.put("hasFile", false);
            result.put("error", "文件不存在或已被删除。");
            result.put("errorCode", "FILE_NOT_FOUND");
            call.resolve(result);
        } catch (Exception exception) {
            JSObject result = new JSObject();
            result.put("hasFile", false);
            result.put("error", "无法读取外部文件：" + exception.getMessage());
            result.put("errorCode", "UNKNOWN");
            call.resolve(result);
        }
    }

    private void enqueueIntent(Intent intent) {
        ioExecutor.execute(() -> enqueueIntentInBackground(intent));
    }

    private void enqueueIntentInBackground(Intent intent) {
        List<Uri> uris = resolveIntentUris(intent);
        if (uris.isEmpty()) return;
        String sharedRequestId = intent.getStringExtra(REQUEST_ID_EXTRA);
        if (sharedRequestId == null || sharedRequestId.isEmpty()) {
            sharedRequestId = UUID.randomUUID().toString();
            intent.putExtra(REQUEST_ID_EXTRA, sharedRequestId);
        }
        for (int index = 0; index < uris.size(); index++) {
            enqueueUri(uris.get(index), uris.size() == 1 ? sharedRequestId : sharedRequestId + "-" + index);
        }
        JSObject signal = new JSObject();
        signal.put("count", readOpenQueue().length());
        notifyListeners("openRequestAvailable", signal, true);
    }

    private void enqueueUri(Uri uri, String requestId) {
        synchronized (queueLock) {
            JSONArray queue = readOpenQueue();
            for (int index = 0; index < queue.length(); index++) {
                if (requestId.equals(queue.optJSONObject(index).optString("requestId"))) return;
            }
            ContentResolver resolver = getContext().getContentResolver();
            String fileName = resolveFileName(resolver, uri);
            long declaredSize = Math.max(0L, resolveFileSize(resolver, uri));
            long queuedSize = openQueueSize(queue);
            if (queue.length() >= MAX_OPEN_QUEUE_ENTRIES) return;
            if (declaredSize > MAX_OPEN_FILE_SIZE || queuedSize + declaredSize > MAX_OPEN_QUEUE_SIZE) {
                queue.put(createQueuedError(requestId, fileName, declaredSize, "外部打开队列已满或文件超过安全上限"));
                writeOpenQueue(queue);
                return;
            }
            File target = null;
            try {
                File directory = new File(getContext().getFilesDir(), "open-queue");
                if (!directory.exists() && !directory.mkdirs()) throw new FileNotFoundException("无法创建打开队列目录");
                target = new File(directory, requestId + "-" + sanitizeName(fileName));
                try (InputStream input = resolver.openInputStream(uri); FileOutputStream output = new FileOutputStream(target)) {
                    if (input == null) throw new FileNotFoundException("无法读取外部文件");
                    copyWithLimit(input, output, MAX_OPEN_FILE_SIZE);
                }
                if (openQueueSize(queue) + target.length() > MAX_OPEN_QUEUE_SIZE) {
                    target.delete();
                    queue.put(createQueuedError(requestId, fileName, target.length(), "外部打开队列空间不足"));
                } else {
                    JSONObject item = new JSONObject();
                    item.put("requestId", requestId);
                    item.put("receivedAt", System.currentTimeMillis());
                    item.put("fileName", fileName);
                    item.put("mimeType", resolver.getType(uri));
                    item.put("size", target.length());
                    item.put("cachedPath", target.getAbsolutePath());
                    item.put("sourceUri", uri.toString());
                    item.put("isArchive", isArchive(fileName, resolver.getType(uri)));
                    queue.put(item);
                }
            } catch (Exception exception) {
                if (target != null) target.delete();
                queue.put(createQueuedError(requestId, fileName, declaredSize, "无法暂存外部文件：" + exception.getMessage()));
            }
            writeOpenQueue(queue);
        }
    }

    private JSONObject createQueuedError(String requestId, String fileName, long size, String message) {
        JSONObject item = new JSONObject();
        try {
            item.put("requestId", requestId);
            item.put("receivedAt", System.currentTimeMillis());
            item.put("fileName", fileName);
            item.put("size", size);
            item.put("cachedPath", "");
            item.put("isArchive", false);
            item.put("error", message);
        } catch (Exception ignored) {
            // JSONObject accepts the primitive values above.
        }
        return item;
    }

    private JSONArray readOpenQueue() {
        synchronized (queueLock) {
            SharedPreferences preferences = getContext().getSharedPreferences(OPEN_QUEUE_PREFERENCES, 0);
            try {
                return new JSONArray(preferences.getString(OPEN_QUEUE_KEY, "[]"));
            } catch (Exception exception) {
                return new JSONArray();
            }
        }
    }

    private void writeOpenQueue(JSONArray queue) {
        getContext().getSharedPreferences(OPEN_QUEUE_PREFERENCES, 0)
            .edit()
            .putString(OPEN_QUEUE_KEY, queue.toString())
            .apply();
    }

    private long openQueueSize(JSONArray queue) {
        long total = 0L;
        for (int index = 0; index < queue.length(); index++) {
            JSONObject item = queue.optJSONObject(index);
            if (item != null && item.optString("error", "").isEmpty()) total += Math.max(0L, item.optLong("size", 0L));
        }
        return total;
    }

    private void resolveOpenRequestInBackground(PluginCall call) {
        String requestId = call.getString("requestId");
        JSONObject queued = findOpenRequest(requestId);
        if (queued == null) {
            call.reject("外部打开请求不存在或已处理");
            return;
        }
        if (!queued.optString("error", "").isEmpty()) {
            try {
                JSObject result = JSObject.fromJSONObject(queued);
                result.put("hasFile", false);
                result.put("errorCode", "UNKNOWN");
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法读取外部打开错误：" + exception.getMessage(), exception);
            }
            return;
        }
        try {
            File stored = resolveAllowedFile(queued.optString("cachedPath"));
            String fileName = queued.optString("fileName");
            String mimeType = queued.optString("mimeType", "");
            if (queued.optBoolean("isArchive", false)) {
                File temporary = new File(getContext().getCacheDir(), "queued-" + requestId + "-" + sanitizeName(fileName));
                try {
                    try (InputStream input = new FileInputStream(stored); OutputStream output = new FileOutputStream(temporary)) {
                        copy(input, output);
                    }
                    JSObject result = createArchiveResult(temporary, fileName, mimeType, stored.length(), queued.optString("sourceUri", null));
                    result.put("requestId", requestId);
                    call.resolve(result);
                } finally {
                    temporary.delete();
                }
            } else {
                JSObject result = createResult(Uri.parse(queued.optString("sourceUri", "")), fileName, mimeType, stored.length(), stored.getAbsolutePath());
                result.put("requestId", requestId);
                call.resolve(result);
            }
        } catch (Exception exception) {
            call.reject("无法处理外部打开请求：" + exception.getMessage(), exception);
        }
    }

    private JSONObject findOpenRequest(String requestId) {
        if (requestId == null) return null;
        JSONArray queue = readOpenQueue();
        for (int index = 0; index < queue.length(); index++) {
            JSONObject item = queue.optJSONObject(index);
            if (item != null && requestId.equals(item.optString("requestId"))) return item;
        }
        return null;
    }

    private void finishOpenRequest(PluginCall call, boolean deleteFile) {
        String requestId = call.getString("requestId");
        synchronized (queueLock) {
            JSONArray queue = readOpenQueue();
            JSONArray remaining = new JSONArray();
            boolean removed = false;
            for (int index = 0; index < queue.length(); index++) {
                JSONObject item = queue.optJSONObject(index);
                if (item != null && requestId != null && requestId.equals(item.optString("requestId"))) {
                    removed = true;
                    if (deleteFile) {
                        String path = item.optString("cachedPath", "");
                        if (!path.isEmpty()) new File(path).delete();
                    }
                } else if (item != null) {
                    remaining.put(item);
                }
            }
            writeOpenQueue(remaining);
            JSObject result = new JSObject();
            result.put("removed", removed);
            call.resolve(result);
        }
    }

    private List<Uri> resolveIntentUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (intent == null) return uris;
        if (intent.getData() != null) uris.add(intent.getData());
        Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream instanceof Uri && !uris.contains(stream)) uris.add((Uri) stream);
        ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (streams != null) for (Uri uri : streams) if (uri != null && !uris.contains(uri)) uris.add(uri);
        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null && !uris.contains(uri)) uris.add(uri);
            }
        }
        return uris;
    }

    @PluginMethod
    public void importArchive(PluginCall call) {
        ioExecutor.execute(() -> importArchiveInBackground(call));
    }

    @PluginMethod
    public void createPdf(PluginCall call) {
        ioExecutor.execute(() -> createPdfInBackground(call));
    }

    @PluginMethod
    public void selectResourceDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "resourceDirectoryResult");
    }

    @ActivityCallback
    private void resourceDirectoryResult(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("目录授权已取消");
            return;
        }
        Uri treeUri = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (SecurityException ignored) {
            // 部分文档提供方只授予本次会话权限，已复制的私有缓存仍可继续使用。
        }
        ioExecutor.execute(() -> copyResourceDirectory(call, treeUri));
    }

    private void copyResourceDirectory(PluginCall call, Uri treeUri) {
        String storageId = "html-resources-" + System.currentTimeMillis();
        File archivesRoot = new File(getContext().getFilesDir(), "archives");
        File outputRoot = new File(archivesRoot, storageId);
        try {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
            if (root == null || !root.isDirectory()) throw new Exception("无法读取所选目录");
            if (!outputRoot.mkdirs()) throw new Exception("无法创建资源目录");
            JSObject resources = new JSObject();
            long[] counters = new long[] { 0L, 0L };
            copyResourceChildren(root, outputRoot, "", resources, counters, 0);
            JSObject response = new JSObject();
            response.put("storageId", storageId);
            response.put("resources", resources);
            response.put("count", counters[0]);
            call.resolve(response);
        } catch (Exception exception) {
            deleteRecursively(outputRoot);
            call.reject("同目录资源授权失败：" + exception.getMessage(), exception);
        }
    }

    private void copyResourceChildren(
        DocumentFile source,
        File outputRoot,
        String relativeDirectory,
        JSObject resources,
        long[] counters,
        int depth
    ) throws Exception {
        if (depth > MAX_ARCHIVE_DEPTH) throw new SecurityException("资源目录层级超过安全上限");
        for (DocumentFile child : source.listFiles()) {
            String name = sanitizeName(child.getName());
            if (child.isDirectory()) {
                copyResourceChildren(child, outputRoot, relativeDirectory + name + "/", resources, counters, depth + 1);
                continue;
            }
            String mimeType = inferResourceMime(name);
            if (mimeType == null) continue;
            counters[0] += 1L;
            if (counters[0] > MAX_RESOURCE_FILES) throw new SecurityException("资源文件数量超过安全上限");
            if (Math.max(0L, child.length()) > MAX_ARCHIVE_ENTRY_SIZE) throw new SecurityException("单个资源超过安全上限");
            File target = new File(outputRoot, relativeDirectory + name).getCanonicalFile();
            if (!isWithin(outputRoot.getCanonicalFile(), target)) throw new SecurityException("资源目录路径越界");
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new Exception("无法创建资源子目录");
            try (
                InputStream input = getContext().getContentResolver().openInputStream(child.getUri());
                FileOutputStream output = new FileOutputStream(target)
            ) {
                if (input == null) throw new FileNotFoundException(name);
                long copied = copyWithLimit(
                    input,
                    output,
                    Math.min(MAX_ARCHIVE_ENTRY_SIZE, MAX_RESOURCE_TOTAL_SIZE - counters[1])
                );
                counters[1] += copied;
            }
            JSObject resource = new JSObject();
            resource.put("mimeType", mimeType);
            resource.put("path", target.getAbsolutePath());
            resource.put("size", target.length());
            resources.put(normalizeResourceKey(relativeDirectory + name), resource);
        }
    }

    private void createPdfInBackground(PluginCall call) {
        String title = call.getString("title", "document");
        String content = call.getString("content", "");
        PdfDocument pdf = new PdfDocument();
        try {
            File shareDirectory = new File(getContext().getCacheDir(), "share");
            if (!shareDirectory.exists() && !shareDirectory.mkdirs()) {
                throw new Exception("无法创建分享目录");
            }
            cleanupOldShareFiles(shareDirectory);

            Paint bodyPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            bodyPaint.setColor(0xff1b211e);
            bodyPaint.setTextSize(11f);
            bodyPaint.setTypeface(Typeface.create("sans", Typeface.NORMAL));
            Paint titlePaint = new Paint(bodyPaint);
            titlePaint.setTextSize(18f);
            titlePaint.setTypeface(Typeface.create("sans", Typeface.BOLD));

            final int pageWidth = 595;
            final int pageHeight = 842;
            final float margin = 42f;
            final float lineHeight = 17f;
            final float maxWidth = pageWidth - margin * 2;
            int pageNumber = 1;
            PdfDocument.Page page = startPdfPage(pdf, pageNumber, pageWidth, pageHeight);
            Canvas canvas = page.getCanvas();
            float y = margin;
            canvas.drawText(trimForPdf(title, 80), margin, y + 18f, titlePaint);
            y += 42f;

            String normalized = content.replace("\r\n", "\n").replace('\r', '\n');
            String[] paragraphs = normalized.split("\n", -1);
            for (String paragraph : paragraphs) {
                List<String> lines = wrapPdfLine(paragraph, bodyPaint, maxWidth);
                for (String line : lines) {
                    if (y + lineHeight > pageHeight - margin) {
                        pdf.finishPage(page);
                        pageNumber += 1;
                        page = startPdfPage(pdf, pageNumber, pageWidth, pageHeight);
                        canvas = page.getCanvas();
                        y = margin;
                    }
                    canvas.drawText(line, margin, y + 11f, bodyPaint);
                    y += lineHeight;
                }
            }
            pdf.finishPage(page);

            String baseName = stripExtension(sanitizeName(title));
            File outputFile = new File(shareDirectory, baseName + "-" + System.currentTimeMillis() + ".pdf");
            try (FileOutputStream output = new FileOutputStream(outputFile)) {
                pdf.writeTo(output);
            }
            // Capacitor Share accepts file: URLs and converts them to a scoped FileProvider URI.
            Uri uri = Uri.fromFile(outputFile);
            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            result.put("path", outputFile.getAbsolutePath());
            result.put("size", outputFile.length());
            result.put("pageCount", pageNumber);
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("PDF 生成失败：" + exception.getMessage(), exception);
        } finally {
            pdf.close();
        }
    }

    private PdfDocument.Page startPdfPage(PdfDocument pdf, int pageNumber, int width, int height) {
        PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(width, height, pageNumber).create();
        return pdf.startPage(info);
    }

    private List<String> wrapPdfLine(String text, Paint paint, float maxWidth) {
        List<String> lines = new ArrayList<>();
        if (text.isEmpty()) {
            lines.add("");
            return lines;
        }
        int offset = 0;
        while (offset < text.length()) {
            int count = paint.breakText(text, offset, text.length(), true, maxWidth, null);
            if (count <= 0) count = 1;
            int end = Math.min(text.length(), offset + count);
            lines.add(text.substring(offset, end));
            offset = end;
        }
        return lines;
    }

    private String trimForPdf(String value, int maxLength) {
        if (value == null) return "";
        return value.length() <= maxLength ? value : value.substring(0, maxLength - 1) + "…";
    }

    private void cleanupOldShareFiles(File shareDirectory) {
        File[] files = shareDirectory.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - 24L * 60L * 60L * 1000L;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < cutoff) file.delete();
        }
        trimDirectoryToSize(shareDirectory, MAX_SHARE_CACHE_SIZE);
    }

    private void trimDirectoryToSize(File directory, long targetBytes) {
        File[] files = directory.listFiles(File::isFile);
        if (files == null) return;
        List<File> ordered = new ArrayList<>();
        long total = 0L;
        for (File file : files) {
            ordered.add(file);
            total += Math.max(0L, file.length());
        }
        ordered.sort(Comparator.comparingLong(File::lastModified));
        for (File file : ordered) {
            if (total <= targetBytes) break;
            long bytes = Math.max(0L, file.length());
            if (file.delete()) total = Math.max(0L, total - bytes);
        }
    }

    private void cleanupTransientOpenFiles() {
        File[] files = getContext().getCacheDir().listFiles();
        if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (file.isFile() && (name.startsWith("open-") || name.startsWith("picked-") || name.startsWith("queued-"))) file.delete();
        }
    }

    private void importArchiveInBackground(PluginCall call) {
        String fileName = call.getString("fileName", "archive.zip");
        String base64Content = call.getString("base64Content");
        String mimeType = call.getString("mimeType", "");
        long size = call.getLong("size", 0L);

        if (base64Content == null || base64Content.isEmpty()) {
            JSObject result = new JSObject();
            result.put("hasFile", false);
            result.put("error", "压缩包内容为空，无法解压。");
            result.put("errorCode", "ARCHIVE_FAILED");
            call.resolve(result);
            return;
        }
        if (size > MAX_OPEN_FILE_SIZE || base64Content.length() > (MAX_OPEN_FILE_SIZE * 4L / 3L) + 8L) {
            call.reject("压缩包超过 100 MB 安全上限");
            return;
        }

        try {
            File archiveFile = new File(getContext().getCacheDir(), "picked-" + System.currentTimeMillis() + "-" + sanitizeName(fileName));
            try (FileOutputStream output = new FileOutputStream(archiveFile)) {
                output.write(Base64.decode(base64Content, Base64.DEFAULT));
            }
            call.resolve(createArchiveResult(archiveFile, fileName, mimeType, size, null));
        } catch (Exception exception) {
            JSObject result = new JSObject();
            result.put("hasFile", false);
            result.put("error", "压缩包解压失败：" + exception.getMessage());
            result.put("errorCode", "ARCHIVE_FAILED");
            call.resolve(result);
        }
    }

    private void notifyFileOpen(Intent intent) {
        ioExecutor.execute(() -> notifyFileOpenInBackground(intent));
    }

    private void notifyFileOpenInBackground(Intent intent) {
        Uri uri = resolveIntentUri(intent);
        if (uri == null) {
            return;
        }

        try {
            ContentResolver resolver = getContext().getContentResolver();
            String fileName = resolveFileName(resolver, uri);
            long size = resolveFileSize(resolver, uri);
            String mimeType = resolver.getType(uri);

            if (isArchive(fileName, mimeType)) {
                File archiveFile = copyUriToCache(resolver, uri, fileName);
                notifyListeners("fileOpen", createArchiveResult(archiveFile, fileName, mimeType, size, uri.toString()), true);
                return;
            }
            if (!isViewableFile(fileName)) {
                notifyListeners("fileOpen", createUnsupportedFileResult(fileName), true);
                return;
            }

            File cachedFile = copyUriToCache(resolver, uri, fileName);
            notifyListeners("fileOpen", createResult(uri, fileName, mimeType, size, cachedFile.getAbsolutePath()), true);
        } catch (SecurityException exception) {
            JSObject error = new JSObject();
            error.put("hasFile", false);
            error.put("error", "文件访问权限已失效，请重新选择文件。");
            error.put("errorCode", "PERMISSION_EXPIRED");
            notifyListeners("fileOpen", error, true);
        } catch (FileNotFoundException exception) {
            JSObject error = new JSObject();
            error.put("hasFile", false);
            error.put("error", "文件不存在或已被删除。");
            error.put("errorCode", "FILE_NOT_FOUND");
            notifyListeners("fileOpen", error, true);
        } catch (Exception exception) {
            JSObject error = new JSObject();
            error.put("hasFile", false);
            error.put("error", "无法读取外部文件：" + exception.getMessage());
            error.put("errorCode", "UNKNOWN");
            notifyListeners("fileOpen", error, true);
        }
    }

    @PluginMethod
    public void readFileChunk(PluginCall call) {
        ioExecutor.execute(() -> {
            String path = call.getString("path");
            long offset = call.getLong("offset", 0L);
            int requestedLength = call.getInt("length", FILE_CHUNK_SIZE);
            try {
                File file = resolveAllowedFile(path);
                int length = Math.max(1, Math.min(FILE_CHUNK_SIZE, requestedLength));
                byte[] bytes = new byte[length];
                int read;
                try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                    input.seek(Math.max(0L, offset));
                    read = input.read(bytes);
                }
                int bytesRead = Math.max(0, read);
                JSObject result = new JSObject();
                result.put("base64Content", bytesRead == 0 ? "" : Base64.encodeToString(bytes, 0, bytesRead, Base64.NO_WRAP));
                result.put("bytesRead", bytesRead);
                result.put("done", offset + bytesRead >= file.length());
                result.put("size", file.length());
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法读取文件分块：" + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void releaseStoredFile(PluginCall call) {
        ioExecutor.execute(() -> {
            String path = call.getString("path");
            try {
                File file = resolveAllowedFile(path);
                boolean deleted = !file.exists() || file.delete();
                JSObject result = new JSObject();
                result.put("deleted", deleted);
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法清理临时文件：" + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void releaseArchive(PluginCall call) {
        ioExecutor.execute(() -> {
            String storageId = call.getString("storageId");
            try {
                File directory = resolveArchiveDirectory(storageId);
                deleteRecursively(directory);
                deleteRecursively(resolvePackageDirectory(storageId));
                JSObject result = new JSObject();
                result.put("deleted", !directory.exists());
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法清理压缩包目录：" + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void cleanupArchives(PluginCall call) {
        ioExecutor.execute(() -> {
            try {
                Set<String> validIds = new HashSet<>();
                JSArray storageIds = call.getArray("storageIds", new JSArray());
                for (Object value : storageIds.toList()) validIds.add(String.valueOf(value));
                File archivesRoot = new File(getContext().getFilesDir(), "archives");
                File[] directories = archivesRoot.listFiles();
                int deleted = 0;
                if (directories != null) {
                    for (File directory : directories) {
                        if (directory.isDirectory() && !validIds.contains(directory.getName())) {
                            deleteRecursively(directory);
                            if (!directory.exists()) deleted += 1;
                        }
                    }
                }
                File packagesRoot = new File(getContext().getFilesDir(), "packages");
                File[] packageDirectories = packagesRoot.listFiles();
                if (packageDirectories != null) {
                    for (File directory : packageDirectories) {
                        if (directory.isDirectory() && !validIds.contains(directory.getName())) {
                            deleteRecursively(directory);
                            if (!directory.exists()) deleted += 1;
                        }
                    }
                }
                JSObject result = new JSObject();
                result.put("deleted", deleted);
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法清理孤立资源目录：" + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void getStorageStatus(PluginCall call) {
        ioExecutor.execute(() -> {
            File filesRoot = getContext().getFilesDir();
            File cacheRoot = getContext().getCacheDir();
            JSObject result = new JSObject();
            result.put("durableBytes", directorySize(new File(filesRoot, "packages")));
            result.put("regenerableBytes", regenerableArchiveSize());
            result.put("openQueueBytes", directorySize(new File(filesRoot, "open-queue")));
            result.put("shareBytes", directorySize(new File(cacheRoot, "share")));
            result.put("freeBytes", filesRoot.getUsableSpace());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void clearRegenerableCache(PluginCall call) {
        ioExecutor.execute(() -> {
            long limit = Math.max(0L, call.getLong("limitMb", 256L)) * 1024L * 1024L;
            boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
            File archivesRoot = new File(getContext().getFilesDir(), "archives");
            File[] directories = archivesRoot.listFiles(File::isDirectory);
            List<File> candidates = new ArrayList<>();
            long total = 0L;
            if (directories != null) {
                for (File directory : directories) {
                    if (!hasPackageOriginal(directory.getName())) continue;
                    candidates.add(directory);
                    total += directorySize(directory);
                }
            }
            candidates.sort(Comparator.comparingLong(File::lastModified));
            int deleted = 0;
            long target = force ? 0L : limit;
            for (File directory : candidates) {
                if (total <= target) break;
                long bytes = directorySize(directory);
                deleteRecursively(directory);
                if (!directory.exists()) {
                    total = Math.max(0L, total - bytes);
                    deleted += 1;
                }
            }
            cleanupOldShareFiles(new File(getContext().getCacheDir(), "share"));
            JSObject result = new JSObject();
            result.put("deleted", deleted);
            result.put("remainingBytes", total);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void openArchiveEntry(PluginCall call) {
        ioExecutor.execute(() -> {
            try {
                String storageId = call.getString("storageId");
                String relativePath = call.getString("relativePath");
                File directory = resolveArchiveDirectory(storageId);
                File target = new File(directory, relativePath == null ? "" : relativePath).getCanonicalFile();
                if (!isWithin(directory, target) || !target.isFile() || !isViewableFile(target.getName())) {
                    throw new SecurityException("压缩包条目不存在或不可读取");
                }
                directory.setLastModified(System.currentTimeMillis());
                JSObject result = new JSObject();
                result.put("cachedPath", target.getAbsolutePath());
                result.put("size", target.length());
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法打开压缩包条目：" + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void getArchiveResources(PluginCall call) {
        ioExecutor.execute(() -> {
            try {
                File directory = resolveArchiveDirectory(call.getString("storageId"));
                directory.setLastModified(System.currentTimeMillis());
                List<File> files = new ArrayList<>();
                collectFiles(directory, files);
                JSObject result = new JSObject();
                result.put("resources", buildResourceMap(directory, files));
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法读取压缩包资源：" + exception.getMessage(), exception);
            }
        });
    }

    private File resolveAllowedFile(String path) throws Exception {
        if (path == null || path.isEmpty()) {
            throw new IllegalArgumentException("文件路径为空");
        }
        File target = new File(path).getCanonicalFile();
        File cacheRoot = getContext().getCacheDir().getCanonicalFile();
        File filesRoot = getContext().getFilesDir().getCanonicalFile();
        if (!isWithin(cacheRoot, target) && !isWithin(filesRoot, target)) {
            throw new SecurityException("文件不在 App 私有目录内");
        }
        return target;
    }

    private File resolveArchiveDirectory(String storageId) throws Exception {
        if (storageId == null || storageId.isEmpty()) {
            throw new IllegalArgumentException("压缩包存储标识为空");
        }
        File archivesRoot = new File(getContext().getFilesDir(), "archives").getCanonicalFile();
        File target = new File(archivesRoot, storageId).getCanonicalFile();
        if (!isWithin(archivesRoot, target)) {
            throw new SecurityException("压缩包目录越界");
        }
        return target;
    }

    private File resolvePackageDirectory(String storageId) throws Exception {
        if (storageId == null || storageId.isEmpty()) throw new IllegalArgumentException("压缩包存储标识为空");
        File packagesRoot = new File(getContext().getFilesDir(), "packages").getCanonicalFile();
        File target = new File(packagesRoot, storageId).getCanonicalFile();
        if (!isWithin(packagesRoot, target)) throw new SecurityException("压缩包原文件目录越界");
        return target;
    }

    private boolean isWithin(File root, File target) {
        return ArchiveSafety.isWithin(root, target);
    }

    private JSObject createResult(Uri uri, String fileName, String mimeType, long size, String cachedPath) {
        JSObject result = new JSObject();
        result.put("hasFile", true);
        result.put("uri", uri.toString());
        result.put("fileName", fileName);
        result.put("mimeType", mimeType);
        result.put("size", size);
        result.put("cachedPath", cachedPath);
        return result;
    }

    private JSObject createArchiveResult(File archiveFile, String archiveName, String mimeType, long archiveSize, String sourceUri) throws Exception {
        String sha256 = sha256(archiveFile);
        File extractDir = createExtractDir(sha256);
        File completeMarker = new File(extractDir, ".complete");
        if (!completeMarker.exists() && archiveFile.length() >= 20L * 1024L * 1024L
            && getContext().getFilesDir().getUsableSpace() < LOW_STORAGE_THRESHOLD) {
            throw new IllegalStateException("剩余空间低于 500 MB，无法解压大型文档包");
        }
        File packageDirectory = resolvePackageDirectory(sha256);
        if (!packageDirectory.exists() && !packageDirectory.mkdirs()) throw new IllegalStateException("无法创建压缩包存储目录");
        File originalFile = new File(packageDirectory, "original." + getExtension(archiveName));
        if (!originalFile.exists()) {
            try (InputStream input = new FileInputStream(archiveFile); OutputStream output = new FileOutputStream(originalFile)) {
                copy(input, output);
            }
        }

        try {
            if (!completeMarker.exists()) {
                File[] stale = extractDir.listFiles();
                if (stale != null) for (File item : stale) deleteRecursively(item);
                String extension = getExtension(archiveName);
                if ("zip".equals(extension)) {
                    extractZip(archiveFile, extractDir);
                } else if ("rar".equals(extension)) {
                    extractRar(archiveFile, extractDir);
                } else {
                    throw new IllegalArgumentException("暂不支持该压缩包格式。");
                }
                if (!completeMarker.createNewFile()) throw new IllegalStateException("无法完成压缩包导入");
            }

            List<File> extractedFiles = new ArrayList<>();
            collectFiles(extractDir, extractedFiles);
            if (extractedFiles.isEmpty()) {
                deleteRecursively(extractDir);
                return createNoViewableFileResult("压缩包解压后没有文件，已清理临时目录。");
            }

            List<File> viewableFiles = new ArrayList<>();
            for (File file : extractedFiles) {
                if (isViewableFile(file.getName())) {
                    viewableFiles.add(file);
                }
            }

            if (viewableFiles.isEmpty()) {
                deleteRecursively(extractDir);
                return createNoViewableFileResult("压缩包中没有 Markdown 或 HTML 文件，已清理临时目录。");
            }

            viewableFiles.sort((left, right) -> {
                String leftPath;
                String rightPath;
                try {
                    leftPath = relativePath(extractDir, left);
                    rightPath = relativePath(extractDir, right);
                } catch (Exception exception) {
                    leftPath = left.getName();
                    rightPath = right.getName();
                }
                int priority = archiveEntryPriority(leftPath) - archiveEntryPriority(rightPath);
                return priority != 0 ? priority : String.CASE_INSENSITIVE_ORDER.compare(leftPath, rightPath);
            });

            JSObject result = new JSObject();
            result.put("hasFile", true);
            result.put("isArchive", true);
            result.put("fileName", archiveName);
            result.put("mimeType", mimeType);
            result.put("size", archiveSize);
            result.put("uri", sourceUri);
            result.put("storageId", extractDir.getName());
            result.put("sha256", sha256);
            result.put("originalPath", originalFile.getAbsolutePath());
            result.put("extractedDir", extractDir.getAbsolutePath());
            result.put("documents", buildArchiveDocuments(extractDir, viewableFiles, archiveName, sourceUri));
            result.put("resources", buildResourceMap(extractDir, extractedFiles));
            return result;
        } catch (RarException exception) {
            deleteRecursively(extractDir);
            JSObject result = new JSObject();
            result.put("hasFile", false);
            result.put("error", "RAR 解压失败。当前解压库不支持 RAR5 或加密压缩包，请改用 ZIP 或 RAR4。");
            result.put("errorCode", "ARCHIVE_FAILED");
            return result;
        } catch (Exception exception) {
            deleteRecursively(extractDir);
            throw exception;
        } finally {
            if (archiveFile.exists()) archiveFile.delete();
        }
    }

    private JSObject createNoViewableFileResult(String message) {
        JSObject result = new JSObject();
        result.put("hasFile", false);
        result.put("error", message);
        result.put("errorCode", "NO_VIEWABLE_FILE");
        return result;
    }

    private JSObject createUnsupportedFileResult(String fileName) {
        JSObject result = new JSObject();
        result.put("hasFile", false);
        result.put("error", "暂不支持该文件类型：" + fileName);
        result.put("errorCode", "UNSUPPORTED_TYPE");
        return result;
    }

    private Uri resolveIntentUri(Intent intent) {
        if (intent == null) {
            return null;
        }

        Uri data = intent.getData();
        if (data != null) {
            return data;
        }

        Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream instanceof Uri) {
            return (Uri) stream;
        }

        ClipData clipData = intent.getClipData();
        if (clipData != null && clipData.getItemCount() > 0) {
            Uri clipUri = clipData.getItemAt(0).getUri();
            if (clipUri != null) {
                return clipUri;
            }
        }

        return null;
    }

    private String resolveFileName(ContentResolver resolver, Uri uri) {
        String fallback = uri.getLastPathSegment();
        if (fallback == null || fallback.isEmpty()) {
            fallback = "未命名.md";
        }

        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return fallback;
        }

        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        }

        return fallback;
    }

    private long resolveFileSize(ContentResolver resolver, Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return -1;
        }

        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0) {
                    return cursor.getLong(index);
                }
            }
        }

        return -1;
    }

    private File copyUriToCache(ContentResolver resolver, Uri uri, String fileName) throws Exception {
        File archiveFile = new File(getContext().getCacheDir(), "open-" + System.currentTimeMillis() + "-" + sanitizeName(fileName));
        try {
            try (InputStream input = resolver.openInputStream(uri);
                 FileOutputStream output = new FileOutputStream(archiveFile)) {
                if (input == null) {
                    throw new IllegalStateException("文件流为空");
                }
                copyWithLimit(input, output, MAX_OPEN_FILE_SIZE);
            }
            return archiveFile;
        } catch (Exception exception) {
            archiveFile.delete();
            throw exception;
        }
    }

    private File createExtractDir(String storageId) {
        File archivesRoot = new File(getContext().getFilesDir(), "archives");
        File extractDir = new File(archivesRoot, storageId);
        if (!extractDir.mkdirs() && !extractDir.isDirectory()) {
            throw new IllegalStateException("无法创建本地解压目录");
        }
        return extractDir;
    }

    private int archiveEntryPriority(String path) {
        String normalized = path.replace('\\', '/').toLowerCase(Locale.ROOT);
        if (normalized.equals("readme.md") || normalized.endsWith("/readme.md")) return 0;
        if (normalized.matches("(?:.*/)?index\\.(?:md|html?|xhtml)")) return 1;
        return 2;
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        try (InputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder value = new StringBuilder();
        for (byte item : digest.digest()) value.append(String.format(Locale.ROOT, "%02x", item));
        return value.toString();
    }

    private void extractZip(File archiveFile, File extractDir) throws Exception {
        int entryCount = 0;
        long expandedSize = 0L;
        try (ZipInputStream input = new ZipInputStream(new java.io.FileInputStream(archiveFile))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                entryCount += 1;
                validateArchiveEntry(entry.getName(), entryCount, entry.getSize(), entry.getCompressedSize(), expandedSize);
                File target = resolveSafeOutputFile(extractDir, entry.getName());
                if (entry.isDirectory()) {
                    if (!target.mkdirs() && !target.isDirectory()) {
                        throw new IllegalStateException("无法创建目录：" + entry.getName());
                    }
                } else {
                    File parent = target.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs()) {
                        throw new IllegalStateException("无法创建目录：" + parent.getName());
                    }
                    try (FileOutputStream output = new FileOutputStream(target)) {
                        long remaining = Math.min(MAX_ARCHIVE_ENTRY_SIZE, MAX_ARCHIVE_EXPANDED_SIZE - expandedSize);
                        long written = copyWithLimit(input, output, remaining);
                        expandedSize += written;
                        validateCompressionRatio(entry.getName(), written, entry.getCompressedSize());
                    }
                }
                input.closeEntry();
            }
        }
    }

    private void extractRar(File archiveFile, File extractDir) throws Exception {
        int entryCount = 0;
        long expandedSize = 0L;
        try (Archive archive = new Archive(archiveFile)) {
            FileHeader header;
            while ((header = archive.nextFileHeader()) != null) {
                entryCount += 1;
                String entryName = resolveRarEntryName(header);
                validateArchiveEntry(entryName, entryCount, header.getFullUnpackSize(), header.getFullPackSize(), expandedSize);
                File target = resolveSafeOutputFile(extractDir, entryName);
                if (header.isDirectory()) {
                    if (!target.mkdirs() && !target.isDirectory()) {
                        throw new IllegalStateException("无法创建目录：" + entryName);
                    }
                } else {
                    File parent = target.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs()) {
                        throw new IllegalStateException("无法创建目录：" + parent.getName());
                    }
                    try (FileOutputStream output = new FileOutputStream(target)) {
                        archive.extractFile(header, output);
                    }
                    long written = target.length();
                    if (written > MAX_ARCHIVE_ENTRY_SIZE) {
                        throw new SecurityException("压缩包单文件超过 20 MB 安全上限：" + entryName);
                    }
                    expandedSize += written;
                    if (expandedSize > MAX_ARCHIVE_EXPANDED_SIZE) {
                        throw new SecurityException("压缩包展开总量超过 200 MB 安全上限");
                    }
                    validateCompressionRatio(entryName, written, header.getFullPackSize());
                }
            }
        }
    }

    private void validateArchiveEntry(String entryName, int entryCount, long expandedSize, long compressedSize, long currentTotal) {
        ArchiveSafety.validateEntry(
            entryName,
            entryCount,
            expandedSize,
            compressedSize,
            currentTotal,
            MAX_ARCHIVE_ENTRIES,
            MAX_ARCHIVE_DEPTH,
            MAX_ARCHIVE_ENTRY_SIZE,
            MAX_ARCHIVE_EXPANDED_SIZE,
            MAX_ARCHIVE_RATIO
        );
    }

    private void validateCompressionRatio(String entryName, long expandedSize, long compressedSize) {
        if (expandedSize > 0 && compressedSize > 0 && expandedSize / Math.max(1L, compressedSize) > MAX_ARCHIVE_RATIO) {
            throw new SecurityException("压缩比超过 100:1 安全上限：" + entryName);
        }
    }

    private File resolveSafeOutputFile(File extractDir, String entryName) throws Exception {
        String normalizedName = entryName.replace('\\', '/');
        File target = new File(extractDir, normalizedName);
        String basePath = extractDir.getCanonicalPath() + File.separator;
        String targetPath = target.getCanonicalPath();
        if (!targetPath.startsWith(basePath)) {
            throw new SecurityException("压缩包包含非法路径：" + entryName);
        }
        return target;
    }

    private JSArray buildArchiveDocuments(File extractDir, List<File> files, String archiveName, String sourceUri) throws Exception {
        JSArray documents = new JSArray();
        for (File file : files) {
            JSObject document = new JSObject();
            String relativePath = relativePath(extractDir, file);
            document.put("fileName", file.getName());
            document.put("relativePath", relativePath);
            document.put("archiveName", archiveName);
            document.put("sourceUri", sourceUri);
            document.put("size", file.length());
            document.put("cachedPath", file.getAbsolutePath());
            documents.put(document);
        }
        return documents;
    }

    private JSObject buildResourceMap(File extractDir, List<File> files) throws Exception {
        JSObject resources = new JSObject();
        for (File file : files) {
            if (isViewableFile(file.getName()) || file.length() > MAX_ARCHIVE_ENTRY_SIZE) {
                continue;
            }

            String mime = inferResourceMime(file.getName());
            if (mime == null) {
                continue;
            }

            String key = normalizeResourceKey(relativePath(extractDir, file));
            JSObject resource = new JSObject();
            resource.put("mimeType", mime);
            resource.put("path", file.getAbsolutePath());
            resource.put("size", file.length());
            resources.put(key, resource);
        }
        return resources;
    }

    private void collectFiles(File root, List<File> files) {
        File[] children = root.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            if (child.isDirectory()) {
                collectFiles(child, files);
            } else {
                files.add(child);
            }
        }
    }

    private boolean hasPackageOriginal(String storageId) {
        try {
            File packageDirectory = resolvePackageDirectory(storageId);
            File[] originals = packageDirectory.listFiles((directory, name) -> name.startsWith("original."));
            return originals != null && originals.length > 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    private long regenerableArchiveSize() {
        File[] directories = new File(getContext().getFilesDir(), "archives").listFiles(File::isDirectory);
        long total = 0L;
        if (directories != null) {
            for (File directory : directories) if (hasPackageOriginal(directory.getName())) total += directorySize(directory);
        }
        return total;
    }

    private long directorySize(File file) {
        if (file == null || !file.exists()) return 0L;
        if (file.isFile()) return Math.max(0L, file.length());
        long total = 0L;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) total += directorySize(child);
        return total;
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        file.delete();
    }

    private void copy(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
    }

    private long copyWithLimit(InputStream input, OutputStream output, long limit) throws Exception {
        if (limit <= 0) {
            throw new SecurityException("压缩包展开总量超过安全上限");
        }
        byte[] buffer = new byte[8192];
        long total = 0L;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > limit) {
                throw new SecurityException("压缩包条目展开后超过安全上限");
            }
            output.write(buffer, 0, read);
        }
        return total;
    }

    private boolean isArchive(String fileName, String mimeType) {
        String extension = getExtension(fileName);
        return ARCHIVE_EXTENSIONS.contains(extension)
            || "application/zip".equalsIgnoreCase(mimeType)
            || "application/x-zip".equalsIgnoreCase(mimeType)
            || "application/x-zip-compressed".equalsIgnoreCase(mimeType)
            || "multipart/x-zip".equalsIgnoreCase(mimeType)
            || "application/x-compressed".equalsIgnoreCase(mimeType)
            || "application/rar".equalsIgnoreCase(mimeType)
            || "application/vnd.rar".equalsIgnoreCase(mimeType)
            || "application/x-rar".equalsIgnoreCase(mimeType)
            || "application/x-rar-compressed".equalsIgnoreCase(mimeType);
    }

    private boolean isViewableFile(String fileName) {
        return VIEWABLE_EXTENSIONS.contains(getExtension(fileName));
    }

    private String inferResourceMime(String fileName) {
        String extension = getExtension(fileName);
        switch (extension) {
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "webp":
                return "image/webp";
            case "gif":
                return "image/gif";
            case "svg":
                return "image/svg+xml";
            case "css":
                return "text/css";
            default:
                return null;
        }
    }

    private String resolveRarEntryName(FileHeader header) {
        String name = header.getFileName();
        if (name != null && !name.isEmpty() && !looksMojibake(name)) {
            return name;
        }

        byte[] bytes = header.getFileNameByteArray();
        String gb18030Name = decodeFileName(bytes, Charset.forName("GB18030"));
        if (!gb18030Name.isEmpty() && !looksMojibake(gb18030Name)) {
            return gb18030Name;
        }

        String gbkName = decodeFileName(bytes, Charset.forName("GBK"));
        if (!gbkName.isEmpty() && !looksMojibake(gbkName)) {
            return gbkName;
        }

        String utf8Name = decodeFileName(bytes, StandardCharsets.UTF_8);
        return utf8Name.isEmpty() ? name : utf8Name;
    }

    private String decodeFileName(byte[] bytes, Charset charset) {
        if (bytes == null || bytes.length == 0) {
            return "";
        }

        int length = bytes.length;
        for (int index = 0; index < bytes.length; index += 1) {
            if (bytes[index] == 0) {
                length = index;
                break;
            }
        }

        return new String(bytes, 0, length, charset).trim();
    }

    private boolean looksMojibake(String value) {
        if (value == null || value.isEmpty()) {
            return true;
        }

        int suspicious = 0;
        for (int index = 0; index < value.length(); index += 1) {
            char current = value.charAt(index);
            if (current == '\uFFFD' || current == '�' || current == '?' || current == 'Ã' || current == 'Â') {
                suspicious += 1;
            }
        }

        return suspicious >= Math.max(1, value.length() / 8);
    }

    private String getExtension(String fileName) {
        int index = fileName == null ? -1 : fileName.lastIndexOf('.');
        if (index < 0 || index >= fileName.length() - 1) {
            return "";
        }
        return fileName.substring(index + 1).toLowerCase(Locale.ROOT);
    }

    private String stripExtension(String fileName) {
        int index = fileName.lastIndexOf('.');
        return index > 0 ? fileName.substring(0, index) : fileName;
    }

    private String sanitizeName(String name) {
        String safe = name == null ? "archive" : name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return safe.isEmpty() ? "archive" : safe;
    }

    private String relativePath(File root, File file) throws Exception {
        String rootPath = root.getCanonicalPath();
        String filePath = file.getCanonicalPath();
        String relative = filePath.substring(rootPath.length());
        if (relative.startsWith(File.separator)) {
            relative = relative.substring(1);
        }
        return relative.replace(File.separatorChar, '/');
    }

    private String normalizeResourceKey(String path) {
        return path.replace('\\', '/').replaceAll("^/+", "").toLowerCase(Locale.ROOT);
    }
}
