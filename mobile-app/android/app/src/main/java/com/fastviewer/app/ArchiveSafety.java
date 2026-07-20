package com.fastviewer.app;

import java.io.File;

final class ArchiveSafety {
    private ArchiveSafety() {}

    static void validateEntry(
        String entryName,
        int entryCount,
        long expandedSize,
        long compressedSize,
        long currentTotal,
        int maxEntries,
        int maxDepth,
        long maxEntrySize,
        long maxTotalSize,
        long maxRatio
    ) {
        if (entryCount > maxEntries) throw new SecurityException("压缩包条目数量超过安全上限");
        String normalized = entryName == null ? "" : entryName.replace('\\', '/');
        int depth = 0;
        for (String part : normalized.split("/")) {
            if (!part.isEmpty() && !".".equals(part)) depth += 1;
        }
        if (depth > maxDepth) throw new SecurityException("压缩包目录层级超过安全上限");
        if (expandedSize > maxEntrySize) throw new SecurityException("压缩包单文件超过安全上限");
        if (expandedSize > 0 && currentTotal + expandedSize > maxTotalSize) {
            throw new SecurityException("压缩包展开总量超过安全上限");
        }
        if (expandedSize > 0 && compressedSize > 0
            && expandedSize / Math.max(1L, compressedSize) > maxRatio) {
            throw new SecurityException("压缩比超过安全上限");
        }
    }

    static boolean isWithin(File root, File target) {
        String rootPath = root.getAbsolutePath() + File.separator;
        String targetPath = target.getAbsolutePath();
        return targetPath.equals(root.getAbsolutePath()) || targetPath.startsWith(rootPath);
    }
}
