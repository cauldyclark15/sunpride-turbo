package com.sunpride.field.diagnostics

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SafeDiagnosticsTest {
    @Test fun redactsCredentialContactLocationSignatureBodyAndName() {
        val secrets = listOf(
            "Bearer session-secret" to "session-secret",
            "abcdefgh.ijklmnop.qrstuvwx" to "ijklmnop",
            "seller@example.test" to "seller@example.test",
            "+63 912 345 6789" to "912 345",
            "lat:14.599512 lng:120.984210" to "14.599512",
            "14.599512,120.984210" to "120.984210",
            "signature: ${"A".repeat(88)}" to "AAAA",
            "name: Juan Dela Cruz" to "Juan",
            "{\"body\":\"private\"}" to "private"
        )
        for ((input, secret) in secrets) assertFalse(Redactor.mask(input).contains(secret))
    }

    @Test fun boundedBreadcrumbsNeverWriteUntrustedEvent() {
        val dir = Files.createTempDirectory("crumb-test").toFile()
        try {
            val crumbs = Breadcrumbs(dir)
            repeat(60) { crumbs.add("sync_started") }
            crumbs.add("Bearer secret seller@example.test")
            assertEquals(50, crumbs.read().size)
            assertEquals("event_redacted", crumbs.read().last())
            assertFalse(File(dir, "field-breadcrumbs").readText().contains("secret"))
        } finally { dir.deleteRecursively() }
    }
}
