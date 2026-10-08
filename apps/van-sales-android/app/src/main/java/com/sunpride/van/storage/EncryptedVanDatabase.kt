package com.sunpride.van.storage

import android.content.Context
import androidx.room.Room
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

/** SQLCipher only; missing/corrupt key refuses open, never plaintext or destructive recovery. */
object EncryptedVanDatabase {
    private val lock = Any()
    fun open(context: Context): VanDatabase = synchronized(lock) {
        openWithPassphrase(context, PassphraseVault(context).passphrase(), PassphraseVault.DB_NAME)
    }
    internal fun openStub(context: Context): VanDatabase = synchronized(lock) {
        val name = "van_stub_store.db"
        openWithPassphrase(context, PassphraseVault(context,name,"van_stub_database_key","sunpride-van-stub-database-aes-v1").passphrase(),name)
    }
    /** Explicit key/name seam for encrypted device tests; never used as a production fallback. */
    internal fun openWithPassphrase(context: Context, passphrase: ByteArray, name: String): VanDatabase {
        require(passphrase.isNotEmpty())
        System.loadLibrary("sqlcipher")
        val db = Room.databaseBuilder(context.applicationContext, VanDatabase::class.java, name)
            .openHelperFactory(SupportOpenHelperFactory(passphrase.copyOf()))
            .addMigrations(VanDatabase.MIGRATION_1_2,VanDatabase.MIGRATION_2_3,VanDatabase.MIGRATION_3_4,VanDatabase.MIGRATION_4_5,VanDatabase.MIGRATION_5_6,VanDatabase.MIGRATION_6_7,VanDatabase.MIGRATION_7_8,VanDatabase.MIGRATION_8_9)
            .build()
        try { db.openHelper.writableDatabase; return db }
        catch (e: Exception) { db.close(); throw e }
    }
}
