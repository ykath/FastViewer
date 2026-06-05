package com.fastviewer.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.github.junrar.Archive;
import com.github.junrar.exception.RarException;
import com.github.junrar.rarfile.FileHeader;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
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
    private static final long RESOURCE_INLINE_LIMIT = 15L * 1024L * 1024L;
    private static final long RESOURCE_INLINE_TOTAL_LIMIT = 40L * 1024L * 1024L;

    private static Intent latestIntent;
    private static FastViewerFilesPlugin activePlugin;

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
    }

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
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

            String base64Content = readBase64(resolver, uri);

            call.resolve(createResult(uri, fileName, mimeType, size, base64Content));
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

            String base64Content = readBase64(resolver, uri);
            notifyListeners("fileOpen", createResult(uri, fileName, mimeType, size, base64Content), true);
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

    private JSObject createResult(Uri uri, String fileName, String mimeType, long size, String base64Content) {
        JSObject result = new JSObject();
        result.put("hasFile", true);
        result.put("uri", uri.toString());
        result.put("fileName", fileName);
        result.put("mimeType", mimeType);
        result.put("size", size);
        result.put("base64Content", base64Content);
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
        }
    }

    private JSObject createNoViewableFileResult(String message) {
        JSObject result = new JSObject();
        result.put("hasFile", false);
        result.put("error", message);
        result.put("errorCode", "NO_VIEWABLE_FILE");
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

    private String readBase64(ContentResolver resolver, Uri uri) throws Exception {
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) {
                throw new IllegalStateException("文件流为空");
            }

            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }

            return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        }
    }

    private File copyUriToCache(ContentResolver resolver, Uri uri, String fileName) throws Exception {
        File archiveFile = new File(getContext().getCacheDir(), "open-" + System.currentTimeMillis() + "-" + sanitizeName(fileName));
        try (InputStream input = resolver.openInputStream(uri);
             FileOutputStream output = new FileOutputStream(archiveFile)) {
            if (input == null) {
                throw new IllegalStateException("文件流为空");
            }
            copy(input, output);
        }
        return archiveFile;
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
        try (ZipInputStream input = new ZipInputStream(new java.io.FileInputStream(archiveFile))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
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
                        copy(input, output);
                    }
                }
                input.closeEntry();
            }
        }
    }

    private void extractRar(File archiveFile, File extractDir) throws Exception {
        try (Archive archive = new Archive(archiveFile)) {
            FileHeader header;
            while ((header = archive.nextFileHeader()) != null) {
                String entryName = resolveRarEntryName(header);
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
                }
            }
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
            document.put("base64Content", readFileBase64(file));
            documents.put(document);
        }
        return documents;
    }

    private JSObject buildResourceMap(File extractDir, List<File> files) throws Exception {
        JSObject resources = new JSObject();
        long total = 0L;
        for (File file : files) {
            if (isViewableFile(file.getName()) || file.length() > RESOURCE_INLINE_LIMIT) {
                continue;
            }

            String mime = inferResourceMime(file.getName());
            if (mime == null) {
                continue;
            }

            total += file.length();
            if (total > RESOURCE_INLINE_TOTAL_LIMIT) {
                break;
            }

            String key = normalizeResourceKey(relativePath(extractDir, file));
            String dataUri = "data:" + mime + ";base64," + readFileBase64(file);
            resources.put(key, dataUri);
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

    private String readFileBase64(File file) throws Exception {
        try (InputStream input = new java.io.FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            copy(input, output);
            return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        }
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
