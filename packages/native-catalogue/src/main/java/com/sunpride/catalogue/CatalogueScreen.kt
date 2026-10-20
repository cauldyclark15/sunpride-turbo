package com.sunpride.catalogue

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** F-616: one read-only, offline-first catalogue for field and van. A scan only
 * opens product information; it cannot create an order, sale or price override. */
@Composable
fun CatalogueScreen(entries: List<CatalogueEntry>, onBack: () -> Unit,
    modifier: Modifier = Modifier, scanEvent: Pair<Long,String>? = null,
    imageDownloader:((CatalogueImage)->ByteArray?)? = null) {
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<CatalogueEntry?>(null) }
    var camera by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val context=LocalContext.current
    val downloader by rememberUpdatedState(imageDownloader)
    var imagesReady by remember { mutableIntStateOf(0) }
    var imageRefresh by remember { mutableIntStateOf(0) }
    val imageCount=remember(entries){entries.mapNotNull{it.details?.image?.sha256}.distinct().size}
    LaunchedEffect(entries,imageRefresh) {
        imagesReady=withContext(Dispatchers.IO) {
            val job=kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]
            runCatching { warmCatalogueImages(context,entries.mapNotNull{it.details},downloader){job?.isActive!=false} }.getOrDefault(0)
        }
    }
    fun scan(code: String) {
        val matches=CatalogueSearch.scan(entries,code)
        query=code
        selected=matches.singleOrNull()
        message=when { matches.isEmpty() -> "No saved product matches this barcode. Download the latest catalogue when online."
            matches.size>1 -> "This barcode matches more than one saved product. Choose the right product below."
            else -> null }
    }
    LaunchedEffect(scanEvent) { scanEvent?.let { scan(it.second) } }
    BackHandler { if(camera) camera=false else if(selected!=null) selected=null else onBack() }
    if(camera) {
        CameraScanScreen(onCode={camera=false;scan(it)},onClose={camera=false},closeLabel="Back to catalogue",modifier=modifier)
        return
    }
    Scaffold(modifier=modifier,contentWindowInsets=WindowInsets.systemBars) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            TextButton(onClick={if(selected!=null){selected=null;message=null;query=""}else onBack()},modifier=Modifier.testTag("catalogue-back")) { Text(if(selected!=null) "Back to catalogue" else "Back") }
            val product=selected?.let { chosen -> entries.firstOrNull { it.id==chosen.id } }
            Text(product?.name ?: "Product catalogue",style=MaterialTheme.typography.headlineSmall,modifier=Modifier.testTag("catalogue-title"))
            if(product==null) {
                Text("Saved on this phone · Read only",style=MaterialTheme.typography.bodySmall)
                if(imageCount>0) TextButton(onClick={imageRefresh++},modifier=Modifier.testTag("catalogue-image-refresh")) { Text("$imagesReady of $imageCount images stored · Refresh images") }
                OutlinedTextField(value=query,onValueChange={query=it;message=null},label={Text("Search name, SKU or barcode")},singleLine=true,
                    modifier=Modifier.fillMaxWidth().testTag("catalogue-search"))
                message?.let { Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("catalogue-message")) }
                val filtered=remember(entries,query) { CatalogueSearch.search(entries,query) }
                Text("${filtered.size} of ${entries.size} saved products")
                LazyColumn(Modifier.weight(1f).testTag("catalogue-results"),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    if(entries.isEmpty()) item { Text("No catalogue has been saved. Download your route or trip while online first.") }
                    items(filtered,key={it.id}) { p ->
                        OutlinedCard(Modifier.fillMaxWidth().clickable { selected=p;message=null }.testTag("catalogue-product-${p.code}")) {
                            Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                                Text(p.name,style=MaterialTheme.typography.titleMedium)
                                Text(p.code,style=MaterialTheme.typography.bodySmall)
                                if(p.details?.sample==true)Text("Sample product content",style=MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    item { Spacer(Modifier.height(16.dp)) }
                }
                OutlinedButton(onClick={camera=true},modifier=Modifier.fillMaxWidth().heightIn(min=56.dp).testTag("catalogue-scan")) { Text("Scan barcode") }
            } else {
                var bitmap by remember(product.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
                LaunchedEffect(product.id,product.details?.versionId,imagesReady) {
                    bitmap=withContext(Dispatchers.IO) { runCatching { catalogueImage(context,product.details,downloader)?.let { BitmapFactory.decodeFile(it.path) } }.getOrNull() }
                }
                LazyColumn(Modifier.weight(1f).testTag("catalogue-detail"),verticalArrangement=Arrangement.spacedBy(14.dp)) {
                    item { Text(product.code,style=MaterialTheme.typography.labelLarge) }
                    if(product.details?.sample==true) item { Text("SAMPLE · Invented training content. Not a real Sunpride food label.",modifier=Modifier.testTag("catalogue-sample")) }
                    item { bitmap?.let { Image(it.asImageBitmap(),contentDescription="Product catalogue image",modifier=Modifier.fillMaxWidth().height(180.dp).testTag("catalogue-image")) }
                        ?: Text("Image not saved on this phone") }
                    val detail=product.details
                    if(detail==null) item { Text("Product details need a fresh download. Connect and refresh your route or trip.") }
                    else {
                        item { CatalogueFact("Description",detail.description) }
                        item { CatalogueFact("Pack hierarchy",detail.packs.joinToString("\n") { it.explanation() }.ifBlank { "Pack information needs setup" }) }
                        item { CatalogueFact("Ingredients",detail.ingredients) }
                        item { CatalogueFact("Allergens",detail.allergens) }
                        item { CatalogueFact("Storage",detail.storage) }
                        item { CatalogueFact("Shelf life",if(detail.shelfLifeDays==0) "Needs setup" else "${detail.shelfLifeDays} days · Check the lot's expiry") }
                        item { CatalogueFact("Case specifications",detail.caseSpecifications) }
                    }
                    item { CatalogueFact("Barcodes",product.barcodes.joinToString("\n").ifBlank { "No barcode is saved" }) }
                    item { Spacer(Modifier.height(16.dp)) }
                }
            }
        }
    }
}
@Composable private fun CatalogueFact(label: String,value: String) {
    Column(verticalArrangement=Arrangement.spacedBy(4.dp)) { Text(label,style=MaterialTheme.typography.titleSmall);Text(value) }
}
