package com.sunpride.field.catalogue

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.sunpride.catalogue.CatalogueEntry
import com.sunpride.catalogue.CatalogueScreen
import com.sunpride.field.ui.FieldBackend
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** F-616 opens only the current verified SQLite generation, including offline. */
@Composable
fun FieldCatalogue(backend: FieldBackend?,onBack: () -> Unit,modifier: Modifier = Modifier) {
    var entries by remember(backend) { mutableStateOf(emptyList<CatalogueEntry>()) }
    LaunchedEffect(backend) {
        entries=withContext(Dispatchers.IO) { runCatching { backend?.catalogueProducts().orEmpty().map {
            CatalogueEntry(it.id,it.code,it.name,it.barcodes.map { b -> b.barcode },it.catalogue)
        } }.getOrDefault(emptyList()) }
    }
    CatalogueScreen(entries,onBack,modifier,imageDownloader=backend?.let { b -> { image -> b.catalogueImage(image) } })
}
