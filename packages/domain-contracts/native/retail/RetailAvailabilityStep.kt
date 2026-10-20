package com.sunpride.retail

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/** F-212/F-213/F-217/F-218/F-219: a step inside the existing call, not a second call flow. */
@Composable fun RetailAvailabilityStep(call: RetailCall, busy: Boolean, saved: Boolean,
    onSave: (List<ShelfAnswer>, Map<String,Long>) -> Unit) {
    var answers by remember(call.snapshotId) { mutableStateOf(call.required.map { ShelfAnswer(it.productId) }) }
    var quantities by remember(call.snapshotId) { mutableStateOf(call.lines.associate { it.productId to it.suggestedBase.toString() }) }
    var scan by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf<String?>(null) }
    fun answer(id: String, state: String, method: String = "tap") {
        answers = answers.map { if(it.productId == id) it.copy(state=state,method=method,shelfBase=if(state=="absent")0 else null) else it }
        if(state=="absent") call.lines.firstOrNull { it.productId==id }?.let { line ->
            quantities=quantities + (id to maxOf(line.minimumBase,line.suggestedBase).toString())
        }
    }
    Column(Modifier.fillMaxWidth().testTag("retail-availability"),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Text("Must-stock availability",style=MaterialTheme.typography.titleMedium)
        Text("${if(call.sample)"SAMPLE · " else ""}${call.label}",style=MaterialTheme.typography.bodySmall)
        Text(if(saved) "Complete · saved on this phone" else "${answers.count { it.state!="not_checked" }} / ${call.required.size} MSL lines checked",
            modifier=Modifier.testTag("retail-completeness"))
        if(!saved) {
            OutlinedTextField(scan,{scan=it},label={Text("Scan barcode or enter product code")},singleLine=true,
                modifier=Modifier.fillMaxWidth().testTag("retail-scan"))
            OutlinedButton(onClick={
                val found=RetailAvailability.scan(call,scan.trim())
                if(found==null)notice="Not a unique MSL barcode. Tap the product instead."
                else {answer(found.productId,"present","scan");notice="${found.name} marked present";scan=""}
            },enabled=!busy&&scan.isNotBlank()) {Text("Mark scanned product present")}
        }
        call.required.forEachIndexed { index,line ->
            val a=answers.single {it.productId==line.productId}
            Column(Modifier.fillMaxWidth().padding(vertical=4.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                Text(line.name,style=MaterialTheme.typography.titleSmall)
                if(!saved) Row(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected=a.state=="present",onClick={answer(line.productId,"present")},label={Text("Present")},modifier=Modifier.testTag("retail-present-$index"))
                    FilterChip(selected=a.state=="absent",onClick={answer(line.productId,"absent")},label={Text("Absent")},modifier=Modifier.testTag("retail-absent-$index"))
                    FilterChip(selected=a.state=="not_checked",onClick={answer(line.productId,"not_checked")},label={Text("Not checked")})
                }
                if(!saved && a.state!="not_checked") Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(a.shelfBase?.toString() ?: "",{v -> if(v.isEmpty()||v.toLongOrNull() in 0L..1_000_000_000L)answers=answers.map {if(it.productId==line.productId)it.copy(shelfBase=v.toLongOrNull())else it}},
                        label={Text("Shelf base units")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),modifier=Modifier.weight(1f))
                    OutlinedTextField(a.backroomBase?.toString() ?: "",{v -> if(v.isEmpty()||v.toLongOrNull() in 0L..1_000_000_000L)answers=answers.map {if(it.productId==line.productId)it.copy(backroomBase=v.toLongOrNull())else it}},
                        label={Text("Back-room base units")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),modifier=Modifier.weight(1f))
                }
                if(!saved && a.state!="not_checked") {
                    Row {
                        Checkbox(checked=a.deliveredBase!=null && a.returnsBase!=null,onCheckedChange={known-> answers=answers.map {if(it.productId==line.productId)it.copy(deliveredBase=if(known)0 else null,returnsBase=if(known)0 else null)else it}},modifier=Modifier.testTag("retail-movements-$index"))
                        Text("I counted deliveries and returns since the previous stock check",style=MaterialTheme.typography.bodySmall)
                    }
                    if(a.deliveredBase!=null && a.returnsBase!=null) Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(a.deliveredBase.toString(),{v->v.toLongOrNull()?.takeIf {it in 0L..1_000_000_000L}?.let {n->answers=answers.map {if(it.productId==line.productId)it.copy(deliveredBase=n)else it}}},label={Text("Delivered base units")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),modifier=Modifier.weight(1f))
                        OutlinedTextField(a.returnsBase.toString(),{v->v.toLongOrNull()?.takeIf {it in 0L..1_000_000_000L}?.let {n->answers=answers.map {if(it.productId==line.productId)it.copy(returnsBase=n)else it}}},label={Text("Returned base units")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),modifier=Modifier.weight(1f))
                    } else Text("Offtake stays unknown until both stock counts and interval movements are known.",style=MaterialTheme.typography.bodySmall)
                }
            }
        }
        Text("Suggested order · review before sending",style=MaterialTheme.typography.titleMedium)
        Text("Quantities below are base units. ${call.lines.firstOrNull()?.let { "${it.scale} base units = 1 ${it.uom}." } ?: ""} Change a proposal or set it to zero to dismiss. Saving prepares an editable order; it does not send or invoice it.",style=MaterialTheme.typography.bodySmall)
        call.lines.forEachIndexed { index,line ->
            val absent=answers.any {it.productId==line.productId&&it.state=="absent"}
            if(absent || line.suggestedBase>0 || line.objective!=null) Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
                Text(line.name,style=MaterialTheme.typography.titleSmall)
                if(absent)Text("Absent MSL line — proposed automatically",modifier=Modifier.testTag("retail-oos-reason-$index"))
                line.objective?.let {Text("Objective: $it")}
                line.reasons.forEach {Text(it,style=MaterialTheme.typography.bodySmall)}
                if(!saved)OutlinedTextField(quantities[line.productId].orEmpty(),{v -> quantities=quantities+(line.productId to v)},label={Text("Proposed base quantity")},singleLine=true,
                    keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),modifier=Modifier.fillMaxWidth().testTag("retail-quantity-$index"))
            }
        }
        notice?.let {Text(it)}
        if(!saved) Button(onClick={
            try {
                RetailAvailability.validate(call,answers)
                val proposed=quantities.mapValues { (_,v)->v.toLongOrNull()?.takeIf {it in 0L..1_000_000_000L} ?: error("Use whole non-negative quantities") }
                onSave(answers,proposed)
            }catch(e:IllegalArgumentException){notice=e.message}catch(e:IllegalStateException){notice=e.message}
        },enabled=!busy&&RetailAvailability.complete(call,answers),modifier=Modifier.fillMaxWidth().testTag("retail-save")) {Text("Save check & prepare order")}
    }
}
