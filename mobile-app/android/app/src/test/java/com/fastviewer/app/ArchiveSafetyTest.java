package com.fastviewer.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import org.junit.Test;

public class ArchiveSafetyTest {
    private static void validate(String name, int count, long expanded, long compressed, long total) {
        ArchiveSafety.validateEntry(name, count, expanded, compressed, total, 1000, 20, 20L, 200L, 100L);
    }

    private static void expectBlocked(Runnable action) {
        try {
            action.run();
            fail("预期安全限制阻止输入");
        } catch (SecurityException expected) {
            // 通过
        }
    }

    @Test
    public void rejectsArchiveLimits() {
        expectBlocked(() -> validate("a", 1001, 1, 1, 0));
        expectBlocked(() -> validate("1/2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/17/18/19/20/21/a", 1, 1, 1, 0));
        expectBlocked(() -> validate("large.bin", 1, 21, 1, 0));
        expectBlocked(() -> validate("bomb.bin", 1, 101, 1, 0));
        expectBlocked(() -> validate("total.bin", 1, 20, 20, 190));
    }

    @Test
    public void acceptsNormalEntryAndChecksContainment() throws Exception {
        validate("docs/readme.md", 2, 10, 5, 20);
        File root = new File("build/safe-root").getCanonicalFile();
        assertTrue(ArchiveSafety.isWithin(root, new File(root, "docs/a.md").getCanonicalFile()));
        assertFalse(ArchiveSafety.isWithin(root, new File(root, "../outside.md").getCanonicalFile()));
    }
}
