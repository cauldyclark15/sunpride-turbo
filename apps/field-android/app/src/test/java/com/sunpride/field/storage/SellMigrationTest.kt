package com.sunpride.field.storage

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SP-0192: v10 -> v11 only ADDS the Sell area's tables. Checked against Room's own exported schemas: the migration's
 * statements are exactly Room's create SQL for the new `sell_` tables, and every field table is byte-for-byte unchanged.
 */
class SellMigrationTest {
    private fun schema(version: Int) = JSONObject(File("schemas/com.sunpride.field.storage.StoreDatabase/$version.json").readText())
        .getJSONObject("database").getJSONArray("entities").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    private fun statements(e: JSONObject): List<String> {
        val t = e.getString("tableName")
        val out = mutableListOf(e.getString("createSql").replace("\${TABLE_NAME}", t))
        e.optJSONArray("indices")?.let { a -> for (i in 0 until a.length()) out += a.getJSONObject(i).getString("createSql").replace("\${TABLE_NAME}", t) }
        return out
    }

    @Test fun migrationCreatesExactlyTheSellTablesRoomExpects() {
        val v11 = schema(11)
        val sell = v11.filter { it.getString("tableName").startsWith("sell_") }
        assertEquals(28, sell.size)
        assertEquals(sell.flatMap(::statements).toSet(), SellMigration.CREATE_SQL.toSet())
        assertEquals(SellMigration.CREATE_SQL.size, SellMigration.CREATE_SQL.toSet().size)
    }

    @Test fun everyFieldTableIsUnchanged() {
        val v10 = schema(10).associateBy { it.getString("tableName") }
        val v11 = schema(11).filterNot { it.getString("tableName").startsWith("sell_") }.associateBy { it.getString("tableName") }
        assertEquals(v10.keys, v11.keys)
        for ((name, old) in v10) assertEquals(name, old.toString(), v11.getValue(name).toString())
    }

    @Test fun migrationNeverChangesOrRemovesARow() {
        assertTrue(SellMigration.CREATE_SQL.all { it.startsWith("CREATE TABLE IF NOT EXISTS `sell_") || it.startsWith("CREATE INDEX IF NOT EXISTS `index_sell_") || it.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS `index_sell_") })
        SellMigration.CREATE_SQL.forEach { sql -> listOf("DROP", "DELETE", "UPDATE", "ALTER", "INSERT").forEach { assertFalse(sql, sql.uppercase().contains(it)) } }
        assertEquals(10, SellMigration.MIGRATION_10_11.startVersion)
        assertEquals(11, SellMigration.MIGRATION_10_11.endVersion)
        // Registered on the one encrypted Field database, after every earlier step.
        val src = File("src/main/java/com/sunpride/field/storage/FieldStore.kt").readText()
        assertTrue(src.contains("MIGRATION_9_10, SellMigration.MIGRATION_10_11)"))
    }
}
