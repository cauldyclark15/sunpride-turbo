package com.sunpride.van.ui

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.catalogue.CatalogueEntry
import com.sunpride.catalogue.CatalogueScreen
import com.sunpride.van.scanning.SenraiseScanner

/** F-616 reuses the H10P vendor input and the same read-only offline catalogue. */
@Composable
fun VanCatalogue(c: VanController) {
    val context=LocalContext.current
    val scanner=remember { SenraiseScanner(context) }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    var sequence by remember { mutableLongStateOf(0) }
    var event by remember { mutableStateOf<Pair<Long,String>?>(null) }
    DisposableEffect(scanner,lifecycle) {
        val observer=LifecycleEventObserver { _,state -> if(state==Lifecycle.Event.ON_START)scanner.start() else if(state==Lifecycle.Event.ON_STOP)scanner.stop() }
        lifecycle.addObserver(observer)
        if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))scanner.start()
        onDispose {lifecycle.removeObserver(observer);scanner.close()}
    }
    LaunchedEffect(scanner) {scanner.scans.collect { scan -> sequence++;event=sequence to scan.code }}
    val entries=if(c.onHold)emptyList() else c.products.map { CatalogueEntry(it.productId,it.code,it.name,it.barcodes,it.catalogue) }
    CatalogueScreen(entries,c::back,scanEvent=event,imageDownloader=c.repository::catalogueImage)
}
