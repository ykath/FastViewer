package com.fastviewer.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.util.Locale;

/** Source apps can provide an archive MIME type or temporary suffix for a text document. */
final class ExternalFileType {
    enum Kind { MARKDOWN, HTML, ZIP, RAR, UNSUPPORTED }

    final Kind kind;
    final String fileName;
    final String mimeType;

    private ExternalFileType(Kind kind, String name, String extension, String mimeType) {
        this.kind = kind;
        this.fileName = extension.isEmpty() || extension(name).equals(extension)
            ? name : replaceExtension(name, extension);
        this.mimeType = mimeType;
    }

    boolean isArchive() {
        return kind == Kind.ZIP || kind == Kind.RAR;
    }

    boolean isDocument() {
        return kind == Kind.MARKDOWN || kind == Kind.HTML;
    }

    static ExternalFileType resolve(File file, String fileName, String mimeType) throws IOException {
        String name = fileName == null || fileName.trim().isEmpty() ? "未命名" : fileName.trim();
        byte[] prefix;
        try (FileInputStream input = new FileInputStream(file)) {
            prefix = new byte[(int) Math.min(file.length(), 8192L)];
            int offset = 0;
            while (offset < prefix.length) {
                int count = input.read(prefix, offset, prefix.length - offset);
                if (count < 0) throw new IOException("文件读取不完整");
                offset += count;
            }
        }

        // Choose the extractor from bytes, never from an untrusted MIME type or suffix.
        if (startsWith(prefix, 0x50, 0x4b, 0x03, 0x04)
            || startsWith(prefix, 0x50, 0x4b, 0x05, 0x06)
            || startsWith(prefix, 0x50, 0x4b, 0x07, 0x08)) {
            return new ExternalFileType(Kind.ZIP, name, "zip", "application/zip");
        }
        if (startsWith(prefix, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00)
            || startsWith(prefix, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00)) {
            return new ExternalFileType(Kind.RAR, name, "rar", "application/vnd.rar");
        }

        String extension = extension(name);
        if (isMarkdown(extension)) return new ExternalFileType(Kind.MARKDOWN, name, "", "text/markdown");
        if (isHtml(extension)) return new ExternalFileType(Kind.HTML, name, "", "text/html");

        if (isArchiveHint(name, mimeType)) {
            String text = decodeText(prefix, file.length() > prefix.length);
            if (text != null) {
                String beginning = text.replace("\uFEFF", "").trim().toLowerCase(Locale.ROOT);
                boolean html = beginning.startsWith("<!doctype html") || beginning.startsWith("<html");
                return html
                    ? new ExternalFileType(Kind.HTML, name, "html", "text/html")
                    : new ExternalFileType(Kind.MARKDOWN, name, "md", "text/markdown");
            }
            throw new IOException("文件内容不是有效的 ZIP / RAR 压缩包，无法按压缩包打开。");
        }
        return new ExternalFileType(Kind.UNSUPPORTED, name, "", mimeType);
    }

    static boolean isArchiveHint(String fileName, String mimeType) {
        String extension = extension(fileName);
        if (isMarkdown(extension) || isHtml(extension)) return false;
        if (extension.equals("zip") || extension.equals("rar")) return true;
        String mime = mimeType == null ? "" : mimeType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        switch (mime) {
            case "application/zip":
            case "application/x-zip":
            case "application/x-zip-compressed":
            case "multipart/x-zip":
            case "application/x-compressed":
            case "application/rar":
            case "application/vnd.rar":
            case "application/x-rar":
            case "application/x-rar-compressed":
                return true;
            default:
                return false;
        }
    }

    private static String decodeText(byte[] bytes, boolean truncated) {
        if (bytes.length == 0) return null;
        String[] encodings = startsWith(bytes, 0xff, 0xfe) ? new String[] { "UTF-16LE" }
            : startsWith(bytes, 0xfe, 0xff) ? new String[] { "UTF-16BE" }
            : new String[] { "UTF-8", "GB18030" };
        for (String encoding : encodings) {
            try {
                // A bounded sample may end halfway through a multibyte character.
                var decoder = Charset.forName(encoding).newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
                var output = java.nio.CharBuffer.allocate(bytes.length);
                var result = decoder.decode(ByteBuffer.wrap(bytes), output, !truncated);
                if (result.isError()) result.throwException();
                output.flip();
                String text = output.toString();
                boolean readable = !text.isEmpty();
                for (int index = 0; index < text.length(); index++) {
                    char value = text.charAt(index);
                    if (Character.isISOControl(value) && value != '\r' && value != '\n' && value != '\t' && value != '\f') {
                        readable = false;
                        break;
                    }
                }
                if (readable) return text;
            } catch (CharacterCodingException ignored) {
                // Try the other supported text encoding before rejecting binary content.
            }
        }
        return null;
    }

    private static boolean startsWith(byte[] bytes, int... signature) {
        if (bytes.length < signature.length) return false;
        for (int index = 0; index < signature.length; index++) {
            if ((bytes[index] & 0xff) != signature[index]) return false;
        }
        return true;
    }

    private static boolean isMarkdown(String extension) {
        return extension.equals("md") || extension.equals("markdown") || extension.equals("mdown");
    }

    private static boolean isHtml(String extension) {
        return extension.equals("html") || extension.equals("htm") || extension.equals("xhtml");
    }

    private static String extension(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String replaceExtension(String name, String extension) {
        int dot = name.lastIndexOf('.');
        return (dot > 0 ? name.substring(0, dot) : name) + "." + extension;
    }
}
