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
        // VAN-017: v2 → v3 adds only the empty, scoped receipt_print table; saved sales and operation bytes are untouched.
        helper.runMigrationsAndValidate(name,3,true,VanDatabase.MIGRATION_2_3).use { database ->
            database.query("SELECT COUNT(*) FROM receipt_print").use { assertTrue(it.moveToFirst()); assertEquals(0,it.getInt(0)) }
            database.query("PRAGMA table_info(`receipt_print`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertEquals(listOf("fullAuthSubject","deviceId","printId","saleId","kind","copyNumber","reason","outcome","startedAt","finishedAt"),columns) }
            database.query("SELECT saleId,receiptNumber,status,totalMinor FROM sale").use { assertTrue(it.moveToFirst()); assertEquals("s1",it.getString(0)); assertEquals("R-1",it.getString(1)); assertEquals("saved",it.getString(2)); assertEquals(8500L,it.getLong(3)) }
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.execSQL("INSERT INTO receipt_print (fullAuthSubject,deviceId,printId,saleId,kind,copyNumber,outcome,startedAt) VALUES ('issuer|subject','d','p1','s1','original',0,'printed',2)")
        }
        // VAN-017: v3 → v4 adds only the empty, scoped sale_receipt table; print history, sales and operation bytes are untouched.
        helper.runMigrationsAndValidate(name,4,true,VanDatabase.MIGRATION_3_4).use { database ->
            database.query("SELECT COUNT(*) FROM sale_receipt").use { assertTrue(it.moveToFirst()); assertEquals(0,it.getInt(0)) }
            database.query("PRAGMA table_info(`sale_receipt`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertEquals(listOf("fullAuthSubject","deviceId","saleId","documentJson"),columns) }
            database.query("SELECT saleId,kind,outcome FROM receipt_print").use { assertTrue(it.moveToFirst()); assertEquals("s1",it.getString(0)); assertEquals("original",it.getString(1)); assertEquals("printed",it.getString(2)) }
            database.query("SELECT receiptNumber,totalMinor FROM sale").use { assertTrue(it.moveToFirst()); assertEquals("R-1",it.getString(0)); assertEquals(8500L,it.getLong(1)) }
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.execSQL("INSERT INTO sale_receipt (fullAuthSubject,deviceId,saleId,documentJson) VALUES ('issuer|subject','d','s1','frozen receipt bytes')")
        }
        // VAN-021: v4 → v5 adds only empty append-only void evidence and its unique sale index.
        helper.runMigrationsAndValidate(name,5,true,VanDatabase.MIGRATION_4_5).use { database ->
            database.query("SELECT COUNT(*) FROM sale_void").use { assertTrue(it.moveToFirst()); assertEquals(0,it.getInt(0)) }
            database.query("PRAGMA table_info(`sale_void`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertEquals(listOf("fullAuthSubject","deviceId","voidId","saleId","tripId","idempotencyKey","reasonCode","note","approvalMethod","approvalCode","createdAt"),columns) }
            database.query("SELECT saleId,kind,outcome FROM receipt_print").use { assertTrue(it.moveToFirst()); assertEquals("s1",it.getString(0)); assertEquals("original",it.getString(1)); assertEquals("printed",it.getString(2)) }
            database.query("SELECT receiptNumber,totalMinor,status FROM sale").use { assertTrue(it.moveToFirst()); assertEquals("R-1",it.getString(0)); assertEquals(8500L,it.getLong(1)); assertEquals("saved",it.getString(2)) }
            database.query("SELECT method,amountMinor FROM payment").use { assertTrue(it.moveToFirst()); assertEquals("cash",it.getString(0)); assertEquals(8500L,it.getLong(1)) }
            database.query("SELECT quantityBase FROM stock_movement").use { assertTrue(it.moveToFirst()); assertEquals(-1L,it.getLong(0)) }
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.query("SELECT documentJson FROM sale_receipt").use { assertTrue(it.moveToFirst()); assertEquals("frozen receipt bytes",it.getString(0)) }
            database.query("PRAGMA index_list(`sale_void`)").use { cursor -> var unique = false
                while(cursor.moveToNext()) if(cursor.getString(1) == "index_sale_void_fullAuthSubject_deviceId_saleId") unique = cursor.getInt(2) == 1
                assertTrue(unique) }
            database.execSQL("INSERT INTO sale_void (fullAuthSubject,deviceId,voidId,saleId,tripId,idempotencyKey,reasonCode,note,approvalMethod,approvalCode,createdAt) VALUES ('issuer|subject','d','v1','s1','t','k','wrong_items',NULL,'none',NULL,2)")
        }
        // VAN-022: v5 → v6 adds only the empty append-only cash count table and its one-per-trip index.
        helper.runMigrationsAndValidate(name,6,true,VanDatabase.MIGRATION_5_6).use { database ->
            database.query("SELECT COUNT(*) FROM cash_reconciliation").use { assertTrue(it.moveToFirst()); assertEquals(0,it.getInt(0)) }
            database.query("PRAGMA table_info(`cash_reconciliation`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertEquals(listOf("fullAuthSubject","deviceId","reconciliationId","tripId","idempotencyKey","currency","expectedMinor","declaredMinor",
                    "varianceMinor","countsJson","reasonCode","note","approvalMethod","approvalCode","cashSaleCount","createdAt"),columns) }
            database.query("SELECT receiptNumber,totalMinor,status FROM sale").use { assertTrue(it.moveToFirst()); assertEquals("R-1",it.getString(0)); assertEquals(8500L,it.getLong(1)); assertEquals("saved",it.getString(2)) }
            database.query("SELECT method,amountMinor FROM payment").use { assertTrue(it.moveToFirst()); assertEquals("cash",it.getString(0)); assertEquals(8500L,it.getLong(1)) }
            database.query("SELECT saleId,reasonCode FROM sale_void").use { assertTrue(it.moveToFirst()); assertEquals("s1",it.getString(0)); assertEquals("wrong_items",it.getString(1)) }
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.query("PRAGMA index_list(`cash_reconciliation`)").use { cursor -> var unique = false
                while(cursor.moveToNext()) if(cursor.getString(1) == "index_cash_reconciliation_fullAuthSubject_deviceId_tripId") unique = cursor.getInt(2) == 1
                assertTrue(unique) }
        }
        // SP-0105: v6 → v7 adds customer/list/promotion facts and nullable sale-line facts without changing saved rows.
        helper.runMigrationsAndValidate(name,7,true,VanDatabase.MIGRATION_6_7).use { database ->
            database.query("PRAGMA table_info(`customer`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertTrue(columns.containsAll(listOf("priceListId","priceListMode"))) }
            database.query("PRAGMA table_info(`price_list_line`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertTrue(columns.contains("priceListCode")) }
            database.query("PRAGMA table_info(`sale_line`)").use { cursor -> val columns=mutableListOf<String>(); while(cursor.moveToNext()) columns+=cursor.getString(1)
                assertTrue(columns.containsAll(listOf("freeBase","discountMinor"))) }
            database.query("SELECT receiptNumber,totalMinor,status FROM sale").use { assertTrue(it.moveToFirst()); assertEquals("R-1",it.getString(0)); assertEquals(8500L,it.getLong(1)); assertEquals("saved",it.getString(2)) }
            database.query("SELECT operationJson,status FROM outbox").use { assertTrue(it.moveToFirst()); assertEquals("immutable bytes",it.getString(0)); assertEquals("pending",it.getString(1)) }
            database.query("SELECT COUNT(*) FROM promotion").use { assertTrue(it.moveToFirst()); assertEquals(0,it.getInt(0)) }
        }
    }
}
