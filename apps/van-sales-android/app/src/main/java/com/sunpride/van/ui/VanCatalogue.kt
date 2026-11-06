package com.sunpride.van.ui

import androidx.compose.runtime.*
import com.sunpride.catalogue.CatalogueEntry
import com.sunpride.catalogue.CatalogueScreen
import com.sunpride.van.scanning.LocalScannerInput

/** F-616 reuses the app's one scanner and the same read-only offline catalogue. */
@Composable
fun VanCatalogue(c: VanController) {
    val scanner=checkNotNull(LocalScannerInput.current)
    var sequence by remember { mutableLongStateOf(0) }
    var event by remember { mutableStateOf<Pair<Long,String>?>(null) }
    LaunchedEffect(scanner) {scanner.scans.collect { scan -> sequence++;event=sequence to scan.code }}
    val entries=if(c.onHold)emptyList() else c.products.map { CatalogueEntry(it.productId,it.code,it.name,it.barcodes,it.catalogue) }
    CatalogueScreen(entries,c::back,scanEvent=event,imageDownloader=c.repository::catalogueImage)
}
