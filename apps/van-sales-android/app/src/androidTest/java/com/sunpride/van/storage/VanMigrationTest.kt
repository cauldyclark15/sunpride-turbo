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
            execSQL("INSERT INTO sale (fullAuthSubject,deviceId,saleId,tripId,receiptNumber,idempotencyKey,customerId,status,totalMinor,createdAt) VALUES ('issuer|subject','d','s1','trip','R-1','id','o1','saved',8500,1)")
            execSQL("INSERT INTO payment (fullAuthSubject,deviceId,paymentId,saleId,method,amountMinor,createdAt) VALUES ('issuer|subject','d','p1','s1','cash',8500,1)")
            close()
        }
        helper.runMigrationsAndValidate(name,1,true).close()
        // VAN-012: v1 → v2 adds nullable payment/credit columns; saved rows and operation bytes are untouched.
        helper.runMigrationsAndValidate(name,2,true,VanDatabase.MIGRATION_1_2).use { database ->
            // A v1 cash sale keeps its posting state; its payment state reads as null (= paid in cash).
            database.query("SELECT status,paymentStatus FROM sale").use { assertTrue(it.moveToFirst()); assertEquals("saved",it.getString(0)); assertTrue(it.isNull(1)) }
            database.query("SELECT method,amountMinor,reference,status,tenderedMinor,dueDate FROM payment").use {
                assertTrue(it.moveToFirst()); assertEquals("cash",it.getString(0)); assertEquals(8500L,it.getLong(1)); assertTrue((2..5).all { i -> it.isNull(i) }) }
            database.query("SELECT creditTermsDays,creditAvailableMinor FROM customer").use { assertEquals(2,it.columnCount) }
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.query("SELECT quantityBase FROM stock_movement").use { assertTrue(it.moveToFirst()); assertEquals(-1L,it.getLong(0)) }
            for(table in listOf("trip","load_line","product","customer","truck_stock_baseline","stock_movement","movement_settlement","outbox","ack","sync_meta","sequence_counter","transaction_id","sale","sale_line","payment","customer_return","return_line","reconciliation","price_list_line")) {
                database.query("PRAGMA table_info(`$table`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1); assertTrue(columns.containsAll(listOf("fullAuthSubject","deviceId"))) }
            }
        }
    }
}
