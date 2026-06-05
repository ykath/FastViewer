package com.fastviewer.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "FastViewerFiles")
public class FastViewerFilesPlugin extends Plugin {
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
            String content = readText(resolver, uri);

            call.resolve(createResult(uri, fileName, mimeType, size, content));
        } catch (Exception exception) {
            call.reject("无法读取外部文件：" + exception.getMessage(), exception);
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
            String content = readText(resolver, uri);
            notifyListeners("fileOpen", createResult(uri, fileName, mimeType, size, content), true);
        } catch (Exception exception) {
            JSObject error = new JSObject();
            error.put("hasFile", false);
            error.put("error", "无法读取外部文件：" + exception.getMessage());
            notifyListeners("fileOpen", error, true);
        }
    }

    private JSObject createResult(Uri uri, String fileName, String mimeType, long size, String content) {
        JSObject result = new JSObject();
        result.put("hasFile", true);
        result.put("uri", uri.toString());
        result.put("fileName", fileName);
        result.put("mimeType", mimeType);
        result.put("size", size);
        result.put("content", content);
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

    private String readText(ContentResolver resolver, Uri uri) throws Exception {
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

            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
