package com.fastviewer.app;

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
    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Intent intent = getActivity().getIntent();
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

            JSObject result = new JSObject();
            result.put("hasFile", true);
            result.put("uri", uri.toString());
            result.put("fileName", fileName);
            result.put("mimeType", mimeType);
            result.put("size", size);
            result.put("content", content);
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("无法读取外部文件：" + exception.getMessage(), exception);
        }
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
