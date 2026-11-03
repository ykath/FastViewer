package com.fastviewer.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ExternalFileTypeTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private ExternalFileType resolve(byte[] bytes, String name, String mime) throws Exception {
        File file = temporary.newFile();
        Files.write(file.toPath(), bytes);
        ExternalFileType type = ExternalFileType.resolve(file, name, mime);
        assertTrue("识别文件不得删除队列原件", file.exists());
        assertEquals(bytes.length, file.length());
        return type;
    }

    @Test
    public void markdownExtensionsOverrideIncorrectArchiveMimeTypes() throws Exception {
        for (String extension : new String[] { "md", "MARKDOWN", "mdown" }) {
            for (String mime : new String[] { "application/vnd.rar", "application/x-rar-compressed", "application/zip", "application/octet-stream", null }) {
                String name = "微信文档." + extension;
                ExternalFileType type = resolve("# 标题\n正文".getBytes(StandardCharsets.UTF_8), name, mime);
                assertEquals(ExternalFileType.Kind.MARKDOWN, type.kind);
                assertEquals(name, type.fileName);
                assertEquals("text/markdown", type.mimeType);
                assertFalse(type.isArchive());
                assertFalse(ExternalFileType.isArchiveHint(name, mime));
            }
        }
    }

    @Test
    public void htmlExtensionsOverrideIncorrectArchiveMimeTypes() throws Exception {
        for (String extension : new String[] { "html", "HTM", "xhtml" }) {
            ExternalFileType type = resolve("<h1>标题</h1>".getBytes(StandardCharsets.UTF_8), "页面." + extension, "application/vnd.rar");
            assertEquals(ExternalFileType.Kind.HTML, type.kind);
            assertEquals("text/html", type.mimeType);
        }
    }

    @Test
    public void textWithTemporaryArchiveSuffixOpensAsMarkdown() throws Exception {
        ExternalFileType type = resolve("# 微信文件\n\n- 内容\n".getBytes(StandardCharsets.UTF_8), "聊天文件.rar", "application/vnd.rar");
        assertEquals(ExternalFileType.Kind.MARKDOWN, type.kind);
        assertEquals("聊天文件.md", type.fileName);
        assertTrue(type.isDocument());
        assertFalse(type.isArchive());
    }

    @Test
    public void extensionlessTextWithArchiveMimeOpensAsMarkdown() throws Exception {
        ExternalFileType type = resolve("正文".getBytes(StandardCharsets.UTF_8), "共享文件", "application/x-rar-compressed; charset=utf-8");
        assertEquals(ExternalFileType.Kind.MARKDOWN, type.kind);
        assertEquals("共享文件.md", type.fileName);
    }

    @Test
    public void htmlWithTemporaryArchiveSuffixPreservesHtmlRendering() throws Exception {
        ExternalFileType type = resolve("\uFEFF\n<!DOCTYPE html><html><body>正文</body></html>".getBytes(StandardCharsets.UTF_8), "页面.zip", "application/zip");
        assertEquals(ExternalFileType.Kind.HTML, type.kind);
        assertEquals("页面.html", type.fileName);
    }

    @Test
    public void textFallbackSupportsChineseAndBomEncodings() throws Exception {
        for (String encoding : new String[] { "GB18030", "UTF-16", "UTF-16LE" }) {
            String text = encoding.equals("UTF-16LE") ? "\uFEFF# 微信文档\n正文" : "# 微信文档\n正文";
            ExternalFileType type = resolve(text.getBytes(Charset.forName(encoding)), "文档.rar", "application/vnd.rar");
            assertEquals(ExternalFileType.Kind.MARKDOWN, type.kind);
        }
    }

    @Test
    public void textSampleMayEndInMiddleOfUtf8Character() throws Exception {
        String text = "a".repeat(8191) + "中文正文";
        ExternalFileType type = resolve(text.getBytes(StandardCharsets.UTF_8), "大文档.rar", "application/vnd.rar");
        assertEquals(ExternalFileType.Kind.MARKDOWN, type.kind);
    }

    @Test
    public void zipSignatureOverridesMisleadingNameAndMime() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("README.md"));
            zip.write("# 正文".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        for (String name : new String[] { "资料.rar", "资料.md", "资料" }) {
            ExternalFileType type = resolve(bytes.toByteArray(), name, "application/vnd.rar");
            assertEquals(ExternalFileType.Kind.ZIP, type.kind);
            assertEquals("资料.zip", type.fileName);
            assertTrue(type.isArchive());
        }
        bytes.reset();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.finish();
        }
        assertEquals(ExternalFileType.Kind.ZIP, resolve(bytes.toByteArray(), "空包.zip", "text/plain").kind);
    }

    @Test
    public void realRar4AndRar5StillReachTheRarExtractor() throws Exception {
        for (byte[] signature : new byte[][] {
            { 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00 },
            { 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00 }
        }) {
            ExternalFileType type = resolve(signature, "文档包.zip", "application/octet-stream");
            assertEquals(ExternalFileType.Kind.RAR, type.kind);
            assertEquals("文档包.rar", type.fileName);
        }
    }

    @Test
    public void invalidArchiveBinaryAndEmptyArchiveDoNotBecomeTextDocuments() throws Exception {
        for (byte[] bytes : new byte[][] { { 0x52, 0x61, 0x72, 0x00, 0x01 }, new byte[0] }) {
            try {
                resolve(bytes, "损坏.rar", "application/vnd.rar");
                fail("应拒绝无有效文件头的二进制压缩包");
            } catch (java.io.IOException expected) {
                assertTrue(expected.getMessage().contains("不是有效的 ZIP / RAR"));
            }
        }
    }

    @Test
    public void binaryCannotHideBehindUtf16Bom() throws Exception {
        byte[] binary = new byte[32];
        Arrays.fill(binary, (byte) 0);
        binary[0] = (byte) 0xff;
        binary[1] = (byte) 0xfe;
        try {
            resolve(binary, "二进制.rar", "application/vnd.rar");
            fail("应拒绝带有 NUL 的二进制内容");
        } catch (java.io.IOException expected) {
            assertTrue(expected.getMessage().contains("不是有效的 ZIP / RAR"));
        }
    }

    @Test
    public void emptyMarkdownAndUnsupportedFilesKeepTheirBehavior() throws Exception {
        assertEquals(ExternalFileType.Kind.MARKDOWN, resolve(new byte[0], "空文档.md", "application/vnd.rar").kind);
        assertEquals(ExternalFileType.Kind.UNSUPPORTED, resolve(new byte[] { 0, 1 }, "文件.pdf", "application/pdf").kind);
    }
}
