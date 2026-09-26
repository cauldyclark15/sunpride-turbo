package com.sunpride.field.storage

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Non-destructive v1 → v2 migration retains immutable work and adds scoped deltas. */
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
        helper.runMigrationsAndValidate(name, 2, true, EncryptedFieldDatabase.MIGRATION_1_2).use { db ->
            db.query("SELECT serializedOperation FROM intents WHERE requestId='uuid'").use { cursor ->
                assertEquals(true, cursor.moveToFirst())
                assertEquals("immutable", cursor.getString(0))
            }
            db.execSQL("INSERT INTO deltas (account,deviceId,scope,entity,entityId,revision,json,tombstone) VALUES ('a','d','s','visit','v',1,NULL,1)")
            db.query("SELECT revision FROM deltas WHERE entityId='v'").use { cursor ->
                assertEquals(true, cursor.moveToFirst())
                assertEquals(1L, cursor.getLong(0))
            }
        }
    }
}
