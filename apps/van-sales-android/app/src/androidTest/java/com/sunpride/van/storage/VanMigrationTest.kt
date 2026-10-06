package com.sunpride.van.storage

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith

/** MigrationTestHelper's unencrypted fixture is ONLY a schema test, never a production store. */
@RunWith(AndroidJUnit4::class)
class VanMigrationTest {
    @get:Rule val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(),VanDatabase::class.java.canonicalName!!)
    @Test fun exportedV1BaselineValidatesAndRetainsImmutableRows() {
        val name="van-migration-baseline.db"
        helper.createDatabase(name,1).apply {
            execSQL("INSERT INTO outbox (fullAuthSubject,deviceId,clientRequestId,tripId,kind,operationJson,createdAt,status) VALUES ('issuer|subject','d','id','trip','trip.start','immutable bytes',1,'pending')")
            execSQL("INSERT INTO stock_movement (fullAuthSubject,deviceId,movementId,tripId,productId,type,stockStatus,quantityBase,clientRequestId,createdAt) VALUES ('issuer|subject','d','m','trip','p','SALE','available',-1,'id',1)")
            close()
        }
        helper.runMigrationsAndValidate(name,1,true).use { database ->
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.query("SELECT quantityBase FROM stock_movement").use { assertTrue(it.moveToFirst()); assertEquals(-1L,it.getLong(0)) }
            for(table in listOf("trip","load_line","product","customer","truck_stock_baseline","stock_movement","movement_settlement","outbox","ack","sync_meta","sequence_counter","transaction_id","sale","sale_line","payment","customer_return","return_line","reconciliation","price_list_line")) {
                database.query("PRAGMA table_info(`$table`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1); assertTrue(columns.containsAll(listOf("fullAuthSubject","deviceId"))) }
            }
        }
    }
}
