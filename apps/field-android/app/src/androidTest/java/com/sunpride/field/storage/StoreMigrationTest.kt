package com.sunpride.field.storage

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Version 1 baseline validation. Future migrations must be additive and tested from exported JSON. */
@RunWith(AndroidJUnit4::class)
class StoreMigrationTest {
    @get:Rule val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(), StoreDatabase::class.java.canonicalName!!)

    @Test fun exportedV1SchemaOpensWithoutDestructiveFallback() {
        val name = "migration-baseline-v1.db"
        helper.createDatabase(name, 1).apply {
            execSQL("INSERT INTO intents (account,deviceId,scope,requestId,clientVisitId,kind,serializedOperation,createdAt) VALUES ('a','d','s','uuid','visit','visit.checkIn','immutable',1)")
            close()
        }
        helper.runMigrationsAndValidate(name, 1, true).use { db ->
            db.query("SELECT serializedOperation FROM intents WHERE requestId='uuid'").use { cursor ->
                assertEquals(true, cursor.moveToFirst())
                assertEquals("immutable", cursor.getString(0))
            }
        }
    }
}
