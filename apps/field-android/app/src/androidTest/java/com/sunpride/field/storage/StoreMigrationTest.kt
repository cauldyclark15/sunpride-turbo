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

    @Test fun v3ToV4RetainsSnapshotAndImmutableWorkAndAddsStableListOrder() {
        val name = "migration-fieldday-v3.db"
        helper.createDatabase(name, 3).apply {
            execSQL("INSERT INTO snapshots (account,deviceId,scope,generation,kind,entityId,json,serviceDate) VALUES ('a','d','s','g','visit','z','{\"sequence\":2}','2026-10-02')")
            execSQL("INSERT INTO snapshots (account,deviceId,scope,generation,kind,entityId,json,serviceDate) VALUES ('a','d','s','g','visit','a','{}','2026-10-02')")
            execSQL("INSERT INTO intents (account,deviceId,scope,requestId,clientVisitId,kind,serializedOperation,createdAt) VALUES ('a','d','s','r','v','visit.checkIn','immutable',1)")
            execSQL("INSERT INTO outbox (account,deviceId,scope,requestId,createdAt,state) VALUES ('a','d','s','r',1,'pending')")
            execSQL("INSERT INTO acks (account,deviceId,scope,requestId,entityId,eventIdsJson,serverTime) VALUES ('a','d','s','ack','v','[]',1)")
            execSQL("INSERT INTO deltas (account,deviceId,scope,entity,entityId,revision,json,tombstone) VALUES ('a','d','s','visit','v',1,NULL,1)")
            execSQL("INSERT INTO partitions (account,deviceId,scope,activeGeneration,syncHealth,held,lastSuccessfulSync) VALUES ('a','d','s','g','synced',0,1)")
            close()
        }
        helper.runMigrationsAndValidate(name, 4, true, EncryptedFieldDatabase.MIGRATION_3_4).use { db ->
            db.query("SELECT json,snapshotOrder FROM snapshots WHERE entityId='z'").use { c ->
                assertEquals(true, c.moveToFirst()); assertEquals("{\"sequence\":2}", c.getString(0)); assertEquals(1, c.getInt(1))
            }
            for (table in listOf("intents", "outbox", "acks", "deltas", "partitions")) {
                db.query("SELECT COUNT(*) FROM $table").use { c -> c.moveToFirst(); assertEquals(1, c.getInt(0)) }
            }
            db.query("SELECT serializedOperation FROM intents").use { c -> c.moveToFirst(); assertEquals("immutable", c.getString(0)) }
        }
    }
    @Test fun completeV1ToV4ChainValidates() {
        val name = "migration-fieldday-v1.db"
        helper.createDatabase(name, 1).close()
        helper.runMigrationsAndValidate(name, 4, true, EncryptedFieldDatabase.MIGRATION_1_2,
            EncryptedFieldDatabase.MIGRATION_2_3, EncryptedFieldDatabase.MIGRATION_3_4).close()
    }
    @Test fun v2ToV3KeepsOutboxAndAddsSyncTimestamp() {
        val name = "migration-status-v2.db"
        helper.createDatabase(name, 2).apply {
            execSQL("INSERT INTO partitions (account,deviceId,scope,syncHealth,held) VALUES ('a','d','s','retry_pending',0)")
            execSQL("INSERT INTO outbox (account,deviceId,scope,requestId,createdAt,state) VALUES ('a','d','s','r',1,'pending')")
            close()
        }
        helper.runMigrationsAndValidate(name, 3, true, EncryptedFieldDatabase.MIGRATION_2_3).use { db ->
            db.query("SELECT state FROM outbox WHERE requestId='r'").use { c ->
                assertEquals(true, c.moveToFirst()); assertEquals("pending", c.getString(0))
            }
            db.query("SELECT lastSuccessfulSync FROM partitions WHERE scope='s'").use { c ->
                assertEquals(true, c.moveToFirst()); assertEquals(true, c.isNull(0))
            }
        }
    }
}
