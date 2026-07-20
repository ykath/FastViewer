package com.fastviewer.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

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

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
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

    private static Intent latestIntent;
    private static FastViewerFilesPlugin activePlugin;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();

    public static void setLatestIntent(Intent intent) {
        latestIntent = intent;
    }

    public static void handleNewIntent(Intent intent) {
        latestIntent = intent;
        if (activePlugin != null) {
            activePlugin.notifyFileOpen(intent);
        }
    }

    @Override
    public void load() {
        activePlugin = this;
        ioExecutor.execute(() -> {
            cleanupOldShareFiles(new File(getContext().getCacheDir(), "share"));
            cleanupTransientOpenFiles();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (activePlugin == this) {
            activePlugin = null;
        }
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        ioExecutor.execute(() -> getLaunchFileInBackground(call));
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
        Intent intent = latestIntent != null ? latestIntent : getActivity().getIntent();
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
    }

    private void cleanupTransientOpenFiles() {
        File[] files = getContext().getCacheDir().listFiles();
        if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (file.isFile() && (name.startsWith("open-") || name.startsWith("picked-"))) file.delete();
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
                JSObject result = new JSObject();
                result.put("deleted", deleted);
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("无法清理孤立资源目录：" + exception.getMessage(), exception);
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
        File extractDir = createExtractDir(archiveName);

        try {
            String extension = getExtension(archiveName);
            if ("zip".equals(extension)) {
                extractZip(archiveFile, extractDir);
            } else if ("rar".equals(extension)) {
                extractRar(archiveFile, extractDir);
            } else {
                throw new IllegalArgumentException("暂不支持该压缩包格式。");
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

            viewableFiles.sort(Comparator.comparing(File::getName, String.CASE_INSENSITIVE_ORDER));

            JSObject result = new JSObject();
            result.put("hasFile", true);
            result.put("isArchive", true);
            result.put("fileName", archiveName);
            result.put("mimeType", mimeType);
            result.put("size", archiveSize);
            result.put("uri", sourceUri);
            result.put("storageId", extractDir.getName());
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

    private File createExtractDir(String archiveName) {
        File archivesRoot = new File(getContext().getFilesDir(), "archives");
        File extractDir = new File(archivesRoot, System.currentTimeMillis() + "-" + stripExtension(sanitizeName(archiveName)));
        if (!extractDir.mkdirs() && !extractDir.isDirectory()) {
            throw new IllegalStateException("无法创建本地解压目录");
        }
        return extractDir;
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
