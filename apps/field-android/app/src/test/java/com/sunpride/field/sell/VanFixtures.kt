package com.sunpride.field.sell

import java.io.File
import java.io.InputStream

/**
 * SP-0192: the frozen van-v1 contract fixtures, read in place (never copied). They share file names with the mobile-v1 fixtures
 * the Field app's own tests load from the class path, so the Sell tests open them by path instead.
 */
object VanFixtures {
    private val dirs = listOf(File("../../../packages/domain-contracts/fixtures/van-v1"), File("../../../packages/domain-contracts/schemas"))
    fun stream(name: String): InputStream = dirs.map { File(it, name) }.first { it.isFile }.inputStream()
}
