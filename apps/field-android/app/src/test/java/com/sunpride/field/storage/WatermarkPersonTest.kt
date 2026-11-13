package com.sunpride.field.storage

import org.junit.Assert.*
import org.junit.Test

/** NF-4: a visit photo always has a verified person name for its watermark, never another person's. */
class WatermarkPersonTest {
    @Test fun snapshotNameWins() =
        assertEquals("Ana", EvidencePhotos.watermarkPerson("Ana", "p1", "p1", "Other"))
    @Test fun aNamelessSnapshotUsesTheNameVerifiedForTheSamePerson() =
        assertEquals("Ana Cruz", EvidencePhotos.watermarkPerson(null, "p1", "p1", "Ana Cruz"))
    @Test fun neverAnotherPersonsNameOrABlank() {
        assertNull(EvidencePhotos.watermarkPerson(null, "p1", "p2", "Someone else"))
        assertNull(EvidencePhotos.watermarkPerson("", "p1", null, null))
        assertNull(EvidencePhotos.watermarkPerson(null, "p1", "p1", " "))
    }
}
