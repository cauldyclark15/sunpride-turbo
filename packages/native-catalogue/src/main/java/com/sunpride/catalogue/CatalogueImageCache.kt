package com.sunpride.catalogue

import android.content.Context
import java.io.File
import java.security.MessageDigest

/** F-616 cache bound applies across all accounts, not once per account. No network
 * URLs, arbitrary filenames, credentials or customer evidence enter this cache. */
class CatalogueImageCache(private val root: File, private val maxBytes: Long = 8L * 1024 * 1024, private val maxFiles: Int = 40) {
    companion object { private val locks = java.util.concurrent.ConcurrentHashMap<String,Any>() }
    private val lock = locks.computeIfAbsent(root.canonicalPath) { Any() }
    init { synchronized(lock) {
        require(maxBytes > 0 && maxFiles > 0); root.mkdirs()
        root.listFiles()?.filter { it.name.startsWith("image-") && it.extension == "tmp" }?.forEach { it.delete() }
    } }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    fun get(hash: String): File? { synchronized(lock) {
        require(Regex("[0-9a-f]{64}").matches(hash))
        val f = File(root, "$hash.jpg")
        if (!f.isFile) return null
        if (f.length() > 524288 || digest(f.readBytes()) != hash) { f.delete(); return null }
        f.setLastModified(System.currentTimeMillis()); return f
    } }
    fun put(hash: String, bytes: ByteArray): File { synchronized(lock) {
        require(bytes.size in 1..524288 && bytes.size <= maxBytes && digest(bytes) == hash)
        require(Regex("[0-9a-f]{64}").matches(hash))
        val f = File(root, "$hash.jpg")
        val temp = File.createTempFile("image-", ".tmp", root)
        try { temp.writeBytes(bytes); check(temp.renameTo(f)) } finally { temp.delete() }
        f.setLastModified(System.currentTimeMillis())
        val files = root.listFiles()?.filter { Regex("[0-9a-f]{64}\\.jpg").matches(it.name) }?.sortedBy { it.lastModified() }?.toMutableList() ?: mutableListOf()
        var total = files.sumOf { it.length() }
        while (files.size > maxFiles || total > maxBytes) { val oldest = files.removeAt(0); total -= oldest.length(); check(oldest.delete()) }
        return f
    } }
}
/** F-616 sample illustrations work even on the first offline route. Uploaded or
 * SAP images use the authenticated same-origin downloader and exact frozen SHA. */
fun catalogueImage(context: Context, detail: CatalogueDetails?, download: ((CatalogueImage)->ByteArray?)? = null,
    isActive: ()->Boolean = {true}): File? {
    val image = detail?.image ?: return null
    if(!isActive())return null
    val cache = CatalogueImageCache(File(context.noBackupFilesDir, "catalogue-images"))
    cache.get(image.sha256)?.let { return it }
    if(detail.sample)runCatching {
        val bytes=context.assets.open("sample-catalogue.jpg").use{it.readBytes()}
        if(bytes.size==image.bytes)cache.put(image.sha256,bytes) else null
    }.getOrNull()?.let{return it}
    val bytes=runCatching{download?.invoke(image)}.getOrNull()?:return null
    if(!isActive()||bytes.size!=image.bytes)return null
    return runCatching{cache.put(image.sha256,bytes)}.getOrNull()
}
/** At most 40 unique images / 8 MiB. Two failed requests stop a broken/offline
 * connection from spending the route's battery on dozens of retries. */
fun warmCatalogueImages(context: Context, details: List<CatalogueDetails>, download: ((CatalogueImage)->ByteArray?)? = null,
    isActive: ()->Boolean = {true}): Int {
    val images=details.filter{it.image!=null}.distinctBy{it.image!!.sha256}
    var failed=0
    for(detail in images.take(40)){
        if(!isActive())break
        if(catalogueImage(context,detail,download,isActive)==null){failed++;if(failed>=2)break}else failed=0
    }
    val cache=CatalogueImageCache(File(context.noBackupFilesDir,"catalogue-images"))
    return images.count{isActive()&&cache.get(it.image!!.sha256)!=null}
}
